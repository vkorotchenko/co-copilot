'use strict';

// Shared request gate for *everything* the bridge serves over plain HTTP —
// the /v1/* mirror, /healthz, and the /mcp endpoint.
//
// Threat model
// ------------
// The listener binds loopback, so the only peers that can reach it are (a)
// other processes on this machine and (b) a browser running on this machine.
// (a) is already trusted to the extent that it could just talk to the BLE
// device itself. (b) is not: a page on any website can make the browser issue
// requests to http://127.0.0.1:4317 or, via DNS rebinding, resolve its own
// hostname to 127.0.0.1 and reach us with an arbitrary Host header. Either way
// the peer address is loopback, so peer-address checking alone does not stop it.
//
// Three cheap, independent checks close that off, and all of them run *before*
// any body is read or any registry mutation happens:
//
//   1. peer address  — must be loopback (unchanged, still the outer fence).
//   2. Host header   — must be a loopback host *and* carry the port we are
//                      actually listening on. A rebound `evil.com` resolves to
//                      127.0.0.1 but still sends `Host: evil.com`, so this is
//                      what actually defeats DNS rebinding.
//   3. Origin header — if present at all it must be a loopback origin. Browsers
//                      always attach one cross-origin; well-behaved CLI callers
//                      never send one, so this costs `curl` nothing.
//
// Plus, for mutating routes, a Content-Type gate (see isJsonContentType): the
// CORS-safelisted content types a browser may send cross-origin without a
// preflight are form-urlencoded, multipart and text/plain. Requiring
// application/json means a cross-origin form post cannot reach a mutation at
// all, because we never answer the preflight it would need.
//
// We deliberately emit **no** CORS headers. There is no legitimate browser
// client for this API, so nothing should ever be granted read access to a
// response; staying silent is the correct answer to a cross-origin caller.

const MAX_HEADER_LEN = 255;
// Host/Origin values are structured tokens. Anything with whitespace, controls,
// credentials, a path, or a comma (i.e. a merged header list) is malformed and
// is rejected outright rather than "best effort" parsed.
const BAD_CHARS = /[\s\u0000-\u001f\u007f]/;

// Reject anything that isn't the loopback interface, even if the listener was
// (mis)configured to a wider bind address. Handles the three forms Node can
// hand us for a local peer: IPv4 (127.0.0.0/8), IPv6 (::1, and its expanded
// spelling), and IPv4-mapped IPv6 (::ffff:127.0.0.1). A zone/scope suffix
// (fe80::1%en0) is stripped before matching so it can't smuggle a match past
// an exact comparison.
function isLoopbackAddress(addr) {
  if (!addr) return false;
  let a = String(addr).trim().toLowerCase();
  const scope = a.indexOf('%');
  if (scope !== -1) a = a.slice(0, scope);
  if (a.startsWith('[') && a.endsWith(']')) a = a.slice(1, -1);
  if (a.startsWith('::ffff:')) a = a.slice('::ffff:'.length);
  if (a === '::1' || a === '0:0:0:0:0:0:0:1') return true;
  // Anchored: `startsWith('127.')` would also accept "127.0.0.1.example.com".
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(a);
}

// A hostname that names this machine's loopback interface. `localhost` is
// matched exactly — `localhost.evil.com` is a different host and must not pass.
function isLoopbackHostName(host) {
  if (!host) return false;
  const h = String(host).trim().toLowerCase();
  if (h === 'localhost') return true;
  return isLoopbackAddress(h);
}

// Split a Host header into { host, port }. Returns null for anything malformed
// so callers get a clean reject instead of a partially-understood value.
//
// An IPv6 literal must be bracketed (RFC 3986). A bare `::1` is ambiguous with
// host:port and is treated as malformed rather than guessed at.
function parseHostHeader(raw) {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!value || value.length > MAX_HEADER_LEN) return null;
  if (BAD_CHARS.test(value)) return null;
  // `,` = merged duplicate headers; `@` = userinfo; `/` `\` `?` `#` = not a Host.
  if (/[,@/\\?#]/.test(value)) return null;

  if (value.startsWith('[')) {
    const close = value.indexOf(']');
    if (close === -1) return null;
    const host = value.slice(1, close);
    if (!host) return null;
    const rest = value.slice(close + 1);
    if (rest === '') return { host, port: null };
    if (rest[0] !== ':') return null;
    const port = rest.slice(1);
    if (!/^\d{1,5}$/.test(port)) return null;
    return { host, port: Number(port) };
  }

  const parts = value.split(':');
  if (parts.length === 1) return parts[0] ? { host: parts[0], port: null } : null;
  if (parts.length === 2) {
    if (!parts[0] || !/^\d{1,5}$/.test(parts[1])) return null;
    return { host: parts[0], port: Number(parts[1]) };
  }
  return null; // unbracketed IPv6, or otherwise not a host[:port]
}

// The Host must name loopback *and* agree with the port we are bound to. The
// port half is the part that matters: a rebound hostname is rejected by the
// name check, and a caller that thinks it is talking to some other service on
// this machine is rejected by the port check.
//
// A Host with no port means "the scheme default", i.e. 80 — which only matches
// if the bridge really was configured onto port 80.
function isAllowedHost(raw, listenPort) {
  const parsed = parseHostHeader(raw);
  if (!parsed) return false;
  if (!isLoopbackHostName(parsed.host)) return false;
  const expected = Number(listenPort);
  if (!Number.isFinite(expected)) return false;
  return (parsed.port == null ? 80 : parsed.port) === expected;
}

// An Origin is acceptable only if it is a bare loopback origin. `Origin: null`
// (sandboxed iframe, file://, some redirects) is not a URL and is rejected, as
// is any non-http(s) scheme. The port is intentionally *not* pinned: a local
// dev server on :3000 is still a loopback origin, and the Content-Type gate is
// what actually stops a cross-origin mutation.
function isAllowedOrigin(raw) {
  if (typeof raw !== 'string') return false;
  const value = raw.trim();
  if (!value || value.length > MAX_HEADER_LEN) return false;
  if (BAD_CHARS.test(value)) return false;
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (url.username || url.password) return false;
  // A serialized origin has no path, query or fragment.
  if ((url.pathname && url.pathname !== '/') || url.search || url.hash) return false;
  return isLoopbackHostName(url.hostname);
}

// `application/json`, with parameters allowed (`; charset=utf-8` is normal and
// must not be rejected). Nothing else: notably not text/plain, which is one of
// the few types a browser may post cross-origin without a preflight.
function isJsonContentType(raw) {
  if (typeof raw !== 'string') return false;
  return raw.split(';')[0].trim().toLowerCase() === 'application/json';
}

// Evaluate the transport-level gate. Returns null when the request may proceed,
// or a { status, code, message } describing why it may not.
//
// Deliberately says nothing about *which* value was wrong and never echoes the
// offending header back: the caller who tripped this is either a local script
// with a typo (the log line has the detail) or something we do not want to help.
function checkRequest(req, { port } = {}) {
  const peer = (req.socket && req.socket.remoteAddress) || '';
  if (!isLoopbackAddress(peer)) {
    return {
      status: 403,
      code: 'forbidden',
      message: 'This API is available on the loopback interface only.',
      detail: `peer ${peer || '(unknown)'}`,
    };
  }

  const headers = req.headers || {};

  if (!isAllowedHost(headers.host, port)) {
    return {
      status: 403,
      code: 'forbidden',
      message: `Host header must name this loopback listener (port ${port}).`,
      detail: `host ${headers.host == null ? '(absent)' : String(headers.host).slice(0, 80)}`,
    };
  }

  // Absent is fine (that is every CLI caller). Present-and-not-loopback is not.
  if (headers.origin !== undefined && !isAllowedOrigin(headers.origin)) {
    return {
      status: 403,
      code: 'forbidden',
      message: 'Cross-origin requests are not accepted by this API.',
      detail: `origin ${String(headers.origin).slice(0, 80)}`,
    };
  }

  return null;
}

// The Host values the MCP SDK's own DNS-rebinding protection should accept.
// The SDK compares the raw header against this list with an exact string match,
// so only the canonical spellings are listed; anything more exotic is still
// caught (and allowed, or not) by checkRequest above, which runs first.
function allowedHostList(host, port) {
  const names = new Set(['127.0.0.1', 'localhost', '[::1]']);
  if (host && isLoopbackHostName(host)) names.add(host.includes(':') ? `[${host}]` : host);
  return [...names].map((n) => `${n}:${port}`);
}

function allowedOriginList(host, port) {
  return allowedHostList(host, port).flatMap((h) => [`http://${h}`, `https://${h}`]);
}

module.exports = {
  checkRequest,
  isLoopbackAddress,
  isLoopbackHostName,
  isAllowedHost,
  isAllowedOrigin,
  isJsonContentType,
  parseHostHeader,
  allowedHostList,
  allowedOriginList,
};

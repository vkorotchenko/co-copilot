'use strict';

const { SessionError } = require('../sessions/registry');
const { SPECIES } = require('../sessions/species');
const { THEMES, validatePalette } = require('../sessions/palettes');
const { validateSummary } = require('../sessions/summary');
const { checkRequest, isLoopbackAddress, isJsonContentType } = require('./guard');
const log = require('../util/log');

// Plain-HTTP mirror of the session/notify surface, served by the *same*
// localhost listener as the MCP endpoint (default 127.0.0.1:4317).
//
// Why: not every reporter can speak MCP. A shell script, a git hook, a CI step
// or a non-Copilot agent should still be able to say "I'm working" with a
// single curl. Routing them through the existing bridge process — rather than a
// second daemon — keeps exactly one owner of the BLE link and one registry.
//
//   GET  /healthz            -> liveness + device/session summary
//   POST /v1/session/begin   -> { label, cwd?, conversation_id?, ttl_seconds? } -> session
//   POST /v1/session/configure -> { session_id, pal?, theme?, colors?, summary? }
//   POST /v1/state           -> { session_id, state, message?, ttl_seconds? }
//   POST /v1/task/complete   -> { session_id, outcome? }
//   POST /v1/session/end     -> { session_id, outcome?, message? }
//   POST /v1/notify          -> { message }
//
// There is deliberately no plain-HTTP confirm endpoint: confirm() blocks for up
// to ten minutes waiting on a physical button, and holding a bare HTTP socket
// open that long invites proxy/keepalive truncation and silent double-asks.
// MCP's companion_confirm already carries those semantics correctly.
//
// Everything here is size-bounded and gated by ./guard: loopback peer, loopback
// Host on the port we actually listen on, loopback-or-absent Origin, and
// `Content-Type: application/json` on every mutating route. No CORS headers are
// emitted, by design — there is no legitimate browser client for this API.

const MAX_BODY_BYTES = 64 * 1024;
const API_PREFIX = '/v1/';
// How long we keep draining a body we have already refused before tearing the
// socket down. Long enough for a client that is mid-upload to finish writing
// and read our 413; short enough that a slow-loris can't hold the socket open.
const DRAIN_GRACE_MS = 1000;

function sendJson(res, status, payload, { close = false } = {}) {
  const body = JSON.stringify(payload);
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  };
  // Signal that we are not reading the rest of this request, so the client
  // doesn't try to reuse the connection for a follow-up.
  if (close) headers.connection = 'close';
  res.writeHead(status, headers);
  res.end(body);
}

function sendError(res, status, code, message, opts) {
  sendJson(res, status, { error: code, message }, opts);
}

// Abandon the remainder of a request body we have already refused.
//
// Destroying the socket up front (the obvious move) makes the peer observe an
// ECONNRESET *instead of* our response: the RST discards whatever the kernel
// had buffered, so a caller that sent an oversized body gets a connection error
// rather than the documented 413 JSON. Instead: respond first, then resume the
// stream to discard (not buffer) whatever is still in flight, and only tear the
// socket down once the client is done or the grace window lapses.
function discardBody(req, res, graceMs = DRAIN_GRACE_MS) {
  const start = () => {
    if (req.readableEnded || req.destroyed) return;
    const timer = setTimeout(() => {
      if (!req.destroyed) req.destroy();
    }, graceMs);
    if (timer.unref) timer.unref();
    const stop = () => clearTimeout(timer);
    req.once('end', stop);
    req.once('error', stop);
    req.once('aborted', stop);
    req.resume(); // flowing mode with no 'data' listener == discard
  };
  if (res.writableFinished) start();
  else res.once('finish', start);
}

// Read a bounded JSON body. Rejects with a coded error rather than throwing raw
// parse noise at the caller. Errors carry `incomplete: true` when the body was
// refused mid-stream, so the caller knows to answer *then* drain.
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let chunks = [];
    let done = false;
    const fail = (status, code, message, incomplete) => {
      if (done) return;
      done = true;
      chunks = []; // release the partial body immediately
      const err = new Error(message);
      err.status = status;
      err.code = code;
      err.incomplete = !!incomplete;
      // Stop taking bytes off the socket, but leave it intact so the response
      // we are about to send can actually reach the caller.
      if (incomplete) req.pause();
      reject(err);
    };
    req.on('data', (c) => {
      if (done) return;
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        fail(413, 'payload_too_large', `Request body exceeds ${MAX_BODY_BYTES} bytes.`, true);
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          const err = new Error('Request body must be a JSON object.');
          err.status = 400;
          err.code = 'invalid_body';
          return reject(err);
        }
        resolve(parsed);
      } catch {
        const err = new Error('Request body is not valid JSON.');
        err.status = 400;
        err.code = 'invalid_body';
        reject(err);
      }
    });
    req.on('error', (e) => fail(400, 'read_error', e.message, false));
  });
}

function invalidArgument(message) {
  const err = new Error(message);
  err.status = 400;
  err.code = 'invalid_argument';
  return err;
}

function requireString(body, field) {
  const value = body[field];
  if (typeof value !== 'string' || !value.trim()) {
    throw invalidArgument(`${field} is required and must be a non-empty string.`);
  }
  return value;
}

function validateNullableEnum(body, field, values) {
  if (!Object.prototype.hasOwnProperty.call(body, field)) return undefined;
  const value = body[field];
  if (value === null) return null;
  if (typeof value !== 'string' || !values.includes(value)) {
    throw invalidArgument(`${field} must be one of: ${values.join(', ')}, or null.`);
  }
  return value;
}

function validateConfigureColors(body) {
  if (!Object.prototype.hasOwnProperty.call(body, 'colors')) return undefined;
  const colors = body.colors;
  if (colors === null) return null;
  if (!colors || typeof colors !== 'object' || Array.isArray(colors)) {
    throw invalidArgument('colors must be a non-null JSON object or null.');
  }

  const wireKeys = ['body', 'bg', 'text', 'text_dim', 'ink'];
  const missing = wireKeys.filter((key) => !Object.prototype.hasOwnProperty.call(colors, key));
  if (missing.length) {
    throw invalidArgument(`Palette is missing required key(s): ${missing.join(', ')}.`);
  }
  const unknown = Object.keys(colors).filter((key) => !wireKeys.includes(key));
  if (unknown.length) {
    throw invalidArgument(`Palette has unknown key(s): ${unknown.join(', ')}.`);
  }

  const internal = {
    body: colors.body,
    bg: colors.bg,
    text: colors.text,
    textDim: colors.text_dim,
    ink: colors.ink,
  };
  const result = validatePalette(internal);
  if (!result.ok) throw invalidArgument(result.reason);
  return internal;
}

function validateConfigureSummary(body) {
  if (!Object.prototype.hasOwnProperty.call(body, 'summary')) return undefined;
  const summary = body.summary;
  if (summary === null) return null;
  const result = validateSummary(summary);
  if (!result.ok) throw invalidArgument(result.reason);
  return result.value;
}

// Map a registry/validation error onto an HTTP status.
function statusForError(err) {
  if (err.status) return err.status;
  if (err instanceof SessionError) {
    return err.code === 'unknown_session' ? 404 : 400;
  }
  return 500;
}

const ROUTES = {
  'GET /healthz': (_body, bridge) => {
    const sessions = bridge.registry.list();
    const live = sessions.filter((record) => record.state !== 'ended');
    return {
      ok: true,
      device_connected: bridge.connected,
      sessions: bridge.registry.size,
      pending_confirmations: bridge.pendingConfirmations,
      default_ttl_seconds: Math.round(bridge.registry.defaultTtlMs / 1000),
      projection_schema_version: 1,
      projection_max_sessions: bridge.deviceProjectionMax,
      live_sessions: live.length,
      species_in_use: [...new Set(live.map((record) => record.pal_id))].sort(),
      usage_tracking: bridge.usageStatus,
    };
  },

  'POST /v1/session/begin': (body, bridge) => {
    requireString(body, 'label');
    return bridge.beginSession({
      label: body.label,
      cwd: body.cwd,
      conversationId: body.conversation_id,
      // `source` is a provenance tag, not caller input: it is how an operator
      // reading companion_status tells an HTTP reporter from an MCP one. A
      // caller-supplied value would let anything mislabel itself as `mcp`, so
      // the transport stamps it and any body field is ignored.
      source: 'http',
      ttlSeconds: body.ttl_seconds,
    });
  },

  'POST /v1/session/configure': (body, bridge) => {
    requireString(body, 'session_id');

    // JSON has no undefined value, so own-property checks are the reliable
    // boundary between "omitted" (leave unchanged) and explicit null (reset).
    // Do this before building the registry arguments; truthiness checks would
    // collapse those two API meanings and make resets impossible.
    const has = (field) => Object.prototype.hasOwnProperty.call(body, field);
    if (!['pal', 'theme', 'colors', 'summary'].some(has)) {
      throw invalidArgument('At least one of pal, theme, colors, or summary must be provided.');
    }

    const args = { id: body.session_id };
    if (has('pal')) args.palId = validateNullableEnum(body, 'pal', SPECIES);
    if (has('theme')) args.themeId = validateNullableEnum(body, 'theme', THEMES);
    if (has('colors')) args.colors = validateConfigureColors(body);
    if (has('summary')) args.summary = validateConfigureSummary(body);
    return bridge.configureSession(args);
  },

  'POST /v1/state': (body, bridge) => {
    requireString(body, 'session_id');
    requireString(body, 'state');
    return bridge.updateSession({
      id: body.session_id,
      state: body.state,
      message: body.message,
      ttlSeconds: body.ttl_seconds,
    });
  },

  'POST /v1/task/complete': (body, bridge) => {
    requireString(body, 'session_id');
    return bridge.completeTask({
      id: body.session_id,
      outcome: body.outcome,
    });
  },

  'POST /v1/session/end': (body, bridge) => {
    requireString(body, 'session_id');
    return bridge.endSession({
      id: body.session_id,
      outcome: body.outcome,
      message: body.message,
    });
  },

  'POST /v1/notify': (body, bridge) => {
    requireString(body, 'message');
    const delivered = bridge.notify(body.message);
    return { delivered, message: body.message };
  },
};

// Returns true when this module owns the request (and has answered it), false
// when the caller should fall through to its own routing (e.g. /mcp).
//
// Gate order matters: every rejection below happens before a single body byte
// is read, so a refused request can never reach the registry. Content-Type is
// checked after routing only so that a wrong *verb* still reports 405 rather
// than a misleading 415 — neither path mutates anything.
function handleApiRequest(req, res, bridge, { port } = {}) {
  const path = (req.url || '').split('?')[0];
  const owned = path === '/healthz' || path.startsWith(API_PREFIX);
  if (!owned) return false;

  const denied = checkRequest(req, { port });
  if (denied) {
    log.debug(`HTTP ${path} -> 403 ${denied.code}: ${denied.detail}`);
    sendError(res, denied.status, denied.code, denied.message);
    return true;
  }

  const route = ROUTES[`${req.method} ${path}`];
  if (!route) {
    // Distinguish "wrong verb on a real route" from "no such route" so callers
    // get an actionable error instead of a blanket 404.
    const pathExists = Object.keys(ROUTES).some((k) => k.endsWith(` ${path}`));
    if (pathExists) sendError(res, 405, 'method_not_allowed', `${req.method} is not allowed on ${path}.`);
    else sendError(res, 404, 'not_found', `No such endpoint: ${path}`);
    return true;
  }

  if (req.method === 'POST' && !isJsonContentType(req.headers && req.headers['content-type'])) {
    sendError(
      res,
      415,
      'unsupported_media_type',
      'Content-Type must be application/json (charset parameters are allowed).'
    );
    return true;
  }

  const bodyPromise = req.method === 'POST' ? readJsonBody(req) : Promise.resolve({});
  bodyPromise
    .then((body) => sendJson(res, 200, route(body, bridge)))
    .catch((err) => {
      const status = statusForError(err);
      if (status >= 500) log.error(`HTTP ${path} failed:`, err.stack || err.message);
      else log.debug(`HTTP ${path} -> ${status} ${err.code || 'error'}: ${err.message}`);
      if (!res.headersSent) {
        sendError(res, status, err.code || 'internal_error', err.message || 'Request failed.', {
          close: err.incomplete,
        });
      }
      // The body was refused mid-stream: answer first (above), then drain and
      // release the socket so the caller actually receives the status.
      if (err.incomplete) discardBody(req, res);
    });
  return true;
}

module.exports = { handleApiRequest, isLoopbackAddress, MAX_BODY_BYTES, DRAIN_GRACE_MS };

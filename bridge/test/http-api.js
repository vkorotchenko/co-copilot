'use strict';

// End-to-end tests for the plain-HTTP mirror served on the same localhost
// listener as the MCP endpoint (/healthz + /v1/*), so non-MCP callers (shell
// scripts, hooks, CI steps) can report session state with a single request.
//
// Run: node test/http-api.js   (exits non-zero on failure)

const assert = require('assert');
const http = require('http');

const PORT = 4398;
process.env.COMPANION_MCP_PORT = String(PORT);
process.env.COMPANION_LOG = process.env.COMPANION_LOG || 'error';

const cfg = require('../src/config');
const { Bridge } = require('../src/bridge');
const { FakeDeviceTransport } = require('../src/transport/fakeDevice');
const { CompanionMcpServer } = require('../src/mcp/server');
const { handleApiRequest, isLoopbackAddress, MAX_BODY_BYTES } = require('../src/http/api');
const { isAllowedHost, isAllowedOrigin, isJsonContentType } = require('../src/http/guard');

// `headers` merges over the defaults; a header set to null is omitted entirely
// (so a request with no Content-Type at all can be exercised).
function request(method, path, body, { rawBody, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload =
      rawBody !== undefined ? rawBody : body === undefined ? null : JSON.stringify(body);
    const base = payload
      ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
      : {};
    const merged = Object.assign(base, headers);
    for (const [k, v] of Object.entries(merged)) if (v === null) delete merged[k];
    const req = http.request(
      {
        host: '127.0.0.1',
        port: PORT,
        path,
        method,
        headers: merged,
      },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(data); } catch { /* non-JSON body */ }
          resolve({ status: res.statusCode, headers: res.headers, json, raw: data });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function withRig(fn) {
  const transport = new FakeDeviceTransport({ autoAnswer: false });
  const bridge = new Bridge(transport, cfg);
  const mcp = new CompanionMcpServer(bridge, cfg);
  await mcp.start();
  bridge.start();
  transport.start();
  await new Promise((r) => setTimeout(r, 30));
  bridge.setModel({ total: 0, running: 0, waiting: 0, msg: 'idle', entries: [] });
  try {
    await fn(bridge, transport);
  } finally {
    bridge.stop();
    await mcp.stop();
    await transport.stop();
  }
}

async function testHealth() {
  await withRig(async () => {
    const res = await request('GET', '/healthz');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.json.ok, true);
    assert.strictEqual(res.json.device_connected, true);
    assert.strictEqual(res.json.sessions, 0);
    assert.strictEqual(res.json.pending_confirmations, 0);
    assert.strictEqual(typeof res.json.default_ttl_seconds, 'number');
    assert.strictEqual(res.json.projection_schema_version, 1);
    assert.strictEqual(res.json.projection_max_sessions, 8);
    assert.strictEqual(res.json.live_sessions, 0);
    assert.deepStrictEqual(res.json.species_in_use, []);
    assert.deepStrictEqual(res.json.usage_tracking, {
      available: false,
      experimental: true,
      source: 'assistant_usage_events',
      tracked_sessions: 0,
    });
  });
}

async function testLifecycle() {
  await withRig(async (bridge, transport) => {
    const begun = await request('POST', '/v1/session/begin', {
      label: 'nightly build',
      cwd: '/srv/app',
      conversation_id: 'http-conversation-1',
      ttl_seconds: 30,
    });
    assert.strictEqual(begun.status, 200);
    const id = begun.json.session_id;
    assert.ok(id, 'begin returns a session_id');
    assert.strictEqual(begun.json.state, 'working');
    assert.strictEqual(begun.json.source, 'http', 'HTTP callers are tagged as such');
    assert.strictEqual(begun.json.conversation_id, 'http-conversation-1');
    assert.strictEqual(begun.json.expires_in_seconds, 30);

    const retried = await request('POST', '/v1/session/begin', {
      label: 'retry',
      cwd: '/different',
      conversation_id: 'http-conversation-1',
      ttl_seconds: 60,
    });
    assert.strictEqual(retried.status, 200);
    assert.strictEqual(retried.json.session_id, id, 'same HTTP conversation reuses one pal');
    assert.strictEqual(retried.json.label, 'nightly build', 'retry preserves record identity');
    assert.strictEqual(retried.json.expires_in_seconds, 60, 'retry refreshes the lease');
    assert.strictEqual(bridge.registry.size, 1);

    const state = await request('POST', '/v1/state', {
      session_id: id,
      state: 'blocked',
      message: 'waiting on review',
    });
    assert.strictEqual(state.status, 200);
    assert.strictEqual(state.json.state, 'blocked');

    // The explicit state reaches the device snapshot.
    assert.strictEqual(bridge.status.waiting, 1, 'blocked session counts as waiting');
    assert.strictEqual(bridge.status.msg, 'waiting on review');

    const health = await request('GET', '/healthz');
    assert.strictEqual(health.json.sessions, 1);

    const completed = await request('POST', '/v1/task/complete', {
      session_id: id,
      outcome: 'failed',
    });
    assert.strictEqual(completed.status, 200);
    assert.strictEqual(completed.json.state, 'idle');
    assert.strictEqual(completed.json.task_outcome, 'failed');
    assert.strictEqual(bridge.registry.get(id).state, 'idle',
      'task completion keeps the session and pal registered');
    assert.ok(bridge.completionLatch.current, 'task completion creates the animation latch');
    assert.strictEqual(bridge.status.waiting, 0, 'completed task no longer counts as waiting');

    await request('POST', '/v1/state', {
      session_id: id,
      state: 'working',
      message: 'next request',
    });
    assert.strictEqual(bridge.completionLatch.current, null,
      'starting the next task clears the previous completion');

    const ended = await request('POST', '/v1/session/end', {
      session_id: id,
      outcome: 'failed',
      message: 'build broke',
    });
    assert.strictEqual(ended.status, 200);
    assert.strictEqual(ended.json.outcome, 'failed');
    assert.strictEqual(ended.json.closing_message, 'build broke');
    assert.strictEqual(bridge.status.waiting, 0, 'an ended session stops counting immediately');
    assert.strictEqual(bridge.status.msg, 'build broke', 'the closing message is flashed');
    assert.strictEqual(bridge.completionLatch.current, null,
      'retiring a conversation does not create a completion animation');
    assert.ok(transport.sent.length > 0);
  });
}

// Ending over HTTP without a closing message must fall straight back, and must
// not bury another session that is still blocked on the human.
async function testEndWithoutMessageOverHttp() {
  await withRig(async (bridge) => {
    const worker = (await request('POST', '/v1/session/begin', { label: 'worker' })).json;
    const reviewer = (await request('POST', '/v1/session/begin', { label: 'reviewer' })).json;
    await request('POST', '/v1/state', {
      session_id: worker.session_id,
      state: 'working',
      message: 'compiling',
    });
    await request('POST', '/v1/state', {
      session_id: reviewer.session_id,
      state: 'blocked',
      message: 'need a decision',
    });
    assert.strictEqual(bridge.status.msg, 'need a decision');

    const ended = await request('POST', '/v1/session/end', { session_id: worker.session_id });
    assert.strictEqual(ended.status, 200);
    assert.strictEqual(ended.json.closing_message, null, 'no message supplied -> none reported');
    assert.strictEqual(
      bridge.status.msg,
      'need a decision',
      'a silent end must not re-flash "compiling" over the blocked session'
    );

    // The last live session ends silently: straight back to passive state.
    await request('POST', '/v1/session/end', { session_id: reviewer.session_id });
    assert.strictEqual(bridge.status.msg, 'idle', 'no sessions left -> passive state');
    assert.strictEqual(bridge.status.waiting, 0);
  });
}

async function testConfigure() {
  await withRig(async (bridge) => {
    let now = Date.now();
    bridge.registry._now = () => now;

    const first = (await request('POST', '/v1/session/begin', {
      label: 'first',
      ttl_seconds: 5,
    })).json;
    const second = (await request('POST', '/v1/session/begin', {
      label: 'second',
      source: 'spoofed',
      ttl_seconds: 5,
    })).json;
    const originalExpiry = second.expires_at;

    now += 4000;
    const configured = await request('POST', '/v1/session/configure', {
      session_id: second.session_id,
      pal: first.pal_id,
      theme: 'cyan',
      colors: { body: 0x45cb, bg: 0, text: 0xffff, text_dim: 0x8410, ink: 0 },
      summary: '  reviewing   HTTP  ',
      source: 'mcp',
    });
    assert.strictEqual(configured.status, 200);
    assert.strictEqual(configured.json.pal_id, first.pal_id, 'explicit duplicate pal is accepted');
    assert.strictEqual(configured.json.theme_id, 'cyan');
    assert.strictEqual(configured.json.palette.body, 0x45cb);
    assert.strictEqual(configured.json.summary, 'reviewing HTTP');
    assert.strictEqual(configured.json.source, 'http', 'configure cannot spoof source');
    assert.strictEqual(configured.json.expires_at, originalExpiry, 'configure does not renew TTL');
    assert.ok(
      !Object.keys(configured.headers).some((h) => h.startsWith('access-control-')),
      'the configure route emits no CORS headers'
    );

    const reset = await request('POST', '/v1/session/configure', {
      session_id: second.session_id,
      pal: null,
      theme: null,
      colors: null,
      summary: null,
    });
    assert.strictEqual(reset.status, 200);
    assert.strictEqual(reset.json.theme_id, 'classic');
    assert.strictEqual(reset.json.summary, second.label);

    now += 1001;
    const idle = bridge.registry.get(second.session_id);
    assert.strictEqual(idle.state, 'idle', 'the original active-task lease expires');
    assert.strictEqual(idle.summary, second.label, 'the long-lived conversation remains registered');

    const wrongVerb = await request('GET', '/v1/session/configure');
    assert.strictEqual(wrongVerb.status, 405);
  });
}

// HTTP mirrors the MCP schema decisions: complete nullable fields are accepted,
// while bad enums, partial/out-of-range/non-integer palettes, non-black V1
// backgrounds, oversized summaries, and empty configure requests are refused.
async function testConfigureValidationParity() {
  await withRig(async (bridge) => {
    let missing = await request('POST', '/v1/session/configure', { summary: 'x' });
    assert.strictEqual(missing.status, 400, 'configure requires session_id');
    assert.strictEqual(missing.json.error, 'invalid_argument');
    missing = await request('POST', '/v1/session/configure', {
      session_id: '   ',
      summary: 'x',
    });
    assert.strictEqual(missing.status, 400);
    assert.strictEqual(missing.json.error, 'invalid_argument');
    missing = await request('POST', '/v1/session/configure', {
      session_id: 'cs-does-not-exist',
      summary: 'x',
    });
    assert.strictEqual(missing.status, 404, 'unknown configure session is coded consistently');
    assert.strictEqual(missing.json.error, 'unknown_session');

    const begun = (await request('POST', '/v1/session/begin', { label: 'parity' })).json;
    const emoji96 = '😀'.repeat(96);
    const valid = [
      { pal: 'owl' },
      { theme: 'green' },
      { colors: { body: 0x45cb, bg: 0, text: 0xffff, text_dim: 0x8410, ink: 0 } },
      { summary: 'short phrase' },
      { summary: emoji96 },
      { summary: 'left\ud800right' },
      { pal: null, theme: null, colors: null, summary: null },
    ];
    for (const fields of valid) {
      const res = await request('POST', '/v1/session/configure', {
        session_id: begun.session_id,
        ...fields,
      });
      assert.strictEqual(res.status, 200, `valid configure rejected: ${JSON.stringify(fields)}`);
      if (fields.summary === emoji96) assert.strictEqual(res.json.summary, emoji96);
      if (fields.summary === 'left\ud800right') {
        assert.strictEqual(res.json.summary, 'left\ufffdright');
        const line = JSON.stringify(bridge.status) + '\n';
        assert.strictEqual(Buffer.from(line, 'utf8').toString('utf8'), line);
      }
    }

    const invalid = [
      {},
      { pal: 'horse' },
      { theme: 'blue' },
      { colors: { body: 0x45cb } },
      { colors: { body: 65536, bg: 0, text: 0xffff, text_dim: 0x8410, ink: 0 } },
      { colors: { body: 1.5, bg: 0, text: 0xffff, text_dim: 0x8410, ink: 0 } },
      { colors: { body: 0x45cb, bg: 1, text: 0xffff, text_dim: 0x8410, ink: 0 } },
      { summary: 'x'.repeat(97) },
    ];
    for (const fields of invalid) {
      const res = await request('POST', '/v1/session/configure', {
        session_id: begun.session_id,
        ...fields,
      });
      assert.strictEqual(res.status, 400, `invalid configure accepted: ${JSON.stringify(fields)}`);
      assert.strictEqual(res.json.error, 'invalid_argument');
    }
  });
}

// The /v1 prefix is already the route allowlist: checkRequest and Content-Type
// run before routing/body collection, so the new path inherits every existing
// hardening layer without a second list that could drift.
async function testConfigureSecurityGate() {
  await withRig(async (bridge) => {
    const begun = (await request('POST', '/v1/session/begin', { label: 'guarded' })).json;
    const before = bridge.registry.get(begun.session_id);
    const body = { session_id: begun.session_id, summary: 'must not apply' };

    let res = await request('POST', '/v1/session/configure', body, { headers: { host: 'evil.com' } });
    assert.strictEqual(res.status, 403, 'bad Host is refused on configure');
    res = await request('POST', '/v1/session/configure', body, {
      headers: { origin: 'https://evil.com' },
    });
    assert.strictEqual(res.status, 403, 'bad Origin is refused on configure');
    res = await handleAsPeer('POST', '/v1/session/configure', '203.0.113.7');
    assert.strictEqual(res.status, 403, 'non-loopback peer is refused on configure');

    for (const contentType of [null, 'text/plain']) {
      res = await request('POST', '/v1/session/configure', undefined, {
        rawBody: JSON.stringify(body),
        headers: { 'content-type': contentType },
      });
      assert.strictEqual(res.status, 415, 'configure requires application/json');
    }

    const huge = JSON.stringify({
      session_id: begun.session_id,
      summary: 'x',
      padding: 'y'.repeat(MAX_BODY_BYTES + 1024),
    });
    res = await request('POST', '/v1/session/configure', undefined, { rawBody: huge });
    assert.strictEqual(res.status, 413, 'configure retains the 64 KB body limit');
    assert.strictEqual(
      bridge.registry.get(begun.session_id).summary,
      before.summary,
      'every refused request is rejected before mutation'
    );
  });
}

async function testNotify() {
  await withRig(async (bridge) => {
    const res = await request('POST', '/v1/notify', { message: 'tests green' });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.json.delivered, true);
    assert.strictEqual(bridge.status.msg, 'tests green');
  });
}

async function testValidation() {
  await withRig(async (bridge) => {
    // Missing required fields.
    let res = await request('POST', '/v1/session/begin', { cwd: '/tmp' });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.json.error, 'invalid_argument');

    for (const conversation_id of ['', '   ', 'x'.repeat(129), 42]) {
      res = await request('POST', '/v1/session/begin', {
        label: 'bad conversation',
        conversation_id,
      });
      assert.strictEqual(res.status, 400, `invalid conversation_id accepted: ${conversation_id}`);
      assert.strictEqual(res.json.error, 'invalid_argument');
    }

    res = await request('POST', '/v1/state', { state: 'working' });
    assert.strictEqual(res.status, 400, 'state without a session_id is rejected');

    res = await request('POST', '/v1/notify', {});
    assert.strictEqual(res.status, 400);

    // Unknown / expired session.
    res = await request('POST', '/v1/state', { session_id: 'cs-does-not-exist', state: 'working' });
    assert.strictEqual(res.status, 404, 'unknown session -> 404');
    assert.strictEqual(res.json.error, 'unknown_session');

    res = await request('POST', '/v1/session/end', { session_id: 'cs-does-not-exist' });
    assert.strictEqual(res.status, 404);
    res = await request('POST', '/v1/task/complete', { session_id: 'cs-does-not-exist' });
    assert.strictEqual(res.status, 404);

    // Bad state value on a real session.
    const begun = await request('POST', '/v1/session/begin', { label: 'validate' });
    res = await request('POST', '/v1/state', {
      session_id: begun.json.session_id,
      state: 'napping',
    });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.json.error, 'invalid_argument');

    res = await request('POST', '/v1/task/complete', {
      session_id: begun.json.session_id,
      outcome: 'maybe',
    });
    assert.strictEqual(res.status, 400, 'invalid task outcome is rejected');
    assert.strictEqual(res.json.error, 'invalid_argument');
    assert.strictEqual(
      bridge.registry.get(begun.json.session_id).state,
      'working',
      'invalid task completion does not mutate the active task'
    );

    await request('POST', '/v1/state', {
      session_id: begun.json.session_id,
      state: 'idle',
    });
    res = await request('POST', '/v1/task/complete', {
      session_id: begun.json.session_id,
      outcome: 'success',
    });
    assert.strictEqual(res.status, 400, 'an idle session has no task to complete');
    assert.strictEqual(res.json.error, 'invalid_argument');

    // Malformed bodies.
    res = await request('POST', '/v1/notify', undefined, { rawBody: '{not json' });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.json.error, 'invalid_body');

    res = await request('POST', '/v1/notify', undefined, { rawBody: '["nope"]' });
    assert.strictEqual(res.status, 400, 'a JSON array is not an acceptable body');

    // Routing errors.
    res = await request('GET', '/v1/state');
    assert.strictEqual(res.status, 405, 'wrong verb on a real route -> 405');
    res = await request('POST', '/v1/nope', {});
    assert.strictEqual(res.status, 404);
    assert.strictEqual(res.json.error, 'not_found');
  });
}

// An oversized body must be answered, not just cut off. Destroying the socket
// before the response is flushed makes the caller observe ECONNRESET instead of
// the documented 413, so a reset is a failure here, not an acceptable outcome.
async function testBodyLimit() {
  await withRig(async (bridge) => {
    const huge = JSON.stringify({ label: 'x'.repeat(MAX_BODY_BYTES + 1024) });
    const res = await request('POST', '/v1/session/begin', undefined, { rawBody: huge });
    assert.strictEqual(res.status, 413, `oversized body must return 413, got ${res.status}`);
    assert.strictEqual(res.json.error, 'payload_too_large');
    assert.match(res.json.message, /exceeds \d+ bytes/, 'the limit is stated in the error');
    assert.strictEqual(bridge.registry.size, 0, 'a refused body creates no session');

    // A body right at the cap is still accepted, so the limit is a bound and
    // not an off-by-one that rejects legal requests.
    const pad = 'y'.repeat(MAX_BODY_BYTES - JSON.stringify({ label: '' }).length);
    const atLimit = JSON.stringify({ label: pad });
    assert.strictEqual(Buffer.byteLength(atLimit), MAX_BODY_BYTES);
    const ok = await request('POST', '/v1/session/begin', undefined, { rawBody: atLimit });
    assert.strictEqual(ok.status, 200, 'a body exactly at the cap should be accepted');

    // The listener survives a refused body and keeps serving.
    const health = await request('GET', '/healthz');
    assert.strictEqual(health.status, 200, 'the server still serves after a 413');
  });
}

// The API is loopback-only. Node hands us the peer address in several different
// spellings depending on the socket family, and all of them have to be
// classified correctly — a miss either locks out a legitimate local caller or
// exposes the session/notify surface to the network.
function testLoopbackClassification() {
  const loopback = [
    '127.0.0.1',
    '127.0.0.53', // systemd-resolved stub, still 127.0.0.0/8
    '127.1.2.3',
    '::1',
    '::1%lo0', // scoped IPv6 loopback
    '0:0:0:0:0:0:0:1', // expanded ::1
    '::ffff:127.0.0.1', // IPv4-mapped IPv6
    '::FFFF:127.0.0.1', // ...case-insensitively
    '::ffff:127.9.9.9',
    '[::1]', // bracketed form
  ];
  const remote = [
    '10.0.0.5',
    '192.168.1.20',
    '172.16.0.1',
    '0.0.0.0',
    '128.0.0.1', // adjacent to the loopback block, but outside it
    '27.0.0.1', // 127.x with the leading digit shorn off
    '::ffff:10.0.0.5', // mapped, but not a loopback IPv4
    '::ffff:192.168.0.9',
    'fe80::1', // link-local, not loopback
    'fe80::1%en0',
    '2001:db8::1',
    '::',
    '127.0.0.1.example.com', // prefix-match bait
    '127.0.0.1evil',
    '',
    null,
    undefined,
  ];

  for (const addr of loopback) {
    assert.strictEqual(isLoopbackAddress(addr), true, `${addr} should be treated as loopback`);
  }
  for (const addr of remote) {
    assert.strictEqual(
      isLoopbackAddress(addr),
      false,
      `${String(addr)} must NOT be treated as loopback`
    );
  }
}

// Minimal req/res doubles so the transport gate can be exercised with an
// arbitrary peer address; binding a routable interface in a unit test is
// neither portable nor safe.
//
// `bridge` defaults to null on purpose: every case these doubles cover is
// rejected by the gate *before* a route body runs, so a null bridge here is an
// assertion in itself — if the handler ever touched it, this would throw rather
// than quietly pass. Production always supplies a real bridge.
function handleAsPeer(method, path, remoteAddress, bridge = null, headers = {}) {
  return new Promise((resolve) => {
    const req = {
      method,
      url: path,
      headers: Object.assign({ host: `127.0.0.1:${PORT}` }, headers),
      socket: { remoteAddress },
      on() {},
      once() {},
    };
    let status = 0;
    const res = {
      headersSent: false,
      writableFinished: false,
      writeHead(code) {
        status = code;
        this.headersSent = true;
      },
      end(body) {
        this.writableFinished = true;
        let json = null;
        try {
          json = JSON.parse(body || '');
        } catch {
          /* non-JSON body */
        }
        resolve({ status, json, raw: body || '' });
      },
      on() {},
      once() {},
    };
    const owned = handleApiRequest(req, res, bridge, { port: PORT });
    assert.strictEqual(owned, true, `${path} should be owned by the API handler`);
  });
}

// ...and the classification is actually enforced on a request, for every route
// the module owns (a 403 must beat routing, validation and body parsing).
async function testLoopbackEnforcement() {
  await withRig(async (bridge) => {
    const ok = await request('GET', '/healthz');
    assert.strictEqual(ok.status, 200, 'a genuine loopback caller is served');

    for (const path of ['/healthz', '/v1/notify', '/v1/session/begin', '/v1/state', '/v1/nope']) {
      const res = await handleAsPeer('POST', path, '203.0.113.7');
      assert.strictEqual(res.status, 403, `${path} must be refused for a remote peer`);
      assert.strictEqual(res.json.error, 'forbidden');
    }

    // The same route is reachable for each accepted loopback spelling.
    for (const addr of ['127.0.0.1', '127.0.0.53', '::1', '::ffff:127.0.0.1', '::1%lo0']) {
      const res = await handleAsPeer('GET', '/healthz', addr, bridge);
      assert.strictEqual(res.status, 200, `${addr} must be served, got ${res.status}`);
      assert.strictEqual(res.json.ok, true);
    }
  });
}

// --- transport gate ---------------------------------------------------------
//
// The mirror mutates bridge state on a bare POST, so a browser on this machine
// is inside the peer-address fence: a page on any site can make the browser
// POST to 127.0.0.1, and a DNS-rebound hostname resolves to 127.0.0.1 too. The
// checks below are what close that off, and every one of them has to land
// *before* the registry is touched — a 403/415 that still created a session
// would be no defence at all.

// Content-Type is the load-bearing anti-CSRF check: form-urlencoded,
// multipart and text/plain are the only types a browser may send cross-origin
// without a preflight, and we answer no preflight. Requiring application/json
// therefore makes a cross-origin mutation unreachable.
async function testContentTypeGate() {
  await withRig(async (bridge) => {
    const body = JSON.stringify({ label: 'should never exist' });

    const refused = [
      ['text/plain', 'text/plain;charset=UTF-8'],
      ['form-urlencoded', 'application/x-www-form-urlencoded'],
      ['multipart', 'multipart/form-data; boundary=x'],
      ['json-ish suffix', 'application/vnd.api+json'],
      ['prefix bait', 'application/json-patch'],
      ['empty', ''],
      ['absent', null],
    ];

    for (const [what, value] of refused) {
      const res = await request('POST', '/v1/session/begin', undefined, {
        rawBody: body,
        headers: { 'content-type': value },
      });
      assert.strictEqual(res.status, 415, `${what} content-type must be refused, got ${res.status}`);
      assert.strictEqual(res.json.error, 'unsupported_media_type');
      assert.strictEqual(bridge.registry.size, 0, `${what}: a refused request must not mutate`);
    }

    // Parameters are normal and must not cause a false rejection.
    for (const value of [
      'application/json',
      'application/json; charset=utf-8',
      'APPLICATION/JSON;CHARSET=UTF-8',
      '  application/json  ',
    ]) {
      const res = await request('POST', '/v1/notify', undefined, {
        rawBody: JSON.stringify({ message: 'ok' }),
        headers: { 'content-type': value },
      });
      assert.strictEqual(res.status, 200, `${value} must be accepted, got ${res.status}`);
    }

    // GET carries no body, so the gate must not apply to it.
    assert.strictEqual((await request('GET', '/healthz')).status, 200);

    // A *large* body refused at the gate is never read, so the listener must
    // still discard it and stay usable — an undrained body would otherwise be
    // parsed as the next request on a keep-alive connection.
    const big = JSON.stringify({ label: 'x'.repeat(200 * 1024) });
    const refusedBig = await request('POST', '/v1/session/begin', undefined, {
      rawBody: big,
      headers: { 'content-type': 'text/plain' },
    });
    assert.strictEqual(refusedBig.status, 415, 'a large non-JSON body is refused at the gate');
    assert.strictEqual(bridge.registry.size, 0, 'and creates nothing');
    assert.strictEqual(
      (await request('POST', '/v1/notify', { message: 'still here' })).status,
      200,
      'the listener still serves after a refused body'
    );
  });
}

// A rebound hostname still arrives on a loopback socket — the Host header is
// the only thing that gives it away.
async function testHostGate() {
  await withRig(async (bridge) => {
    const hostile = [
      'evil.com',
      `evil.com:${PORT}`,
      'localhost.evil.com',
      `localhost.evil.com:${PORT}`,
      `127.0.0.1.evil.com:${PORT}`,
      'attacker.test',
      // Right host, wrong port: the caller believes it is talking to some other
      // local service, which is exactly the rebinding/confusion case.
      `127.0.0.1:${PORT + 1}`,
      'localhost:1',
      'localhost', // no port == port 80, and we are not on 80
      // Malformed / smuggling shapes.
      `user@127.0.0.1:${PORT}`,
      `127.0.0.1:${PORT}, evil.com`,
      `127.0.0.1:${PORT}/x`,
      '::1:4317', // unbracketed IPv6 is ambiguous, not "best effort" parsed
      `127.0.0.1:${PORT}x`,
      '127.0.0.1:',
      ':4317',
      '[::1',
    ];

    for (const host of hostile) {
      const res = await request('POST', '/v1/session/begin', { label: 'pwn' }, {
        headers: { host },
      });
      assert.strictEqual(res.status, 403, `Host "${host}" must be refused, got ${res.status}`);
      assert.strictEqual(res.json.error, 'forbidden');
      assert.strictEqual(bridge.registry.size, 0, `Host "${host}": no session may be created`);
    }

    // An absent or empty Host can't be produced by Node's client (it fills the
    // default in), so it is exercised through the request double instead. HTTP
    // /1.1 requires the header; a request without one is malformed, not a
    // caller we should guess for.
    for (const host of [undefined, '']) {
      const res = await handleAsPeer('POST', '/v1/session/begin', '127.0.0.1', null, { host });
      assert.strictEqual(res.status, 403, `Host ${JSON.stringify(host)} must be refused`);
      assert.strictEqual(res.json.error, 'forbidden');
    }

    // ...and the accepted loopback spellings still work.
    for (const host of [`127.0.0.1:${PORT}`, `localhost:${PORT}`, `LocalHost:${PORT}`,
                        `[::1]:${PORT}`, `127.0.0.53:${PORT}`]) {
      const res = await request('GET', '/healthz', undefined, { headers: { host } });
      assert.strictEqual(res.status, 200, `Host "${host}" should be served, got ${res.status}`);
    }

    // A refused Host is refused on every route the module owns, mutating or not.
    for (const path of ['/healthz', '/v1/notify', '/v1/state', '/v1/nope']) {
      const res = await request('POST', path, { message: 'x' }, { headers: { host: 'evil.com' } });
      assert.strictEqual(res.status, 403, `${path} must refuse a hostile Host`);
    }
    assert.strictEqual(bridge.registry.size, 0);
  });
}

// Origin is belt-and-braces behind the Content-Type gate, and it is what a
// browser attaches whenever the request is cross-origin.
async function testOriginGate() {
  await withRig(async (bridge) => {
    const hostile = [
      'https://evil.com',
      'http://evil.com',
      'http://localhost.evil.com',
      'http://127.0.0.1.evil.com',
      'null', // sandboxed iframe / file:// — not a URL, not trusted
      'file://',
      'chrome-extension://abcdef',
      'data:text/html,x',
      'http://user:pass@localhost',
      'http://localhost/path', // an origin has no path
      'not a url',
      '',
    ];

    for (const origin of hostile) {
      const res = await request('POST', '/v1/session/begin', { label: 'pwn' }, {
        headers: { origin },
      });
      assert.strictEqual(res.status, 403, `Origin "${origin}" must be refused, got ${res.status}`);
      assert.strictEqual(res.json.error, 'forbidden');
      assert.strictEqual(bridge.registry.size, 0, `Origin "${origin}": no session may be created`);
    }

    // Loopback origins are fine, on any port — a local dev server calling the
    // bridge is a legitimate caller. So is no Origin at all (every CLI client).
    for (const origin of [
      'http://localhost',
      `http://localhost:${PORT}`,
      'http://localhost:3000',
      'http://127.0.0.1:8080',
      'http://[::1]:4317',
      'https://localhost:8443',
    ]) {
      const res = await request('POST', '/v1/notify', { message: 'hi' }, { headers: { origin } });
      assert.strictEqual(res.status, 200, `Origin "${origin}" should be served, got ${res.status}`);
    }

    // We must never hand a browser read access to a response.
    const res = await request('GET', '/healthz', undefined, {
      headers: { origin: 'http://localhost:3000' },
    });
    assert.strictEqual(res.status, 200);
    assert.ok(
      !Object.keys(res.headers).some((h) => h.startsWith('access-control-')),
      'no CORS headers may be emitted, for any origin'
    );
  });
}

// `source` is provenance, not caller input: a caller must not be able to pass
// itself off as an MCP reporter (or anything else) over plain HTTP.
async function testSourceIsNotCallerControlled() {
  await withRig(async () => {
    const res = await request('POST', '/v1/session/begin', {
      label: 'liar',
      source: 'mcp',
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.json.source, 'http', 'the transport stamps source, not the body');
  });
}

// Unit-level coverage of the classifiers, so the shapes above are pinned even
// when the HTTP plumbing changes around them.
function testGateClassifiers() {
  const P = 4317;
  for (const host of [`127.0.0.1:${P}`, `localhost:${P}`, `[::1]:${P}`, `127.9.9.9:${P}`,
                      `[0:0:0:0:0:0:0:1]:${P}`, `LOCALHOST:${P}`]) {
    assert.strictEqual(isAllowedHost(host, P), true, `${host} should be an allowed Host`);
  }
  for (const host of ['evil.com', `evil.com:${P}`, `localhost.evil.com:${P}`, `localhost:${P + 1}`,
                      'localhost', `127.0.0.1.evil.com:${P}`, `user@localhost:${P}`,
                      `localhost:${P},evil.com`, '::1:4317', '[::1', '', null, undefined,
                      `localhost:${P}\r\nX: y`]) {
    assert.strictEqual(isAllowedHost(host, P), false, `${String(host)} must NOT be an allowed Host`);
  }

  for (const origin of ['http://localhost', 'http://localhost:3000', 'http://127.0.0.1:4317',
                        'https://127.0.0.53', 'http://[::1]:4317', 'http://localhost/']) {
    assert.strictEqual(isAllowedOrigin(origin), true, `${origin} should be an allowed Origin`);
  }
  for (const origin of ['http://evil.com', 'https://localhost.evil.com', 'null', 'file:///x',
                        'chrome-extension://a', 'http://user:pass@localhost', 'http://localhost/p',
                        'http://localhost?q=1', '', null, undefined, 'http://127.0.0.1.evil.com']) {
    assert.strictEqual(isAllowedOrigin(origin), false, `${String(origin)} must NOT be allowed`);
  }

  for (const ct of ['application/json', 'application/json; charset=utf-8', 'Application/JSON',
                    ' application/json ;charset=us-ascii']) {
    assert.strictEqual(isJsonContentType(ct), true, `${ct} should count as JSON`);
  }
  for (const ct of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data',
                    'application/vnd.api+json', 'application/jsonx', '', null, undefined]) {
    assert.strictEqual(isJsonContentType(ct), false, `${String(ct)} must NOT count as JSON`);
  }
}

async function testMcpEndpointStillRoutes() {
  await withRig(async () => {
    // The mirror must not shadow the MCP endpoint or the 404 fallthrough.
    const res = await request('GET', '/nope');
    assert.strictEqual(res.status, 404, 'unrelated paths still 404 from the MCP handler');
    const mcp = await request('POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'ping' });
    assert.ok(mcp.status < 500, `/mcp should still be served, got ${mcp.status}`);
  });
}

// /mcp reaches the same tools the mirror does (companion_state and friends), so
// it needs the same transport gate. The SDK enforces application/json on POST
// /mcp itself; Host/Origin are ours, applied before the body is read.
async function testMcpEndpointIsGated() {
  await withRig(async (bridge) => {
    for (const headers of [
      { host: 'evil.com' },
      { host: `localhost.evil.com:${PORT}` },
      { host: `127.0.0.1:${PORT + 1}` },
      { origin: 'http://evil.com' },
      { origin: 'null' },
    ]) {
      const res = await request('POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'ping' }, {
        headers,
      });
      assert.strictEqual(
        res.status,
        403,
        `/mcp must refuse ${JSON.stringify(headers)}, got ${res.status}`
      );
      // Answered in the client's own protocol, not a bare body it can't parse.
      assert.strictEqual(res.json && res.json.jsonrpc, '2.0');
      assert.ok(res.json.error && res.json.error.message, 'a JSON-RPC error is returned');
    }
    assert.strictEqual(bridge.registry.size, 0, 'a refused /mcp call reaches no tool');

    // The SDK's own media-type check still stands behind ours.
    const wrongType = await request('POST', '/mcp', undefined, {
      rawBody: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
      headers: { 'content-type': 'text/plain', accept: 'application/json, text/event-stream' },
    });
    assert.strictEqual(wrongType.status, 415, `/mcp must refuse text/plain, got ${wrongType.status}`);

    // A legitimate loopback call is unaffected by any of the above. (The SDK
    // requires both JSON and SSE in Accept; supplying it proves we got past our
    // gate and into real MCP handling rather than stopping at a 403.)
    const ok = await request('POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'ping' }, {
      headers: {
        origin: `http://localhost:${PORT}`,
        accept: 'application/json, text/event-stream',
      },
    });
    assert.ok(ok.status < 400, `a loopback-origin /mcp call should be served, got ${ok.status}`);
  });
}

async function main() {
  await testHealth();
  await testLifecycle();
  await testEndWithoutMessageOverHttp();
  await testConfigure();
  await testConfigureValidationParity();
  await testConfigureSecurityGate();
  await testNotify();
  await testValidation();
  await testBodyLimit();
  testLoopbackClassification();
  await testLoopbackEnforcement();
  testGateClassifiers();
  await testContentTypeGate();
  await testHostGate();
  await testOriginGate();
  await testSourceIsNotCallerControlled();
  await testMcpEndpointStillRoutes();
  await testMcpEndpointIsGated();
  console.log(
    'PASS: HTTP mirror (health, session lifecycle/configure, closing-message semantics, notify, ' +
      'validation, body limits, loopback/Host/Origin/Content-Type gate, source provenance, ' +
      '/mcp gate)'
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('FAIL:', err.stack || err.message);
    process.exit(1);
  });

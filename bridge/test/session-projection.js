'use strict';

const assert = require('assert');

process.env.COMPANION_LOG = process.env.COMPANION_LOG || 'error';

const { Bridge } = require('../src/bridge');
const { statusPayload } = require('../src/mcp/server');
const { FakeDeviceTransport } = require('../src/transport/fakeDevice');
const { composeModel, rankSessions, STATE_PRIORITY } = require('../src/sessions/compose');
const { speciesIndex } = require('../src/sessions/species');
const { paletteFor } = require('../src/sessions/palettes');
const {
  buildSnapshot,
  clampBytes,
  displayIdsFor,
  shapeSessionRows,
  SESSION_SCHEMA_VERSION,
  SESSION_STATE_CODES,
  SUMMARY_MAX_BYTES,
} = require('../src/protocol/snapshot');

const NO_LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function palette(theme) {
  const value = paletteFor(theme);
  return {
    body: value.body,
    bg: value.bg,
    text: value.text,
    text_dim: value.textDim,
    ink: value.ink,
  };
}

function row({
  id,
  state,
  summary = id,
  pal = 'capybara',
  theme = 'classic',
  created = '2026-09-15T10:00:00.000Z',
  updated = '2026-09-15T10:00:00.000Z',
  message = '',
} = {}) {
  return {
    session_id: id,
    pal_id: pal,
    palette: palette(theme),
    summary,
    state,
    message,
    created_at: created,
    updated_at: updated,
  };
}

// Exact additive wire fixture. Only the compact row keys are allowed through;
// registry-only metadata never leaks into the heartbeat.
{
  const sessions = [
    row({ id: 'session-idle', state: 'idle', summary: 'Taking a break', pal: 'duck' }),
    row({
      id: 'session-blocked',
      state: 'blocked',
      summary: 'Waiting for review',
      pal: 'owl',
      theme: 'cyan',
      message: 'need review',
    }),
  ];
  const model = composeModel({
    passive: { total: 0, running: 0, waiting: 0, completed: false, msg: 'idle', entries: [] },
    sessions,
    projectionLimit: 8,
  });
  assert.deepStrictEqual(buildSnapshot(model), {
    total: 2,
    running: 0,
    waiting: 1,
    completed: false,
    msg: 'need review',
    entries: [],
    sv: 1,
    ss: [
      {
        i: '4a095d98cbba',
        p: 7,
        c: [0x05d9, 0x0000, 0xffff, 0x8410, 0x0000],
        s: 4,
        m: 'Waiting for review',
      },
      {
        i: '40f80aa49ba7',
        p: 1,
        c: [0xbd51, 0x0000, 0xffff, 0x8410, 0x0000],
        s: 0,
        m: 'Taking a break',
      },
    ],
  });
}

// Ranking priority and wire codes intentionally run in opposite directions.
{
  const states = ['idle', 'thinking', 'working', 'waiting', 'blocked'];
  assert.deepStrictEqual(states.map((state) => SESSION_STATE_CODES[state]), [0, 1, 2, 3, 4]);
  assert.deepStrictEqual(states.map((state) => STATE_PRIORITY[state]), [0, 1, 2, 3, 4]);
  const ranked = rankSessions(states.map((state) => row({ id: state, state })), 8);
  assert.deepStrictEqual(ranked.map((session) => session.state), states.slice().reverse());
  assert.deepStrictEqual(ranked.map((session) => SESSION_STATE_CODES[session.state]), [4, 3, 2, 1, 0]);
}

// Within one state: newest update, then oldest creation, then id ascending.
{
  const sessions = [
    row({ id: 'z', state: 'blocked', updated: '2026-09-15T10:02:00Z', created: '2026-09-15T09:00:00Z' }),
    row({ id: 'c', state: 'blocked', updated: '2026-09-15T10:03:00Z', created: '2026-09-15T09:02:00Z' }),
    row({ id: 'b', state: 'blocked', updated: '2026-09-15T10:03:00Z', created: '2026-09-15T09:01:00Z' }),
    row({ id: 'a', state: 'blocked', updated: '2026-09-15T10:03:00Z', created: '2026-09-15T09:01:00Z' }),
  ];
  assert.deepStrictEqual(rankSessions(sessions, 8).map((session) => session.session_id), ['a', 'b', 'c', 'z']);
}

// Ended rows are never projected, even if their timestamps and former state
// would otherwise put them first.
{
  const ranked = rankSessions([
    row({ id: 'ended', state: 'ended', updated: '2099-01-01T00:00:00Z' }),
    row({ id: 'live', state: 'idle' }),
  ], 8);
  assert.deepStrictEqual(ranked.map((session) => session.session_id), ['live']);
  assert.ok(!shapeSessionRows(ranked).some((session) => session.i === 'ended'));
}

// Truncated hashes need collision handling inside the selected set. The test
// hash forces the unsalted values to collide, then returns deterministic salted
// replacements so both uniqueness and repeatability are observable.
{
  const sessions = [row({ id: 'one', state: 'working' }), row({ id: 'two', state: 'working' })];
  const forcedHash = (input) => input.includes('\0') ? '000000000002' : '000000000001';
  const first = displayIdsFor(sessions, forcedHash);
  const second = displayIdsFor(sessions, forcedHash);
  assert.deepStrictEqual(first, ['000000000001', '000000000002']);
  assert.deepStrictEqual(second, first);
  const reversed = displayIdsFor(sessions.slice().reverse(), forcedHash);
  assert.deepStrictEqual(
    Object.fromEntries(sessions.map((session, index) => [session.session_id, first[index]])),
    Object.fromEntries(sessions.slice().reverse().map((session, index) => [session.session_id, reversed[index]])),
    'collision replacements stay attached to the same full ids regardless of input order'
  );
  assert.strictEqual(new Set(first).size, first.length);
}

// Summary caps are encoded UTF-8 bytes, not JavaScript characters, and no
// boundary is allowed to manufacture a lone surrogate.
{
  const cases = [
    ['ascii', 'a'.repeat(80), 'a'.repeat(48)],
    ['cjk', '漢'.repeat(20), '漢'.repeat(16)],
    ['astral', '😀'.repeat(20), '😀'.repeat(12)],
    ['lone surrogate', `safe\uD800tail`, 'safe�tail'],
  ];
  for (const [name, input, expected] of cases) {
    const value = clampBytes(input, SUMMARY_MAX_BYTES);
    assert.strictEqual(value, expected, `${name}: unexpected clamp`);
    assert.ok(Buffer.byteLength(value, 'utf8') <= SUMMARY_MAX_BYTES, `${name}: over byte cap`);
    assert.strictEqual(JSON.parse(JSON.stringify(value)), value, `${name}: JSON round trip changed`);
    assert.ok(!NO_LONE_SURROGATE.test(value), `${name}: lone surrogate survived`);
  }
}

// Palette order and species index are wire contracts, not object iteration
// accidents. Check every slot and uint16 bound explicitly.
{
  const source = row({ id: 'palette', state: 'thinking', pal: 'dragon', theme: 'magenta' });
  const [wire] = shapeSessionRows([source]);
  assert.strictEqual(wire.p, speciesIndex(source.pal_id));
  assert.deepStrictEqual(wire.c, [
    source.palette.body,
    source.palette.bg,
    source.palette.text,
    source.palette.text_dim,
    source.palette.ink,
  ]);
  assert.strictEqual(wire.c.length, 5);
  assert.ok(wire.c.every((value) => Number.isInteger(value) && value >= 0 && value <= 0xffff));
}

// More than eight live sessions remain available to registry/status callers;
// only the device snapshot is bounded, and it contains exactly the ranked top.
{
  let now = Date.now();
  const transport = new FakeDeviceTransport({ autoAnswer: false });
  const bridge = new Bridge(transport, {
    keepaliveMs: 10000,
    statusPollMs: 15000,
    confirm: { maxQueue: 8 },
    sessions: { now: () => now, maxSessions: 64, deviceProjectionMax: 8 },
  });
  const states = ['idle', 'thinking', 'working', 'waiting', 'blocked'];
  for (let i = 0; i < 15; i++) {
    now += 1000;
    const begun = bridge.beginSession({ label: `session-${String(i).padStart(2, '0')}` });
    now += 1000;
    bridge.updateSession({ id: begun.session_id, state: states[i % states.length] });
  }
  const listed = bridge.registry.list(now);
  const expected = rankSessions(listed, 8);
  const snapshot = bridge.status;
  const status = statusPayload(bridge);
  assert.strictEqual(listed.length, 15);
  assert.strictEqual(status.sessions.length, 15, 'companion_status retains every registry row');
  assert.strictEqual(status.projection.live, 15);
  assert.strictEqual(snapshot.ss.length, 8);
  assert.deepStrictEqual(snapshot.ss.map((session) => session.i), displayIdsFor(expected));
  assert.strictEqual(snapshot.total, 15, 'aggregate counts still represent all live sessions');
}

// Official usage is joined by the stable Copilot conversation ID, exposed in
// companion_status, and projected as compact per-pal stats. Process-log
// context is not attached because the log has no positive session identity.
{
  const transport = new FakeDeviceTransport({ autoAnswer: false });
  const bridge = new Bridge(transport, {
    keepaliveMs: 10000,
    statusPollMs: 15000,
    confirm: { maxQueue: 8 },
    sessions: { maxSessions: 64, deviceProjectionMax: 8 },
  });
  bridge.setModel({
    total: 0,
    running: 0,
    waiting: 0,
    completed: false,
    msg: 'idle',
    entries: [],
    officialUsage: {
      available: true,
      experimental: true,
      source: 'assistant_usage_events',
      total_output_tokens: 4567,
      sessions: {
        'copilot-conversation': {
          api_calls: 4,
          input_tokens: 12345,
          output_tokens: 4567,
          cache_read_tokens: 10000,
          cache_write_tokens: 500,
          reasoning_tokens: 300,
          total_nano_aiu: 9000,
          updated_at: '2026-09-17T08:00:00.000Z',
          latest_model: 'gpt-5.6-sol',
          models: {
            'gpt-5.6-sol': {
              api_calls: 4,
              input_tokens: 12345,
              output_tokens: 4567,
              cache_read_tokens: 10000,
              cache_write_tokens: 500,
              reasoning_tokens: 300,
              total_nano_aiu: 9000,
              updated_at: '2026-09-17T08:00:00.000Z',
            },
          },
        },
      },
    },
  });
  const begun = bridge.beginSession({
    label: 'usage pal',
    conversationId: 'copilot-conversation',
  });
  assert.strictEqual(begun.usage.output_tokens, 4567,
    'a new pal immediately inherits cached official usage');
  assert.strictEqual(bridge.status.ss[0].u, 4567);
  assert.strictEqual(bridge.status.ss[0].q, 12345);
  assert.strictEqual(bridge.status.ss[0].d, 'gpt-5.6-sol');
  assert.strictEqual(bridge.status.ss[0].v, 1);
  assert.ok(!Object.prototype.hasOwnProperty.call(bridge.status.ss[0], 'x'));
  const payload = statusPayload(bridge);
  assert.strictEqual(payload.sessions[0].usage.input_tokens, 12345);
  assert.strictEqual(payload.sessions[0].usage.latest_model, 'gpt-5.6-sol');
  assert.deepStrictEqual(
    [payload.sessions[0].usage.context_used, payload.sessions[0].usage.context_max],
    [0, 0]
  );
  assert.deepStrictEqual(payload.usage_tracking, {
    available: true,
    experimental: true,
    source: 'assistant_usage_events',
    tracked_sessions: 1,
  });

  bridge.setModel({
    total: 0,
    running: 0,
    waiting: 0,
    completed: false,
    msg: 'idle',
    entries: [],
    officialUsage: {
      available: true,
      experimental: true,
      source: 'assistant_usage_events',
      total_output_tokens: 0,
      sessions: {},
    },
  });
  assert.strictEqual(bridge.registry.get(begun.session_id).usage, null,
    'an authoritative empty snapshot clears usage removed by a store reset');
  assert.ok(!Object.prototype.hasOwnProperty.call(bridge.status.ss[0], 'u'),
    'cleared usage is no longer projected to firmware');
}

// Even one tracked process log is not positive correlation: it can be stale or
// belong to another conversation. Context stays absent until a source carries
// the exact session identity.
{
  const transport = new FakeDeviceTransport({ autoAnswer: false });
  const bridge = new Bridge(transport, {
    keepaliveMs: 10000,
    statusPollMs: 15000,
    confirm: { maxQueue: 8 },
    sessions: { maxSessions: 64, deviceProjectionMax: 8 },
  });
  bridge.setModel({
    total: 1,
    running: 1,
    waiting: 0,
    completed: false,
    msg: 'working...',
    entries: [],
    tokensUsed: 80000,
    tokensMax: 128000,
    focus: {
      sessionId: 'focus-session',
      trackedLogs: 1,
      logFile: 'process-other-session.log',
    },
    officialUsage: {
      available: true,
      experimental: true,
      source: 'assistant_usage_events',
      total_output_tokens: 100,
      sessions: {
        'focus-session': {
          input_tokens: 2000,
          output_tokens: 100,
          latest_model: 'gpt-test',
          models: { 'gpt-test': {} },
        },
      },
    },
  });
  bridge.beginSession({ label: 'unattributed context', conversationId: 'focus-session' });
  assert.strictEqual(bridge.status.ss[0].u, 100);
  assert.strictEqual(bridge.status.ss[0].d, 'gpt-test');
  assert.ok(!Object.prototype.hasOwnProperty.call(bridge.status.ss[0], 'x'));
}

// No projected rows means no additive keys at all: this is the byte-identical
// legacy success criterion, not an empty versioned roster.
{
  const snapshot = buildSnapshot({
    total: 0,
    running: 0,
    waiting: 0,
    completed: false,
    msg: 'idle',
    entries: [],
    sessionRows: [],
  });
  assert.ok(!Object.prototype.hasOwnProperty.call(snapshot, 'sv'));
  assert.ok(!Object.prototype.hasOwnProperty.call(snapshot, 'ss'));
}

// A new user prompt carrying the exact Copilot conversation UUID starts the
// next task cycle even before the orchestrator reports an explicit state.
{
  let now = 1000;
  const transport = new FakeDeviceTransport({ autoAnswer: false });
  const bridge = new Bridge(transport, {
    keepaliveMs: 10000,
    statusPollMs: 15000,
    confirm: { maxQueue: 8 },
    sessions: { maxSessions: 64, deviceProjectionMax: 8 },
  }, { now: () => now });
  const begun = bridge.beginSession({
    label: 'automatic task cycle',
    conversationId: 'copilot-session-uuid',
  });
  now = 1100;
  bridge.completeTask({ id: begun.session_id, outcome: 'success' });
  assert.strictEqual(bridge.registry.get(begun.session_id).state, 'idle');

  bridge.setModel({
    total: 0, running: 0, waiting: 0, completed: false, msg: 'idle', entries: [],
    edges: [],
  });
  bridge.setModel({
    total: 1, running: 1, waiting: 0, completed: false, msg: 'working...', entries: [],
    edges: [{
      kind: 'user',
      id: 'user-new-task',
      at: 1150,
      session: 'copilot-session-uuid',
    }],
  });
  assert.strictEqual(bridge.registry.get(begun.session_id).state, 'thinking',
    'the exact session user edge reconnects the idle pal to a new task');
  assert.strictEqual(bridge.status.ss[0].s, 1);

  now = 1200;
  bridge.completeTask({ id: begun.session_id, outcome: 'success' });
  bridge.setModel({
    total: 1, running: 1, waiting: 0, completed: false, msg: 'working...', entries: [],
    edges: [{
      kind: 'user',
      id: 'user-other-task',
      at: 1250,
      session: 'different-session-uuid',
    }],
  });
  assert.strictEqual(bridge.registry.get(begun.session_id).state, 'idle',
    'an unrelated session edge cannot activate this pal');

  bridge.setModel({
    total: 1, running: 1, waiting: 0, completed: false, msg: 'working...', entries: [],
    edges: [{
      kind: 'user',
      id: 'user-delayed-old-task',
      at: 1190,
      session: 'copilot-session-uuid',
    }],
  });
  assert.strictEqual(bridge.registry.get(begun.session_id).state, 'idle',
    'a delayed prior-cycle user edge cannot revive an idle pal');

  now = 1300;
  const other = bridge.beginSession({
    label: 'other conversation',
    conversationId: 'other-copilot-session',
  });
  now = 1400;
  bridge.completeTask({ id: other.session_id, outcome: 'success' });
  bridge.setModel({
    total: 2, running: 1, waiting: 0, completed: false, msg: 'working...', entries: [],
    edges: [{
      kind: 'user',
      id: 'user-valid-despite-newer-other-completion',
      at: 1250,
      session: 'copilot-session-uuid',
    }],
  });
  assert.strictEqual(bridge.registry.get(begun.session_id).state, 'thinking',
    'another conversation completion cannot suppress this session valid new prompt');
}

// The entire projection is pure and deterministic.
{
  const sessions = [
    row({ id: 'same-a', state: 'waiting', pal: 'cat', summary: 'review' }),
    row({ id: 'same-b', state: 'working', pal: 'robot', summary: 'build' }),
  ];
  const model = composeModel({ passive: null, sessions, projectionLimit: 8 });
  assert.deepStrictEqual(buildSnapshot(model), buildSnapshot(model));
  for (const session of buildSnapshot(model).ss) {
    assert.match(session.i, /^[0-9a-f]{12}$/);
  }
  assert.strictEqual(new Set(buildSnapshot(model).ss.map((session) => session.i)).size, 2);
  assert.strictEqual(SESSION_SCHEMA_VERSION, 1);
  assert.strictEqual(SUMMARY_MAX_BYTES, 48);
}

console.log('PASS: ranked session projection, compact wire rows, byte-safe summaries, and full status');

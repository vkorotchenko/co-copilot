'use strict';

const assert = require('assert');
const EventEmitter = require('events');
process.env.COMPANION_LOG = process.env.COMPANION_LOG || 'error';

const { Bridge } = require('../src/bridge');
const { CopilotLogTail } = require('../src/copilot/logtail');
const { CopilotSource } = require('../src/copilot/source');
const { CopilotStore } = require('../src/copilot/store');
const { PermissionWatch } = require('../src/copilot/permwatch');
const { BleCentral } = require('../src/ble/central');
const { FakeDeviceTransport } = require('../src/transport/fakeDevice');
const { rankSessions } = require('../src/sessions/compose');
const { CompletionLatch, completedPal } = require('../src/sessions/completionLatch');
const {
  buildSnapshot, enforceBudget, serializedBytes, shapeCompletion,
  HARD_CEILING, SUMMARY_MAX_BYTES,
} = require('../src/protocol/snapshot');

const CFG = {
  keepaliveMs: 10000, statusPollMs: 60000, confirm: { maxQueue: 8 },
  sessions: {
    defaultTtlMs: 90000, minTtlMs: 5000, maxTtlMs: 3600000,
    maxSessions: 64, endedLingerMs: 10000, deviceProjectionMax: 8,
  },
};
const BASE_EDGES = Object.freeze({
  prompt: { id: 'prompt-seed', at: 100 }, user: { id: 'user-seed', at: 100 },
  tool: { id: 'tool-seed', at: 100 }, aiRequest: { id: 'ai-seed', at: 100 },
});

class TestTransport extends EventEmitter {
  constructor() { super(); this.connected = true; this.sent = []; }
  writeLine(value) { this.sent.push(value); return Promise.resolve(true); }
  writeSnapshot(value) { this.sent.push(value); return Promise.resolve(true); }
}

function passive(overrides = {}) {
  return {
    total: 0, running: 0, waiting: 0, completed: false, msg: 'idle', entries: [],
    edgeIds: BASE_EDGES, ...overrides,
  };
}
function makeBridge({ now = 1000, epoch = 101, sessions = {} } = {}) {
  let clock = now;
  const transport = new TestTransport();
  const bridge = new Bridge(transport, { ...CFG, sessions: { ...CFG.sessions, ...sessions } }, {
    now: () => clock, randomUint32: () => epoch,
  });
  return { bridge, transport, now: () => clock, advance(ms) { clock += ms; return clock; } };
}
function advertise(transport, capable = true) {
  transport.emit('line', {
    ack: 'status', ok: true, data: capable ? { name: 'test-device', cl: 1 } : { name: 'test-device' },
  });
}
function advertiseCl(transport, cl) {
  transport.emit('line', { ack: 'status', ok: true, data: { name: 'test-device', cl } });
}
function latch(bridge, outcome = 'success') {
  bridge.completionLatch.completePassive({ outcome });
  return bridge.completionLatch.current;
}
function has(object, key) { return Object.prototype.hasOwnProperty.call(object, key); }
function scalarSafe(value) {
  return !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value);
}

const tests = [];
function test(name, criteria, fn) { tests.push({ name, criteria, fn }); }

test('capability skew preserves legacy completion and gates sg/sc', [1], () => {
  const { bridge, transport } = makeBridge();
  bridge.setModel(passive({ completed: true, msg: 'completed' }));
  latch(bridge);
  assert.strictEqual(bridge.status.completed, true);
  assert.ok(!has(bridge.status, 'sg') && !has(bridge.status, 'sc'));
  advertise(transport, false);
  assert.ok(!has(bridge.status, 'sg'));
  advertise(transport);
  assert.strictEqual(bridge.status.completed, true);
  assert.deepStrictEqual({ sg: bridge.status.sg, g: bridge.status.sc.g }, { sg: 101, g: 1 });
  bridge.setModel(passive({ tokens: 1 }));
  assert.strictEqual(bridge.status.sg, 101, 'every capable snapshot carries sg');
});

test('capability gate accepts only a numeric cl:1', [1], () => {
  for (const cl of [true, '1', 0, 2]) {
    const { bridge, transport } = makeBridge();
    bridge.setModel(passive({ completed: true, msg: 'completed' }));
    latch(bridge);
    advertiseCl(transport, cl);
    assert.ok(!has(bridge.status, 'sg') && !has(bridge.status, 'sc'),
      `cl:${JSON.stringify(cl)} must not enable the completion capability`);
    assert.strictEqual(bridge.status.completed, true,
      'legacy completion survives a rejected capability advertisement');
    advertiseCl(transport, 1);
    assert.deepStrictEqual({ sg: bridge.status.sg, g: bridge.status.sc.g }, { sg: 101, g: 1 },
      'numeric cl:1 still enables the capability after a rejected advertisement');
  }
});

test('explicit outcomes map to success/failed/aborted wire codes', [2], () => {
  const { bridge, transport } = makeBridge();
  advertise(transport);
  for (const [outcome, code] of Object.entries({ success: 0, failed: 1, aborted: 2 })) {
    const session = bridge.beginSession({ label: `outcome-${outcome}` });
    bridge.completeTask({ id: session.session_id, outcome });
    assert.strictEqual(bridge.status.sc.o, code);
  }
});

test('captured completed pal survives registry removal', [3], () => {
  const rig = makeBridge();
  advertise(rig.transport);
  const session = rig.bridge.beginSession({ label: 'captured pal' });
  rig.bridge.configureSession({ id: session.session_id, palId: 'owl', summary: 'finished work' });
  rig.bridge.completeTask({ id: session.session_id });
  rig.bridge.endSession({ id: session.session_id });
  const captured = JSON.parse(JSON.stringify(rig.bridge.status.sc));
  rig.advance(CFG.sessions.endedLingerMs + 1);
  assert.strictEqual(rig.bridge.registry.get(session.session_id), null);
  assert.deepStrictEqual(rig.bridge.status.sc, captured);
  assert.ok(!rig.bridge.status.ss || !rig.bridge.status.ss.some((row) => row.i === captured.i));
});

test('new passive completion creates an ownerless latch', [4], () => {
  const { bridge, transport } = makeBridge();
  advertise(transport);
  bridge.setModel(passive());
  bridge.setModel(passive({ completionEdge: { id: 'turn:new', outcome: 'failed', at: 1100 } }));
  assert.strictEqual(bridge.completionLatch.current.owner, null);
  assert.deepStrictEqual(bridge.status.sc, { g: 1, o: 1 });
});

test('passive source primes historical data without a startup latch', [5], () => {
  const source = new CopilotSource({
    sessionStoreDb: '/nonexistent', logsDir: '/nonexistent', sessionStateDir: '/nonexistent',
    settingsJson: '/nonexistent', busyWindowMs: 1, activeWindowMs: 1, maxEntries: 1,
    completedHoldMs: 6000, perm: {},
  });
  const markers = [
    { id: 'historical', time: new Date(100) }, { id: 'new', time: new Date(200) },
  ];
  source._store = {
    countActiveSessions: () => 0, newestTurnMarker: () => markers.shift() || null,
    recentTurns: () => [],
  };
  source._log = {
    update() {}, runningCount: () => 0, aiActive: false, aiRequestEdge: null,
    tokens: null, contextTokens: null, model: null, effort: null,
  };
  source._perm = { update() {}, pending: () => null, waitingForUser: () => false, edgeIds: {} };
  source._readSettings = () => ({ model: null, effort: null });
  assert.strictEqual(source._buildModel().completionEdge, undefined);
  assert.strictEqual(source._buildModel().completionEdge.id, 'turn:new');
});

test('failed and empty store baselines stay semantically distinct', [5], () => {
  const store = new CopilotStore({ sessionStoreDb: '/nonexistent' });
  store._db = { prepare: () => ({ get: () => undefined }) };
  assert.strictEqual(store.newestTurnMarker(), null, 'successful no-row query is empty');
  store._db = { prepare: () => ({ get: () => { throw new Error('busy'); } }) };
  assert.strictEqual(store.newestTurnMarker(), undefined, 'failed query is unavailable');

  function sourceFor(markers) {
    const source = new CopilotSource({
      sessionStoreDb: '/nonexistent', logsDir: '/nonexistent', sessionStateDir: '/nonexistent',
      settingsJson: '/nonexistent', busyWindowMs: 1, activeWindowMs: 1, maxEntries: 1,
      completedHoldMs: 6000, perm: {},
    });
    source._store = {
      countActiveSessions: () => 0, newestTurnMarker: () => markers.shift(),
      recentTurns: () => [],
    };
    source._log = {
      update() {}, runningCount: () => 0, aiActive: false, aiRequestEdge: null,
      tokens: null, contextTokens: null, model: null, effort: null,
    };
    source._perm = { update() {}, pending: () => null, waitingForUser: () => false, edgeIds: {} };
    source._readSettings = () => ({ model: null, effort: null });
    return source;
  }

  const historical = { id: 'historical', time: new Date(100) };
  const failedFirst = sourceFor([undefined, historical, historical]);
  assert.strictEqual(failedFirst._buildModel().completionEdge, undefined);
  assert.strictEqual(failedFirst._buildModel().completionEdge, undefined,
    'first successful historical read primes after an earlier failure');
  assert.strictEqual(failedFirst._buildModel().completionEdge, undefined,
    'unchanged historical data never latches');

  const newAfterEmpty = { id: 'first-real-row', time: new Date(200) };
  const emptyFirst = sourceFor([null, newAfterEmpty]);
  assert.strictEqual(emptyFirst._buildModel().completionEdge, undefined);
  assert.strictEqual(emptyFirst._buildModel().completionEdge.id, 'turn:first-real-row',
    'a row genuinely inserted after an empty baseline latches');
});

test('epoch is stable and generation is monotonic', [6], () => {
  const completion = new CompletionLatch({ now: () => 1000, randomUint32: () => 0x12345678 });
  const epoch = completion.epoch;
  completion.completePassive({});
  assert.deepStrictEqual({ epoch: completion.epoch, g: completion.current.g }, { epoch, g: 1 });
  assert.deepStrictEqual(completion.wire(), completion.wire());
  completion.clear(); completion.completePassive({});
  assert.deepStrictEqual({ epoch: completion.epoch, g: completion.current.g }, { epoch, g: 2 });
});

test('new completion replaces the slot and advances generation', [7], () => {
  const completion = new CompletionLatch({ now: () => 1000, randomUint32: () => 77 });
  completion.completePassive({ outcome: 'success' });
  assert.deepStrictEqual(completion.wire(), { g: 1, o: 0 });
  completion.completePassive({ outcome: 'aborted' });
  assert.deepStrictEqual(completion.wire(), { g: 2, o: 2 });
});

test('exact epoch and generation dismissal clears before next snapshot', [8], () => {
  const { bridge, transport } = makeBridge();
  advertise(transport); latch(bridge);
  transport.emit('line', { cmd: 'completion', sg: 101, g: 1, action: 'dismiss' });
  assert.strictEqual(bridge.status.sg, 101);
  assert.ok(!has(bridge.status, 'sc'));
});

test('wrong, duplicate, and malformed dismissals are harmless', [9], () => {
  const { bridge, transport } = makeBridge();
  advertise(transport); latch(bridge);
  const wrong = [
    { cmd: 'completion', sg: 100, g: 1, action: 'dismiss' },
    { cmd: 'completion', sg: 101, g: 2, action: 'dismiss' },
    { cmd: 'completion', sg: 101, g: 1, action: 'other' },
    { cmd: 'completion', sg: '101', g: 1, action: 'dismiss' },
    { cmd: 'completion' }, {}, [], 'not-json', null,
  ];
  for (const payload of wrong) {
    assert.doesNotThrow(() => transport.emit('line', payload));
    assert.ok(bridge.status.sc, `must not clear for ${String(payload)}`);
  }
  transport.emit('line', { cmd: 'completion', sg: 101, g: 1, action: 'dismiss' });
  assert.ok(!has(bridge.status, 'sc'));
  assert.doesNotThrow(() => transport.emit('line', {
    cmd: 'completion', sg: 101, g: 1, action: 'dismiss',
  }));
});

test('device-line boundary ignores every non-command shape', [9], () => {
  const central = new BleCentral({ ble: { fallbackChunk: 20, namePrefix: 'Copilot' } });
  const bridge = new Bridge(central, CFG, { now: () => 1000, randomUint32: () => 101 });
  latch(bridge);
  const generation = bridge.completionLatch.current.g;
  const lines = [
    'null', '[]', 'true', '42', '"text"', '{bad json',
    '{}', '{"cmd":"completion"}',
    '{"cmd":"completion","sg":"101","g":1,"action":"dismiss"}',
    '{"cmd":"completion","sg":100,"g":1,"action":"dismiss"}',
    '{"cmd":"completion","sg":101,"g":2,"action":"dismiss"}',
    '{"cmd":"completion","sg":101,"g":1,"action":"other"}',
  ];
  for (const line of lines) {
    assert.doesNotThrow(() => central._onDeviceLine(line), line);
    assert.strictEqual(bridge.completionLatch.current.g, generation, line);
  }
});

test('new bridge instance has a distinct epoch and empty latch', [10], () => {
  const first = makeBridge({ epoch: 111 }).bridge;
  const second = makeBridge({ epoch: 222 }).bridge;
  latch(first);
  assert.notStrictEqual(first.completionLatch.epoch, second.completionLatch.epoch);
  assert.notStrictEqual(second.completionLatch.epoch, 0);
  assert.strictEqual(second.completionLatch.current, null);
});

test('reconnect resends the same live epoch and generation after opt-in', [11], () => {
  const { bridge, transport } = makeBridge();
  advertise(transport); latch(bridge);
  const generation = bridge.status.sc.g;
  transport.connected = false; transport.emit('disconnected');
  assert.ok(!has(bridge.status, 'sg'));
  transport.connected = true; advertise(transport);
  assert.deepStrictEqual({ sg: bridge.status.sg, g: bridge.status.sc.g }, { sg: 101, g: generation });
});

test('explicit lifecycle starts clear semantic new cycles', [12], () => {
  const begun = makeBridge().bridge;
  latch(begun); begun.beginSession({ label: 'new begin' });
  assert.strictEqual(begun.completionLatch.current, null);
  const transitions = [
    ['idle', 'thinking'], ['idle', 'working'], ['idle', 'waiting'], ['idle', 'blocked'],
    ['waiting', 'thinking'], ['waiting', 'working'], ['blocked', 'thinking'], ['blocked', 'working'],
  ];
  for (const [from, to] of transitions) {
    const { bridge } = makeBridge();
    const session = bridge.beginSession({ label: `${from}-${to}` });
    bridge.updateSession({ id: session.session_id, state: from });
    latch(bridge);
    bridge.updateSession({ id: session.session_id, state: to });
    assert.strictEqual(bridge.completionLatch.current, null, `${from}->${to}`);
  }
});

test('passive prompt, user, tool, and AI request identities clear', [12], () => {
  for (const key of ['prompt', 'user', 'tool', 'aiRequest']) {
    const { bridge } = makeBridge();
    bridge.setModel(passive()); latch(bridge);
    bridge.setModel(passive({ edgeIds: { ...BASE_EDGES, [key]: { id: `${key}-new`, at: 1001 } } }));
    assert.strictEqual(bridge.completionLatch.current, null, key);
  }
  const watch = new PermissionWatch({ sessionStateDir: '/nonexistent', perm: { minAgeMs: 0 } });
  const state = { partial: '', pending: null, waitingUser: false, waitingSince: 0 };
  watch._consume(state,
    '{"type":"permission.requested","timestamp":"1970-01-01T00:00:01.001Z","data":{"requestId":"p2","permissionRequest":{"kind":"shell"}}}\n' +
    '{"type":"user.message","id":"u2","timestamp":"1970-01-01T00:00:01.002Z","data":{"messageId":"u2"}}\n' +
    '{"type":"tool.execution_start","id":"t2","timestamp":"1970-01-01T00:00:01.003Z","data":{"toolCallId":"t2","toolName":"shell"}}\n');
  assert.deepStrictEqual(
    [watch.edgeIds.prompt.id, watch.edgeIds.user.id, watch.edgeIds.tool.id], ['p2', 'u2', 't2']
  );
  const tail = new CopilotLogTail({ logsDir: '/nonexistent' });
  tail._consume('1970-01-01T00:00:01.004Z Start of group: Sending request to the AI model\n');
  assert.deepStrictEqual(tail.aiRequestEdge, { id: '1', at: 1004 });
});

test('passive identities are collision-safe and stable across polls', [12], () => {
  const cases = [
    ['prompt', 'permission.requested', null, {
      requestId: 'shared-id', permissionRequest: { kind: 'shell' },
    }],
    ['user', 'user.message', 'shared-id', { messageId: 'shared-id' }],
    ['tool', 'tool.execution_start', 'shared-id', {
      toolCallId: 'shared-id', toolName: 'shell',
    }],
  ];
  for (const [category, type, eventId, data] of cases) {
    const watch = new PermissionWatch({ sessionStateDir: '/nonexistent', perm: { minAgeMs: 0 } });
    const consume = (namespace, timestamp) => {
      const state = {
        partial: '', pending: null, waitingUser: false, waitingSince: 0,
        edgeNamespace: namespace,
      };
      watch._consume(state, `${JSON.stringify({ type, id: eventId, timestamp, data })}\n`);
      return watch.edgeIds[category];
    };
    const first = consume('/sessions/one/events.jsonl', '1970-01-01T00:00:01.000Z');
    const stable = consume('/sessions/one/events.jsonl', '1970-01-01T00:00:01.000Z');
    assert.strictEqual(stable.id, first.id, `${category} identity is stable across unchanged polls`);

    const sameSession = makeBridge();
    sameSession.bridge.setModel(passive({ edgeIds: { [category]: first } }));
    latch(sameSession.bridge);
    sameSession.bridge.setModel(passive({ edgeIds: { [category]: stable } }));
    assert.ok(sameSession.bridge.completionLatch.current,
      `stable ${category} identity does not spuriously clear`);

    const second = consume('/sessions/two/events.jsonl', '1970-01-01T00:00:02.000Z');
    assert.notStrictEqual(second.id, first.id, `${category} identity includes session file`);
    sameSession.bridge.setModel(passive({ edgeIds: { [category]: second } }));
    assert.strictEqual(sameSession.bridge.completionLatch.current, null,
      `same raw ${category} id in a different session clears`);
  }
});

test('cosmetic and steady-state observations do not clear', [13], () => {
  const { bridge } = makeBridge();
  const active = bridge.beginSession({ label: 'steady worker' });
  bridge.setModel(passive({ running: 1, msg: 'working...' })); latch(bridge);
  const generation = bridge.completionLatch.current.g;
  bridge.configureSession({ id: active.session_id, summary: 'cosmetic' });
  bridge.updateSession({ id: active.session_id, state: 'working', message: 'lease renewal' });
  bridge.setModel(passive({
    running: 1, msg: 'log grew', entries: ['same transcript'], tokens: 50,
    model: 'test-model', effort: 'high',
  }));
  bridge.setModel(passive({
    running: 1, msg: 'log grew again', entries: ['same transcript'], tokens: 51,
    model: 'test-model-2', effort: 'low',
  }));
  assert.strictEqual(bridge.completionLatch.current.g, generation);
});

test('work already active at capture does not clear the latch', [14], () => {
  const { bridge } = makeBridge();
  const active = bridge.beginSession({ label: 'already active' });
  bridge.setModel(passive({ running: 1, msg: 'working...' })); latch(bridge);
  bridge.updateSession({ id: active.session_id, state: 'working', message: 'still working' });
  bridge.setModel(passive({ running: 1, msg: 'still working...' }));
  assert.ok(bridge.completionLatch.current);
});

test('completion storage is independent of registry capacity, TTL, and liveness', [15], () => {
  const rig = makeBridge({ sessions: { maxSessions: 1, endedLingerMs: 10 } });
  const owner = rig.bridge.registry.begin({ label: 'ended owner' });
  rig.bridge.completionLatch.completeExplicit(owner, 'success');
  rig.bridge.registry.end({ id: owner.session_id });
  rig.bridge.registry.begin({ label: 'capacity newcomer' });
  assert.strictEqual(rig.bridge.registry.size, 1);
  assert.ok(rig.bridge.completionLatch.current);
  rig.advance(11); rig.bridge.registry.prune(rig.now());
  assert.ok(rig.bridge.completionLatch.current);
  assert.strictEqual(rig.bridge.registry.get(owner.session_id), null);
});

test('completion is excluded from rows, counts, and carousel ranking', [16], () => {
  const { bridge, transport } = makeBridge();
  advertise(transport);
  const blocked = bridge.beginSession({ label: 'blocked live' });
  bridge.updateSession({ id: blocked.session_id, state: 'blocked' });
  const working = bridge.beginSession({ label: 'working live' });
  bridge.updateSession({ id: working.session_id, state: 'working' });
  const before = bridge.status;
  const rankBefore = rankSessions(bridge.registry.list(), 8).map((row) => row.session_id);
  latch(bridge);
  const after = bridge.status;
  assert.deepStrictEqual(
    { total: after.total, running: after.running, waiting: after.waiting, ss: after.ss },
    { total: before.total, running: before.running, waiting: before.waiting, ss: before.ss }
  );
  assert.deepStrictEqual(rankSessions(bridge.registry.list(), 8).map((row) => row.session_id), rankBefore);
  assert.ok(after.ss.every((row) => row.i !== after.sc.i));
});

test('budget degrades in order while retaining completion core', [17, 19], () => {
  const huge = 'x'.repeat(5000);
  const candidate = {
    total: 1, running: 1, waiting: 1, completed: true, msg: huge,
    entries: ['a'.repeat(1000), 'b'.repeat(1000)],
    tokens: 1, tokens_today: 2, tokens_used: 3, tokens_max: 4,
    model: huge, effort: huge, prompt: { id: huge, tool: huge, hint: huge },
    sv: 1,
    ss: [
      { i: '000000000001', p: 0, c: [0, 0, 0, 0, 0], s: 0, m: huge },
      { i: '000000000002', p: 0, c: [0, 0, 0, 0, 0], s: 0, m: huge },
    ],
    sg: 101,
    sc: { g: 7, o: 1, i: '0123456789ab', p: 7, c: [1, 2, 3, 4, 5], m: huge, d: 9 },
  };
  const labels = [];
  enforceBudget(candidate, (label) => {
    if (labels[labels.length - 1] !== label) labels.push(label);
  });
  assert.deepStrictEqual(labels, [
    'ss-tail', 'entries-tail', 'omit-entries', 'omit-sc-duration', 'omit-sc-pal',
    'omit-token-counters', 'omit-model', 'omit-effort', 'omit-completed',
    'core-msg', 'core-hint', 'core-tool', 'core-id',
  ]);
  assert.strictEqual(candidate.sg, 101);
  assert.deepStrictEqual(candidate.sc, { g: 7, o: 1 });
  assert.ok(serializedBytes(candidate) <= HARD_CEILING);
});

test('encoder throws instead of emitting an oversized required frame', [17], () => {
  const impossible = {
    total: 0, running: 0, waiting: 0, msg: '', prompt: { id: '', tool: '', hint: '' },
    sg: 101, sc: { g: 1, o: 0 }, requiredFutureCore: ['z'.repeat(HARD_CEILING)],
  };
  assert.throws(() => enforceBudget(impossible), /Snapshot exceeds firmware hard ceiling/);
});

test('astral metadata is byte bounded, scalar safe, and all-or-none', [17, 19], () => {
  const pal = completedPal({
    session_id: 'unicode-session', pal_id: 'owl',
    palette: { body: 1, bg: 2, text: 3, text_dim: 4, ink: 5 },
    summary: `${'😀'.repeat(20)}\uD800tail`,
  });
  assert.strictEqual(Buffer.byteLength(pal.m, 'utf8'), SUMMARY_MAX_BYTES);
  assert.strictEqual(pal.m, '😀'.repeat(12));
  assert.ok(scalarSafe(pal.m));
  assert.deepStrictEqual(
    ['i', 'p', 'c', 'm'].filter((key) => has(shapeCompletion({ g: 1, o: 0, ...pal }), key)),
    ['i', 'p', 'c', 'm']
  );
  assert.deepStrictEqual(shapeCompletion({ g: 1, o: 0, i: pal.i, m: 'partial' }), { g: 1, o: 0 });
  const heavy = buildSnapshot({
    total: 255, running: 255, waiting: 255, completed: true, msg: '😀'.repeat(1000),
    entries: Array(8).fill('😀漢\uD800'.repeat(500)),
    prompt: { id: '😀'.repeat(1000), tool: '漢'.repeat(1000), hint: '😀漢'.repeat(1000) },
    completionEpoch: 101, completion: { g: 9, o: 2, ...pal, d: 42 },
  });
  assert.ok(serializedBytes(heavy) <= HARD_CEILING);
  assert.deepStrictEqual({ sg: heavy.sg, g: heavy.sc.g, o: heavy.sc.o }, { sg: 101, g: 9, o: 2 });
  const tuple = ['i', 'p', 'c', 'm'].filter((key) => has(heavy.sc, key));
  assert.ok(tuple.length === 0 || tuple.length === 4);
  if (heavy.sc.m) assert.ok(scalarSafe(heavy.sc.m));
});

test('valid completion identity and palette survive shaping and copying', [3, 17, 19], () => {
  const legitimate = {
    g: 7, o: 2, i: 'abcdef012345', p: 17,
    c: [0, 1, 0x7fff, 0xffff, 42], m: 'legitimate palette', d: 9,
  };
  assert.deepStrictEqual(shapeCompletion(legitimate), legitimate,
    'valid 12-hex identity and five-color palette are retained');
  assert.deepStrictEqual(
    shapeCompletion({ ...legitimate, i: legitimate.i.toUpperCase() }),
    { g: 7, o: 2, d: 9 },
    'an uppercase identity is not a valid owner and drops the whole tuple'
  );

  const completion = new CompletionLatch({ now: () => 1000, randomUint32: () => 77 });
  completion.completeExplicit({
    session_id: 'palette-copy', pal_id: 'owl', summary: 'palette', created_at: new Date(0).toISOString(),
    palette: { body: 0, bg: 1, text: 0x7fff, text_dim: 0xffff, ink: 42 },
  });
  const first = completion.current;
  assert.deepStrictEqual(first.pal.c, [0, 1, 0x7fff, 0xffff, 42]);
  first.pal.c[2] = 9;
  assert.deepStrictEqual(completion.current.pal.c, [0, 1, 0x7fff, 0xffff, 42],
    'deep copy preserves the original palette content');
});

test('waiting, blocked, and prompt presentation outrank completion', [18], () => {
  for (const item of [
    { state: 'waiting', message: 'waiting wins' },
    { state: 'blocked', message: 'blocked wins' },
  ]) {
    const { bridge, transport } = makeBridge();
    advertise(transport);
    const session = bridge.beginSession({ label: item.state });
    bridge.updateSession({ id: session.session_id, state: item.state, message: item.message });
    latch(bridge);
    assert.strictEqual(bridge.status.msg, item.message);
    assert.ok(bridge.status.sc);
  }
  const { bridge, transport } = makeBridge();
  advertise(transport);
  bridge.setModel(passive({
    waiting: 1, msg: 'approval waiting',
    prompt: { id: 'prompt-live', tool: 'shell', hint: 'approve' },
  }));
  latch(bridge);
  assert.deepStrictEqual(
    { id: bridge.status.prompt.id, msg: bridge.status.msg },
    { id: 'prompt-live', msg: 'approval waiting' }
  );
});

test('fake device defaults legacy and can advertise cl:1', [1], async () => {
  async function ackFor(options) {
    const device = new FakeDeviceTransport(options);
    const ack = new Promise((resolve) => device.once('line', resolve));
    device.writeLine({ cmd: 'status' });
    return ack;
  }
  assert.strictEqual((await ackFor({ autoAnswer: false })).data.cl, undefined);
  assert.strictEqual((await ackFor({ autoAnswer: false, completionLatch: true })).data.cl, 1);
});

async function run() {
  const filter = process.env.COMPLETION_TEST_FILTER;
  const selected = filter ? tests.filter((entry) => entry.name.includes(filter)) : tests;
  const failures = [];
  for (const entry of selected) {
    try {
      await entry.fn();
      console.log(`PASS: [${entry.criteria.join(',')}] ${entry.name}`);
    } catch (error) {
      failures.push({ entry, error });
      console.error(`FAIL: [${entry.criteria.join(',')}] ${entry.name}`);
      console.error(error.stack || error.message || String(error));
    }
  }
  if (failures.length) {
    console.error(`FAIL: ${failures.length}/${selected.length} completion acceptance tests failed`);
    process.exitCode = 1;
  } else {
    console.log(`PASS: ${selected.length} completion acceptance tests passed`);
  }
}

run().catch((error) => { console.error(error.stack || error.message || String(error)); process.exit(1); });

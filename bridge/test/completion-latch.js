'use strict';

const assert = require('assert');
const EventEmitter = require('events');

process.env.COMPANION_LOG = process.env.COMPANION_LOG || 'error';

const { Bridge } = require('../src/bridge');
const { FakeDeviceTransport } = require('../src/transport/fakeDevice');
const { CopilotSource } = require('../src/copilot/source');
const { CopilotLogTail } = require('../src/copilot/logtail');
const {
  CompletionLatch,
  UINT32_MAX,
  completedPal,
} = require('../src/sessions/completionLatch');
const {
  buildSnapshot, shapeCompletion, serializedBytes, HARD_CEILING,
} = require('../src/protocol/snapshot');

class TestTransport extends EventEmitter {
  constructor() {
    super();
    this.connected = true;
    this.sent = [];
  }
  writeLine(value) { this.sent.push(value); return Promise.resolve(true); }
  writeSnapshot(value) { this.sent.push(value); return Promise.resolve(true); }
}

const cfg = {
  keepaliveMs: 10000,
  statusPollMs: 60000,
  confirm: { maxQueue: 8 },
  sessions: {
    defaultTtlMs: 90000,
    minTtlMs: 5000,
    maxTtlMs: 3600000,
    maxSessions: 64,
    endedLingerMs: 10000,
    deviceProjectionMax: 8,
  },
};

function statusAck(transport, capable = true) {
  transport.emit('line', {
    ack: 'status',
    ok: true,
    data: capable ? { name: 'test-device', cl: 1 } : { name: 'test-device' },
  });
}

function model(overrides = {}) {
  return {
    total: 0,
    running: 0,
    waiting: 0,
    completed: false,
    msg: 'idle',
    entries: [],
    edgeIds: { prompt: 'seed-prompt', user: 'seed-user', tool: 'seed-tool', aiRequest: 1 },
    ...overrides,
  };
}

(function latchStateModel() {
  let now = 10000;
  const random = [0, 42, 43];
  const latch = new CompletionLatch({ now: () => now, randomUint32: () => random.shift() });
  assert.strictEqual(latch.epoch, 42, 'epoch is injected, random, and nonzero');

  const record = {
    session_id: 'cs-test',
    label: 'build api',
    summary: 'build api',
    pal_id: 'owl',
    palette: { body: 1, bg: 2, text: 3, text_dim: 4, ink: 5 },
    created_at: new Date(5000).toISOString(),
  };
  assert.deepStrictEqual(completedPal(record), {
    i: '9ad9a8b6a879', p: 7, c: [1, 2, 3, 4, 5], m: 'build api',
  });
  let current = latch.completeExplicit(record, 'failed');
  assert.strictEqual(current.g, 1);
  assert.strictEqual(current.o, 1);
  assert.strictEqual(current.d, 5);
  assert.deepStrictEqual(latch.wire(), { g: 1, o: 1, ...current.pal, d: 5 });
  const exposed = latch.current;
  exposed.pal.c[0] = 0;
  assert.strictEqual(latch.current.pal.c[0], 1, 'current deep-copies the palette');

  now = 12000;
  current = latch.completePassive({ id: 'turn:2', outcome: 'success' });
  assert.strictEqual(current.g, 2, 'new completion replaces and increments');
  assert.strictEqual(current.owner, null);
  assert.deepStrictEqual(latch.wire(), { g: 2, o: 0 });

  latch._generation = UINT32_MAX;
  current = latch.completePassive({ outcome: 'aborted' });
  assert.strictEqual(latch.epoch, 43, 'overflow rotates epoch');
  assert.strictEqual(current.g, 1, 'overflow restarts generation at one');
  assert.strictEqual(current.o, 2);
  assert.strictEqual(latch.dismiss({ sg: -1, g: 1 }), false);
  assert.strictEqual(latch.dismiss({ sg: 42, g: 1 }), false);
  assert.strictEqual(latch.dismiss({ sg: 43, g: 2 }), false);
  assert.strictEqual(latch.dismiss({ sg: 43, g: 1 }), true);
  assert.strictEqual(latch.current, null);
})();

(function bridgeWiringAndEdges() {
  let now = 100000;
  const transport = new TestTransport();
  const bridge = new Bridge(transport, cfg, { now: () => now, randomUint32: () => 99 });
  bridge.setModel(model());

  const alreadyActive = bridge.beginSession({
    label: 'already active', cwd: '/work/api', source: 'mcp',
  });
  const finished = bridge.beginSession({
    label: 'finished task', cwd: '/work/bridge', source: 'mcp',
  });
  bridge.configureSession({
    id: finished.session_id,
    palId: 'dragon',
    summary: 'shipping the bridge',
  });
  now += 6500;
  const completedTask = bridge.completeTask({ id: finished.session_id, outcome: 'success' });
  assert.strictEqual(completedTask.state, 'idle');
  assert.strictEqual(completedTask.task_outcome, 'success');
  assert.strictEqual(bridge.registry.get(finished.session_id).state, 'idle');
  assert.ok(!Object.prototype.hasOwnProperty.call(bridge.status, 'sg'), 'legacy device gets no sg');
  assert.ok(!Object.prototype.hasOwnProperty.call(bridge.status, 'sc'), 'legacy device gets no sc');

  statusAck(transport, false);
  assert.strictEqual(bridge.completionCapable, false);
  statusAck(transport, true);
  const capable = bridge.status;
  assert.strictEqual(capable.sg, 99);
  assert.strictEqual(capable.sc.g, 1);
  assert.strictEqual(capable.sc.o, 0);
  assert.strictEqual(capable.sc.p, 5);
  assert.deepStrictEqual(capable.sc.c, [0xbd51, 0, 0xffff, 0x8410, 0]);
  assert.strictEqual(capable.sc.m, 'shipping the bridge');
  assert.strictEqual(capable.sc.d, 6);
  assert.ok(capable.ss.some((row) => row.i === capable.sc.i),
    'task completion keeps the long-lived session pal in the idle roster');

  bridge.configureSession({ id: alreadyActive.session_id, summary: 'cosmetic only' });
  bridge.updateSession({ id: alreadyActive.session_id, state: 'working', message: 'keepalive' });
  bridge.setModel(model({ tokens: 5, model: 'gpt-test' }));
  assert.strictEqual(bridge.status.sc.g, 1, 'configure, steady state, tokens and model do not clear');

  transport.emit('line', { cmd: 'completion', sg: 99, g: 2, action: 'dismiss' });
  transport.emit('line', { cmd: 'completion', sg: 98, g: 1, action: 'dismiss' });
  transport.emit('line', { cmd: 'completion', sg: 99, g: 1, action: 'other' });
  assert.ok(bridge.status.sc, 'stale and malformed dismissals are ignored');
  transport.emit('line', { cmd: 'completion', sg: 99, g: 1, action: 'dismiss' });
  assert.ok(!bridge.status.sc, 'exact dismissal clears');
  assert.strictEqual(bridge.status.sg, 99, 'absence of sc is authoritative clear');

  bridge.completeTask({ id: alreadyActive.session_id, outcome: 'failed' });
  const generation = bridge.status.sc.g;
  bridge.setModel(model({ completionEdge: {
    id: 'turn:uncorrelated', outcome: 'success', at: now - 600,
  } }));
  assert.strictEqual(bridge.status.sc.g, generation + 1,
    'an edge correlated with nothing is ordinary evidence, not a guessed echo');
  assert.ok(!bridge.status.sc.i, 'and latches ownerless');
  bridge.updateSession({ id: alreadyActive.session_id, state: 'working' });
  bridge.completeTask({ id: alreadyActive.session_id, outcome: 'failed' });
  const failedGeneration = bridge.status.sc.g;
  bridge.setModel(model({ completionEdge: {
    id: 'turn:explicit-echo', outcome: 'success', at: now - 500, cwd: '/work/api',
  } }));
  assert.strictEqual(bridge.status.sc.o, 1, 'passive echo does not overwrite explicit failure');
  assert.strictEqual(bridge.status.sc.g, failedGeneration,
    'passive echo does not increment generation');
  bridge.setModel(model({ completionEdge: {
    id: 'turn:explicit-echo', outcome: 'success', at: now - 500, cwd: '/work/api',
  } }));
  assert.strictEqual(bridge.status.sc.o, 1, 'passive echo does not overwrite explicit failure');
  assert.strictEqual(bridge.status.sc.g, failedGeneration,
    'passive echo does not increment generation');
  bridge.setModel(model({ edgeIds: { tool: { id: 'delayed-end-tool', at: now - 100 } } }));
  assert.strictEqual(bridge.status.sc.o, 1, 'delayed pre-end tool observation does not clear');
  bridge.setModel(model({ edgeIds: {
    prompt: { id: 'seed-prompt', at: now - 1000 },
    user: { id: 'user-2', at: now + 1 },
    tool: { id: 'seed-tool', at: now - 1000 },
    aiRequest: { id: '1', at: now - 1000 },
  } }));
  assert.ok(!bridge.status.sc, 'new user identity clears before the next snapshot');

  const another = bridge.beginSession({ label: 'next cycle', source: 'mcp' });
  bridge.completeTask({ id: another.session_id, outcome: 'aborted' });
  assert.ok(bridge.status.sc.g > generation, 'generation remains monotonic across clear');

  const parent = bridge.beginSession({
    label: 'persistent parent',
    source: 'mcp',
    conversationId: 'conversation-parent',
  });
  const completedChild = bridge.beginSession({ label: 'other completion', source: 'mcp' });
  bridge.completeTask({ id: completedChild.session_id, outcome: 'success' });
  const parentRetryGeneration = bridge.status.sc.g;
  const parentRetry = bridge.beginSession({
    label: 'must not replace parent',
    source: 'mcp',
    conversationId: 'conversation-parent',
  });
  assert.strictEqual(parentRetry.session_id, parent.session_id);
  assert.strictEqual(
    bridge.status.sc.g,
    parentRetryGeneration,
    'idempotent begin refresh does not clear an unrelated completion'
  );

  bridge.beginSession({ label: 'new begin', source: 'mcp' });
  assert.ok(!bridge.status.sc, 'explicit session_begin clears');

  const completionSource = bridge.beginSession({ label: 'completion source', source: 'mcp' });
  bridge.completeTask({ id: completionSource.session_id });
  assert.ok(bridge.status.sc);
  bridge.updateSession({ id: completionSource.session_id, state: 'working' });
  assert.ok(!bridge.status.sc, 'idle-to-active explicit transition starts a new cycle');
  now += 31_000; // Expire unrelated sessions' bounded delayed-echo guards.

  const passiveId = 'turn:200';
  const stableEdges = {
    prompt: { id: 'seed-prompt', at: now - 1000 },
    user: { id: 'user-2', at: now + 1 },
    tool: { id: 'seed-tool', at: now - 1000 },
    aiRequest: { id: '1', at: now - 1000 },
  };
  bridge.setModel(model({ edgeIds: stableEdges, completionEdge: { id: passiveId, outcome: 'success', at: now + 10 } }));
  assert.deepStrictEqual(bridge.status.sc, { g: bridge.completionLatch.current.g, o: 0 });
  const passiveGeneration = bridge.status.sc.g;
  bridge.setModel(model({ edgeIds: stableEdges, completionEdge: { id: passiveId, outcome: 'success', at: now + 10 } }));
  assert.strictEqual(bridge.status.sc.g, passiveGeneration, 'same passive completion edge does not relatch');

  const samePoll = bridge.beginSession({ label: 'same poll completion', source: 'mcp' });
  bridge.completeTask({ id: samePoll.session_id });
  bridge.setModel(model({
    edgeIds: { user: { id: 'same-poll-user', at: now + 30 } },
    completionEdge: { id: 'turn:before-new-work', outcome: 'success', at: now + 20 },
  }));
  assert.ok(!bridge.status.sc, 'newer work in the same poll wins over an older completion');
  const reconnectSource = bridge.beginSession({ label: 'reconnect completion', source: 'mcp' });
  bridge.completeTask({ id: reconnectSource.session_id });

  const epoch = bridge.status.sg;
  const reconnectGeneration = bridge.status.sc.g;
  transport.connected = false;
  transport.emit('disconnected');
  assert.strictEqual(bridge.completionCapable, false);
  transport.connected = true;
  assert.ok(!Object.prototype.hasOwnProperty.call(bridge.status, 'sg'));
  statusAck(transport, true);
  assert.strictEqual(bridge.status.sg, epoch, 'same process keeps epoch across reconnect');
  assert.strictEqual(bridge.status.sc.g, reconnectGeneration, 'live latch keeps generation across reconnect');
})();

(function passiveStartupPriming() {
  const source = new CopilotSource({
    sessionStoreDb: '/nonexistent', logsDir: '/nonexistent', sessionStateDir: '/nonexistent',
    settingsJson: '/nonexistent', busyWindowMs: 1, activeWindowMs: 1, maxEntries: 1,
    completedHoldMs: 6000, perm: {},
  });
  const newest = [null, new Date(1000), new Date(1000)];
  source._store = {
    countActiveSessions: () => 0,
    newestTurnMarker: () => {
      const value = newest.shift();
      return value ? { id: String(value.getTime()), time: value } : null;
    },
    recentTurns: () => [],
  };
  source._log = {
    update() {}, runningCount: () => 0, aiActive: false, aiRequestGeneration: 0,
    aiRequestEdge: null,
    tokens: null, contextTokens: null, model: null, effort: null,
  };
  source._perm = { update() {}, pending: () => null, waitingForUser: () => false, edgeIds: {} };
  source._readSettings = () => ({ model: null, effort: null });
  assert.strictEqual(source._buildModel().completionEdge, undefined, 'startup history is seeded');
  assert.strictEqual(source._buildModel().completionEdge.id, 'turn:1000',
    'the first completion after an empty startup is a real edge');
  assert.strictEqual(source._buildModel().completionEdge, undefined, 'reread does not relatch');

  const sameSecond = new CopilotSource({
    sessionStoreDb: '/nonexistent', logsDir: '/nonexistent', sessionStateDir: '/nonexistent',
    settingsJson: '/nonexistent', busyWindowMs: 1, activeWindowMs: 1, maxEntries: 1,
    completedHoldMs: 6000, perm: {},
  });
  const markers = [
    { id: '10', time: new Date(2000) },
    { id: '11', time: new Date(2000) },
  ];
  sameSecond._store = {
    countActiveSessions: () => 0, newestTurnMarker: () => markers.shift() || markers[0],
    recentTurns: () => [],
  };
  sameSecond._log = source._log;
  sameSecond._perm = source._perm;
  sameSecond._readSettings = source._readSettings;
  assert.strictEqual(sameSecond._buildModel().completionEdge, undefined);
  assert.strictEqual(sameSecond._buildModel().completionEdge.id, 'turn:11',
    'row identity detects two completions in the same second');

  const failedBaseline = new CopilotSource({
    sessionStoreDb: '/nonexistent', logsDir: '/nonexistent', sessionStateDir: '/nonexistent',
    settingsJson: '/nonexistent', busyWindowMs: 1, activeWindowMs: 1, maxEntries: 1,
    completedHoldMs: 6000, perm: {},
  });
  const failedThenHistorical = [
    undefined,
    { id: 'historical', time: new Date(3000) },
    { id: 'historical', time: new Date(3000) },
    { id: 'new', time: new Date(4000) },
  ];
  failedBaseline._store = {
    countActiveSessions: () => 0,
    newestTurnMarker: () => failedThenHistorical.shift(),
    recentTurns: () => [],
  };
  failedBaseline._log = source._log;
  failedBaseline._perm = source._perm;
  failedBaseline._readSettings = source._readSettings;
  assert.strictEqual(failedBaseline._buildModel().completionEdge, undefined,
    'a failed first query does not prime the completion source');
  assert.strictEqual(failedBaseline._buildModel().completionEdge, undefined,
    'the first successful historical baseline primes without latching');
  assert.strictEqual(failedBaseline._buildModel().completionEdge, undefined,
    'unchanged historical data remains quiet');
  assert.strictEqual(failedBaseline._buildModel().completionEdge.id, 'turn:new',
    'a row inserted after the successful baseline still latches');
})();

(function passiveEdgesAreNamespacedBySessionFile() {
  const watch = new (require('../src/copilot/permwatch').PermissionWatch)({
    sessionStateDir: '/nonexistent', perm: { minAgeMs: 0 },
  });
  const makeState = (session) => ({
    partial: '', pending: null, waitingUser: false, waitingSince: 0,
    edgeNamespace: `/sessions/${session}/events.jsonl`,
  });
  const consume = (state, type, data, id, timestamp) => {
    watch._consume(state, JSON.stringify({ type, id, timestamp, data }) + '\n');
    return watch.edgeIds;
  };
  const cases = [
    ['prompt', 'permission.requested', {
      requestId: 'shared-request', permissionRequest: { kind: 'shell' },
    }, null],
    ['user', 'user.message', { messageId: 'shared-message' }, 'shared-message'],
    ['tool', 'tool.execution_start', {
      toolCallId: 'shared-tool', toolName: 'shell',
    }, 'shared-tool'],
  ];

  for (const [category, type, data, id] of cases) {
    const first = consume(makeState('one'), type, data, id, '1970-01-01T00:00:01.000Z');
    const firstId = first[category].id;
    const second = consume(makeState('two'), type, data, id, '1970-01-01T00:00:02.000Z');
    assert.notStrictEqual(second[category].id, firstId,
      `${category} identity includes its session file`);

    const rig = new Bridge(new TestTransport(), cfg, { now: () => 1500, randomUint32: () => 100 });
    rig.setModel(model({ edgeIds: first }));
    rig.completionLatch.completePassive({ outcome: 'success' });
    rig.setModel(model({ edgeIds: second }));
    assert.strictEqual(rig.completionLatch.current, null,
      `same ${category} id in another session clears the latch`);
  }
})();

(function malformedTransportMessagesAreIgnored() {
  const central = new (require('../src/ble/central').BleCentral)({
    ble: { fallbackChunk: 20, namePrefix: 'Copilot' },
  });
  const bridge = new Bridge(central, cfg, { now: () => 2000, randomUint32: () => 101 });
  bridge.completionLatch.completePassive({ outcome: 'success' });
  const generation = bridge.completionLatch.current.g;
  const ignored = [
    'null', '[]', 'true', '42', '"text"',
    '{"cmd":"completion"',
    '{"cmd":"completion","sg":100,"g":1,"action":"dismiss"}',
    '{"cmd":"completion","sg":101,"g":2,"action":"dismiss"}',
    '{"cmd":"completion","sg":101,"g":1,"action":"other"}',
  ];
  for (const line of ignored) {
    assert.doesNotThrow(() => central._onDeviceLine(line));
    assert.strictEqual(bridge.completionLatch.current.g, generation,
      `transport line must not alter latch: ${line}`);
  }
  central._onDeviceLine('{"cmd":"completion","sg":101,"g":1,"action":"dismiss"}');
  assert.strictEqual(bridge.completionLatch.current, null, 'exact transport dismissal clears');
})();

(function logReplayDoesNotCreateWorkEdge() {
  const tail = new CopilotLogTail({ logsDir: '/nonexistent' });
  const line = 'Start of group: Sending request to the AI model\n';
  tail._consume(line, true);
  assert.strictEqual(tail.aiRequestGeneration, 1);
  tail._groupStack = [];
  tail._aiOpen = 0;
  tail._consume(line, false);
  assert.strictEqual(tail.aiRequestGeneration, 1, 'truncation replay does not advance identity');
  assert.strictEqual(tail.aiActive, true, 'truncation replay still reconstructs open group state');
})();

(function budgetKeepsRequiredLatchCore() {
  const huge = '\u0001"\\'.repeat(2500);
  const snap = buildSnapshot({
    total: 255,
    running: 255,
    waiting: 255,
    completed: true,
    msg: huge,
    entries: Array(8).fill(huge),
    prompt: { id: huge, tool: huge, hint: huge },
    sessionRows: Array.from({ length: 8 }, (_, i) => ({
      session_id: `s-${i}`,
      pal_id: 'owl',
      palette: { body: 1, bg: 2, text: 3, text_dim: 4, ink: 5 },
      state: 'blocked',
      summary: huge,
    })),
    completionEpoch: 123,
    completion: { g: 7, o: 1, i: '0123456789ab', p: 7, c: [1, 2, 3, 4, 5], m: huge, d: 9 },
  });
  assert.ok(serializedBytes(snap) <= HARD_CEILING);
  assert.strictEqual(snap.sg, 123);
  assert.strictEqual(snap.sc.g, 7);
  assert.strictEqual(snap.sc.o, 1);
  const palKeys = ['i', 'p', 'c', 'm'].filter((key) => Object.prototype.hasOwnProperty.call(snap.sc, key));
  assert.ok(palKeys.length === 0 || palKeys.length === 4, 'completed pal metadata degrades all-or-none');
  assert.deepStrictEqual(
    shapeCompletion({ g: 1, o: 0, i: 'not-12-hex', p: 1, c: [1, 2, 3, 4, 5], m: 'bad' }),
    { g: 1, o: 0 },
    'invalid completion identity drops the whole metadata tuple'
  );
  assert.deepStrictEqual(
    shapeCompletion({ g: 1, o: 0, i: '0123456789ab', p: 1, c: [1, 2, 3, 4], m: 'bad' }),
    { g: 1, o: 0 },
    'a non-five-color palette drops the whole metadata tuple'
  );
})();

async function fakeCapabilityAdvertisement() {
  const legacy = new FakeDeviceTransport({ autoAnswer: false });
  const capable = new FakeDeviceTransport({ autoAnswer: false, completionLatch: true });
  const legacyAck = new Promise((resolve) => legacy.once('line', resolve));
  const capableAck = new Promise((resolve) => capable.once('line', resolve));
  legacy.writeLine({ cmd: 'status' });
  capable.writeLine({ cmd: 'status' });
  assert.strictEqual((await legacyAck).data.cl, undefined, 'fake defaults to legacy status');
  assert.strictEqual((await capableAck).data.cl, 1, 'fake can opt into cl:1');
}

fakeCapabilityAdvertisement()
  .then(() => console.log(
    'PASS: completion latch state, wire capability, semantic clears, reconnect, and budget'
  ))
  .catch((err) => { console.error(err); process.exit(1); });

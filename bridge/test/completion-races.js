'use strict';

// Regressions for the two completion-latch races found in review:
//
//   1. The passive turn row that persists an explicitly completed task is written
//      *after* companion_task_complete, so the old "echo is older than the
//      latch" guard never fired and the explicit owner/outcome/duration was
//      downgraded to an anonymous success one snapshot later.
//   2. After a reconnect the bridge forgets the device is completion-capable
//      and, until the next status poll, speaks the legacy dialect — long
//      enough for a legacy `completed` pulse to wedge the firmware mirror.
//      The bridge half of the fix is asking for capability on connect.

const assert = require('assert');
const EventEmitter = require('events');

process.env.COMPANION_LOG = process.env.COMPANION_LOG || 'error';

const { Bridge, EXPLICIT_ECHO_WINDOW_MS, normalizeCwd } = require('../src/bridge');

class TestTransport extends EventEmitter {
  constructor() { super(); this.connected = true; this.sent = []; }
  writeLine(value) { this.sent.push(value); return Promise.resolve(true); }
  writeSnapshot(value) { this.sent.push(value); return Promise.resolve(true); }
}

const CFG = {
  keepaliveMs: 10000,
  statusPollMs: 60000,
  confirm: { maxQueue: 8 },
  sessions: {
    defaultTtlMs: 90000, minTtlMs: 5000, maxTtlMs: 3600000,
    maxSessions: 64, endedLingerMs: 10000, deviceProjectionMax: 8,
  },
};

const EDGES = Object.freeze({
  prompt: { id: 'prompt-seed', at: 500 },
  user: { id: 'user-seed', at: 500 },
  tool: { id: 'tool-seed', at: 500 },
  aiRequest: { id: 'ai-seed', at: 500 },
});

function passive(overrides = {}) {
  return {
    total: 0, running: 0, waiting: 0, completed: false, msg: 'idle', entries: [],
    edgeIds: EDGES, ...overrides,
  };
}

function makeRig({ now = 100000, epoch = 4242, statusPollMs } = {}) {
  let clock = now;
  const transport = new TestTransport();
  const cfg = statusPollMs ? { ...CFG, statusPollMs } : CFG;
  const bridge = new Bridge(transport, cfg, { now: () => clock, randomUint32: () => epoch });
  return { bridge, transport, now: () => clock, advance(ms) { clock += ms; return clock; } };
}

function advertise(transport) {
  transport.emit('line', { ack: 'status', ok: true, data: { name: 'test-device', cl: 1 } });
}

// Explicitly complete a configured task so the latch carries an owner tuple,
// a non-success outcome, and a duration — everything an echo could downgrade.
function completeExplicit(
  rig,
  { outcome = 'failed', cwd = '/work/repo', label = 'ship it', conversationId = null } = {}
) {
  rig.bridge.setModel(passive());
  const session = rig.bridge.beginSession({ label, cwd, conversationId, source: 'mcp' });
  rig.bridge.configureSession({
    id: session.session_id, palId: 'dragon', summary: 'compiling the firmware',
  });
  rig.advance(7000);
  rig.bridge.completeTask({ id: session.session_id, outcome });
  const latched = rig.bridge.status.sc;
  assert.ok(latched && latched.i, 'explicit task completion latches an owned completion');
  return { session, latched: JSON.parse(JSON.stringify(latched)) };
}

function turnEdge(
  rig,
  { id = 'turn:9001', ahead = 1500, cwd = '/work/repo', session } = {}
) {
  const edge = { id, outcome: 'success', at: rig.now() + ahead };
  if (cwd !== undefined) edge.cwd = cwd;
  if (session !== undefined) edge.session = session;
  return edge;
}

// --- race 1: the explicit task completion's own turn-row echo ---------------

(function laterEchoNeverDowngradesAnyOutcome() {
  for (const outcome of ['success', 'failed', 'aborted']) {
    const rig = makeRig();
    advertise(rig.transport);
    const { session, latched } = completeExplicit(rig, { outcome });

    // The real turn row lands two polls later with a *newer* timestamp.
    rig.advance(2000);
    rig.bridge.setModel(passive({ completionEdge: turnEdge(rig) }));

    assert.deepStrictEqual(rig.bridge.status.sc, latched,
      `${outcome}: later turn-row echo must not touch the explicit slot`);
    const current = rig.bridge.completionLatch.current;
    assert.strictEqual(current.owner, session.session_id, `${outcome}: latch keeps its owner`);
    assert.strictEqual(current.d, 7, `${outcome}: duration is not erased`);
    assert.strictEqual(current.pal.p, 5, `${outcome}: the completed pal is not erased`);
  }
})();

(function suppressionIsOneShot() {
  const rig = makeRig();
  advertise(rig.transport);
  const { latched } = completeExplicit(rig);

  rig.advance(1000);
  rig.bridge.setModel(passive({ completionEdge: turnEdge(rig, { id: 'turn:echo' }) }));
  assert.deepStrictEqual(rig.bridge.status.sc, latched, 'the echo is swallowed once');

  // A second, distinct turn row is a genuinely different completion even with
  // no interaction edge in between: one turn writes exactly one row.
  rig.advance(1000);
  rig.bridge.setModel(passive({ completionEdge: turnEdge(rig, { id: 'turn:second' }) }));
  assert.strictEqual(rig.bridge.status.sc.o, 0, 'a second completion applies');
  assert.strictEqual(rig.bridge.status.sc.g, latched.g + 1, 'and advances the generation');
  assert.ok(!rig.bridge.status.sc.i, 'the second completion is ownerless/passive');
})();

(function interveningWorkDisablesSuppression() {
  for (const key of ['user', 'tool', 'aiRequest', 'prompt']) {
    const rig = makeRig();
    advertise(rig.transport);
    const { latched } = completeExplicit(rig, { conversationId: 'copilot-a' });

    rig.advance(1000);
    const started = rig.now();
    rig.bridge.setModel(passive({
      edgeIds: {
        ...EDGES,
        [key]: { id: `${key}-new-work`, at: started, session: 'copilot-a' },
      },
    }));
    assert.ok(!rig.bridge.status.sc, `${key}: new work clears the latch outright`);

    rig.advance(3000);
    rig.bridge.setModel(passive({
      edgeIds: {
        ...EDGES,
        [key]: { id: `${key}-new-work`, at: started, session: 'copilot-a' },
      },
      completionEdge: turnEdge(rig, {
        id: 'turn:after-new-work',
        session: 'copilot-a',
      }),
    }));
    const after = rig.bridge.status.sc;
    assert.ok(after, `${key}: the completion after new work is latched, not suppressed`);
    assert.strictEqual(after.o, 0);
    assert.ok(!after.i, `${key}: the new latch is passive/ownerless`);
    assert.ok(after.g > latched.g, `${key}: generation advances for real new work`);
  }
})();

(function differentSessionCwdIsNotSuppressed() {
  const rig = makeRig();
  advertise(rig.transport);
  const { latched } = completeExplicit(rig, { cwd: '/work/repo' });

  rig.advance(1200);
  rig.bridge.setModel(passive({
    completionEdge: turnEdge(rig, { id: 'turn:other-session', cwd: '/work/other-repo' }),
  }));
  assert.strictEqual(rig.bridge.status.sc.o, 0,
    'a completion from another working directory is different work');
  assert.strictEqual(rig.bridge.status.sc.g, latched.g + 1);
})();

(function correlatedEchoesAreSuppressed() {
  const cases = [
    {
      label: 'same cwd modulo separator',
      session: { cwd: '/work/repo' },
      edge: { cwd: '/work/repo/' },
    },
    {
      label: 'matching Copilot session identity, unknown edge cwd',
      session: { cwd: '/work/repo', conversationId: 'copilot-a' },
      edge: { cwd: null, session: 'copilot-a' },
    },
    {
      label: 'matching identity outweighs a different cwd',
      session: { cwd: '/work/repo', conversationId: 'copilot-a' },
      edge: { cwd: '/work/elsewhere', session: 'copilot-a' },
    },
  ];
  for (const { session, edge, label } of cases) {
    const rig = makeRig();
    advertise(rig.transport);
    const { latched } = completeExplicit(rig, session);
    rig.advance(1200);
    rig.bridge.setModel(passive({
      completionEdge: turnEdge(rig, { id: 'turn:echo', ...edge }),
    }));
    assert.deepStrictEqual(rig.bridge.status.sc, latched, `${label}: echo suppressed`);
    assert.strictEqual(rig.bridge.explicitEchoGuardCount, 0,
      `${label}: and consumed exactly one guard`);
  }
  assert.strictEqual(normalizeCwd('/work/repo//'), '/work/repo');
  assert.strictEqual(normalizeCwd('   '), null);
  assert.strictEqual(normalizeCwd(null), null);
})();

// Reviewer repro: an uncorrelated guard used to rank as a generic match, so a
// completion that identified itself as *different* work could be swallowed by
// it. Correlation is positive-only now — agreement on session identity or on
// cwd — and everything else is ordinary evidence that latches normally while
// the guard stays armed for its own, correlatable echo.
(function uncorrelatedEdgesLatchAndConsumeNothing() {
  const cases = [
    { label: 'unknown edge cwd', session: { cwd: '/work/repo' }, edge: { cwd: null } },
    { label: 'unknown session cwd', session: { cwd: null }, edge: { cwd: '/work/repo' } },
    { label: 'no identity at all', session: { cwd: null }, edge: { cwd: null } },
    {
      label: 'edge names a different session than the guard',
      session: { cwd: '/work/repo', conversationId: 'copilot-a' },
      edge: { cwd: null, session: 'copilot-b' },
    },
    {
      label: 'edge names a session the guard cannot claim',
      session: { cwd: null },
      edge: { cwd: null, session: 'copilot-b' },
    },
  ];
  for (const { session, edge, label } of cases) {
    const rig = makeRig();
    advertise(rig.transport);
    const { latched } = completeExplicit(rig, session);
    rig.advance(1200);
    rig.bridge.setModel(passive({
      completionEdge: turnEdge(rig, { id: 'turn:unrelated', ...edge }),
    }));
    const after = rig.bridge.status.sc;
    assert.strictEqual(after.g, latched.g + 1, `${label}: uncorrelated evidence latches`);
    assert.ok(!after.i, `${label}: and latches ownerless`);
    assert.strictEqual(rig.bridge.explicitEchoGuardCount, 1,
      `${label}: the guard is untouched and still waits for its own echo`);
  }
})();

(function suppressionExpires() {
  const rig = makeRig();
  advertise(rig.transport);
  const { latched } = completeExplicit(rig);

  rig.advance(EXPLICIT_ECHO_WINDOW_MS + 1);
  rig.bridge.setModel(passive({ completionEdge: turnEdge(rig, { id: 'turn:very-late' }) }));
  assert.strictEqual(rig.bridge.status.sc.o, 0, 'past the window the edge is ordinary evidence');
  assert.strictEqual(rig.bridge.status.sc.g, latched.g + 1);

  const inside = makeRig();
  advertise(inside.transport);
  const still = completeExplicit(inside).latched;
  inside.advance(EXPLICIT_ECHO_WINDOW_MS - 1);
  inside.bridge.setModel(passive({ completionEdge: turnEdge(inside, { id: 'turn:late', ahead: 0 }) }));
  assert.deepStrictEqual(inside.bridge.status.sc, still, 'inside the window the echo is suppressed');
})();

(function dismissalClearsTheCardButKeepsTheGuardArmed() {
  // Dismissing the card the user just read must not un-finish the turn: the
  // echo of that same turn is still in flight and must still be swallowed,
  // otherwise the completion the user dismissed walks straight back on as a
  // fresh anonymous success card with a new generation.
  for (const outcome of ['failed', 'aborted', 'success']) {
    const dismissed = makeRig();
    advertise(dismissed.transport);
    const { latched } = completeExplicit(dismissed, { outcome });
    dismissed.transport.emit('line', {
      cmd: 'completion', sg: dismissed.bridge.status.sg, g: latched.g, action: 'dismiss',
    });
    assert.ok(!dismissed.bridge.status.sc, `${outcome}: device dismissal clears the slot`);
    assert.strictEqual(dismissed.bridge.explicitEchoGuardCount, 1,
      `${outcome}: dismissal does not disarm the guard for the turn that just ended`);

    dismissed.advance(1000);
    dismissed.bridge.setModel(passive({
      completionEdge: turnEdge(dismissed, { id: 'turn:after-dismiss' }),
    }));
    assert.ok(!dismissed.bridge.status.sc,
      `${outcome}: the dismissed completion's own echo stays swallowed`);
    assert.strictEqual(dismissed.bridge.completionLatch.current, null,
      `${outcome}: and creates no new generation behind the scenes`);
    assert.strictEqual(dismissed.bridge.explicitEchoGuardCount, 0,
      `${outcome}: the echo consumed the guard exactly once`);

    // Genuinely later work still latches: the guard was one-shot, not a mute.
    dismissed.advance(1000);
    dismissed.bridge.setModel(passive({
      completionEdge: turnEdge(dismissed, { id: 'turn:real-next-work' }),
    }));
    const next = dismissed.bridge.status.sc;
    assert.ok(next && next.o === 0 && !next.i,
      `${outcome}: a later independent completion still latches passively`);
    assert.strictEqual(next.g, latched.g + 1, `${outcome}: and advances the generation once`);
  }

  const restarted = makeRig();
  advertise(restarted.transport);
  const { session } = completeExplicit(restarted);
  restarted.bridge.updateSession({
    id: session.session_id,
    state: 'working',
    message: 'next task',
  });
  assert.ok(!restarted.bridge.status.sc, 'a new explicit cycle clears the slot');
  restarted.advance(1000);
  restarted.bridge.setModel(passive({ completionEdge: turnEdge(restarted, { id: 'turn:next' }) }));
  assert.ok(restarted.bridge.status.sc, 'and disarms the guard for the new cycle');
  assert.strictEqual(restarted.bridge.status.sc.o, 0);
})();

// --- race 2 (bridge half): capability is requested on connect ---------------

async function capabilityIsRequestedOnConnect() {
  const rig = makeRig({ statusPollMs: 40 });
  const bridge = rig.bridge;
  advertise(rig.transport);
  const { latched } = completeExplicit(rig);
  assert.strictEqual(bridge.completionCapable, true);

  rig.transport.connected = false;
  rig.transport.emit('disconnected');
  assert.strictEqual(bridge.completionCapable, false,
    'capability knowledge resets, so heartbeats go legacy-shaped');

  rig.transport.connected = true;
  rig.transport.sent.length = 0;
  rig.transport.emit('connected', 'test-device');
  await new Promise((resolve) => setImmediate(resolve));

  const asked = rig.transport.sent.filter((line) => line && line.cmd === 'status');
  assert.strictEqual(asked.length, 1,
    'capability is requested during the connect handshake, not a poll interval later');
  const beforeAck = rig.transport.sent.filter((line) => line && line.total !== undefined);
  assert.ok(beforeAck.every((snap) => !Object.prototype.hasOwnProperty.call(snap, 'sg')),
    'snapshots stay legacy-shaped until the ack lands');

  advertise(rig.transport);
  assert.strictEqual(bridge.completionCapable, true, 'the connect-time ack closes the gap');
  assert.strictEqual(bridge.status.sg, 4242, 'same process, same epoch');
  assert.deepStrictEqual(bridge.status.sc, latched, 'the live latch is resent unchanged');

  await new Promise((resolve) => setTimeout(resolve, 100));
  const polled = rig.transport.sent.filter((line) => line && line.cmd === 'status');
  assert.ok(polled.length >= 2, 'the periodic status poll is still running');
  bridge.stop();
}

capabilityIsRequestedOnConnect()
  .then(() => console.log(
    'PASS: explicit-task echo suppression (identity, one-shot, window) and connect-time capability'
  ))
  .catch((error) => { console.error(error.stack || error.message || String(error)); process.exit(1); });

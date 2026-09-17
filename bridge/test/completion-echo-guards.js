'use strict';

// Regressions for concurrent explicit-task-completion echo guards.
//
// The single `_explicitEcho` slot could only remember one completed task: when
// two agents completed inside the same window, the second event overwrote the first
// guard, the first session's turn-row echo consumed the survivor, and the
// second session's own echo then found nothing armed and downgraded an owned
// failed/aborted card to an anonymous passive success one (new generation, no
// pal, no duration — the introduction replays on the device).
//
// The guards are now a small bounded FIFO keyed by the live session
// (owner + latched generation) and correlated by working directory:
//   * a guard whose cwd is known and differs from the edge's known cwd is not a
//     candidate,
//   * exact cwd match beats an unknown on either side; within a tier the oldest
//     armed guard wins, so A/B and B/A echo order give the same result,
//   * exactly one guard is consumed per suppressed edge, and an edge that
//     matches nothing consumes nothing and latches normally,
//   * a device dismissal clears the displayed card but leaves the guards armed:
//     the dismissed turn is still finished, so its pending echo must still be
//     swallowed rather than reappearing as a fresh anonymous card.

const assert = require('assert');
const EventEmitter = require('events');

process.env.COMPANION_LOG = process.env.COMPANION_LOG || 'error';

const {
  Bridge,
  EXPLICIT_ECHO_WINDOW_MS,
  MAX_EXPLICIT_ECHO_GUARDS,
} = require('../src/bridge');

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

function makeRig({ now = 100000, epoch = 4242 } = {}) {
  let clock = now;
  const transport = new TestTransport();
  const bridge = new Bridge(transport, CFG, { now: () => clock, randomUint32: () => epoch });
  transport.emit('line', { ack: 'status', ok: true, data: { name: 'test-device', cl: 1 } });
  bridge.setModel(passive());
  return { bridge, transport, now: () => clock, advance(ms) { clock += ms; return clock; } };
}

// Begin + configure so the latch can carry a pal. The guards only exist between
// task completion and its passive echo; a later active state is a new cycle.
function start(
  rig,
  { label, cwd, conversationId = null, pal = 'dragon', summary = 'compiling the firmware' }
) {
  const session = rig.bridge.beginSession({ label, cwd, conversationId, source: 'mcp' });
  rig.bridge.configureSession({ id: session.session_id, palId: pal, summary });
  return session;
}

function complete(rig, session, outcome) {
  rig.bridge.completeTask({ id: session.session_id, outcome });
  const latched = rig.bridge.status.sc;
  assert.ok(latched && latched.i, 'explicit task completion latches an owned completion');
  return JSON.parse(JSON.stringify(latched));
}

function echo(rig, { id, cwd, session, ahead = 1500 }) {
  const edge = { id, outcome: 'success', at: rig.now() + ahead };
  if (cwd !== undefined) edge.cwd = cwd;
  if (session !== undefined) edge.session = session;
  rig.advance(400);
  rig.bridge.setModel(passive({ completionEdge: edge }));
}

function snapshotOfLatch(rig) {
  const current = rig.bridge.completionLatch.current;
  return current && {
    g: current.g, o: current.o, d: current.d, owner: current.owner,
    pal: current.pal && { i: current.pal.i, p: current.pal.p, m: current.pal.m },
  };
}

// --- reviewer repros: two explicit completions inside one window -----------

(function twoEndsSuppressTheirOwnEchoesInEitherOrder() {
  const cases = [
    {
      label: 'A success then B failed, same cwd',
      a: { cwd: '/work/repo', outcome: 'success', pal: 'cat' },
      b: { cwd: '/work/repo', outcome: 'failed', pal: 'dragon' },
    },
    {
      label: 'A failed then B aborted, different cwd',
      a: { cwd: '/work/alpha', outcome: 'failed', pal: 'cat' },
      b: { cwd: '/work/beta', outcome: 'aborted', pal: 'dragon' },
    },
    {
      // Shared directory, so only the Copilot session identity tells the two
      // echoes apart.
      label: 'A aborted then B success, same cwd, identity on the wire',
      a: {
        cwd: '/work/repo', outcome: 'aborted', pal: 'cat',
        conversationId: 'copilot-a', edgeSession: 'copilot-a', edgeCwd: null,
      },
      b: {
        cwd: '/work/repo', outcome: 'success', pal: 'dragon',
        conversationId: 'copilot-b', edgeSession: 'copilot-b', edgeCwd: null,
      },
    },
  ];

  for (const { label, a, b } of cases) {
    for (const order of ['A/B', 'B/A']) {
      const rig = makeRig();
      const sa = start(rig, {
        label: 'task a', cwd: a.cwd, pal: a.pal, summary: 'alpha work',
        conversationId: a.conversationId || null,
      });
      const sb = start(rig, {
        label: 'task b', cwd: b.cwd, pal: b.pal, summary: 'beta work',
        conversationId: b.conversationId || null,
      });

      rig.advance(7000);
      complete(rig, sa, a.outcome);
      rig.advance(3000);
      const owned = complete(rig, sb, b.outcome);
      const ownedLatch = snapshotOfLatch(rig);
      assert.strictEqual(ownedLatch.owner, sb.session_id, `${label}: B owns the visible card`);
      assert.strictEqual(rig.bridge.explicitEchoGuardCount, 2,
        `${label}: B's completion does not disarm A's pending echo`);

      const echoes = {
        A: () => echo(rig, {
          id: 'turn:a', cwd: 'edgeCwd' in a ? a.edgeCwd : a.cwd, session: a.edgeSession,
        }),
        B: () => echo(rig, {
          id: 'turn:b', cwd: 'edgeCwd' in b ? b.edgeCwd : b.cwd, session: b.edgeSession,
        }),
      };
      for (const which of order.split('/')) echoes[which]();

      assert.deepStrictEqual(rig.bridge.status.sc, owned,
        `${label} (${order}): both echoes are suppressed, B's wire slot is untouched`);
      assert.deepStrictEqual(snapshotOfLatch(rig), ownedLatch,
        `${label} (${order}): B keeps its outcome, pal, duration and generation`);
      assert.strictEqual(rig.bridge.explicitEchoGuardCount, 0,
        `${label} (${order}): each echo consumed exactly one guard`);
    }
  }
})();

(function everyGuardIsStillOneShot() {
  const rig = makeRig();
  const sa = start(rig, { label: 'task a', cwd: '/work/repo' });
  const sb = start(rig, { label: 'task b', cwd: '/work/repo' });
  rig.advance(5000);
  complete(rig, sa, 'success');
  const owned = complete(rig, sb, 'failed');

  echo(rig, { id: 'turn:a', cwd: '/work/repo' });
  echo(rig, { id: 'turn:b', cwd: '/work/repo' });
  assert.deepStrictEqual(
    rig.bridge.status.sc,
    owned,
    'two task completions swallow exactly two echoes'
  );

  // A third turn row is genuinely new work: one turn writes one row.
  echo(rig, { id: 'turn:third', cwd: '/work/repo' });
  const after = rig.bridge.status.sc;
  assert.strictEqual(after.o, 0, 'the third completion applies');
  assert.strictEqual(after.g, owned.g + 1, 'and advances the generation exactly once');
  assert.ok(!after.i, 'the third completion is ownerless/passive');
})();

// --- non-matching edges consume nothing ------------------------------------

(function unrelatedCwdNeitherSuppressesNorConsumes() {
  const rig = makeRig();
  const sa = start(rig, { label: 'task a', cwd: '/work/alpha' });
  const sb = start(rig, { label: 'task b', cwd: '/work/beta' });
  rig.advance(4000);
  complete(rig, sa, 'failed');
  const owned = complete(rig, sb, 'aborted');

  echo(rig, { id: 'turn:gamma', cwd: '/work/gamma' });
  const latchedPassive = rig.bridge.status.sc;
  assert.strictEqual(latchedPassive.o, 0, 'a third directory is genuinely independent work');
  assert.strictEqual(latchedPassive.g, owned.g + 1);
  assert.ok(!latchedPassive.i, 'and it latches ownerless');
  assert.strictEqual(rig.bridge.explicitEchoGuardCount, 2,
    'a non-matching edge must not consume either guard');

  // The still-armed guards answer their own echoes without resurrecting the
  // older explicit cards.
  echo(rig, { id: 'turn:a', cwd: '/work/alpha' });
  echo(rig, { id: 'turn:b', cwd: '/work/beta' });
  assert.deepStrictEqual(rig.bridge.status.sc, latchedPassive,
    'suppressed echoes never resurrect an older card');
  assert.strictEqual(rig.bridge.explicitEchoGuardCount, 0);
})();

(function sessionIdentityBeatsCwdCorrelation() {
  const rig = makeRig();
  // Both tasks run in the same directory, so cwd cannot tell their echoes
  // apart; the Copilot session identity can.
  const sa = start(rig, {
    label: 'task a', cwd: '/work/repo', conversationId: 'copilot-a',
  });
  const sb = start(rig, {
    label: 'task b', cwd: '/work/repo', conversationId: 'copilot-b',
  });
  rig.advance(4000);
  complete(rig, sa, 'failed');
  const owned = complete(rig, sb, 'aborted');

  // The row names B: the identity match wins over the older, equally
  // cwd-matching guard that FIFO would otherwise pick.
  echo(rig, { id: 'turn:b', cwd: '/work/repo', session: 'copilot-b' });
  assert.deepStrictEqual(rig.bridge.status.sc, owned, "B's echo is suppressed");
  assert.strictEqual(rig.bridge.explicitEchoGuardCount, 1, "A's guard is still armed");

  echo(rig, { id: 'turn:a', cwd: '/work/repo', session: 'copilot-a' });
  assert.deepStrictEqual(rig.bridge.status.sc, owned, "A's echo is suppressed by its own guard");
  assert.strictEqual(rig.bridge.explicitEchoGuardCount, 0);
})();

// Reviewer repro: a guard that knows neither a conversation id nor a cwd used
// to rank as a generic match, so a completion that positively identified a
// *different* Copilot session was swallowed by it. The unrelated completion
// disappeared from the display, and the uncorrelatable task's own echo later
// latched as an anonymous passive success.
(function uncorrelatedGuardsNeverSuppressAKnownSessionCompletion() {
  const rig = makeRig();
  const blind = start(rig, { label: 'no identity', cwd: null });
  const known = start(rig, {
    label: 'known', cwd: '/work/beta', conversationId: 'copilot-b',
  });
  rig.advance(4000);
  complete(rig, blind, 'failed');
  const owned = complete(rig, known, 'aborted');
  assert.strictEqual(rig.bridge.explicitEchoGuardCount, 2);

  // A third, genuinely unrelated conversation finishes work.
  echo(rig, { id: 'turn:c', cwd: '/work/gamma', session: 'copilot-c' });
  const latchedPassive = rig.bridge.status.sc;
  assert.strictEqual(latchedPassive.g, owned.g + 1,
    'an unrelated session completion latches instead of being eaten by a blind guard');
  assert.ok(!latchedPassive.i, 'and latches ownerless');
  assert.strictEqual(rig.bridge.explicitEchoGuardCount, 2,
    'neither guard is consumed by work it cannot be correlated with');

  // The correlatable guard still answers its own echo.
  echo(rig, { id: 'turn:b', cwd: '/work/beta', session: 'copilot-b' });
  assert.deepStrictEqual(rig.bridge.status.sc, latchedPassive,
    "B's echo is suppressed and resurrects nothing");
  assert.strictEqual(rig.bridge.explicitEchoGuardCount, 1,
    'the blind guard is left to its bounded expiry');

  rig.advance(EXPLICIT_ECHO_WINDOW_MS + 1);
  assert.strictEqual(rig.bridge.explicitEchoGuardCount, 0,
    'and it lapses with the window rather than swallowing later work');
})();

// --- bounded memory --------------------------------------------------------

(function guardsAreBoundedAndEvictOldestFirst() {
  const rig = makeRig();
  const total = MAX_EXPLICIT_ECHO_GUARDS + 1;
  const sessions = [];
  for (let i = 0; i < total; i++) {
    sessions.push(start(rig, { label: `task ${i}`, cwd: `/work/r${i}` }));
  }
  rig.advance(3000);
  let owned = null;
  for (let i = 0; i < total; i++) owned = complete(rig, sessions[i], 'failed');
  assert.strictEqual(rig.bridge.explicitEchoGuardCount, MAX_EXPLICIT_ECHO_GUARDS,
    'guard memory is bounded by the configured maximum');

  // The surviving guards each answer their own echo.
  for (let i = 1; i < total; i++) echo(rig, { id: `turn:r${i}`, cwd: `/work/r${i}` });
  assert.deepStrictEqual(rig.bridge.status.sc, owned,
    'every retained guard suppressed its own echo, newest card untouched');
  assert.strictEqual(rig.bridge.explicitEchoGuardCount, 0);

  // The evicted (oldest) guard is gone deterministically: its echo is ordinary
  // evidence now.
  echo(rig, { id: 'turn:r0', cwd: '/work/r0' });
  assert.strictEqual(rig.bridge.status.sc.g, owned.g + 1,
    'the evicted guard no longer suppresses — eviction is oldest-first');
  assert.ok(!rig.bridge.status.sc.i);
})();

(function expiredGuardsArePrunedNotRetained() {
  const rig = makeRig();
  const sa = start(rig, { label: 'task a', cwd: '/work/alpha' });
  const sb = start(rig, { label: 'task b', cwd: '/work/beta' });
  rig.advance(2000);
  const first = complete(rig, sa, 'failed');
  rig.advance(2000);
  const owned = complete(rig, sb, 'aborted');
  assert.ok(owned.g > first.g, 'the newest explicit completion is the one displayed');

  rig.advance(EXPLICIT_ECHO_WINDOW_MS + 1);
  assert.strictEqual(rig.bridge.explicitEchoGuardCount, 0, 'expired guards are pruned');

  echo(rig, { id: 'turn:a-late', cwd: '/work/alpha' });
  assert.strictEqual(rig.bridge.status.sc.g, owned.g + 1,
    'past the window a turn row is ordinary evidence again');
  assert.ok(!rig.bridge.status.sc.i);
})();

// --- disarm edges ----------------------------------------------------------

(function semanticWorkDisarmsOnlyTheMatchingConversationGuard() {
  for (const key of ['prompt', 'user', 'tool', 'aiRequest']) {
    const rig = makeRig();
    const sa = start(rig, {
      label: 'task a', cwd: '/work/alpha', conversationId: 'copilot-a',
    });
    const sb = start(rig, {
      label: 'task b', cwd: '/work/beta', conversationId: 'copilot-b',
    });
    rig.advance(3000);
    complete(rig, sa, 'failed');
    const owned = complete(rig, sb, 'aborted');

    rig.advance(1000);
    const started = rig.now();
    rig.bridge.setModel(passive({
      edgeIds: {
        ...EDGES,
        [key]: { id: `${key}-new-work`, at: started, session: 'copilot-b' },
      },
    }));
    assert.ok(!rig.bridge.status.sc, `${key}: new work clears the latch`);
    assert.strictEqual(rig.bridge.explicitEchoGuardCount, 1,
      `${key}: B's new work leaves A's pending echo guard armed`);

    rig.advance(3000);
    echo(rig, {
      id: 'turn:a-echo',
      cwd: '/work/alpha',
      session: 'copilot-a',
    });
    assert.ok(!rig.bridge.status.sc, `${key}: A's delayed echo is still suppressed`);
    assert.strictEqual(rig.bridge.explicitEchoGuardCount, 0);

    rig.bridge.setModel(passive({
      edgeIds: {
        ...EDGES,
        [key]: { id: `${key}-new-work`, at: started, session: 'copilot-b' },
      },
      completionEdge: {
        id: 'turn:after-new-work',
        outcome: 'success',
        at: rig.now() + 1500,
        session: 'copilot-b',
        cwd: '/work/beta',
      },
    }));
    const after = rig.bridge.status.sc;
    assert.ok(after && after.o === 0 && !after.i,
      `${key}: the completion after real new work latches passively`);
    assert.ok(after.g > owned.g, `${key}: and advances the generation`);
  }
})();

(function explicitNewCycleDisarmsOnlyItsOwnGuard() {
  const rig = makeRig();
  const sa = start(rig, {
    label: 'task a', cwd: '/work/alpha', conversationId: 'copilot-a',
  });
  const sb = start(rig, {
    label: 'task b', cwd: '/work/beta', conversationId: 'copilot-b',
  });
  rig.bridge.updateSession({ id: sb.session_id, state: 'idle' });
  rig.advance(3000);
  complete(rig, sa, 'failed');

  rig.bridge.updateSession({ id: sb.session_id, state: 'working', message: 'next task' });
  assert.ok(!rig.bridge.status.sc, 'new work in B clears the visible completion card');
  assert.strictEqual(rig.bridge.explicitEchoGuardCount, 1,
    "new work in B does not disarm A's delayed-echo guard");

  echo(rig, { id: 'turn:a', cwd: '/work/alpha', session: 'copilot-a' });
  assert.ok(!rig.bridge.status.sc, "A's delayed echo remains suppressed");
  assert.strictEqual(rig.bridge.explicitEchoGuardCount, 0);
})();

(function dismissalAndUnrelatedCyclesKeepGuardsArmed() {
  // A dismissal is a display action: it clears the card the user just read. It
  // does not un-finish the turns behind the armed guards, so every pending echo
  // must still be swallowed — in either arrival order — instead of resurfacing
  // as a fresh anonymous card the user never asked for.
  for (const order of ['A/B', 'B/A']) {
    const dismissed = makeRig();
    const da = start(dismissed, { label: 'task a', cwd: '/work/alpha' });
    const db = start(dismissed, { label: 'task b', cwd: '/work/beta' });
    dismissed.advance(3000);
    complete(dismissed, da, 'failed');
    const owned = complete(dismissed, db, 'aborted');
    dismissed.transport.emit('line', {
      cmd: 'completion', sg: dismissed.bridge.status.sg, g: owned.g, action: 'dismiss',
    });
    assert.ok(!dismissed.bridge.status.sc, `${order}: the device dismissal clears the slot`);
    assert.strictEqual(dismissed.bridge.explicitEchoGuardCount, 2,
      `${order}: dismissal clears the display, not the guards of completed turns`);

    const echoes = {
      A: () => echo(dismissed, { id: 'turn:a', cwd: '/work/alpha' }),
      B: () => echo(dismissed, { id: 'turn:b', cwd: '/work/beta' }),
    };
    for (const which of order.split('/')) echoes[which]();
    assert.ok(!dismissed.bridge.status.sc,
      `${order}: both pending echoes stay swallowed after the dismissal`);
    assert.strictEqual(dismissed.bridge.completionLatch.current, null,
      `${order}: and no new generation or card is created`);
    assert.strictEqual(dismissed.bridge.explicitEchoGuardCount, 0,
      `${order}: each echo consumed exactly one guard, whichever landed first`);

    // The guards were one-shot, not a mute: real later work still latches.
    echo(dismissed, { id: 'turn:third', cwd: '/work/alpha' });
    const after = dismissed.bridge.status.sc;
    assert.ok(after && after.o === 0 && !after.i,
      `${order}: a genuinely independent completion latches passively`);
    assert.strictEqual(after.g, owned.g + 1, `${order}: and advances the generation exactly once`);
  }

  // An echo that matches no guard is independent work even right after a
  // dismissal, and it never resurrects the dismissed owned card.
  const unmatched = makeRig();
  const ua = start(unmatched, { label: 'task a', cwd: '/work/alpha' });
  unmatched.advance(3000);
  const ownedUnmatched = complete(unmatched, ua, 'failed');
  unmatched.transport.emit('line', {
    cmd: 'completion', sg: unmatched.bridge.status.sg, g: ownedUnmatched.g, action: 'dismiss',
  });
  echo(unmatched, { id: 'turn:gamma', cwd: '/work/gamma' });
  assert.ok(unmatched.bridge.status.sc, 'an unmatched row after a dismissal is ordinary evidence');
  assert.ok(!unmatched.bridge.status.sc.i, 'and never resurrects the dismissed owned card');
  assert.strictEqual(unmatched.bridge.explicitEchoGuardCount, 1,
    "and consumes nothing, so alpha's own echo is still protected");

  const restarted = makeRig();
  const ra = start(restarted, {
    label: 'task a', cwd: '/work/alpha', conversationId: 'copilot-a',
  });
  const rb = start(restarted, {
    label: 'task b', cwd: '/work/beta', conversationId: 'copilot-b',
  });
  restarted.advance(3000);
  complete(restarted, ra, 'failed');
  complete(restarted, rb, 'aborted');
  start(restarted, {
    label: 'task c', cwd: '/work/gamma', conversationId: 'copilot-c',
  });
  assert.ok(!restarted.bridge.status.sc, 'a new explicit cycle clears the slot');
  assert.strictEqual(restarted.bridge.explicitEchoGuardCount, 2,
    'but unrelated sessions keep their pending echo guards');
  echo(restarted, { id: 'turn:a', cwd: '/work/alpha', session: 'copilot-a' });
  assert.ok(!restarted.bridge.status.sc, "A's delayed echo stays suppressed");
  assert.strictEqual(restarted.bridge.explicitEchoGuardCount, 1);
  echo(restarted, { id: 'turn:b', cwd: '/work/beta', session: 'copilot-b' });
  assert.ok(!restarted.bridge.status.sc, "B's delayed echo stays suppressed");
  assert.strictEqual(restarted.bridge.explicitEchoGuardCount, 0);
})();

(function armingOnAnUnownedLatchLeavesOtherGuardsAlone() {
  const rig = makeRig();
  const sa = start(rig, { label: 'task a', cwd: '/work/alpha' });
  rig.advance(3000);
  complete(rig, sa, 'failed');
  assert.strictEqual(rig.bridge.explicitEchoGuardCount, 1);

  // An unrelated directory latches ownerless over the card: there is now no
  // owner to protect, so arming adds nothing — and must not wipe the guard of
  // the session still waiting for its own row.
  echo(rig, { id: 'turn:gamma', cwd: '/work/gamma' });
  const passiveCard = rig.bridge.status.sc;
  assert.ok(passiveCard && !passiveCard.i);
  assert.strictEqual(rig.bridge._armExplicitEcho({ cwd: '/work/beta' }), null,
    'an unowned latch arms no guard');
  assert.strictEqual(rig.bridge.explicitEchoGuardCount, 1, "A's guard survives");

  echo(rig, { id: 'turn:a', cwd: '/work/alpha' });
  assert.deepStrictEqual(rig.bridge.status.sc, passiveCard, "A's echo is still suppressed");
})();

console.log(
  'PASS: concurrent explicit-task echo guards (per-session correlation, order independence, ' +
  'bounded memory, disarm edges)'
);

'use strict';

// Regression for the post-dismissal semantic-edge watermark.
//
// Echo guards used to decide "is this newly observed prompt/user/tool/AI edge
// newer than the completion I am protecting?" by comparing the edge against
// `_completion.current` — the card on the *screen*. A device dismissal clears
// that card, so after a dismissal every newly observed edge took the
// `!current` branch and disarmed every guard, including an edge timestamped
// *before* the protected completion (an old event replayed out of a session
// file that permwatch only just discovered). The task's own turn-row echo then
// found nothing armed, latched as an anonymous passive success, and the card
// the user had just dismissed walked back on with a new generation and a
// downgraded outcome.
//
// The protected completion time now lives in the guards themselves:
//   * `_protectedCompletionAt()` is the newest of the displayed card and every
//     armed guard, so dismissal cannot lower the bar,
//   * an edge at or before that floor is replayed history: it clears nothing,
//     disarms nothing and is not counted as an interaction,
//   * an edge past the floor disarms only the older guards that share its
//     conversation identity, so one session's new work cannot expose another
//     session's delayed completion echo,
//   * an edge with no timestamp orders against nothing: it still clears the
//     displayed card but disarms no guard, and the bounded 30 s window is its
//     backstop, so protection never becomes indefinite.

const assert = require('assert');
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');

process.env.COMPANION_LOG = process.env.COMPANION_LOG || 'error';

const {
  Bridge,
  EXPLICIT_ECHO_WINDOW_MS,
  MAX_EXPLICIT_ECHO_GUARDS,
} = require('../src/bridge');
const { PermissionWatch } = require('../src/copilot/permwatch');

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

const EDGE_KEYS = ['prompt', 'user', 'tool', 'aiRequest'];

const SEED_EDGES = Object.freeze({
  prompt: { id: 'prompt-seed', at: 500 },
  user: { id: 'user-seed', at: 500 },
  tool: { id: 'tool-seed', at: 500 },
  aiRequest: { id: 'ai-seed', at: 500 },
});

function passive(overrides = {}) {
  return {
    total: 0, running: 0, waiting: 0, completed: false, msg: 'idle', entries: [],
    edgeIds: SEED_EDGES, ...overrides,
  };
}

function makeRig({ now = 1000000, epoch = 4242 } = {}) {
  let clock = now;
  const transport = new TestTransport();
  const bridge = new Bridge(transport, CFG, { now: () => clock, randomUint32: () => epoch });
  transport.emit('line', { ack: 'status', ok: true, data: { name: 'test-device', cl: 1 } });
  bridge.setModel(passive());
  return { bridge, transport, now: () => clock, advance(ms) { clock += ms; return clock; } };
}

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

function dismiss(rig, generation) {
  rig.transport.emit('line', {
    cmd: 'completion', sg: rig.bridge.status.sg, g: generation, action: 'dismiss',
  });
  assert.ok(!rig.bridge.status.sc, 'the device dismissal clears the visible card');
}

// A passive interaction edge observed *now* but carrying `at` — the timestamp
// the CLI wrote into the event, which for a replayed file is in the past.
function observeEdge(rig, key, edge, extra = {}) {
  rig.bridge.setModel(passive({ edgeIds: { ...SEED_EDGES, [key]: edge }, ...extra }));
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

// --- reviewer repro: dismissal must not lower the protection floor ---------

(function replayedOldEdgeAfterDismissalKeepsTheGuardArmed() {
  for (const key of EDGE_KEYS) {
    const rig = makeRig();
    const session = start(rig, {
      label: 'firmware', cwd: '/work/alpha', conversationId: 'copilot-alpha',
    });
    rig.advance(5000);
    const owned = complete(rig, session, 'failed');
    const completedAt = rig.now();
    assert.strictEqual(
      rig.bridge.explicitEchoGuardCount,
      1,
      `${key}: task completion arms one guard`
    );

    dismiss(rig, owned.g);
    assert.strictEqual(rig.bridge.explicitEchoGuardCount, 1,
      `${key}: a dismissal clears the display, not the guard`);
    assert.strictEqual(rig.bridge._protectedCompletionAt(), completedAt,
      `${key}: the protection floor is carried by the guard, not by the screen`);

    // Newly *observed* identity, old event timestamp: permwatch found a file
    // whose history predates the completion we are protecting.
    rig.advance(600);
    observeEdge(rig, key, { id: `${key}-replayed`, at: completedAt - 4000 });
    assert.strictEqual(rig.bridge.explicitEchoGuardCount, 1,
      `${key}: an edge older than the protected completion disarms nothing`);

    // The task's own turn row finally lands.
    echo(rig, { id: 'turn:alpha', cwd: '/work/alpha' });
    assert.ok(!rig.bridge.status.sc,
      `${key}: the dismissed card does not come back as a passive success`);
    assert.strictEqual(rig.bridge.completionLatch.current, null,
      `${key}: and no new completion is latched at all`);
    assert.strictEqual(rig.bridge.explicitEchoGuardCount, 0,
      `${key}: the echo consumed exactly one guard`);

    // The suppressed echo consumed no generation either: real later work is
    // still the very next generation after the dismissed card.
    echo(rig, { id: 'turn:later', cwd: '/work/alpha' });
    const later = rig.bridge.status.sc;
    assert.ok(later && !later.i, `${key}: genuinely later work still latches passively`);
    assert.strictEqual(later.g, owned.g + 1,
      `${key}: and advances the generation exactly once`);
  }
})();

(function replayedHistoryIsNotCountedAsAnInteractionAfterDismissal() {
  // The replayed edge must not be treated as "an interaction happened", or the
  // guard's own echo would be filtered out as older-than-the-interaction and
  // left armed until it expired instead of being consumed. Newness is judged
  // against the protected completion, never against a screen that a dismissal
  // has already cleared.
  const rig = makeRig();
  const session = start(rig, { label: 'firmware', cwd: '/work/alpha' });
  rig.advance(5000);
  const owned = complete(rig, session, 'failed');
  const completedAt = rig.now();
  dismiss(rig, owned.g);

  rig.advance(600);
  observeEdge(rig, 'tool', { id: 'tool-replayed', at: completedAt - 4000 });
  // An echo whose own row timestamp predates that replayed edge.
  rig.bridge.setModel(passive({
    completionEdge: {
      id: 'turn:alpha', outcome: 'success', at: completedAt - 5000, cwd: '/work/alpha',
    },
  }));
  assert.ok(!rig.bridge.status.sc, 'the dismissed card stays gone');
  assert.strictEqual(rig.bridge.explicitEchoGuardCount, 0,
    'and the guard answered that echo instead of being stranded by a phantom interaction');
})();

(function edgeExactlyAtTheCompletionTimeIsNotNewer() {
  const rig = makeRig();
  const session = start(rig, { label: 'firmware', cwd: '/work/alpha' });
  rig.advance(5000);
  const owned = complete(rig, session, 'aborted');
  const completedAt = rig.now();
  dismiss(rig, owned.g);

  rig.advance(900);
  observeEdge(rig, 'tool', { id: 'tool-same-instant', at: completedAt });
  assert.strictEqual(rig.bridge.explicitEchoGuardCount, 1,
    'an edge at the completion instant is not newer than it');
  echo(rig, { id: 'turn:alpha', cwd: '/work/alpha' });
  assert.ok(!rig.bridge.status.sc, 'so the pending echo is still swallowed');
})();

// --- no-dismiss symmetry ---------------------------------------------------

(function dismissedAndUndismissedRunsAgreeOnTheGuards() {
  for (const key of EDGE_KEYS) {
    const kept = makeRig();
    const keptSession = start(kept, { label: 'firmware', cwd: '/work/alpha' });
    kept.advance(5000);
    const owned = complete(kept, keptSession, 'failed');
    const ownedLatch = snapshotOfLatch(kept);
    const completedAt = kept.now();

    kept.advance(600);
    observeEdge(kept, key, { id: `${key}-replayed`, at: completedAt - 4000 });
    assert.strictEqual(kept.bridge.explicitEchoGuardCount, 1,
      `${key}: the undismissed run keeps its guard too`);
    assert.deepStrictEqual(kept.bridge.status.sc, owned,
      `${key}: replayed history never clears a card that is still on screen`);

    echo(kept, { id: 'turn:alpha', cwd: '/work/alpha' });
    assert.deepStrictEqual(kept.bridge.status.sc, owned,
      `${key}: the echo is suppressed and the owned card is untouched`);
    assert.deepStrictEqual(snapshotOfLatch(kept), ownedLatch,
      `${key}: outcome, pal, duration and generation all survive`);
    assert.strictEqual(kept.bridge.explicitEchoGuardCount, 0,
      `${key}: exactly one guard was consumed, as in the dismissed run`);
  }
})();

// --- genuinely newer work still disarms promptly ---------------------------

(function newerEdgeAfterDismissalDisarmsImmediately() {
  for (const key of EDGE_KEYS) {
    const rig = makeRig();
    const session = start(rig, {
      label: 'firmware', cwd: '/work/alpha', conversationId: 'copilot-alpha',
    });
    rig.advance(5000);
    const owned = complete(rig, session, 'failed');
    dismiss(rig, owned.g);

    rig.advance(1200);
    observeEdge(rig, key, {
      id: `${key}-new-work`,
      at: rig.now(),
      session: 'copilot-alpha',
    });
    assert.strictEqual(rig.bridge.explicitEchoGuardCount, 0,
      `${key}: an edge past the protected completion disarms the guard at once`);

    echo(rig, {
      id: 'turn:new-work',
      cwd: '/work/alpha',
      session: 'copilot-alpha',
    });
    const after = rig.bridge.status.sc;
    assert.ok(after && after.o === 0 && !after.i,
      `${key}: the completion of that new work latches passively`);
    assert.strictEqual(after.g, owned.g + 1, `${key}: and advances the generation`);
  }
})();

// --- multiple guards with different completion times -----------------------

(function edgesAreFilteredByConversationAndCompletionTime() {
  // A ends, then B ends three seconds later; B's card is dismissed. An edge
  // that lands between the two completions is not attributable to new work —
  // B's own interaction edge predates B's completion. It must disarm neither
  // guard, or A's pending echo could resurface as an anonymous card.
  const between = makeRig();
  const ba = start(between, {
    label: 'task a', cwd: '/work/alpha', conversationId: 'copilot-alpha',
  });
  const bb = start(between, {
    label: 'task b', cwd: '/work/beta', conversationId: 'copilot-beta',
  });
  between.advance(4000);
  complete(between, ba, 'failed');
  const firstAt = between.now();
  between.advance(3000);
  const ownedB = complete(between, bb, 'aborted');
  const secondAt = between.now();
  assert.ok(secondAt > firstAt);
  dismiss(between, ownedB.g);
  assert.strictEqual(between.bridge.explicitEchoGuardCount, 2);

  between.advance(500);
  observeEdge(between, 'tool', {
    id: 'tool-between',
    at: firstAt + 1000,
    session: 'copilot-beta',
  });
  assert.strictEqual(between.bridge.explicitEchoGuardCount, 2,
    'an edge older than the newest protected completion disarms no guard');

  echo(between, { id: 'turn:a', cwd: '/work/alpha', session: 'copilot-alpha' });
  echo(between, { id: 'turn:b', cwd: '/work/beta', session: 'copilot-beta' });
  assert.ok(!between.bridge.status.sc, 'both pending echoes stay swallowed');
  assert.strictEqual(between.bridge.explicitEchoGuardCount, 0,
    'each echo consumed exactly one guard');

  // New work in B disarms B's guard but preserves A's unrelated guard.
  const after = makeRig();
  const aa = start(after, {
    label: 'task a', cwd: '/work/alpha', conversationId: 'copilot-alpha',
  });
  const ab = start(after, {
    label: 'task b', cwd: '/work/beta', conversationId: 'copilot-beta',
  });
  after.advance(4000);
  complete(after, aa, 'failed');
  after.advance(3000);
  const ownedLater = complete(after, ab, 'aborted');
  dismiss(after, ownedLater.g);
  after.advance(800);
  observeEdge(after, 'user', {
    id: 'user-new-work',
    at: after.now(),
    session: 'copilot-beta',
  });
  assert.strictEqual(after.bridge.explicitEchoGuardCount, 1,
    "B's new work preserves A's outstanding guard");
  echo(after, { id: 'turn:a', cwd: '/work/alpha', session: 'copilot-alpha' });
  assert.ok(!after.bridge.status.sc, "A's delayed echo remains suppressed");
  echo(after, { id: 'turn:new', cwd: '/work/beta', session: 'copilot-beta' });
  const card = after.bridge.status.sc;
  assert.ok(card && !card.i, 'and the next completion latches as ordinary evidence');

  // Per-guard filtering, asserted directly: the helper only drops an older
  // guard from the matching conversation.
  const filtered = makeRig();
  const fa = start(filtered, {
    label: 'task a', cwd: '/work/alpha', conversationId: 'copilot-alpha',
  });
  const fb = start(filtered, {
    label: 'task b', cwd: '/work/beta', conversationId: 'copilot-beta',
  });
  filtered.advance(2000);
  complete(filtered, fa, 'failed');
  const fFirstAt = filtered.now();
  filtered.advance(2500);
  complete(filtered, fb, 'aborted');
  assert.strictEqual(filtered.bridge._disarmExplicitEchoesForInteraction({
    at: fFirstAt,
    session: 'copilot-alpha',
  }), 0,
    'a guard is not disarmed by an edge at its own completion instant');
  assert.strictEqual(filtered.bridge._disarmExplicitEchoesForInteraction({
    at: fFirstAt + 1,
    session: 'copilot-alpha',
  }), 1,
    'only the strictly older matching guard is dropped');
  assert.strictEqual(filtered.bridge.explicitEchoGuardCount, 1,
    "the later session's guard survives its neighbour's disarm");
})();

// --- unknown edge timestamps ----------------------------------------------

(function unknownTimestampsClearTheCardButDisarmNothing() {
  // Undismissed: an identity with no timestamp is still the strongest hint we
  // have that something is happening, so it clears the card — but it orders
  // against nothing, so it may not disarm a guard.
  const shown = makeRig();
  const shownSession = start(shown, { label: 'firmware', cwd: '/work/alpha' });
  shown.advance(5000);
  complete(shown, shownSession, 'failed');
  shown.advance(400);
  observeEdge(shown, 'prompt', 'prompt-no-timestamp');
  assert.ok(!shown.bridge.status.sc, 'an undated edge still clears the displayed card');
  assert.strictEqual(shown.bridge.explicitEchoGuardCount, 1,
    'but proves nothing about ordering, so the guard stays armed');
  echo(shown, { id: 'turn:alpha', cwd: '/work/alpha' });
  assert.ok(!shown.bridge.status.sc, 'the pending echo is still swallowed');
  assert.strictEqual(shown.bridge.explicitEchoGuardCount, 0);

  // Dismissed: same answer, and the protection is bounded — once the window
  // lapses the guard is gone and a turn row is ordinary evidence again, so an
  // undated edge can never create indefinite stale protection.
  const bounded = makeRig();
  const boundedSession = start(bounded, { label: 'firmware', cwd: '/work/alpha' });
  bounded.advance(5000);
  const owned = complete(bounded, boundedSession, 'aborted');
  dismiss(bounded, owned.g);
  bounded.advance(400);
  observeEdge(bounded, 'tool', { id: 'tool-no-timestamp' });
  assert.strictEqual(bounded.bridge.explicitEchoGuardCount, 1,
    'an undated edge disarms nothing after a dismissal either');

  bounded.advance(EXPLICIT_ECHO_WINDOW_MS + 1);
  assert.strictEqual(bounded.bridge.explicitEchoGuardCount, 0,
    'the bounded window is the backstop for undated edges');
  echo(bounded, { id: 'turn:late', cwd: '/work/alpha' });
  const late = bounded.bridge.status.sc;
  assert.ok(late && !late.i, 'past the window a turn row latches normally again');
})();

// --- expiry, cap and dismissal interactions --------------------------------

(function protectionDecaysWithTheGuardsAndStaysBounded() {
  // Replayed history keeps the floor up only while a guard is armed. Once the
  // window lapses the floor is gone, so even an old-timestamped completion
  // latches: nothing is retained indefinitely.
  const rig = makeRig();
  const session = start(rig, { label: 'firmware', cwd: '/work/alpha' });
  rig.advance(5000);
  const owned = complete(rig, session, 'failed');
  const completedAt = rig.now();
  dismiss(rig, owned.g);
  observeEdge(rig, 'user', { id: 'user-replayed', at: completedAt - 3000 });
  assert.strictEqual(rig.bridge.explicitEchoGuardCount, 1);

  rig.advance(EXPLICIT_ECHO_WINDOW_MS + 1);
  assert.strictEqual(rig.bridge.explicitEchoGuardCount, 0, 'expired guards are pruned');
  observeEdge(rig, 'user', { id: 'user-replayed-2', at: completedAt - 2000 });
  echo(rig, { id: 'turn:late', cwd: '/work/alpha' });
  const late = rig.bridge.status.sc;
  assert.ok(late && !late.i,
    'with no guard left there is no protection floor and evidence applies again');
  assert.strictEqual(late.g, owned.g + 1, 'the generation advances exactly once');

  // The cap still evicts oldest-first across a dismissal plus replayed edges.
  const capped = makeRig();
  const total = MAX_EXPLICIT_ECHO_GUARDS + 1;
  const sessions = [];
  for (let i = 0; i < total; i++) {
    sessions.push(start(capped, { label: `task ${i}`, cwd: `/work/r${i}` }));
  }
  capped.advance(3000);
  let last = null;
  for (let i = 0; i < total; i++) last = complete(capped, sessions[i], 'failed');
  const cappedAt = capped.now();
  dismiss(capped, last.g);
  capped.advance(700);
  observeEdge(capped, 'tool', { id: 'tool-replayed', at: cappedAt - 1000 });
  assert.strictEqual(capped.bridge.explicitEchoGuardCount, MAX_EXPLICIT_ECHO_GUARDS,
    'guard memory stays bounded by the cap, dismissal or not');
  for (let i = 1; i < total; i++) echo(capped, { id: `turn:r${i}`, cwd: `/work/r${i}` });
  assert.ok(!capped.bridge.status.sc, 'every retained guard answered its own echo');
  assert.strictEqual(capped.bridge.explicitEchoGuardCount, 0);
  echo(capped, { id: 'turn:r0', cwd: '/work/r0' });
  assert.ok(capped.bridge.status.sc, 'the evicted guard no longer suppresses');
})();

(function newExplicitCycleDisarmsItsOwnGuard() {
  const rig = makeRig();
  const session = start(rig, { label: 'firmware', cwd: '/work/alpha' });
  rig.advance(5000);
  const owned = complete(rig, session, 'failed');
  dismiss(rig, owned.g);
  rig.bridge.updateSession({
    id: session.session_id,
    state: 'working',
    message: 'next task',
  });
  assert.strictEqual(rig.bridge.explicitEchoGuardCount, 0,
    "a conversation's new explicit cycle supersedes its previous guard");
  echo(rig, { id: 'turn:alpha', cwd: '/work/alpha' });
  assert.ok(rig.bridge.status.sc && !rig.bridge.status.sc.i,
    'so the next passive completion latches normally');
})();

// --- per-guard lifecycle vs the display watermark --------------------------

// Reviewer repro: the global "newest protected completion" watermark also
// gated *disarming*, so a valid session-A interaction at t=1500 could not
// disarm A's guard (completed at t=1000) once session B completed at t=2000.
// A's guard then survived its own new work and swallowed A's next turn row.
(function anInteractionDisarmsItsOwnGuardDespiteANewerForeignCompletion() {
  for (const key of EDGE_KEYS) {
    const rig = makeRig();
    const sa = start(rig, {
      label: 'task a', cwd: '/work/alpha', conversationId: 'copilot-alpha',
    });
    const sb = start(rig, {
      label: 'task b', cwd: '/work/beta', conversationId: 'copilot-beta',
    });
    rig.advance(4000);
    complete(rig, sa, 'failed');
    const aCompletedAt = rig.now();
    rig.advance(2000);
    const ownedB = complete(rig, sb, 'aborted');
    assert.strictEqual(rig.bridge.explicitEchoGuardCount, 2);

    // A goes back to work 500 ms after its own completion — still older than
    // B's completion, which is newer and owns the screen.
    rig.advance(1000);
    observeEdge(rig, key, {
      id: `${key}-alpha-resumes`,
      at: aCompletedAt + 500,
      session: 'copilot-alpha',
    });
    assert.strictEqual(rig.bridge.explicitEchoGuardCount, 1,
      `${key}: A's own new work disarms A's guard even though B completed later`);
    assert.deepStrictEqual(rig.bridge.status.sc, ownedB,
      `${key}: but it is older than B's completion, so B's card stays on screen`);

    // A's next turn row is therefore genuine evidence, not a protected echo.
    echo(rig, { id: 'turn:alpha-2', cwd: '/work/alpha', session: 'copilot-alpha' });
    const after = rig.bridge.status.sc;
    assert.ok(after && !after.i, `${key}: A's later completion latches passively`);
    assert.strictEqual(after.g, ownedB.g + 1, `${key}: and advances the generation once`);
    assert.strictEqual(rig.bridge.explicitEchoGuardCount, 1,
      `${key}: B's guard is untouched by any of it`);

    // B's own echo still finds its guard.
    echo(rig, { id: 'turn:beta', cwd: '/work/beta', session: 'copilot-beta' });
    assert.deepStrictEqual(rig.bridge.status.sc, after,
      `${key}: B's delayed echo is still suppressed`);
    assert.strictEqual(rig.bridge.explicitEchoGuardCount, 0);
  }
})();

// A correlated echo must be *consumed* even when it arrives in the same model
// as an unrelated, newer interaction that means it should not be displayed.
// Skipping consumption stranded the guard, which then swallowed the session's
// next, genuinely independent completion.
(function correlatedEchoIsConsumedEvenWhenItIsNotDisplayed() {
  const rig = makeRig();
  const sa = start(rig, {
    label: 'task a', cwd: '/work/alpha', conversationId: 'copilot-alpha',
  });
  start(rig, { label: 'task b', cwd: '/work/beta', conversationId: 'copilot-beta' });
  rig.advance(4000);
  const ownedA = complete(rig, sa, 'failed');
  const completedAt = rig.now();
  assert.strictEqual(rig.bridge.explicitEchoGuardCount, 1);

  // One model carries both B's newer prompt and A's delayed turn row.
  rig.advance(400);
  rig.bridge.setModel(passive({
    edgeIds: {
      ...SEED_EDGES,
      user: { id: 'user-beta-new-work', at: completedAt + 3000, session: 'copilot-beta' },
    },
    completionEdge: {
      id: 'turn:alpha-echo',
      outcome: 'success',
      at: completedAt + 500,
      session: 'copilot-alpha',
      cwd: '/work/alpha',
    },
  }));
  assert.ok(!rig.bridge.status.sc,
    "B's newer work clears the display and A's echo does not latch behind it");
  assert.strictEqual(rig.bridge.explicitEchoGuardCount, 0,
    "A's guard answered its own echo instead of being stranded");

  // Proof the guard is really gone: A's next task row latches normally.
  echo(rig, { id: 'turn:alpha-next', cwd: '/work/alpha', session: 'copilot-alpha' });
  const after = rig.bridge.status.sc;
  assert.ok(after && after.o === 0 && !after.i,
    "A's next completion is ordinary evidence, not a second suppressed echo");
  assert.strictEqual(after.g, ownedA.g + 1, 'and advances the generation exactly once');
})();

// --- concurrent sessions deliver every edge, not just the newest -----------

// The permission watch used to keep one global slot per edge kind, so two
// session files appending between polls overwrote one another and only one
// conversation's edge reached the bridge. The model now carries the per-session
// batch; every entry must be applied.
(function simultaneousEdgesFromSeveralSessionsAllReachTheGuards() {
  for (const key of EDGE_KEYS.filter((k) => k !== 'aiRequest')) {
    const rig = makeRig();
    const sa = start(rig, {
      label: 'task a', cwd: '/work/alpha', conversationId: 'copilot-alpha',
    });
    const sb = start(rig, {
      label: 'task b', cwd: '/work/beta', conversationId: 'copilot-beta',
    });
    rig.advance(3000);
    complete(rig, sa, 'failed');
    complete(rig, sb, 'aborted');
    assert.strictEqual(rig.bridge.explicitEchoGuardCount, 2);

    // Both conversations resume in the same poll, with the same edge kind.
    rig.advance(1500);
    const at = rig.now();
    rig.bridge.setModel(passive({
      edges: [
        { kind: key, id: `${key}-alpha-resume`, at, session: 'copilot-alpha' },
        { kind: key, id: `${key}-beta-resume`, at, session: 'copilot-beta' },
      ],
      // The level-triggered map still reports only the last one; it must not
      // be the only thing the bridge sees.
      edgeIds: { ...SEED_EDGES, [key]: { id: `${key}-beta-resume`, at, session: 'copilot-beta' } },
    }));
    assert.strictEqual(rig.bridge.explicitEchoGuardCount, 0,
      `${key}: both conversations' guards are disarmed by their own edges`);

    // Both later rows are now ordinary evidence.
    echo(rig, { id: 'turn:alpha', cwd: '/work/alpha', session: 'copilot-alpha' });
    const first = rig.bridge.status.sc;
    assert.ok(first && !first.i, `${key}: A's completion latches after real new work`);
    echo(rig, { id: 'turn:beta', cwd: '/work/beta', session: 'copilot-beta' });
    const second = rig.bridge.status.sc;
    assert.strictEqual(second.g, first.g + 1,
      `${key}: B's completion latches too, neither edge was lost`);
  }

  // A batch entry is applied exactly once: repeating it in the level-triggered
  // map in the same model must not double-count as a second interaction.
  const rig = makeRig();
  const session = start(rig, {
    label: 'solo', cwd: '/work/alpha', conversationId: 'copilot-alpha',
  });
  rig.advance(3000);
  const owned = complete(rig, session, 'failed');
  rig.advance(500);
  const at = rig.now();
  rig.bridge.setModel(passive({
    edges: [{ kind: 'user', id: 'user-once', at, session: 'copilot-alpha' }],
    edgeIds: { ...SEED_EDGES, user: { id: 'user-once', at, session: 'copilot-alpha' } },
  }));
  assert.ok(!rig.bridge.status.sc, 'the batched edge cleared the card');
  assert.strictEqual(rig.bridge.explicitEchoGuardCount, 0, 'and disarmed the guard once');
  echo(rig, { id: 'turn:alpha', cwd: '/work/alpha', session: 'copilot-alpha' });
  const after = rig.bridge.status.sc;
  assert.ok(after && !after.i && after.g === owned.g + 1,
    'the completion of that work latches exactly once');
})();

// --- newly discovered permwatch file replays real old timestamps -----------

(function permwatchReplayOfAnOldSessionFileKeepsTheGuard() {
  const root = path.join(__dirname, '.scratch-guard-watermark');
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  try {
    // Real wall clock here: permwatch stamps edges from the event timestamps
    // in the file, so the rig has to share that time base.
    const rig = makeRig({ now: Date.now() });
    const session = start(rig, { label: 'firmware', cwd: '/work/alpha' });
    rig.advance(5000);
    const owned = complete(rig, session, 'failed');
    const completedAt = rig.now();
    dismiss(rig, owned.g);

    const watch = new PermissionWatch({
      sessionStateDir: root,
      perm: { minAgeMs: 0, recentWindowMs: 60 * 60 * 1000 },
    });
    watch.update();
    assert.deepStrictEqual(watch.edgeIds, { prompt: null, user: null, tool: null },
      'nothing discovered yet');

    // A session directory that only becomes visible now, holding events from
    // well before the completion we are protecting.
    const sessDir = path.join(root, 'sess-old');
    fs.mkdirSync(sessDir);
    const oldest = new Date(completedAt - 30000).toISOString();
    const older = new Date(completedAt - 20000).toISOString();
    fs.writeFileSync(path.join(sessDir, 'events.jsonl'),
      JSON.stringify({
        type: 'permission.requested',
        data: { requestId: 'req-old', permissionRequest: { kind: 'shell', fullCommandText: 'ls' } },
        id: 'evt-old', timestamp: oldest,
      }) + '\n' +
      JSON.stringify({
        type: 'tool.execution_start',
        data: { toolCallId: 'tc-old', toolName: 'bash' },
        id: 'evt-tool-old', timestamp: older,
      }) + '\n');
    watch.update();

    const replayed = watch.edgeIds;
    assert.ok(replayed.tool && replayed.tool.at === Date.parse(older),
      'permwatch replays the file with its original timestamps');
    assert.ok(replayed.prompt && replayed.prompt.at === Date.parse(oldest));

    rig.advance(300);
    rig.bridge.setModel(passive({ edgeIds: { ...replayed, aiRequest: null } }));
    assert.strictEqual(rig.bridge.explicitEchoGuardCount, 1,
      'a newly discovered file full of old events does not disarm the guard');

    echo(rig, { id: 'turn:alpha', cwd: '/work/alpha' });
    assert.ok(!rig.bridge.status.sc,
      'so the dismissed failed card cannot return as an anonymous success');
    assert.strictEqual(rig.bridge.explicitEchoGuardCount, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})();

console.log(
  'PASS: post-dismissal semantic-edge watermark (guard-carried completion times, per-guard ' +
  'filtering, undated edges, bounded protection, permwatch replay)'
);

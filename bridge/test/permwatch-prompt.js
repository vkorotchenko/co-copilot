'use strict';

// Tests for the live current-prompt capture and session focus added to
// PermissionWatch.
//
// Why this exists: `turns` rows are written when a turn *ends*, so a transcript
// built only from completed turns is permanently one question behind — while
// you are waiting on question N the screen still shows N-1. The session-state
// event stream carries the question as soon as it is asked
// ({"type":"user.message","data":{"content":...}}), which is the only source
// that can show the *current* work. It is also the only place a session id
// exists at all (the process logs carry none), so it doubles as the focus
// signal that keeps the pal state and the transcript text describing the same
// conversation.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { PermissionWatch } = require('../src/copilot/permwatch');

function userLine(text, {
  id = 'evt-' + Math.random(),
  at = Date.now(),
  transformed,
  source,
} = {}) {
  return JSON.stringify({
    type: 'user.message',
    data: {
      content: text,
      transformedContent: transformed === undefined ? text : transformed,
      agentMode: 'autopilot',
      ...(source === undefined ? {} : { source }),
    },
    id,
    timestamp: new Date(at).toISOString(),
  }) + '\n';
}

function eventLine(type, data = {}, at = Date.now()) {
  return JSON.stringify({ type, data, id: 'e-' + Math.random(), timestamp: new Date(at).toISOString() }) + '\n';
}

function permLine(requestId, at = Date.now()) {
  return JSON.stringify({
    type: 'permission.requested',
    data: { requestId, permissionRequest: { kind: 'shell', fullCommandText: 'git push' } },
    id: 'p-' + requestId,
    timestamp: new Date(at).toISOString(),
  }) + '\n';
}

function makeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'permwatch-prompt-'));
}

function session(root, id) {
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'events.jsonl');
}

const CFG = (root, extra = {}) => ({
  sessionStateDir: root,
  perm: { minAgeMs: 0, recentWindowMs: 60 * 60 * 1000, ...extra },
});

// --- 1. startup priming does not resurrect old questions ---------------------
(function primingDoesNotPresentHistoryAsCurrentWork() {
  const root = makeRoot();
  try {
    const events = session(root, 'sess-history');
    const hoursAgo = Date.now() - 5 * 60 * 60 * 1000;
    fs.writeFileSync(events,
      userLine('i plugged in the hardware', { id: 'u1', at: hoursAgo }) +
      userLine('test', { id: 'u2', at: hoursAgo + 1000 }) +
      eventLine('assistant.message', { toolRequests: [] }, hoursAgo + 2000));

    const watch = new PermissionWatch(CFG(root));
    watch.update(); // first sight => priming replay of the whole tail

    assert.strictEqual(watch.currentPrompt(), null,
      'a five-hour-old question replayed at startup is history, not current work');

    // ...but the replay still recovered the session's state and activity.
    const [activity] = watch.sessionActivity();
    assert.strictEqual(activity.sessionId, 'sess-history',
      'the session id comes from the events directory');
    assert.strictEqual(activity.lastUserAt, hoursAgo + 1000,
      'priming still records when the session last saw a user message');
    assert.strictEqual(watch.waitingForUser(), true,
      'priming still recovers the waiting-for-user state');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})();

(function primingKeepsAnInFlightQuestionLive() {
  const root = makeRoot();
  try {
    const events = session(root, 'sess-inflight');
    // The bridge restarting mid-turn: the question is seconds old and its turn
    // row cannot exist yet. Dropping it would blank the screen for the whole
    // turn, so a *recent* primed prompt stays live.
    fs.writeFileSync(events, userLine('restart me mid turn', { id: 'u1', at: Date.now() - 3000 }));

    const watch = new PermissionWatch(CFG(root));
    watch.update();
    const p = watch.currentPrompt();
    assert.ok(p, 'a seconds-old primed question is still in flight');
    assert.strictEqual(p.text, 'restart me mid turn');
    assert.strictEqual(p.sessionId, 'sess-inflight');

    // The window is configurable, and a tight one suppresses even this.
    const strict = new PermissionWatch(CFG(root, { promptPrimeWindowMs: 500 }));
    strict.update();
    assert.strictEqual(strict.currentPrompt(), null,
      'promptPrimeWindowMs bounds how old a primed prompt may be');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})();

(function primingRecoversALongTurnWithRecentActivity() {
  const root = makeRoot();
  try {
    const events = session(root, 'sess-long-running');
    const now = Date.now();
    fs.writeFileSync(events,
      userLine('keep showing this long-running question', {
        id: 'u-long',
        at: now - 10 * 60 * 1000,
      }) +
      userLine('TEAM_ROOT: /tmp You are a spawned reviewer', {
        id: 'u-agent',
        at: now - 1000,
        source: 'agent-child-session',
      }));

    const watch = new PermissionWatch(CFG(root));
    watch.update();
    assert.strictEqual(watch.currentPrompt().text,
      'keep showing this long-running question',
      'recent delegated work keeps the older human question live without replacing it');
    assert.ok(!String(watch.edgeIds.user.id).includes('u-agent'),
      'delegated instructions do not publish a user edge');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})();

// --- 2. delegated agent instructions are not human prompts -------------------
(function delegatedMessagesDoNotReplaceTheHumanQuestion() {
  const root = makeRoot();
  try {
    const events = session(root, 'sess-delegated');
    fs.writeFileSync(events, eventLine('session.start', {}, Date.now() - 10000));
    const watch = new PermissionWatch(CFG(root));
    watch.update();

    fs.appendFileSync(events, userLine('the human question', { id: 'u-human' }));
    watch.update();
    const humanEdge = watch.edgeIds.user;
    assert.strictEqual(
      humanEdge.session,
      'sess-delegated',
      'semantic interaction edges carry their Copilot session identity'
    );

    fs.appendFileSync(events, userLine(
      'You are Strong Sad. TEAM ROOT: /tmp Review this implementation.',
      { id: 'u-agent', source: 'agent-reviewer' }
    ));
    watch.update();

    assert.strictEqual(watch.currentPrompt().text, 'the human question',
      'spawn instructions never replace the device transcript');
    assert.deepStrictEqual(watch.edgeIds.user, humanEdge,
      'spawn instructions never look like semantic new-user-work edges');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})();

// --- 3. recovery skips unusable and torn newer message records ---------------
(function recoveryFallsBackPastWrapperOnlyAndTornMessages() {
  const root = makeRoot();
  try {
    const events = session(root, 'sess-recovery-fallback');
    const now = Date.now();
    const noise = eventLine('tool.execution_complete', {
      toolCallId: 'noise',
      output: 'y'.repeat(4000),
    }, now - 1000);
    fs.writeFileSync(events,
      userLine('the real human question', { id: 'u-real', at: now - 5000 }) +
      userLine('<system_reminder>injected only</system_reminder>', {
        id: 'u-wrapper',
        at: now - 4000,
      }));
    for (let i = 0; i < 120; i++) fs.appendFileSync(events, noise);
    fs.appendFileSync(events,
      '{"type":"user.message","data":{"content":"torn newest record"');

    const watch = new PermissionWatch(CFG(root, {
      promptPrimeWindowMs: 60 * 60 * 1000,
      primeMaxBytes: 2 * 1024 * 1024,
    }));
    watch.update();
    assert.strictEqual(watch.currentPrompt().text, 'the real human question',
      'a wrapper-only event and torn trailing record do not hide the prior valid prompt');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})();

// --- 4. recovery preserves UTF-8 split across read chunks --------------------
(function recoveryDecodesUtf8AcrossChunkBoundaries() {
  const root = makeRoot();
  try {
    const events = session(root, 'sess-utf8-boundary');
    const boundary = 256 * 1024;
    const prefix = '{"type":"user.message","data":{"content":"emoji ';
    const suffix = ' here"},"id":"u-emoji","timestamp":"' +
      new Date().toISOString() + '"}\n';
    const paddingLength = boundary - 2 - Buffer.byteLength(prefix) - 1;
    const padding = 'x'.repeat(paddingLength) + '\n';
    const laterNoise = eventLine('tool.execution_complete', {
      toolCallId: 'after',
      output: 'z'.repeat(300000),
    });
    fs.writeFileSync(events, padding + prefix + '😀' + suffix + laterNoise);

    const watch = new PermissionWatch(CFG(root, {
      promptPrimeWindowMs: 60 * 60 * 1000,
      primeMaxBytes: 1024 * 1024,
    }));
    watch.update();
    assert.strictEqual(watch.currentPrompt().text, 'emoji 😀 here',
      'chunked recovery preserves a multi-byte character split across reads');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})();

// --- 5. a new question is captured immediately -------------------------------
(function newUserMessageIsCapturedBeforeAnyTurnRowExists() {
  const root = makeRoot();
  try {
    const events = session(root, 'sess-live');
    fs.writeFileSync(events, eventLine('session.start', {}, Date.now() - 10000));
    const watch = new PermissionWatch(CFG(root));
    watch.update();
    assert.strictEqual(watch.currentPrompt(), null, 'nothing asked yet');

    fs.appendFileSync(events, userLine('why is the pal showing old text', { id: 'u-new' }));
    watch.update();

    const p = watch.currentPrompt();
    assert.ok(p, 'the question is available the moment it is written');
    assert.strictEqual(p.text, 'why is the pal showing old text');
    assert.strictEqual(p.id, 'u-new', 'the event id is the stable prompt identity');
    assert.strictEqual(p.sessionId, 'sess-live');

    // It survives the work the agent then does — the question stays "current"
    // for the whole turn, not just until the first tool call.
    fs.appendFileSync(events, eventLine('assistant.message', { toolRequests: [{ name: 'bash' }] }));
    fs.appendFileSync(events, eventLine('tool.execution_start', { toolCallId: 't1', toolName: 'bash' }));
    watch.update();
    assert.strictEqual(watch.currentPrompt().id, 'u-new',
      'tool activity does not retire the question being worked on');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})();

// --- 3. injected system wrappers are stripped --------------------------------
(function injectedWrappersAreStrippedBeforeDisplay() {
  const root = makeRoot();
  try {
    const events = session(root, 'sess-wrapped');
    fs.writeFileSync(events, eventLine('session.start', {}, Date.now() - 10000));
    const watch = new PermissionWatch(CFG(root));
    watch.update();

    // The harness-transformed variant is what some CLI versions put in
    // `content`; both fields must sanitize to the same clean text.
    fs.appendFileSync(events, userLine(
      '<current_datetime>2026-09-16T14:08:56-07:00</current_datetime>\n\nrun the build',
      { id: 'u-wrapped' }
    ));
    watch.update();
    assert.strictEqual(watch.currentPrompt().text, 'run the build',
      '<current_datetime> wrappers are stripped');

    fs.appendFileSync(events, userLine(
      'fix the flaky test\n<system_reminder>\n<sql_tables>todos</sql_tables>\n',
      { id: 'u-reminder' }
    ));
    watch.update();
    assert.strictEqual(watch.currentPrompt().text, 'fix the flaky test',
      'an unclosed <system_reminder> tail is stripped');

    // A message that is *only* injected content is not a question at all, so it
    // must not supersede the real one.
    fs.appendFileSync(events, userLine(
      '<system_reminder>tool budget refreshed</system_reminder>', { id: 'u-noise' }
    ));
    watch.update();
    assert.strictEqual(watch.currentPrompt().id, 'u-reminder',
      'a pure-wrapper message is dropped rather than blanking the transcript');

    // Multi-line prompts collapse to one line and are bounded.
    fs.appendFileSync(events, userLine('a'.repeat(5000), { id: 'u-huge' }));
    watch.update();
    const huge = watch.currentPrompt();
    assert.strictEqual(huge.text.length, 600, 'captured prompt text is bounded');
    fs.appendFileSync(events, userLine('line one\n\n   line two\ttabbed', { id: 'u-multi' }));
    watch.update();
    assert.strictEqual(watch.currentPrompt().text, 'line one line two tabbed',
      'whitespace is collapsed the same way persisted turns are');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})();

// --- 4. multiple sessions, newer prompt, supersede ---------------------------
(function multipleSessionsAreTrackedIndependently() {
  const root = makeRoot();
  try {
    const a = session(root, 'sess-a');
    const b = session(root, 'sess-b');
    fs.writeFileSync(a, eventLine('session.start', {}, Date.now() - 20000));
    fs.writeFileSync(b, eventLine('session.start', {}, Date.now() - 20000));
    const watch = new PermissionWatch(CFG(root));
    watch.update();

    const base = Date.now();
    fs.appendFileSync(a, userLine('question in A', { id: 'a1', at: base }));
    fs.appendFileSync(b, userLine('question in B', { id: 'b1', at: base + 1000 }));
    watch.update();

    assert.strictEqual(watch.currentPrompt().text, 'question in B',
      'the unscoped read returns the newest question across sessions');
    assert.strictEqual(watch.currentPrompt('sess-a').text, 'question in A',
      'a scoped read returns that session, not the globally newest');
    assert.strictEqual(watch.currentPrompt('sess-b').text, 'question in B');
    assert.strictEqual(watch.currentPrompt('sess-missing'), null);

    // A newer question in A supersedes A's older one, and does not touch B.
    fs.appendFileSync(a, userLine('follow-up in A', { id: 'a2', at: base + 2000 }));
    watch.update();
    assert.strictEqual(watch.currentPrompt('sess-a').text, 'follow-up in A',
      'a newer question replaces the older one');
    assert.strictEqual(watch.currentPrompt('sess-b').text, 'question in B',
      'and leaves the other session alone');
    assert.strictEqual(watch.currentPrompt().text, 'follow-up in A',
      'the newest across sessions moves with it');

    assert.strictEqual(watch.sessionActivity().length, 2, 'both sessions are tracked');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})();

// --- 5. row catch-up / de-duplication ----------------------------------------
(function resolvingAPromptRetiresItExactlyOnce() {
  const root = makeRoot();
  try {
    const events = session(root, 'sess-catchup');
    fs.writeFileSync(events, eventLine('session.start', {}, Date.now() - 10000));
    const watch = new PermissionWatch(CFG(root));
    watch.update();

    fs.appendFileSync(events, userLine('did it land yet', { id: 'u-catch' }));
    watch.update();
    assert.ok(watch.currentPrompt(), 'live while the turn runs');

    // The caller (copilot/source.js) matched the question against a freshly
    // written `turns` row and retires the provisional copy.
    assert.strictEqual(watch.resolvePrompt('sess-catchup', 'u-catch'), true);
    assert.strictEqual(watch.currentPrompt(), null,
      'once the persisted row has caught up the provisional copy is gone');
    assert.strictEqual(watch.resolvePrompt('sess-catchup', 'u-catch'), false,
      'resolving twice is a no-op, not a crash');
    assert.strictEqual(watch.resolvePrompt('sess-catchup', 'some-other-id'), false,
      'a stale id never retires the wrong prompt');

    // The next question is live again — resolution is per-prompt, not a latch.
    fs.appendFileSync(events, userLine('and the next one', { id: 'u-next' }));
    watch.update();
    assert.strictEqual(watch.currentPrompt().text, 'and the next one');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})();

// --- 6. focus selection ------------------------------------------------------
(function focusPrefersRequestingThenWaitingThenActive() {
  const root = makeRoot();
  try {
    const quiet = session(root, 'sess-quiet');
    const active = session(root, 'sess-active');
    const waiting = session(root, 'sess-waiting');
    const blocked = session(root, 'sess-blocked');
    const now = Date.now();

    // Quiet: activity, but older than the focus window.
    fs.writeFileSync(quiet, userLine('long ago', { id: 'q1', at: now - 10 * 60 * 1000 }));
    // Active: a question in flight.
    fs.writeFileSync(active, userLine('working on this', { id: 'a1', at: now - 2000 }));
    // Waiting: finished its response and handed the turn back.
    fs.writeFileSync(waiting,
      userLine('older question', { id: 'w1', at: now - 5000 }) +
      eventLine('assistant.message', { toolRequests: [] }, now - 4000));
    // Blocked: sitting on a permission request (newest event is the request).
    fs.writeFileSync(blocked,
      userLine('oldest question of all', { id: 'b1', at: now - 60000 }) +
      permLine('req-1', now - 30000));

    const watch = new PermissionWatch(CFG(root));
    watch.update();

    assert.strictEqual(watch.focus().sessionId, 'sess-blocked',
      'a session literally asking you something outranks everything else');
    assert.strictEqual(watch.focus().reason, 'requesting');

    // Answering the request drops it to merely-tracked, and the waiting session
    // takes over.
    fs.appendFileSync(blocked, eventLine('permission.completed', { requestId: 'req-1' }, now - 100));
    watch.update();
    assert.strictEqual(watch.focus().sessionId, 'sess-waiting',
      'with nothing asking, the session waiting on the user wins');
    assert.strictEqual(watch.focus().reason, 'waiting');

    // The user replies there; now only the in-flight question is special.
    fs.appendFileSync(waiting, userLine('here you go', { id: 'w2', at: now }));
    watch.update();
    const pick = watch.focus();
    assert.strictEqual(pick.sessionId, 'sess-waiting',
      'a live question beats an older live question on recency');
    assert.strictEqual(pick.reason, 'prompt');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})();

(function focusIsDeterministicAndDegradesSafely() {
  const empty = new PermissionWatch({ sessionStateDir: '/nonexistent', perm: { minAgeMs: 0 } });
  empty.update();
  assert.strictEqual(empty.focus(), null, 'no session-state directory => no focus, not a throw');
  assert.deepStrictEqual(empty.sessionActivity(), []);
  assert.strictEqual(empty.currentPrompt(), null);

  const root = makeRoot();
  try {
    // Two sessions with the *same* semantic edge timestamp and the same tier:
    // the tie must break deterministically on session id, not Map order.
    const at = Date.now();
    fs.writeFileSync(session(root, 'sess-zzz'), userLine('same instant', { id: 'z', at }));
    fs.writeFileSync(session(root, 'sess-aaa'), userLine('same instant', { id: 'a', at }));
    for (let i = 0; i < 4; i++) {
      const watch = new PermissionWatch(CFG(root));
      watch.update();
      assert.strictEqual(watch.focus().sessionId, 'sess-aaa',
        'an exact tie always resolves to the lowest session id');
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})();

// --- 7. a live prompt keeps its session tracked ------------------------------
(function aLivePromptSurvivesAFrozenMtime() {
  const root = makeRoot();
  try {
    const events = session(root, 'sess-frozen');
    fs.writeFileSync(events, eventLine('session.start', {}, Date.now() - 1000));
    // A very tight recency window: without the live-prompt exemption the file
    // would be dropped from the candidate set on the next poll and the question
    // would vanish mid-turn.
    const watch = new PermissionWatch(CFG(root, { recentWindowMs: 1 }));
    watch.update();
    fs.appendFileSync(events, userLine('long running question', { id: 'u-frozen' }));
    watch.update();
    assert.ok(watch.currentPrompt(), 'captured');

    const old = Date.now() / 1000 - 3600;
    fs.utimesSync(events, old, old); // mtime goes stale while the turn runs
    watch.update();
    assert.ok(watch.currentPrompt(),
      'a session with a live question is never evicted for being quiet');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})();

// --- 8. bounded recovery on a large events file ------------------------------
(function restartRecoveryCrossesLargeToolOutputButStaysBounded() {
  const root = makeRoot();
  try {
    const events = session(root, 'sess-big');
    // A long-running session can put a large tool result after the current
    // question before launchd restarts the bridge. Recovery must cross the
    // old 256 KiB polling cap while remaining explicitly bounded.
    const noise = eventLine('tool.execution_complete', { toolCallId: 'x', output: 'y'.repeat(4000) });
    fs.writeFileSync(events, userLine('buried question', { id: 'u-buried', at: Date.now() - 5000 }));
    for (let i = 0; i < 120; i++) fs.appendFileSync(events, noise); // ~500 KB of tail
    assert.ok(fs.statSync(events).size > 256 * 1024, 'the fixture must exceed the read cap');

    const watch = new PermissionWatch(CFG(root, { promptPrimeWindowMs: 60 * 60 * 1000 }));
    watch.update();
    assert.strictEqual(watch.currentPrompt().text, 'buried question',
      'restart recovery finds a current question beyond the normal polling cap');

    const bounded = new PermissionWatch(CFG(root, {
      promptPrimeWindowMs: 60 * 60 * 1000,
      primeMaxBytes: 256 * 1024,
    }));
    bounded.update();
    assert.strictEqual(bounded.currentPrompt(), null,
      'an explicitly small recovery budget does not scan beyond its hard bound');

    // The live path remains incremental after the larger one-time recovery.
    fs.appendFileSync(events, userLine('the next question', { id: 'u-next' }));
    watch.update();
    assert.strictEqual(watch.currentPrompt().text, 'the next question',
      'appends to a huge file are still captured immediately');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})();

// --- 10. abandoned prompts expire, and recovery fan-out is bounded -----------
(function abandonedPromptExpiresAfterSessionQuiet() {
  const root = makeRoot();
  try {
    const events = session(root, 'sess-abandoned');
    fs.writeFileSync(events, eventLine('session.start', {}, Date.now() - 2000));
    const watch = new PermissionWatch(CFG(root, { promptMaxQuietMs: 100 }));
    watch.update();
    fs.appendFileSync(events, userLine('the CLI was killed', {
      id: 'u-abandoned',
      at: Date.now() - 1000,
    }));
    watch.update();
    assert.strictEqual(watch.currentPrompt(), null,
      'a prompt whose session is quiet beyond the configured limit is retired');
    assert.notStrictEqual(watch.focus().reason, 'prompt',
      'an abandoned prompt no longer owns transcript focus');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})();

(function startupRecoveryPrimesOnlyABoundedNumberOfFilesPerPoll() {
  const root = makeRoot();
  try {
    const now = Date.now() / 1000;
    for (let i = 0; i < 3; i++) {
      const events = session(root, `sess-prime-${i}`);
      fs.writeFileSync(events, userLine(`question ${i}`));
      fs.utimesSync(events, now + i, now + i);
    }
    const watch = new PermissionWatch(CFG(root, { maxPrimeFilesPerUpdate: 1 }));
    watch.update();
    assert.strictEqual(watch.sessionActivity().length, 1,
      'first poll primes only the configured number of new files');
    watch.update();
    assert.strictEqual(watch.sessionActivity().length, 2,
      'second poll advances deferred recovery');
    watch.update();
    assert.strictEqual(watch.sessionActivity().length, 3,
      'all candidate sessions are eventually recovered');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})();

(function invalidTimingConfigurationFallsBackSafely() {
  const watch = new PermissionWatch(CFG('/nonexistent', {
    promptPrimeWindowMs: NaN,
    promptMaxQuietMs: NaN,
    focusActiveWindowMs: NaN,
  }));
  assert.strictEqual(watch._promptPrimeWindowMs, 2 * 60 * 1000,
    'invalid prompt-prime timing falls back to two minutes');
  assert.strictEqual(watch._promptMaxQuietMs, 60 * 60 * 1000,
    'invalid quiet expiry falls back to the configured recent-session window');
  assert.strictEqual(watch._focusActiveWindowMs, 60 * 1000,
    'invalid focus timing falls back to one minute');
})();

console.log(
  'PASS: PermissionWatch live prompts (priming, capture, stripping, multi-session, ' +
  'supersede, catch-up) and deterministic focus'
);

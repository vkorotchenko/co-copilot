'use strict';

// Tests for multi-log tracking in CopilotLogTail.
//
// Every CLI process writes its own ~/.copilot/logs/process-*.log, so two
// concurrent sessions are two files. The tail used to follow only the
// newest-mtime file and reset its group stack on every switch:
//
//     this._file = newest;  ...  this._groupStack = []; this._aiOpen = 0;
//
// So whenever the *other* log was written to, the first log's in-flight AI
// request was forgotten and "running" collapsed to 0 — the pal dropped out of
// thinking mid-turn and flapped back when the request finally closed. Each file
// now owns its own group stack and the counts aggregate across all of them.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { CopilotLogTail } = require('../src/copilot/logtail');

const START_AI = '2026-09-16T21:00:00.000Z [INFO] --- Start of group: Sending request to the AI model ---\n';
const START_OTHER = '2026-09-16T21:00:00.000Z [INFO] --- Start of group: Compacting context ---\n';
const END = '2026-09-16T21:00:01.000Z [INFO] --- End of group ---\n';
const GRACE = 20 * 1000;

function makeDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'logtail-multi-'));
}

function logFile(dir, name) {
  return path.join(dir, `process-${name}.log`);
}

// mtime resolution can be coarse; nudge it explicitly so "which file is newest"
// is a property of the test, not of the filesystem clock.
function touch(file, secondsFromNow) {
  const t = Date.now() / 1000 + secondsFromNow;
  fs.utimesSync(file, t, t);
}

// Grace windows are measured against Date.now(); a few real milliseconds have
// to pass before "the window lapsed" is a meaningful assertion.
function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// --- 1. two concurrent active requests ---------------------------------------
(function concurrentRequestsInDifferentLogsBothCount() {
  const dir = makeDir();
  try {
    const a = logFile(dir, 'a');
    const b = logFile(dir, 'b');
    fs.writeFileSync(a, '');
    fs.writeFileSync(b, '');
    const tail = new CopilotLogTail({ logsDir: dir });
    tail.update(); // attach both at EOF

    fs.appendFileSync(a, START_AI);
    tail.update();
    assert.strictEqual(tail.runningCount(GRACE), 1, 'one session is generating');
    assert.strictEqual(tail.aiActive, true);

    fs.appendFileSync(b, START_AI);
    tail.update();
    assert.strictEqual(tail.runningCount(GRACE), 2,
      'two concurrent sessions in two logs are two running requests');

    // A non-AI group in one file must not inflate the count, and its End must
    // pop the right entry (the stacks are per-file and well-nested).
    fs.appendFileSync(a, START_OTHER);
    tail.update();
    assert.strictEqual(tail.runningCount(GRACE), 2, 'a non-AI group is not a request');
    fs.appendFileSync(a, END);
    tail.update();
    assert.strictEqual(tail.runningCount(GRACE), 2,
      'closing the non-AI group leaves both AI requests open');

    assert.strictEqual(tail.trackedLogCount, 2, 'both logs are tracked');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})();

// --- 2. the regression: switching which file is newest ------------------------
(function switchingNewestLogDoesNotDropAnInFlightRequest() {
  const dir = makeDir();
  try {
    const a = logFile(dir, 'a');
    const b = logFile(dir, 'b');
    fs.writeFileSync(a, '');
    fs.writeFileSync(b, '');
    const tail = new CopilotLogTail({ logsDir: dir });
    tail.update();

    // A opens a long request.
    fs.appendFileSync(a, START_AI);
    touch(a, -5);
    tail.update();
    assert.strictEqual(tail.runningCount(GRACE), 1);

    // B is then written to and becomes the newest log. Under the old
    // single-file design this reattached and wiped A's open group.
    fs.appendFileSync(b, '2026-09-16T21:00:02.000Z [INFO] some unrelated chatter\n');
    touch(b, 0);
    tail.update();
    assert.strictEqual(tail.runningCount(GRACE), 1,
      "A's in-flight request survives B becoming the newest log");
    assert.strictEqual(tail.aiActive, true);

    // Flip back and forth a few times; the count must never wobble.
    for (let i = 0; i < 3; i++) {
      touch(a, i); tail.update();
      assert.strictEqual(tail.runningCount(GRACE), 1, 'stable while A is newest');
      touch(b, i); tail.update();
      assert.strictEqual(tail.runningCount(GRACE), 1, 'stable while B is newest');
    }

    // Only A's own End closes it.
    fs.appendFileSync(a, END);
    tail.update();
    assert.strictEqual(tail.aiActive, false, 'the request closes when its own group ends');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})();

// --- 3. one completes while the other keeps running --------------------------
(function oneSessionFinishingLeavesTheOtherRunning() {
  const dir = makeDir();
  try {
    const a = logFile(dir, 'a');
    const b = logFile(dir, 'b');
    fs.writeFileSync(a, '');
    fs.writeFileSync(b, '');
    const tail = new CopilotLogTail({ logsDir: dir });
    tail.update();

    fs.appendFileSync(a, START_AI);
    fs.appendFileSync(b, START_AI);
    tail.update();
    assert.strictEqual(tail.runningCount(GRACE), 2);

    fs.appendFileSync(a, END);
    tail.update();
    assert.strictEqual(tail.aiActive, true, 'B is still generating');
    // A is inside its grace window (a tool gap), B is genuinely open.
    assert.strictEqual(tail.runningCount(GRACE), 2,
      'the finished session stays counted for its grace window');
    sleep(10);
    assert.strictEqual(tail.runningCount(1), 1,
      'once the grace lapses, only the genuinely open request counts');

    fs.appendFileSync(b, END);
    tail.update();
    assert.strictEqual(tail.aiActive, false, 'nothing is open now');
    sleep(10);
    assert.strictEqual(tail.runningCount(1), 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})();

// --- 4. truncation / rotation -------------------------------------------------
(function truncationRebuildsStateWithoutReplayingAsLive() {
  const dir = makeDir();
  try {
    const a = logFile(dir, 'a');
    fs.writeFileSync(a, 'x'.repeat(4096) + '\n');
    const tail = new CopilotLogTail({ logsDir: dir });
    tail.update();

    fs.appendFileSync(a, START_AI);
    tail.update();
    assert.strictEqual(tail.runningCount(GRACE), 1);
    const generationBefore = tail.aiRequestGeneration;

    // Rotated in place: the file shrinks and its content is replaced with a
    // history that happens to contain an open group.
    fs.writeFileSync(a, START_AI);
    tail.update();
    assert.strictEqual(tail.aiActive, true,
      'the replayed content still reconstructs the open-group state');
    assert.strictEqual(tail.aiRequestGeneration, generationBefore,
      'but a truncation replay is not new work and must not advance the edge');

    // Growth after the truncation is live again.
    fs.appendFileSync(a, END);
    fs.appendFileSync(a, START_AI);
    tail.update();
    assert.strictEqual(tail.aiRequestGeneration, generationBefore + 1,
      'a genuinely new request after the rotation advances the edge');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})();

(function attachingToAnExistingLogDoesNotReplayItsGroups() {
  const dir = makeDir();
  try {
    // A log that already contains an unclosed AI group from an hour ago. A
    // fresh bridge must not report that historical request as running.
    fs.writeFileSync(logFile(dir, 'stale'), START_AI + START_AI);
    const tail = new CopilotLogTail({ logsDir: dir });
    tail.update();
    assert.strictEqual(tail.aiActive, false, 'attaching at EOF ignores historical groups');
    assert.strictEqual(tail.runningCount(GRACE), 0);
    assert.strictEqual(tail.aiRequestEdge, null, 'and creates no work edge');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})();

// --- 5. bounded tracking and cleanup -----------------------------------------
(function trackingIsBoundedAndPrunesVanishedLogs() {
  const dir = makeDir();
  try {
    for (let i = 0; i < 12; i++) {
      const f = logFile(dir, `n${i}`);
      fs.writeFileSync(f, '');
      touch(f, -i);
    }
    const tail = new CopilotLogTail({ logsDir: dir, logs: { maxFiles: 4 } });
    tail.update();
    assert.strictEqual(tail.trackedLogCount, 4, 'tracking is capped by cfg.logs.maxFiles');

    // Old logs outside the recency window are not tracked... except the newest
    // one overall, which is always followed so a session resuming after a long
    // idle is not missed (this is also the pre-multi-log behaviour).
    const dirOld = makeDir();
    try {
      const ancient = logFile(dirOld, 'ancient');
      const alsoAncient = logFile(dirOld, 'older-still');
      fs.writeFileSync(ancient, '');
      fs.writeFileSync(alsoAncient, '');
      touch(ancient, -7 * 24 * 60 * 60);
      touch(alsoAncient, -14 * 24 * 60 * 60);
      const windowed = new CopilotLogTail({ logsDir: dirOld, logs: { recentWindowMs: 60 * 1000 } });
      windowed.update();
      assert.strictEqual(windowed.trackedLogCount, 1,
        'only the newest log survives the window; the older one is dropped');
      assert.strictEqual(windowed.focusLog, 'process-ancient.log',
        'and it is the newest, not an arbitrary one');

      // It resumes: the very first appended request is seen, not skipped.
      fs.appendFileSync(ancient, START_AI);
      windowed.update();
      assert.strictEqual(windowed.runningCount(GRACE), 1,
        'a long-idle session resuming is picked up on its first request');
    } finally {
      fs.rmSync(dirOld, { recursive: true, force: true });
    }

    // A tracked log that disappears is forgotten.
    const dropMe = logFile(dir, 'n0');
    assert.strictEqual(tail.trackedLogCount, 4);
    fs.rmSync(dropMe);
    tail.update();
    assert.ok(tail.trackedLogCount <= 4, 'the vanished log is pruned, not leaked');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})();

(function anOpenRequestIsNeverEvictedForNewerLogs() {
  const dir = makeDir();
  try {
    const busy = logFile(dir, 'busy');
    fs.writeFileSync(busy, '');
    touch(busy, -60);
    const tail = new CopilotLogTail({ logsDir: dir, logs: { maxFiles: 1 } });
    tail.update();
    fs.appendFileSync(busy, START_AI);
    tail.update();
    assert.strictEqual(tail.runningCount(GRACE), 1);
    touch(busy, -60); // appending refreshed its mtime; make it the older file again

    // A newer log appears and, at maxFiles:1, would otherwise displace it.
    const newer = logFile(dir, 'newer');
    fs.writeFileSync(newer, '');
    touch(newer, 0);
    tail.update();
    assert.strictEqual(tail.aiActive, true,
      'a log holding an open AI request is retained past the file cap');
    assert.strictEqual(tail.trackedLogCount, 2);

    // Once it closes, the cap applies again.
    fs.appendFileSync(busy, END);
    touch(busy, -60);
    tail.update();
    touch(busy, -60);
    tail.update();
    assert.strictEqual(tail.trackedLogCount, 1, 'the cap reasserts once nothing is in flight');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})();

// --- 6. detail fields follow a deterministic focus ---------------------------
(function detailFieldsComeFromTheFocusedLog() {
  const dir = makeDir();
  try {
    const a = logFile(dir, 'a');
    const b = logFile(dir, 'b');
    fs.writeFileSync(a, '[INFO] Using default model: claude-alpha-1\n' +
      '[INFO] CompactionProcessor: Utilization 10.0% (100/1000 tokens)\n');
    fs.writeFileSync(b, '[INFO] Using default model: claude-beta-2\n' +
      '[INFO] CompactionProcessor: Utilization 50.0% (500/1000 tokens)\n');
    touch(a, -30);
    touch(b, 0);

    const tail = new CopilotLogTail({ logsDir: dir });
    tail.update();
    assert.strictEqual(tail.focusLog, 'process-b.log', 'the newest log is the focus');
    assert.strictEqual(tail.model, 'claude-beta-2', 'model comes from the focused log');
    assert.deepStrictEqual(tail.contextTokens, { used: 500, max: 1000 });
    assert.strictEqual(tail.tokens, 500);
    assert.strictEqual(tail.tokenSample.value, 500);
    assert.ok(tail.tokenSample.source.startsWith('process-b.log#'));

    // Focus moves with mtime, deterministically.
    touch(a, 30);
    tail.update();
    assert.strictEqual(tail.focusLog, 'process-a.log');
    assert.strictEqual(tail.model, 'claude-alpha-1',
      'the detail fields follow the focus rather than interleaving two sessions');
    assert.deepStrictEqual(tail.contextTokens, { used: 100, max: 1000 });
    assert.strictEqual(tail.tokenSample.value, 100);
    assert.ok(tail.tokenSample.source.startsWith('process-a.log#'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})();

(function rotatedLogGetsANewTokenGeneration() {
  const dir = makeDir();
  try {
    const file = logFile(dir, 'rotating-tokens');
    fs.writeFileSync(
      file,
      '[INFO] CompactionProcessor: Utilization 10.0% (100/1000 tokens)\n' +
      'padding to make the first generation longer\n'
    );
    const tail = new CopilotLogTail({ logsDir: dir });
    tail.update();
    const before = tail.tokenSample;
    assert.strictEqual(before.value, 100);

    fs.writeFileSync(
      file,
      '[INFO] CompactionProcessor: Utilization 50.0% (500/1000 tokens)\n'
    );
    tail.update();
    const after = tail.tokenSample;
    assert.strictEqual(after.value, 500);
    assert.notStrictEqual(after.source, before.source,
      'a truncated log establishes a new fallback-counter baseline');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})();

(function detailFallsBackWhenTheFocusHasNone() {
  const dir = makeDir();
  try {
    const quiet = logFile(dir, 'quiet');
    const detailed = logFile(dir, 'detailed');
    fs.writeFileSync(quiet, '[INFO] nothing useful here\n');
    fs.writeFileSync(detailed, '[INFO] Using default model: claude-gamma-3\n');
    touch(detailed, -10);
    touch(quiet, 0);

    const tail = new CopilotLogTail({ logsDir: dir });
    tail.update();
    assert.strictEqual(tail.focusLog, 'process-quiet.log');
    assert.strictEqual(tail.model, 'claude-gamma-3',
      'when the focused log never names a model, the most recent known value is used');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})();

// --- 7. degradation ----------------------------------------------------------
(function missingDirectoryAndUngroupedLogsDegrade() {
  const missing = new CopilotLogTail({ logsDir: '/nonexistent' });
  missing.update();
  assert.strictEqual(missing.runningCount(GRACE), 0, 'no logs => idle, not a throw');
  assert.strictEqual(missing.aiActive, false);
  assert.strictEqual(missing.model, null);
  assert.strictEqual(missing.tokens, null);
  assert.strictEqual(missing.tokenSample, null);
  assert.strictEqual(missing.contextTokens, null);
  assert.strictEqual(missing.focusLog, null);
  assert.strictEqual(missing.trackedLogCount, 0);

  const dir = makeDir();
  try {
    // An older CLI with no group markers at all: fall back to raw growth.
    const f = logFile(dir, 'legacy');
    fs.writeFileSync(f, '');
    const tail = new CopilotLogTail({ logsDir: dir });
    tail.update();
    assert.strictEqual(tail.runningCount(GRACE), 0, 'no growth yet');
    fs.appendFileSync(f, '[INFO] doing something without group markers\n');
    tail.update();
    assert.strictEqual(tail.runningCount(GRACE), 1,
      'growth alone still reads as one running session on a group-less log');
    assert.strictEqual(tail.busy(GRACE), true);
    sleep(10);
    assert.strictEqual(tail.runningCount(1), 0, 'and expires with the window');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})();

// --- 8. nested subdirectories still resolve ----------------------------------
(function perSessionSubdirectoriesAreFound() {
  const dir = makeDir();
  try {
    const nested = path.join(dir, 'session_one');
    fs.mkdirSync(nested);
    fs.writeFileSync(path.join(nested, 'process-x.log'), '');
    const tail = new CopilotLogTail({ logsDir: dir });
    tail.update();
    assert.strictEqual(tail.trackedLogCount, 1, 'a --log-dir subdirectory layout is walked');
    fs.appendFileSync(path.join(nested, 'process-x.log'), START_AI);
    tail.update();
    assert.strictEqual(tail.runningCount(GRACE), 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})();

console.log(
  'PASS: multi-log tail (concurrent requests, mtime switching, truncation/rotation, ' +
  'bounded cleanup, focused detail fields)'
);

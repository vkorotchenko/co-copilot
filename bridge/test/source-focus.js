'use strict';

// End-to-end tests for CopilotSource: the device transcript and the live pal
// state must describe the SAME conversation, and the transcript must show the
// question currently being worked on rather than the previous one.
//
// The reported failure (2026-09-16): the pal correctly animated "thinking" for
// the question just asked, while the screen showed `i plugged in the hardware`
// and `test` — the two most recent *completed* turns. Three defects combined:
//
//   1. `turns` rows are written at turn END, so a completed-turn-only
//      transcript is structurally one question behind.
//   2. parseUtc() could not read the store's ISO timestamps, so entries lost
//      their HH:MM prefix and nothing could be ordered against the live prompt.
//   3. state (newest process log) and text (newest completed turn) were chosen
//      independently and could come from different sessions.
//
// These tests drive the real CopilotStore against a temp SQLite file and the
// real PermissionWatch against a temp session-state tree, so they fail if any
// of the three regresses.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const { CopilotSource } = require('../src/copilot/source');
const { CopilotStore } = require('../src/copilot/store');
const { PermissionWatch } = require('../src/copilot/permwatch');

const SCHEMA = `
CREATE TABLE sessions (
  id TEXT PRIMARY KEY, cwd TEXT, repository TEXT, host_type TEXT, branch TEXT,
  summary TEXT, created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  turn_index INTEGER NOT NULL, user_message TEXT, assistant_response TEXT,
  timestamp TEXT DEFAULT (datetime('now')), UNIQUE(session_id, turn_index)
);
CREATE TABLE assistant_usage_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  turn_index INTEGER,
  agent_id TEXT,
  model TEXT NOT NULL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_read_tokens INTEGER,
  cache_write_tokens INTEGER,
  reasoning_tokens INTEGER,
  total_nano_aiu INTEGER,
  created_at TEXT
);`;

// --- rig ---------------------------------------------------------------------

function makeRig() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'source-focus-'));
  const dbFile = path.join(root, 'session-store.db');
  const stateDir = path.join(root, 'session-state');
  fs.mkdirSync(stateDir);

  const db = new Database(dbFile);
  db.exec(SCHEMA);

  const cfg = {
    sessionStoreDb: dbFile,
    sessionStateDir: stateDir,
    logsDir: path.join(root, 'logs'),
    settingsJson: path.join(root, 'settings.json'),
    perm: { minAgeMs: 0, recentWindowMs: 60 * 60 * 1000 },
    busyWindowMs: 20000,
    activeWindowMs: 5 * 60 * 1000,
    completedHoldMs: 6000,
    maxEntries: 6,
    tickMs: 1000,
  };

  const source = new CopilotSource(cfg);
  source._store = new CopilotStore(cfg);
  source._store.open();
  source._perm = new PermissionWatch(cfg);
  // The process-log tail is exercised separately (test/logtail-multi.js); here
  // it is a quiet stub so the transcript logic is the only variable.
  source._log = {
    update() {}, runningCount: () => 0, aiActive: false, aiRequestEdge: null,
    tokens: null, contextTokens: null, model: null, effort: null,
    focusLog: null, trackedLogCount: 0,
  };
  source._readSettings = () => ({ model: null, effort: null });

  return {
    root, db, cfg, source,
    addSession(id, cwd = '/work/' + id, repository = id) {
      db.prepare('INSERT INTO sessions (id, cwd, repository) VALUES (?,?,?)')
        .run(id, cwd, repository);
      const dir = path.join(stateDir, id);
      fs.mkdirSync(dir, { recursive: true });
      const events = path.join(dir, 'events.jsonl');
      if (!fs.existsSync(events)) fs.writeFileSync(events, '');
      return events;
    },
    // A *completed* turn: what the CLI writes when the turn ends.
    addTurn(sessionId, index, message, at) {
      db.prepare(
        'INSERT INTO turns (session_id, turn_index, user_message, timestamp) VALUES (?,?,?,?)'
      ).run(sessionId, index, message, new Date(at).toISOString());
    },
    addUsage(sessionId, {
      turn = 0,
      agent = null,
      model = 'gpt-test',
      input = 0,
      output = 0,
      cacheRead = 0,
      cacheWrite = 0,
      reasoning = 0,
      nanoAiu = 0,
      at = Date.now(),
    } = {}) {
      db.prepare(
        `INSERT INTO assistant_usage_events (
           session_id, turn_index, agent_id, model, input_tokens, output_tokens,
           cache_read_tokens, cache_write_tokens, reasoning_tokens,
           total_nano_aiu, created_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`
      ).run(
        sessionId, turn, agent, model, input, output, cacheRead, cacheWrite,
        reasoning, nanoAiu, new Date(at).toISOString()
      );
    },
    // A live question: what the CLI writes the moment you hit enter.
    ask(sessionId, message, at, id = 'evt-' + Math.random()) {
      fs.appendFileSync(path.join(stateDir, sessionId, 'events.jsonl'),
        JSON.stringify({
          type: 'user.message',
          data: { content: message, transformedContent: message, agentMode: 'autopilot' },
          id, timestamp: new Date(at).toISOString(),
        }) + '\n');
      return id;
    },
    event(sessionId, type, data, at) {
      fs.appendFileSync(path.join(stateDir, sessionId, 'events.jsonl'),
        JSON.stringify({ type, data, id: 'e-' + Math.random(), timestamp: new Date(at).toISOString() }) + '\n');
    },
    complete(sessionId, at, success = true, id = 'done-' + Math.random()) {
      fs.appendFileSync(path.join(stateDir, sessionId, 'events.jsonl'),
        JSON.stringify({
          type: 'session.task_complete',
          data: { summary: 'done', success },
          id,
          timestamp: new Date(at).toISOString(),
        }) + '\n');
      return id;
    },
    cleanup() {
      source._store.close();
      try { db.close(); } catch { /* already closed */ }
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

// Entries are sent oldest-first; the firmware highlights the LAST one as the
// newest. Strip the HH:MM prefix for readable assertions.
const texts = (model) => model.entries.map((e) => e.replace(/^\d{2}:\d{2} /, ''));
const newest = (model) => texts(model)[model.entries.length - 1];

// --- 1. the reported regression ----------------------------------------------
(function theCurrentQuestionIsShown_notThePreviousOne() {
  const rig = makeRig();
  try {
    const now = Date.now();
    rig.addSession('sess-main', '/Users/v/workspace/arduino/co-copilot', 'co-copilot');

    // Exactly the user's history: two completed turns...
    rig.addTurn('sess-main', 0, 'i plugged in the hardware', now - 90 * 60 * 1000);
    rig.addTurn('sess-main', 1, 'test', now - 88 * 60 * 1000);
    // ...and the question being worked on right now, which has no turn row yet.
    rig.ask('sess-main', "Im also seeing that the pal is thinking but the text is old", now - 5000, 'u-current');

    const model = rig.source._buildModel();

    assert.strictEqual(
      newest(model), "Im also seeing that the pal is thinking but the text is old",
      'the highlighted newest entry must be the question currently being worked on, ' +
      'not the previous completed turn'
    );
    assert.deepStrictEqual(texts(model), [
      'i plugged in the hardware',
      'test',
      "Im also seeing that the pal is thinking but the text is old",
    ], 'history stays, oldest-first, with the live question appended as newest');

    // Every entry carries a clock prefix again (the ISO parse regression).
    for (const entry of model.entries) {
      assert.ok(/^\d{2}:\d{2} /.test(entry), `entry must carry HH:MM: ${entry}`);
    }

    // State and text agree on which conversation this is.
    assert.strictEqual(model.focus.sessionId, 'sess-main');
    assert.strictEqual(model.focus.turnSession, 'sess-main');
    assert.strictEqual(model.focus.provisional, true,
      'the newest entry is flagged as the not-yet-persisted live question');
  } finally {
    rig.cleanup();
  }
})();

// --- 2. question N, not N-1, across a whole turn ------------------------------
(function whileQuestionNIsActiveEntriesIncludeN() {
  const rig = makeRig();
  try {
    const now = Date.now();
    rig.addSession('sess-n');
    for (let i = 1; i <= 3; i++) {
      rig.addTurn('sess-n', i - 1, `question ${i}`, now - (10 - i) * 60 * 1000);
    }

    // Before question 4 is asked, the newest entry is question 3.
    assert.strictEqual(newest(rig.source._buildModel()), 'question 3');

    // Ask question 4. Its turn row will not exist until the turn ends.
    const promptId = rig.ask('sess-n', 'question 4', now - 4000, 'u-q4');
    let model = rig.source._buildModel();
    assert.strictEqual(newest(model), 'question 4',
      'question N is shown while it is being worked on, not N-1');
    assert.ok(texts(model).includes('question 3'), 'and the history is still there');

    // Work happens; the question stays current for the whole turn.
    rig.event('sess-n', 'assistant.message', { toolRequests: [{ name: 'bash' }] }, now - 3000);
    rig.event('sess-n', 'tool.execution_start', { toolCallId: 't1', toolName: 'bash' }, now - 2000);
    model = rig.source._buildModel();
    assert.strictEqual(newest(model), 'question 4', 'still current mid-turn');
    assert.strictEqual(model.focus.provisional, true);

    // The turn ends and the row lands. The entry must not double up.
    rig.addTurn('sess-n', 3, 'question 4', now - 1000);
    model = rig.source._buildModel();
    assert.strictEqual(newest(model), 'question 4');
    assert.strictEqual(
      texts(model).filter((t) => t === 'question 4').length, 1,
      'once persisted, the provisional copy is de-duplicated away'
    );
    assert.strictEqual(model.focus.provisional, false,
      'and the transcript is pure completed history again');
    assert.strictEqual(rig.source._perm.currentPrompt('sess-n'), null,
      'the watcher was told to retire the resolved prompt');

    // A repeat question with the SAME text must still appear immediately: the
    // older row for "question 4" predates it, so it cannot masquerade as the
    // persisted copy. (Matching allows one second of slack for legacy
    // second-precision row timestamps, so the repeat is asked after that.)
    rig.ask('sess-n', 'question 4', now + 5000, 'u-q4-again');
    model = rig.source._buildModel();
    assert.strictEqual(
      texts(model).filter((t) => t === 'question 4').length, 2,
      'asking the same thing twice shows both, rather than swallowing the new one'
    );
    assert.strictEqual(model.focus.provisional, true);
  } finally {
    rig.cleanup();
  }
})();

// --- 3. state and text come from the same session ----------------------------
(function focusKeepsStateAndTextOnOneSession() {
  const rig = makeRig();
  try {
    const now = Date.now();
    rig.addSession('sess-foreground', '/work/app', 'app');
    rig.addSession('sess-background', '/work/bot', 'bot');

    rig.addTurn('sess-foreground', 0, 'foreground history', now - 20 * 60 * 1000);
    // The background session owns the newest completed turn. Under the old
    // newest-turn-wins rule its transcript would have taken over the screen.
    rig.addTurn('sess-background', 0, 'background autopilot chatter', now - 60 * 1000);

    // ...but the foreground session is the one blocked on you right now.
    rig.event('sess-background', 'assistant.message', { toolRequests: [{ name: 'bash' }] }, now - 30000);
    rig.ask('sess-foreground', 'what is taking so long', now - 3000, 'u-fg');
    rig.event('sess-foreground', 'permission.requested', {
      requestId: 'req-fg', permissionRequest: { kind: 'shell', fullCommandText: 'git push' },
    }, now - 2000);

    const model = rig.source._buildModel();

    assert.strictEqual(model.focus.sessionId, 'sess-foreground',
      'the session asking you something is the focus');
    assert.strictEqual(model.focus.source, 'requesting');
    assert.strictEqual(model.focus.turnSession, 'sess-foreground',
      'and the completed rows were read from that same session');
    assert.ok(!texts(model).some((t) => t.includes('background autopilot')),
      'the other conversation never leaks into the transcript');
    assert.deepStrictEqual(texts(model), ['foreground history', 'what is taking so long']);

    // The live state describes the same session: its permission prompt is what
    // the device is told about.
    assert.strictEqual(model.waiting, 1);
    assert.strictEqual(model.msg, 'approval waiting');
    assert.ok(model.prompt && model.prompt.id === 'perm-req-fg');
  } finally {
    rig.cleanup();
  }
})();

(function aBrandNewSessionNeverBorrowsAnotherSessionsHistory() {
  const rig = makeRig();
  try {
    const now = Date.now();
    rig.addSession('sess-old', '/work/old', 'old');
    rig.addSession('sess-fresh', '/work/fresh', 'fresh');
    rig.addTurn('sess-old', 0, 'yesterdays question', now - 4 * 60 * 1000);

    // A session that has never completed a turn asks its first question.
    rig.ask('sess-fresh', 'first question in a new session', now - 2000, 'u-fresh');

    const model = rig.source._buildModel();
    assert.strictEqual(model.focus.sessionId, 'sess-fresh');
    assert.deepStrictEqual(texts(model), ['first question in a new session'],
      "a new conversation shows only itself rather than the previous session's history");
    assert.ok(model.focus.source.endsWith('/new-session'),
      'diagnostics record that the store had no rows for this session yet');
  } finally {
    rig.cleanup();
  }
})();

// --- 4. degradation ----------------------------------------------------------
(function noEventStreamFallsBackToCompletedTurns() {
  const rig = makeRig();
  try {
    const now = Date.now();
    rig.addSession('sess-only');
    rig.addTurn('sess-only', 0, 'older', now - 3 * 60 * 1000);
    rig.addTurn('sess-only', 1, 'newer', now - 60 * 1000);

    // An older CLI (or a wiped session-state tree): no events at all.
    fs.rmSync(path.join(rig.root, 'session-state'), { recursive: true, force: true });
    const model = rig.source._buildModel();
    assert.deepStrictEqual(texts(model), ['older', 'newer'],
      'with no event stream the transcript is the historical completed-turn view');
    assert.strictEqual(model.focus.sessionId, null, 'and focus reports honestly that it had none');
    assert.strictEqual(model.focus.source, 'store');
  } finally {
    rig.cleanup();
  }
})();

(function aPermwatchWithoutTheNewApiStillWorks() {
  const rig = makeRig();
  try {
    const now = Date.now();
    rig.addSession('sess-compat');
    rig.addTurn('sess-compat', 0, 'legacy path', now - 60 * 1000);
    // A test double / older watcher exposing only the original surface.
    rig.source._perm = {
      update() {}, pending: () => null, waitingForUser: () => false, edgeIds: {},
    };
    const model = rig.source._buildModel();
    assert.deepStrictEqual(texts(model), ['legacy path']);
    assert.strictEqual(model.focus.sessionId, null);
  } finally {
    rig.cleanup();
  }
})();

(function focusIsNeverSentToTheDevice() {
  const { composeModel } = require('../src/sessions/compose');
  const rig = makeRig();
  try {
    rig.addSession('sess-wire');
    rig.ask('sess-wire', 'anything', Date.now() - 1000, 'u-wire');
    const model = rig.source._buildModel();
    assert.ok(model.focus, 'the source reports focus for diagnostics');
    const composed = composeModel({ passive: model, sessions: [] });
    assert.strictEqual(composed.focus, undefined,
      'composition drops it: focus is diagnostics, not wire budget');
  } finally {
    rig.cleanup();
  }
})();

(function officialUsageIsKeyedByTheCopilotSession() {
  const rig = makeRig();
  try {
    const now = Date.now();
    rig.addSession('sess-usage');
    rig.addUsage('sess-usage', {
      input: 1000,
      output: 120,
      cacheRead: 800,
      cacheWrite: 50,
      reasoning: 25,
      nanoAiu: 5000,
      at: now - 1000,
    });
    rig.addUsage('sess-usage', {
      agent: 'child-agent',
      model: 'gpt-child',
      input: 500,
      output: 30,
      at: now,
    });

    const model = rig.source._buildModel();
    assert.strictEqual(model.officialUsage.available, true);
    assert.strictEqual(model.officialUsage.sessions['sess-usage'].api_calls, 2);
    assert.strictEqual(model.officialUsage.sessions['sess-usage'].output_tokens, 150);
    assert.strictEqual(model.tokens, 0,
      'the first authoritative total establishes a bridge-lifetime baseline');
    assert.strictEqual(
      model.officialUsage.sessions['sess-usage'].models['gpt-child'].output_tokens,
      30,
      'subagent model calls remain visible inside the parent session aggregate'
    );
    assert.strictEqual(
      model.officialUsage.sessions['sess-usage'].latest_model,
      'gpt-child',
      'the newest official usage row identifies the model shown on pal stats'
    );

    rig.addUsage('sess-usage', { output: 50, at: now + 1000 });
    const advanced = rig.source._buildModel();
    assert.strictEqual(advanced.officialUsage.sessions['sess-usage'].output_tokens, 200);
    assert.strictEqual(advanced.tokens, 50,
      'only output produced after the bridge baseline advances pet progression');

    rig.db.exec('DELETE FROM assistant_usage_events');
    rig.addUsage('sess-usage', { output: 200, at: now + 2000 });
    const rebuilt = rig.source._buildModel();
    assert.strictEqual(rebuilt.officialUsage.sessions['sess-usage'].output_tokens, 200);
    assert.strictEqual(rebuilt.tokens, 50,
      'repopulating the usage table with historical totals does not replay them');
  } finally {
    rig.cleanup();
  }
})();

(function tokenSourceSwitchesNeverReplayHistoricalUsage() {
  const rig = makeRig();
  try {
    let usage = {
      available: false,
      experimental: true,
      source: 'assistant_usage_events',
      sessions: {},
      total_output_tokens: 0,
    };
    rig.source._store.usageSnapshot = () => usage;

    rig.source._log.tokens = 100;
    assert.strictEqual(rig.source._buildModel().tokens, 0);
    rig.source._log.tokens = 120;
    assert.strictEqual(rig.source._buildModel().tokens, 20);

    usage = {
      available: true,
      experimental: true,
      source: 'assistant_usage_events',
      sessions: {},
      total_output_tokens: 1000000,
    };
    assert.strictEqual(rig.source._buildModel().tokens, 20,
      'switching to official lifetime totals establishes a new raw baseline');

    usage = { ...usage, available: false };
    rig.source._log.tokens = 100000;
    assert.strictEqual(rig.source._buildModel().tokens, 20,
      'a transient official-query failure holds the monotonic counter');

    usage = { ...usage, available: true, total_output_tokens: 1000030 };
    assert.strictEqual(rig.source._buildModel().tokens, 50,
      'official recovery credits only usage produced since the last good sample');
  } finally {
    rig.cleanup();
  }
})();

(function fallbackCountersRemainIndependentAcrossProcessLogs() {
  const rig = makeRig();
  try {
    rig.source._store.usageSnapshot = () => ({
      available: false,
      experimental: true,
      source: 'assistant_usage_events',
      sessions: {},
      total_output_tokens: 0,
    });

    rig.source._log.focusLog = 'process-a.log';
    rig.source._log.tokens = 100;
    assert.strictEqual(rig.source._buildModel().tokens, 0);

    rig.source._log.focusLog = 'process-b.log';
    rig.source._log.tokens = 20;
    assert.strictEqual(rig.source._buildModel().tokens, 0);

    rig.source._log.focusLog = 'process-a.log';
    rig.source._log.tokens = 100;
    assert.strictEqual(rig.source._buildModel().tokens, 0,
      'returning to an unchanged higher counter does not replay its history');

    rig.source._log.tokens = 130;
    assert.strictEqual(rig.source._buildModel().tokens, 30,
      'only a positive delta from the same process log advances progression');
  } finally {
    rig.cleanup();
  }
})();

(function rotatedFallbackLogEstablishesANewBaseline() {
  const rig = makeRig();
  try {
    rig.source._store.usageSnapshot = () => ({
      available: false,
      experimental: true,
      source: 'assistant_usage_events',
      sessions: {},
      total_output_tokens: 0,
    });

    rig.source._log.tokenSample = { source: 'process-a.log#1', value: 100 };
    assert.strictEqual(rig.source._buildModel().tokens, 0);
    rig.source._log.tokenSample = { source: 'process-a.log#2', value: 500 };
    assert.strictEqual(rig.source._buildModel().tokens, 0,
      'a rotated file does not replay the replacement log history');
    rig.source._log.tokenSample = { source: 'process-a.log#2', value: 525 };
    assert.strictEqual(rig.source._buildModel().tokens, 25);
  } finally {
    rig.cleanup();
  }
})();

// --- 5. the completion latch still behaves -----------------------------------
(function provisionalPromptsDoNotDisturbCompletionEdges() {
  const rig = makeRig();
  try {
    const now = Date.now();
    rig.addSession('sess-latch');
    rig.addTurn('sess-latch', 0, 'historical', now - 10 * 60 * 1000);
    // A question already in the file at startup: priming must not invent a
    // completion or a new-work edge out of replayed history.
    rig.ask('sess-latch', 'replayed history question', now - 3 * 60 * 60 * 1000, 'u-old');

    let model = rig.source._buildModel();
    assert.strictEqual(model.completionEdge, undefined,
      'startup primes the completion baseline without latching');
    assert.strictEqual(model.focus.provisional, false,
      'and a three-hour-old replayed question is not presented as live work');

    // A real new turn row is still a real completion edge, with a real time.
    rig.addTurn('sess-latch', 1, 'finished work', now - 1000);
    model = rig.source._buildModel();
    assert.ok(model.completionEdge, 'a new turn row latches a completion');
    assert.strictEqual(model.completionEdge.id, 'turn:2');
    assert.strictEqual(model.completionEdge.session, 'sess-latch');
    assert.ok(model.completionEdge.at > 0,
      'the edge carries a real epoch (this was 0 while ISO timestamps failed to parse)');
    assert.strictEqual(model.completed, true, 'and the celebrate window opens');

    // Re-reading the same row does not re-latch.
    assert.strictEqual(rig.source._buildModel().completionEdge, undefined);
  } finally {
    rig.cleanup();
  }
})();

// Older clients may populate SQLite without creating a session-state event
// stream. That absence is not delegated-agent evidence, so the legacy turn-row
// completion fallback must remain available.
(function sqliteCompletionFallbackWorksWithoutAnEventStream() {
  const rig = makeRig();
  try {
    const now = Date.now();
    const events = rig.addSession('sess-legacy');
    fs.rmSync(events);
    rig.addTurn('sess-legacy', 0, 'historical', now - 60 * 1000);
    assert.strictEqual(rig.source._buildModel().completionEdge, undefined);

    rig.addTurn('sess-legacy', 1, 'legacy completion', now - 1000);
    const model = rig.source._buildModel();
    assert.ok(model.completionEdge, 'SQLite still completes when events.jsonl is unavailable');
    assert.strictEqual(model.completionEdge.id, 'turn:2');
    assert.strictEqual(model.completionEdge.session, 'sess-legacy');
  } finally {
    rig.cleanup();
  }
})();

// Current CLIs expose an immediate task boundary in events.jsonl. It must
// celebrate before SQLite catches up, and the later row for that same turn must
// not produce a second completion when the next prompt arrives.
(function taskCompleteEventBeatsDelayedTurnRow() {
  const rig = makeRig();
  try {
    const now = Date.now();
    rig.addSession('sess-live');
    rig.addTurn('sess-live', 0, 'historical', now - 60 * 1000);
    rig.ask('sess-live', 'finish this now', now - 5000, 'u-live');

    let model = rig.source._buildModel(); // prime store + observe the user edge
    assert.strictEqual(model.completionEdge, undefined);

    rig.complete('sess-live', now - 1000, true, 'task-done-live');
    model = rig.source._buildModel();
    assert.ok(model.completionEdge, 'task_complete creates an immediate completion edge');
    assert.ok(model.completionEdge.id.includes('task-done-live'));
    assert.strictEqual(model.completionEdge.session, 'sess-live');
    assert.strictEqual(model.completionEdge.outcome, 'success');
    assert.strictEqual(model.completed, true);

    // The database catches up only when another prompt arrives. That row is
    // transcript data now, not a second completion signal.
    rig.addTurn('sess-live', 1, 'finish this now', now + 1000);
    rig.ask('sess-live', 'next question', now + 1100, 'u-next');
    model = rig.source._buildModel();
    assert.strictEqual(
      model.completionEdge,
      undefined,
      'the delayed row cannot replay the previous celebration on the next prompt'
    );

    rig.addTurn('sess-live', 2, 'legacy fallback turn', now + 2000);
    model = rig.source._buildModel();
    assert.ok(model.completionEdge,
      'after the one delayed echo is consumed, a different later row still completes');
    assert.strictEqual(model.completionEdge.id, 'turn:3');
  } finally {
    rig.cleanup();
  }
})();

// A spawned agent writes ordinary rows to the same SQLite turns table as its
// parent. The event stream is the ownership authority, so that child row must
// not become an ownerless success completion after the parent's task finishes.
(function delegatedTurnRowsCannotReplaceTheParentCompletion() {
  const rig = makeRig();
  try {
    const now = Date.now();
    rig.addSession('sess-parent');
    rig.addSession('sess-child');
    rig.addTurn('sess-parent', 0, 'historical parent turn', now - 60 * 1000);
    rig.ask('sess-parent', 'delegate this work', now - 5000, 'u-parent');
    rig.event('sess-child', 'user.message', {
      content: 'review the implementation',
      source: 'agent-reviewer',
    }, now - 4000);

    assert.strictEqual(rig.source._buildModel().completionEdge, undefined);
    rig.complete('sess-parent', now - 1000, true, 'parent-done');
    const parent = rig.source._buildModel().completionEdge;
    assert.ok(parent && parent.id.includes('parent-done'));
    assert.strictEqual(parent.session, 'sess-parent');

    rig.addTurn('sess-child', 0, 'delegated review', now + 1000);
    assert.strictEqual(
      rig.source._buildModel().completionEdge,
      undefined,
      'a delegated SQLite turn cannot replace the parent completion'
    );
  } finally {
    rig.cleanup();
  }
})();

// The event stream carries no working directory, but the session store does —
// under the same session id. Enriching the completion edge with it is what lets
// the bridge correlate a live task completion with the explicit session that
// produced it instead of guessing.
(function eventCompletionEdgesCarryTheSessionWorkingDirectory() {
  const rig = makeRig();
  try {
    const now = Date.now();
    rig.addSession('sess-cwd', '/work/firmware');
    rig.addTurn('sess-cwd', 0, 'historical', now - 60 * 1000);
    rig.ask('sess-cwd', 'build it', now - 5000, 'u-cwd');
    rig.source._buildModel();

    rig.complete('sess-cwd', now - 1000, true, 'task-cwd');
    const model = rig.source._buildModel();
    assert.ok(model.completionEdge, 'the task boundary still produces an edge');
    assert.strictEqual(model.completionEdge.cwd, '/work/firmware',
      'looked up from the session store, not guessed');
    assert.strictEqual(model.completionEdge.session, 'sess-cwd');

    // An unknown session stays null rather than borrowing another's directory.
    assert.strictEqual(rig.source._sessionCwd('sess-does-not-exist'), null);
    assert.strictEqual(rig.source._sessionCwd(null), null);
  } finally {
    rig.cleanup();
  }
})();

// Two conversations working at once produce edges of the same kind between
// polls. The model must carry both — a single newest-per-kind slot loses one
// session's evidence entirely.
(function concurrentSessionsEachContributeTheirOwnEdges() {
  const rig = makeRig();
  try {
    const now = Date.now();
    rig.addSession('sess-one', '/work/one');
    rig.addSession('sess-two', '/work/two');
    rig.addTurn('sess-one', 0, 'historical one', now - 60 * 1000);
    rig.addTurn('sess-two', 0, 'historical two', now - 60 * 1000);
    rig.source._buildModel(); // prime both files

    rig.ask('sess-one', 'question one', now - 2000, 'u-one');
    rig.ask('sess-two', 'question two', now - 1000, 'u-two');
    const model = rig.source._buildModel();

    const users = (model.edges || []).filter((edge) => edge.kind === 'user');
    assert.deepStrictEqual(users.map((edge) => edge.session).sort(), ['sess-one', 'sess-two'],
      'both conversations reach the bridge in the same model');
    assert.ok(model.edgeIds.user, 'the newest-per-kind slot is still published');

    // Drained: the next model does not replay them as fresh interactions.
    const next = rig.source._buildModel();
    assert.deepStrictEqual(next.edges, [], 'edges are edge-triggered, not level-triggered');
  } finally {
    rig.cleanup();
  }
})();

console.log(
  'PASS: source focus (current question over previous, one session for state and text, ' +
  'de-duplication, safe fallbacks, completion edges)'
);

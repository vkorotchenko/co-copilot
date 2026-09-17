'use strict';

// Temp-SQLite tests for CopilotStore against the *real* session-store schema.
//
// Two defects are covered:
//
//  1. Active-session windows compared text to text. `datetime('now', '-300
//     seconds')` yields '2026-09-16 21:00:00' while rows are written as
//     '2026-09-16T00:00:01.000Z'; 'T' (0x54) sorts after ' ' (0x20), so a
//     21-hour-old row compared as *inside* a five-minute window. Every
//     comparison is now epoch seconds computed by SQLite itself.
//
//  2. recentTurns() picked its own focus session (whoever held the newest
//     completed turn) independently of the session driving the live state. It
//     now takes the focused session id from the caller.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const { CopilotStore } = require('../src/copilot/store');

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
);`;

const USAGE_SCHEMA = `
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

function makeStore(seed) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'store-sessions-'));
  const file = path.join(root, 'session-store.db');
  const db = new Database(file);
  db.exec(SCHEMA);
  seed(db);
  db.close();
  const store = new CopilotStore({ sessionStoreDb: file });
  assert.ok(store.open(), 'store should open the seeded database');
  return { store, root, file };
}

function cleanup(ctx) {
  ctx.store.close();
  fs.rmSync(ctx.root, { recursive: true, force: true });
}

// Wall-clock helpers so the tests describe "N seconds ago", not fixed dates.
const isoAgo = (sec) => new Date(Date.now() - sec * 1000).toISOString();
const legacyAgo = (sec) =>
  new Date(Date.now() - sec * 1000).toISOString().replace('T', ' ').replace(/\..*$/, '');

// --- 1. ISO active windows ---------------------------------------------------
(function isoTimestampsRespectTheActiveWindow() {
  const ctx = makeStore((db) => {
    db.prepare('INSERT INTO sessions (id, cwd, repository) VALUES (?,?,?)')
      .run('sess-fresh', '/work/a', 'a');
    db.prepare('INSERT INTO sessions (id, cwd, repository) VALUES (?,?,?)')
      .run('sess-stale', '/work/b', 'b');
    const ins = db.prepare(
      'INSERT INTO turns (session_id, turn_index, user_message, timestamp) VALUES (?,?,?,?)'
    );
    // Inside a 5-minute window.
    ins.run('sess-fresh', 0, 'recent question', isoAgo(30));
    // Well outside it, but EARLIER THE SAME DAY — the case that used to compare
    // as "inside" because 'T' > ' '.
    ins.run('sess-stale', 0, 'this morning', isoAgo(8 * 60 * 60));
  });

  assert.strictEqual(
    ctx.store.countActiveSessions(5 * 60 * 1000), 1,
    'only the session with a turn inside the window counts; an ISO row from ' +
    'hours earlier the same day must not compare as recent'
  );
  assert.strictEqual(
    ctx.store.countActiveSessions(12 * 60 * 60 * 1000), 2,
    'widening the window past both rows counts both sessions'
  );
  cleanup(ctx);
})();

(function legacyAndIsoRowsShareOneWindow() {
  const ctx = makeStore((db) => {
    for (const id of ['sess-iso', 'sess-legacy', 'sess-old-legacy', 'sess-garbage']) {
      db.prepare('INSERT INTO sessions (id, cwd) VALUES (?,?)').run(id, '/work/' + id);
    }
    const ins = db.prepare(
      'INSERT INTO turns (session_id, turn_index, user_message, timestamp) VALUES (?,?,?,?)'
    );
    ins.run('sess-iso', 0, 'iso row', isoAgo(20));
    ins.run('sess-legacy', 0, 'legacy row', legacyAgo(40));
    ins.run('sess-old-legacy', 0, 'old legacy row', legacyAgo(6 * 60 * 60));
    ins.run('sess-garbage', 0, 'corrupt row', 'not-a-timestamp');
  });

  assert.strictEqual(
    ctx.store.countActiveSessions(5 * 60 * 1000), 2,
    'a mixed-format store counts both recent rows, excludes the old one, and ' +
    'silently drops the unparseable row instead of poisoning the count'
  );
  cleanup(ctx);
})();

// --- 2. focused recentTurns across interleaved sessions ----------------------
(function recentTurnsFollowTheFocusedSession() {
  const ctx = makeStore((db) => {
    db.prepare('INSERT INTO sessions (id, cwd, repository) VALUES (?,?,?)')
      .run('sess-foreground', '/work/app', 'app');
    db.prepare('INSERT INTO sessions (id, cwd, repository) VALUES (?,?,?)')
      .run('sess-background', '/work/bot', 'bot');
    const ins = db.prepare(
      'INSERT INTO turns (session_id, turn_index, user_message, timestamp) VALUES (?,?,?,?)'
    );
    // Deliberately interleaved in time AND in insertion order, so neither
    // timestamp order nor rowid order alone yields a clean single-session read.
    ins.run('sess-foreground', 0, 'fg one', isoAgo(300));
    ins.run('sess-background', 0, 'bg one', isoAgo(280));
    ins.run('sess-foreground', 1, 'fg two', isoAgo(260));
    ins.run('sess-background', 1, 'bg two', isoAgo(240));
    ins.run('sess-foreground', 2, 'fg three', isoAgo(220));
    // The background session owns the newest completed turn — the old
    // implementation would have shown its transcript no matter what the user
    // was actually looking at.
    ins.run('sess-background', 2, 'bg three', isoAgo(10));
  });

  const fg = ctx.store.recentTurns(6, 'sess-foreground');
  assert.deepStrictEqual(
    fg.map((t) => t.userMessage), ['fg three', 'fg two', 'fg one'],
    'a focused read returns only that session, newest first'
  );
  assert.ok(fg.every((t) => t.sessionId === 'sess-foreground'),
    'every row is tagged with the session it came from');
  assert.ok(fg.every((t) => t.time instanceof Date && !Number.isNaN(t.time.getTime())),
    'ISO timestamps resolve to usable Dates');

  const bg = ctx.store.recentTurns(6, 'sess-background');
  assert.deepStrictEqual(bg.map((t) => t.userMessage), ['bg three', 'bg two', 'bg one']);

  // No focus supplied => historical behaviour (newest-turn session wins).
  assert.deepStrictEqual(
    ctx.store.recentTurns(6).map((t) => t.userMessage),
    ['bg three', 'bg two', 'bg one'],
    'without a focus the newest-turn session is still used'
  );

  // A focus with no rows yet falls back rather than returning nothing, and the
  // returned sessionId tells the caller the fallback happened.
  const unknown = ctx.store.recentTurns(6, 'sess-brand-new');
  assert.strictEqual(unknown[0].sessionId, 'sess-background',
    'an unknown focus falls back to the newest-turn session, flagged by sessionId');

  assert.strictEqual(ctx.store.recentTurns(2, 'sess-foreground').length, 2, 'limit is honoured');
  cleanup(ctx);
})();

(function mixedFormatRowsSortChronologically() {
  const ctx = makeStore((db) => {
    db.prepare('INSERT INTO sessions (id, cwd) VALUES (?,?)').run('sess-mixed', '/work/mixed');
    const ins = db.prepare(
      'INSERT INTO turns (session_id, turn_index, user_message, timestamp) VALUES (?,?,?,?)'
    );
    // Inserted oldest-first but alternating format; a lexical ORDER BY would
    // put every 'T' row above every ' ' row regardless of actual time.
    ins.run('sess-mixed', 0, 'oldest', legacyAgo(400));
    ins.run('sess-mixed', 1, 'middle', isoAgo(300));
    ins.run('sess-mixed', 2, 'newest', legacyAgo(100));
  });

  assert.deepStrictEqual(
    ctx.store.recentTurns(5, 'sess-mixed').map((t) => t.userMessage),
    ['newest', 'middle', 'oldest'],
    'mixed-format rows order by real time, not by text'
  );
  cleanup(ctx);
})();

// --- newestTurnMarker carries a usable epoch ---------------------------------
(function newestTurnMarkerHasARealTimestamp() {
  const ctx = makeStore((db) => {
    db.prepare('INSERT INTO sessions (id, cwd) VALUES (?,?)').run('sess-edge', '/work/edge');
    db.prepare(
      'INSERT INTO turns (session_id, turn_index, user_message, timestamp) VALUES (?,?,?,?)'
    ).run('sess-edge', 0, 'finished', isoAgo(5));
  });

  const marker = ctx.store.newestTurnMarker();
  assert.ok(marker && marker.time instanceof Date, 'marker carries a Date');
  assert.ok(Number.isFinite(marker.time.getTime()) && marker.time.getTime() > 0,
    'the completion edge timestamp is a real epoch, not 0 from an Invalid Date');
  assert.strictEqual(marker.sessionId, 'sess-edge');
  assert.strictEqual(marker.cwd, '/work/edge');
  cleanup(ctx);
})();

(function corruptTimestampStillYieldsAnEdge() {
  const ctx = makeStore((db) => {
    db.prepare('INSERT INTO sessions (id, cwd) VALUES (?,?)').run('sess-bad', '/work/bad');
    db.prepare(
      'INSERT INTO turns (session_id, turn_index, user_message, timestamp) VALUES (?,?,?,?)'
    ).run('sess-bad', 0, 'finished', 'garbage');
  });
  const marker = ctx.store.newestTurnMarker();
  assert.ok(marker, 'a corrupt timestamp still produces a marker (identity is the row id)');
  assert.strictEqual(marker.time, null, 'and reports no usable time rather than a wrong one');
  cleanup(ctx);
})();

// --- official per-session usage --------------------------------------------
(function structuredUsageIsAggregatedPerCopilotSession() {
  const ctx = makeStore((db) => {
    db.exec(USAGE_SCHEMA);
    const insert = db.prepare(
      `INSERT INTO assistant_usage_events (
         session_id, turn_index, agent_id, model, input_tokens, output_tokens,
         cache_read_tokens, cache_write_tokens, reasoning_tokens,
         total_nano_aiu, created_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    );
    insert.run('sess-a', 0, null, 'model-one', 100, 10, 80, 5, 2, 1000, isoAgo(20));
    insert.run('sess-a', 0, 'subagent-1', 'model-two', 200, 20, 150, 10, 4, 2000, isoAgo(10));
    insert.run('sess-b', 0, null, 'model-one', 300, 30, 250, 15, 6, 3000, isoAgo(5));
  });

  let usage = ctx.store.usageSnapshot();
  assert.strictEqual(usage.available, true);
  assert.strictEqual(usage.experimental, true);
  assert.strictEqual(usage.source, 'assistant_usage_events');
  assert.strictEqual(usage.total_output_tokens, 60);
  assert.deepStrictEqual(
    {
      calls: usage.sessions['sess-a'].api_calls,
      input: usage.sessions['sess-a'].input_tokens,
      output: usage.sessions['sess-a'].output_tokens,
      cacheRead: usage.sessions['sess-a'].cache_read_tokens,
      cacheWrite: usage.sessions['sess-a'].cache_write_tokens,
      reasoning: usage.sessions['sess-a'].reasoning_tokens,
      nanoAiu: usage.sessions['sess-a'].total_nano_aiu,
    },
    {
      calls: 2,
      input: 300,
      output: 30,
      cacheRead: 230,
      cacheWrite: 15,
      reasoning: 6,
      nanoAiu: 3000,
    },
    'root and subagent calls aggregate into the same session/pal'
  );
  assert.strictEqual(usage.sessions['sess-a'].models['model-one'].output_tokens, 10);
  assert.strictEqual(usage.sessions['sess-a'].models['model-two'].output_tokens, 20);
  assert.strictEqual(usage.sessions['sess-a'].latest_model, 'model-two');
  assert.ok(
    Number.isFinite(Date.parse(usage.sessions['sess-a'].models['model-two'].updated_at)),
    'each model keeps its most recent official usage timestamp'
  );

  const writer = new Database(ctx.file);
  writer.prepare(
    `INSERT INTO assistant_usage_events (
       session_id, turn_index, agent_id, model, input_tokens, output_tokens,
       cache_read_tokens, cache_write_tokens, reasoning_tokens,
       total_nano_aiu, created_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).run('sess-a', 1, null, 'model-one', 50, 7, 40, 3, 1, 700, new Date().toISOString());
  writer.close();

  usage = ctx.store.usageSnapshot();
  assert.strictEqual(usage.sessions['sess-a'].api_calls, 3, 'new rows are reflected immediately');
  assert.strictEqual(usage.sessions['sess-a'].output_tokens, 37);
  assert.strictEqual(usage.sessions['sess-a'].models['model-one'].output_tokens, 17);
  assert.strictEqual(usage.total_output_tokens, 67);
  const filtered = ctx.store.usageSnapshot(['sess-a']);
  assert.deepStrictEqual(Object.keys(filtered.sessions), ['sess-a'],
    'the bridge can request only currently registered pal sessions');
  assert.strictEqual(filtered.total_output_tokens, 67,
    'global output-token progression still includes every official usage row');

  const deleteWriter = new Database(ctx.file);
  deleteWriter.prepare('DELETE FROM assistant_usage_events WHERE session_id = ?').run('sess-b');
  deleteWriter.close();
  usage = ctx.store.usageSnapshot(['sess-b']);
  assert.deepStrictEqual(usage.sessions, {},
    'requested session totals are re-queried so deleted rows do not remain attached');

  const replaceWriter = new Database(ctx.file);
  replaceWriter.exec('DELETE FROM assistant_usage_events');
  replaceWriter.prepare(
    `INSERT INTO assistant_usage_events (
       session_id, turn_index, agent_id, model, input_tokens, output_tokens,
       cache_read_tokens, cache_write_tokens, reasoning_tokens,
       total_nano_aiu, created_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).run('sess-c', 0, null, 'model-three', 10, 4, 0, 0, 0, 40, new Date().toISOString());
  replaceWriter.close();
  usage = ctx.store.usageSnapshot(['sess-a', 'sess-c']);
  assert.deepStrictEqual(Object.keys(usage.sessions), ['sess-c'],
    'an atomic table rebuild cannot preserve removed per-pal usage');
  assert.strictEqual(usage.sessions['sess-c'].output_tokens, 4);
  assert.strictEqual(usage.total_output_tokens, 4,
    'an atomic table rebuild replaces the global raw baseline instead of replaying history');
  cleanup(ctx);
})();

(function olderStoresDegradeWithoutInventingUsage() {
  const ctx = makeStore(() => {});
  const usage = ctx.store.usageSnapshot();
  assert.strictEqual(usage.available, false);
  assert.deepStrictEqual(usage.sessions, {});
  assert.strictEqual(usage.total_output_tokens, 0);
  cleanup(ctx);
})();

console.log(
  'PASS: store windows, focused turns, and structured per-session usage'
);

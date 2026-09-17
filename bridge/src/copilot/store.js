'use strict';

const fs = require('fs');
const path = require('path');
const log = require('../util/log');

const USAGE_TABLE = 'assistant_usage_events';
const USAGE_REPROBE_MS = 60 * 1000;
const USAGE_REQUIRED_COLUMNS = Object.freeze([
  'id',
  'session_id',
  'model',
  'input_tokens',
  'output_tokens',
  'cache_read_tokens',
  'cache_write_tokens',
  'reasoning_tokens',
  'total_nano_aiu',
  'created_at',
]);

// Read-only view over the Copilot CLI session store (~/.copilot/session-store.db).
// This is the history source for session counts and recent transcript. Current
// CLIs also materialize the official SDK `assistant.usage` events in
// `assistant_usage_events`, giving us authoritative per-call token totals keyed
// by Copilot session ID. Running/waiting state still comes from the live event
// and process-log sources. We never write to this DB.
//
// Timestamp formats: this store has shipped at least two. Older CLI builds used
// SQLite's own `datetime('now')` text ('YYYY-MM-DD HH:MM:SS', implicitly UTC);
// current builds write JavaScript ISO-8601 ('YYYY-MM-DDTHH:MM:SS.sssZ'). Both
// (and explicit ±HH:MM offsets) have to work, and — critically — they must
// never be compared *lexically* against each other: 'T' (0x54) sorts after
// ' ' (0x20), so `'2026-09-16T00:00:01Z' >= '2026-09-16 21:00:00'` is true even
// though the left side is 21 hours older. Every window comparison below is done
// on integer epoch seconds computed by SQLite itself, which understands both.
class CopilotStore {
  constructor(cfg) {
    this._dbPath = cfg.sessionStoreDb;
    this._db = null;
    this._Database = null;
    this._usageSupported = null;
    this._usageProbeAt = 0;
    this._usageDataVersion = null;
    this._usageOutputTotal = 0;
  }

  open() {
    if (this._db) return true;
    if (!fs.existsSync(this._dbPath)) {
      log.warn(`Session store not found at ${this._dbPath}; session counts will be 0.`);
      return false;
    }
    try {
      // eslint-disable-next-line global-require
      this._Database = require('better-sqlite3');
    } catch (err) {
      log.error('better-sqlite3 not available; session history disabled.', err.message);
      return false;
    }
    try {
      this._db = new this._Database(this._dbPath, { readonly: true, fileMustExist: true });
      this._db.pragma('busy_timeout = 2000');
      log.info(`Opened session store: ${path.basename(this._dbPath)}`);
      return true;
    } catch (err) {
      log.error('Failed to open session store (read-only):', err.message);
      this._db = null;
      return false;
    }
  }

  get ready() {
    return !!this._db;
  }

  // Distinct sessions that produced a turn within the window.
  //
  // Both sides are reduced to epoch seconds with strftime('%s', ...) so the
  // comparison is format-independent: a row stored as ISO-8601 and a window
  // bound derived from 'now' compare numerically, not as text. strftime is
  // available in every SQLite the CLI could have bundled (unlike unixepoch(),
  // which needs 3.38+), and it yields NULL for an unparseable timestamp, so a
  // corrupt row is simply excluded instead of poisoning the count.
  countActiveSessions(windowMs) {
    if (!this._db) return 0;
    try {
      const arg = `-${Math.round(windowMs / 1000)} seconds`;
      const row = this._db
        .prepare(
          `SELECT COUNT(DISTINCT session_id) AS n
             FROM turns
            WHERE CAST(strftime('%s', timestamp) AS INTEGER)
                  >= CAST(strftime('%s', 'now', ?) AS INTEGER)`
        )
        .get(arg);
      return row ? row.n : 0;
    } catch (err) {
      log.debug('countActiveSessions failed:', err.message);
      return 0;
    }
  }

  // Stable newest-inserted turn marker. Turn timestamps have only second
  // precision, so timestamp alone cannot distinguish two completions in the
  // same second. The row id is the monotonic edge identity. A successful empty
  // query returns null; an unavailable/failed query returns undefined.
  //
  // `time` is always a usable Date when the row carries anything parseable:
  // the JS parse (millisecond precision) is preferred, with SQLite's own epoch
  // as the fallback for any exotic-but-valid format JS would reject. The
  // completion edge derived from this marker therefore always has a real
  // timestamp for the bridge's replay watermark to compare against.
  newestTurnMarker() {
    if (!this._db) return undefined;
    try {
      const row = this._db
        .prepare(
          `SELECT t.id AS id, t.session_id AS session_id, t.timestamp AS ts,
                  CAST(strftime('%s', t.timestamp) AS INTEGER) AS tsEpoch,
                  s.cwd AS cwd
             FROM turns t
             LEFT JOIN sessions s ON s.id = t.session_id
            ORDER BY t.id DESC LIMIT 1`
        )
        .get();
      if (!row || row.id == null) return null;
      return {
        id: String(row.id),
        sessionId: row.session_id || null,
        cwd: row.cwd || null,
        time: parseUtc(row.ts) || epochSecondsToDate(row.tsEpoch),
      };
    } catch (err) {
      log.debug('newestTurnMarker failed:', err.message);
      return undefined;
    }
  }

  newestTurnTime() {
    const marker = this.newestTurnMarker();
    return marker ? marker.time : null;
  }

  // Working directory recorded for one session, or null when the store is
  // unavailable, the session is unknown, or the column is empty. A lookup, not
  // a guess: callers use it to correlate an event-stream completion (which
  // carries no directory of its own) with explicit session state.
  sessionCwd(sessionId) {
    if (!this._db || !sessionId) return null;
    try {
      const row = this._db
        .prepare('SELECT cwd FROM sessions WHERE id = ? LIMIT 1')
        .get(String(sessionId));
      return row && row.cwd ? row.cwd : null;
    } catch (err) {
      log.debug('sessionCwd failed:', err.message);
      return null;
    }
  }

  // Official per-session model usage, accumulated from the CLI's local
  // materialization of SDK `assistant.usage` events.
  //
  // `assistant.usage` itself is ephemeral and an external MCP server cannot
  // subscribe to the interactive CLI process. The CLI persists a
  // privacy-minimal row for each call in assistant_usage_events, so this
  // read-only adapter preserves the ordinary `copilot` workflow while exposing
  // the same token categories as experimental session.usage.getMetrics.
  //
  // SQLite's data_version lets us refresh the global total only after another
  // process commits a change. Per-session totals are queried from current rows
  // so deletion or table rebuilds cannot leave stale pal usage behind.
  usageSnapshot(sessionIds, now = Date.now()) {
    const unavailable = {
      available: false,
      experimental: true,
      source: USAGE_TABLE,
      sessions: {},
      total_output_tokens: 0,
    };
    if (!this._db || !this._hasUsageSchema(now)) return unavailable;

    try {
      this._refreshUsageOutputTotal();
      const sessions = this._queryUsageSessions(sessionIds);
      return {
        available: true,
        experimental: true,
        source: USAGE_TABLE,
        sessions,
        total_output_tokens: this._usageOutputTotal,
      };
    } catch (err) {
      log.debug('usageSnapshot failed:', err.message);
      return unavailable;
    }
  }

  _hasUsageSchema(now) {
    if (
      this._usageSupported !== null &&
      (this._usageSupported || now - this._usageProbeAt < USAGE_REPROBE_MS)
    ) {
      return this._usageSupported;
    }
    this._usageProbeAt = now;
    try {
      const columns = new Set(
        this._db.prepare(`PRAGMA table_info('${USAGE_TABLE}')`).all().map((row) => row.name)
      );
      this._usageSupported = USAGE_REQUIRED_COLUMNS.every((name) => columns.has(name));
      if (!this._usageSupported) {
        log.debug(`${USAGE_TABLE} is absent or missing required usage columns.`);
      }
    } catch (err) {
      log.debug('usage schema probe failed:', err.message);
      this._usageSupported = false;
    }
    return this._usageSupported;
  }

  _refreshUsageOutputTotal() {
    const dataVersion = integer(this._db.pragma('data_version', { simple: true }));
    if (this._usageDataVersion === dataVersion) return;
    const row = this._db
      .prepare(
        `SELECT COALESCE(SUM(COALESCE(output_tokens, 0)), 0) AS output_tokens
           FROM ${USAGE_TABLE}`
      )
      .get();
    this._usageOutputTotal = nonNegative(row && row.output_tokens);
    this._usageDataVersion = dataVersion;
  }

  // Per-pal totals are authoritative current-state queries. Querying only the
  // registered Copilot session IDs keeps the normal bridge tick bounded while
  // ensuring removed rows disappear from status and firmware projection.
  _queryUsageSessions(sessionIds) {
    const requested = Array.isArray(sessionIds)
      ? [...new Set(sessionIds.filter(Boolean).map(String))]
      : null;
    if (requested && requested.length === 0) return {};

    const where = requested
      ? `WHERE session_id IN (${requested.map(() => '?').join(',')})`
      : '';
    const rows = this._db
      .prepare(
        `SELECT session_id, model, COUNT(*) AS api_calls,
                SUM(COALESCE(input_tokens, 0)) AS input_tokens,
                SUM(COALESCE(output_tokens, 0)) AS output_tokens,
                SUM(COALESCE(cache_read_tokens, 0)) AS cache_read_tokens,
                SUM(COALESCE(cache_write_tokens, 0)) AS cache_write_tokens,
                SUM(COALESCE(reasoning_tokens, 0)) AS reasoning_tokens,
                SUM(COALESCE(total_nano_aiu, 0)) AS total_nano_aiu,
                MAX(created_at) AS updated_at
           FROM ${USAGE_TABLE}
           ${where}
          GROUP BY session_id, model`
      )
      .all(...(requested || []));

    const totals = new Map();
    for (const row of rows) mergeUsage(totals, row);
    return Object.fromEntries(
      [...totals.entries()].map(([sessionId, usage]) => [sessionId, copyUsage(usage)])
    );
  }

  // Most recent *completed* turns, newest first, with the session's working
  // directory.
  //
  // Scoped to a single session so the device transcript reflects one coherent
  // conversation instead of interleaving a background/autopilot session's
  // prompts with the one you're actively using. The caller (copilot/source.js)
  // supplies the focused session id it also used to pick the live state, so
  // state and text describe the same conversation. When no id is supplied — or
  // the supplied one has no rows yet (a brand-new session whose first turn
  // hasn't completed) — we fall back to the session owning the newest turn,
  // which is the historical behaviour.
  //
  // Ordering is by (epoch seconds, id) so rows written in different timestamp
  // formats still sort chronologically.
  recentTurns(limit, sessionId = null) {
    if (!this._db) return [];
    try {
      const focus = this._resolveTurnSession(sessionId);
      if (!focus) return [];
      const rows = this._db
        .prepare(
          `SELECT s.cwd AS cwd, s.repository AS repository,
                  t.session_id AS sessionId,
                  t.user_message AS userMessage, t.timestamp AS ts,
                  CAST(strftime('%s', t.timestamp) AS INTEGER) AS tsEpoch
             FROM turns t
             JOIN sessions s ON s.id = t.session_id
            WHERE t.session_id = ?
            ORDER BY CAST(strftime('%s', t.timestamp) AS INTEGER) DESC, t.id DESC
            LIMIT ?`
        )
        .all(focus, limit);
      return rows.map((r) => ({
        cwd: r.cwd || '',
        repository: r.repository || '',
        sessionId: r.sessionId || focus,
        userMessage: r.userMessage || '',
        time: parseUtc(r.ts) || epochSecondsToDate(r.tsEpoch),
      }));
    } catch (err) {
      log.debug('recentTurns failed:', err.message);
      return [];
    }
  }

  // Which session should own the transcript: the requested one if it actually
  // has rows, else whichever session holds the newest turn.
  _resolveTurnSession(sessionId) {
    if (sessionId) {
      const hit = this._db
        .prepare('SELECT 1 AS ok FROM turns WHERE session_id = ? LIMIT 1')
        .get(String(sessionId));
      if (hit) return String(sessionId);
    }
    const newest = this._db
      .prepare(
        `SELECT session_id FROM turns
          ORDER BY CAST(strftime('%s', timestamp) AS INTEGER) DESC, id DESC LIMIT 1`
      )
      .get();
    return newest && newest.session_id ? newest.session_id : null;
  }

  close() {
    if (this._db) {
      try { this._db.close(); } catch { /* noop */ }
      this._db = null;
    }
    this._usageSupported = null;
    this._usageProbeAt = 0;
    this._usageDataVersion = null;
    this._usageOutputTotal = 0;
  }
}

function emptyCounters() {
  return {
    api_calls: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    reasoning_tokens: 0,
    total_nano_aiu: 0,
  };
}

function emptyUsage() {
  return {
    ...emptyCounters(),
    updated_at: null,
    latest_model: null,
    models: Object.create(null),
  };
}

function mergeUsage(totals, row) {
  const sessionId = String(row.session_id || '');
  const model = String(row.model || '');
  if (!sessionId || !model) return 0;

  let total = totals.get(sessionId);
  if (!total) {
    total = emptyUsage();
    totals.set(sessionId, total);
  }
  let byModel = total.models[model];
  if (!byModel) {
    byModel = { ...emptyCounters(), updated_at: null };
    total.models[model] = byModel;
  }

  const counters = [
    'api_calls',
    'input_tokens',
    'output_tokens',
    'cache_read_tokens',
    'cache_write_tokens',
    'reasoning_tokens',
    'total_nano_aiu',
  ];
  let outputTokens = 0;
  for (const key of counters) {
    const value = nonNegative(row[key]);
    total[key] = addSafe(total[key], value);
    byModel[key] = addSafe(byModel[key], value);
    if (key === 'output_tokens') outputTokens = value;
  }
  const updatedAt = normalizeStoredTime(row.updated_at);
  if (updatedAt) {
    byModel.updated_at = updatedAt;
    if (
      !total.updated_at ||
      updatedAt > total.updated_at ||
      (updatedAt === total.updated_at && model < total.latest_model)
    ) {
      total.updated_at = updatedAt;
      total.latest_model = model;
    }
  }
  return outputTokens;
}

function copyUsage(usage) {
  return {
    api_calls: usage.api_calls,
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    cache_read_tokens: usage.cache_read_tokens,
    cache_write_tokens: usage.cache_write_tokens,
    reasoning_tokens: usage.reasoning_tokens,
    total_nano_aiu: usage.total_nano_aiu,
    updated_at: usage.updated_at,
    latest_model: usage.latest_model,
    models: Object.fromEntries(
      Object.entries(usage.models).map(([model, value]) => [model, { ...value }])
    ),
  };
}

function nonNegative(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

function integer(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

function addSafe(a, b) {
  return Math.min(Number.MAX_SAFE_INTEGER, nonNegative(a) + nonNegative(b));
}

function normalizeStoredTime(value) {
  const parsed = parseUtc(value);
  return parsed ? parsed.toISOString() : null;
}

// Accepted shapes for a stored timestamp, all normalized to UTC:
//
//   '2026-09-16T21:08:56.212Z'      current CLI (ISO-8601, ms, Z)
//   '2026-09-16T21:08:56Z'          ISO without milliseconds
//   '2026-09-16T14:08:56.212-07:00' explicit offset (also '-0700')
//   '2026-09-16T21:08:56'           ISO without a zone  -> treated as UTC
//   '2026-09-16 21:08:56'           legacy SQLite datetime('now') -> UTC
//   '2026-09-16'                    date only -> midnight UTC
//   Date / finite number (epoch ms) pass through
//
// Anything else — including a well-shaped but impossible date like
// '2026-02-30T00:00:00Z' — returns null rather than a silently wrong Date.
//
// The old implementation did `new Date(ts.replace(' ', 'T') + 'Z')`, which
// appends a second 'Z' to an already-ISO string ('...212ZZ') and yields an
// Invalid Date. That is why every transcript line lost its HH:MM prefix and why
// the completion edge carried at:0.
const TS_RE = new RegExp(
  '^(\\d{4})-(\\d{2})-(\\d{2})' +                                 // date
  '(?:[T ](\\d{2}):(\\d{2})(?::(\\d{2}))?(?:\\.(\\d{1,9}))?)?' +  // time
  '\\s*(Z|[+-]\\d{2}:?\\d{2})?$',                                 // zone
  'i'
);

function parseUtc(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? new Date(value) : null;
  }
  if (typeof value !== 'string') return null;

  const m = TS_RE.exec(value.trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = m[4] === undefined ? 0 : Number(m[4]);
  const minute = m[5] === undefined ? 0 : Number(m[5]);
  const second = m[6] === undefined ? 0 : Number(m[6]);

  // Validate on the *calendar* fields, before any zone shift. Checking the
  // resulting Date's UTC components instead would reject legitimate values:
  // '2026-09-30T23:00:00-07:00' is October in UTC, which is correct, not a
  // rollover. Anything out of range here ('2026-13-01', '2026-02-30',
  // '2026-09-16T25:00:00') is genuinely garbage.
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(year, month)) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;

  // Pad/trim the fraction to exactly 3 digits and default a missing zone to UTC
  // (which is what both stored formats mean).
  const ms = ((m[7] || '') + '000').slice(0, 3);
  const zoneRaw = m[8];
  let zone = 'Z';
  if (zoneRaw && zoneRaw.toUpperCase() !== 'Z') {
    zone = zoneRaw.length === 5 ? `${zoneRaw.slice(0, 3)}:${zoneRaw.slice(3)}` : zoneRaw;
  }

  const date = new Date(
    `${m[1]}-${m[2]}-${m[3]}T${pad2(hour)}:${pad2(minute)}:${pad2(second)}.${ms}${zone}`
  );
  return Number.isNaN(date.getTime()) ? null : date;
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function epochSecondsToDate(seconds) {
  if (seconds == null) return null;
  const n = Number(seconds);
  if (!Number.isFinite(n)) return null;
  return new Date(n * 1000);
}

module.exports = { CopilotStore, parseUtc };

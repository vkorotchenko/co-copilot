'use strict';

const fs = require('fs');
const EventEmitter = require('events');
const { CopilotStore } = require('./store');
const { CopilotLogTail } = require('./logtail');
const { PermissionWatch } = require('./permwatch');
const { stripInjected, flatten, promptText } = require('./sanitize');
const log = require('../util/log');

const MAX_PENDING_STORE_ECHOES = 8;

// Read the user's configured model/effort from ~/.copilot/settings.json. The
// INFO-level process log only names the model when it's the *default* ("Using
// default model: ..."); an explicitly-pinned model (settings.json "model")
// never appears there, so this is the reliable source for it. Cached by mtime
// so we re-read only when the file actually changes. Best-effort: any error
// degrades to nulls.
function makeSettingsReader(file) {
  let mtimeMs = -1;
  let cached = { model: null, effort: null };
  return () => {
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      return { model: null, effort: null };
    }
    if (stat.mtimeMs === mtimeMs) return cached;
    mtimeMs = stat.mtimeMs;
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      cached = {
        model: typeof j.model === 'string' && j.model ? j.model : null,
        effort:
          typeof j.effortLevel === 'string' && j.effortLevel
            ? j.effortLevel
            : null,
      };
    } catch {
      cached = { model: null, effort: null };
    }
    return cached;
  };
}

// Aggregates the Copilot CLI data sources (session store + live log tail +
// session-state event watch) into a single activity model and emits it on a
// fixed tick. The orchestrator turns models into wire snapshots and handles
// send/diff/keepalive.
//
// ---------------------------------------------------------------------------
// One conversation, one screen
// ---------------------------------------------------------------------------
// The device shows a pal state (thinking / waiting / celebrating) *and* a block
// of transcript text. Those used to be chosen independently — state from
// whichever process log was newest, text from whichever session held the newest
// completed `turns` row — so on a busy desk the pal could animate one
// conversation while the screen quoted another.
//
// Now a single focused session id, taken from the session-state event stream
// (permwatch.focus()), drives both: it scopes the transcript query and is
// reported in diagnostics. And because `turns` rows are only written when a
// turn *ends*, a completed-turn-only transcript is permanently one question
// behind — so the live `user.message` for that same focused session is merged
// in as a provisional newest entry until its row catches up.
//
// Events:
//   'model' -> (model)   see buildSnapshot() in protocol/snapshot.js for shape
class CopilotSource extends EventEmitter {
  constructor(cfg, deps = {}) {
    super();
    this._cfg = cfg;
    this._store = new CopilotStore(cfg);
    this._log = new CopilotLogTail(cfg);
    this._perm = new PermissionWatch(cfg);
    this._readSettings = makeSettingsReader(cfg.settingsJson);
    this._usageSessionIds =
      typeof deps.usageSessionIds === 'function' ? deps.usageSessionIds : null;
    this._timer = null;
    // Celebration latch (see _buildModel): task_complete events are the timely
    // signal; the newest SQLite turn remains a fallback for older clients.
    this._lastTurnId = null;
    this._lastEventCompletionId = null;
    this._pendingStoreEchoes = new Map();
    this._completionPrimed = false;
    this._celebrateUntil = 0;
    // The firmware consumes `tokens` as one bridge-lifetime cumulative
    // counter. Normalize raw sources into that single domain so switching from
    // a log estimate to official lifetime totals cannot replay history.
    this._tokenCounter = {
      total: 0,
      seen: false,
      official: false,
      rawBySource: new Map(),
    };
    // Last focus decision, exposed for diagnostics (never sent to the device).
    this._focus = null;
  }

  start() {
    this._store.open();
    const tick = () => {
      try {
        this.emit('model', this._buildModel());
      } catch (err) {
        log.error('source tick failed:', err.message);
      }
    };
    tick();
    this._timer = setInterval(tick, this._cfg.tickMs);
  }

  // Last focus decision: which session the transcript and state describe, why
  // it was chosen, and which log supplied the detail fields. Additive; purely
  // diagnostic.
  get focus() {
    return this._focus ? { ...this._focus } : null;
  }

  _buildModel() {
    const cfg = this._cfg;
    // Advance the log tail first so running-count and token parsing reflect the
    // latest log bytes. (Without this the tail never reads and the device stays
    // permanently "idle" with no tokens.)
    this._log.update();
    this._perm.update();
    const running = this._log.runningCount(cfg.busyWindowMs);
    const storeTotal = this._store.countActiveSessions(cfg.activeWindowMs);
    const total = Math.max(storeTotal, running);
    // Passive detection of Copilot's built-in permission prompts: when a session
    // is blocked waiting on the user, surface it as the device prompt so the
    // buddy lights up (the buttons can't answer it — it clears when the user
    // responds in the terminal and `permission.completed` lands in the log).
    const pendingPerm = this._perm.pending();
    const waitingUser = this._perm.waitingForUser();
    const waiting = (pendingPerm || waitingUser) ? 1 : 0;

    const newest = this._store.newestTurnMarker();
    // Edge-triggered completion: current CLIs write session.task_complete to
    // events.jsonl immediately, while the SQLite turn row may not become
    // visible until the next user prompt. Prefer the event so the celebration
    // happens when work actually ends; keep the row as an older-client fallback.
    const newestMs = newest && newest.time ? newest.time.getTime() : 0;
    const newestId = newest ? String(newest.id) : null;
    let completionEdge = null;
    const eventCompletion =
      typeof this._perm.completionEdge === 'function'
        ? this._perm.completionEdge()
        : null;
    if (
      eventCompletion &&
      eventCompletion.id != null &&
      eventCompletion.id !== this._lastEventCompletionId
    ) {
      this._lastEventCompletionId = eventCompletion.id;
      this._celebrateUntil = Date.now() + cfg.completedHoldMs;
      completionEdge = {
        id: `event:${eventCompletion.id}`,
        outcome: eventCompletion.outcome || 'success',
        at: Number.isFinite(eventCompletion.at) ? eventCompletion.at : Date.now(),
        session: eventCompletion.sessionId || null,
        // The event stream has no working directory of its own; the session
        // store does, keyed by the same session id. Looked up, never guessed:
        // an unknown session simply stays null rather than borrowing another
        // session's directory.
        cwd: this._sessionCwd(eventCompletion.sessionId),
      };
      this._armStoreEcho(completionEdge);
    }
    if (!this._completionPrimed && newest !== undefined) {
      this._completionPrimed = true;
      this._lastTurnId = newestId; // prime on startup; don't celebrate history
    } else if (newestId !== null && newestId !== this._lastTurnId) {
      const ownership = this._sessionOwnership(newest.sessionId);
      // A freshly discovered session file may need another poll before its
      // human/delegated owner is known. Keep the marker pending rather than
      // turning an unclassified child-agent row into a success completion.
      if (ownership !== 'unknown') {
        this._lastTurnId = newestId;
        const delayedEventEcho = this._consumeStoreEcho(newest);
        if (!completionEdge && !delayedEventEcho && ownership !== 'delegated') {
          this._celebrateUntil = Date.now() + cfg.completedHoldMs;
          completionEdge = {
            id: `turn:${newestId}`,
            outcome: 'success',
            at: newestMs,
            session: newest.sessionId || null,
            cwd: newest.cwd || null,
          };
        }
      }
    }
    const completed = !this._log.aiActive && Date.now() < this._celebrateUntil;

    const { entries, focus } = this._buildTranscript();
    this._focus = focus;
    const officialUsage =
      this._store && typeof this._store.usageSnapshot === 'function'
        ? this._store.usageSnapshot(this._trackedUsageSessionIds())
        : null;

    const model = {
      total,
      running,
      waiting,
      completed: !!completed,
      msg: deriveMsg({ running, waiting, total, pendingPerm, waitingUser }),
      entries,
      // Additive diagnostic: which conversation `entries` and the live state
      // describe. composeModel() copies only the documented device fields, so
      // this never reaches the wire snapshot or the firmware budget.
      focus,
      edgeIds: {
        ...this._perm.edgeIds,
        aiRequest: this._log.aiRequestEdge || null,
      },
      // Edge-triggered, per-session view of the same semantic edges: every
      // prompt/user/tool edge newly observed in this poll, including several of
      // the same kind from different conversations. `edgeIds` reports only the
      // newest of each kind, so concurrent sessions used to overwrite one
      // another between polls and the loser never reached the bridge.
      edges: this._takeEdges(),
    };
    if (officialUsage) model.officialUsage = officialUsage;
    if (completionEdge) model.completionEdge = completionEdge;

    // A pending built-in permission prompt rides the device's existing prompt
    // UI (buildSnapshot forwards model.prompt). The firmware de-dups by id, so
    // re-sending the same `perm-<requestId>` never re-nags. An MCP confirm, if
    // active, still takes precedence (the bridge overlays its own prompt).
    if (pendingPerm) {
      model.prompt = { id: pendingPerm.id, tool: pendingPerm.tool, hint: pendingPerm.hint };
    }

    const tokens = this._cumulativeOutputTokens(officialUsage);
    if (tokens != null) model.tokens = tokens;
    const ctx = this._log.contextTokens;
    if (ctx) { model.tokensUsed = ctx.used; model.tokensMax = ctx.max; }

    // Model/effort: prefer the live log, fall back to the user's settings.json
    // (the log omits an explicitly-pinned model and only logs effort at debug).
    const settings = this._readSettings();
    const modelName = this._log.model || settings.model;
    const effort = this._log.effort || settings.effort;
    if (modelName) model.model = modelName;
    if (effort) model.effort = effort;

    return model;
  }

  // Every semantic edge the permission watch newly observed this poll, or an
  // empty list for a watcher that does not publish them (older contract, test
  // doubles). Drained, so each edge is reported exactly once.
  _takeEdges() {
    if (!this._perm || typeof this._perm.takeEdges !== 'function') return [];
    try {
      const edges = this._perm.takeEdges();
      return Array.isArray(edges) ? edges : [];
    } catch (err) {
      log.debug('edge drain failed:', err.message);
      return [];
    }
  }

  _trackedUsageSessionIds() {
    if (!this._usageSessionIds) return undefined;
    try {
      const ids = this._usageSessionIds();
      return Array.isArray(ids) ? ids : [];
    } catch (err) {
      log.debug('usage session selection failed:', err.message);
      return [];
    }
  }

  _sessionOwnership(sessionId) {
    if (!this._perm || typeof this._perm.sessionOwnership !== 'function') return 'human';
    try {
      const ownership = this._perm.sessionOwnership(sessionId);
      return ownership === 'human' || ownership === 'delegated' || ownership === 'unavailable'
        ? ownership
        : 'unknown';
    } catch (err) {
      log.debug('session ownership lookup failed:', err.message);
      return 'unknown';
    }
  }

  // Normalize raw counters into one cumulative value for the firmware's pet
  // progression. The first reading from each source is a baseline, not earned
  // progress. After official usage becomes available it remains authoritative;
  // transient query failures hold the last value instead of falling back to an
  // unrelated context-window counter and replaying history on recovery.
  _cumulativeOutputTokens(officialUsage) {
    const counter = this._tokenCounter;
    if (officialUsage && officialUsage.available) {
      counter.official = true;
      return this._observeTokenCounter('official', officialUsage.total_output_tokens);
    }
    if (counter.official) return counter.seen ? counter.total : null;
    const sample = this._log && this._log.tokenSample;
    if (sample && sample.source) {
      return this._observeTokenCounter(`log:${sample.source}`, sample.value);
    }
    const source = this._log && this._log.focusLog ? `log:${this._log.focusLog}` : 'log';
    return this._observeTokenCounter(source, this._log.tokens);
  }

  _observeTokenCounter(source, value) {
    const counter = this._tokenCounter;
    if (value === null || value === undefined) return counter.seen ? counter.total : null;
    const raw = Number(value);
    if (!Number.isFinite(raw) || raw < 0) return counter.seen ? counter.total : null;
    const normalized = Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(raw));

    if (!counter.rawBySource.has(source)) {
      counter.rawBySource.set(source, normalized);
      counter.seen = true;
      return counter.total;
    }

    const previous = counter.rawBySource.get(source);
    if (normalized >= previous) {
      counter.total = Math.min(
        Number.MAX_SAFE_INTEGER,
        counter.total + (normalized - previous)
      );
    }
    counter.rawBySource.set(source, normalized);
    return counter.total;
  }

  // Working directory the session store records for a Copilot session, or null
  // when it is unknown (no store, no row, or a test double without the
  // lookup). Used to correlate a live event completion with the explicit
  // session that produced it.
  _sessionCwd(sessionId) {
    if (!sessionId || !this._store || typeof this._store.sessionCwd !== 'function') return null;
    try {
      return this._store.sessionCwd(sessionId);
    } catch (err) {
      log.debug('session cwd lookup failed:', err.message);
      return null;
    }
  }

  _armStoreEcho(completion) {
    const sessionId = completion && completion.session;
    if (!sessionId) return;
    // One task eventually creates one SQLite row. Replacing the same session's
    // older guard is safe because that older row lands when the next prompt
    // begins, before another task in the session can complete.
    this._pendingStoreEchoes.delete(sessionId);
    this._pendingStoreEchoes.set(sessionId, {
      completionId: completion.id,
      at: completion.at,
    });
    while (this._pendingStoreEchoes.size > MAX_PENDING_STORE_ECHOES) {
      this._pendingStoreEchoes.delete(this._pendingStoreEchoes.keys().next().value);
    }
  }

  _consumeStoreEcho(marker) {
    const sessionId = marker && marker.sessionId;
    if (!sessionId || !this._pendingStoreEchoes.has(sessionId)) return null;
    const echo = this._pendingStoreEchoes.get(sessionId);
    this._pendingStoreEchoes.delete(sessionId);
    return echo;
  }

  // Build the transcript for one conversation, plus the focus record explaining
  // which conversation that was.
  //
  // Order of operations:
  //   1. Pick the focused session from the event stream (active/requesting/
  //      waiting first, newest semantic edge as the tie-break).
  //   2. Read that session's completed turns.
  //   3. If a live prompt exists for the same session and no completed row has
  //      caught up to it yet, splice it in as the newest entry.
  //
  // Every step degrades to the previous behaviour when its input is missing, so
  // a CLI without session-state events, a mocked permwatch, or an unreadable
  // store all still produce a transcript.
  _buildTranscript() {
    const cfg = this._cfg;
    const focusPick = this._pickFocus();
    const focusId = focusPick ? focusPick.sessionId : null;

    const turns = this._store.recentTurns(cfg.maxEntries, focusId) || [];
    const turnSession = turns.length ? (turns[0].sessionId || null) : null;
    // The store falls back to the newest-turn session when the focused one has
    // no completed rows yet (a brand-new conversation). Detect that so we never
    // present another conversation's history as this one's.
    const storeFellBack = !!(focusId && turnSession && turnSession !== focusId);

    const provisional = this._livePrompt(focusId);

    let rows = turns;
    let source = focusPick ? focusPick.reason : 'store';
    if (storeFellBack) {
      if (provisional) {
        // A live question in a session with no completed rows: show only it.
        // Splicing in the *other* session's history is exactly the mismatch
        // this focus work exists to prevent.
        rows = [];
        source = `${source}/new-session`;
      } else {
        // Nothing live to contradict the rows, so showing recent history beats
        // showing an empty screen. Flagged so diagnostics stay honest.
        source = `${source}/store-fallback`;
      }
    }

    let merged = rows;
    let mergedProvisional = false;
    if (provisional) {
      if (this._isPersisted(provisional, rows)) {
        // The turn row caught up: retire the provisional copy so it is neither
        // re-merged nor kept alive by the watcher.
        if (typeof this._perm.resolvePrompt === 'function') {
          this._perm.resolvePrompt(provisional.sessionId, provisional.id);
        }
      } else {
        merged = [{
          cwd: '',
          repository: '',
          sessionId: provisional.sessionId,
          userMessage: provisional.text,
          time: new Date(provisional.at),
        }].concat(rows);
        mergedProvisional = true;
      }
    }

    // recentTurns is newest-first; the firmware renders the transcript oldest-
    // at-top and treats the LAST line as the newest ("fresh", highlighted, and
    // the only one shown in the compact live view). So hand it oldest-first
    // (newest last) — otherwise the buddy shows/highlights the oldest prompts.
    const entries = merged
      .slice(0, cfg.maxEntries)
      .map((t) => formatEntry(t))
      .filter(Boolean)
      .reverse();

    return {
      entries,
      focus: {
        sessionId: focusId,
        source,
        turnSession: storeFellBack ? turnSession : (turnSession || focusId),
        provisional: mergedProvisional,
        logFile: typeof this._log.focusLog === 'string' ? this._log.focusLog : null,
        trackedLogs: Number.isFinite(this._log.trackedLogCount)
          ? this._log.trackedLogCount
          : null,
      },
    };
  }

  // Focused session from the event stream, or null when unavailable (older CLI
  // with no session-state dir, or a test double without the method).
  _pickFocus() {
    if (!this._perm || typeof this._perm.focus !== 'function') return null;
    let pick;
    try {
      pick = this._perm.focus();
    } catch (err) {
      log.debug('focus selection failed:', err.message);
      return null;
    }
    if (!pick || !pick.sessionId) return null;
    return { sessionId: String(pick.sessionId), reason: pick.reason || 'focus' };
  }

  _livePrompt(focusId) {
    if (!focusId || !this._perm || typeof this._perm.currentPrompt !== 'function') return null;
    try {
      const p = this._perm.currentPrompt(focusId);
      return p && p.text ? p : null;
    } catch (err) {
      log.debug('current prompt read failed:', err.message);
      return null;
    }
  }

  // Has the completed `turns` row for this live prompt landed yet?
  //
  // Text equality alone would be wrong: asking "test" twice would make the
  // second, still-running question look already-persisted because of the first
  // one's row. The row is written when the turn *ends*, so it is always at or
  // after the prompt — requiring that ordering (with a second of slack for the
  // store's second-precision timestamps) distinguishes the two.
  _isPersisted(provisional, rows) {
    for (const row of rows) {
      if (!row) continue;
      if (row.sessionId && row.sessionId !== provisional.sessionId) continue;
      const rowText = promptText(row.userMessage, provisional.text.length);
      if (rowText !== provisional.text) continue;
      const rowMs = row.time ? row.time.getTime() : NaN;
      if (!Number.isFinite(rowMs) || rowMs >= provisional.at - 1000) return true;
    }
    return false;
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    this._store.close();
  }
}

function deriveMsg({ running, total, pendingPerm, waitingUser }) {
  if (pendingPerm) return 'approval waiting';
  if (waitingUser) return 'your turn';
  if (running > 0) return 'working...';
  if (total > 0) return 'idle';
  return 'idle';
}

// "HH:MM <summary>" for the device transcript, newest first. The summary is
// the full prompt with whitespace/newlines collapsed to single spaces; the
// device word-wraps and scrolls it, so we send it (nearly) whole rather than
// truncating to a single short line.
function formatEntry(turn) {
  const when = turn.time ? hhmm(turn.time) : '';
  let text = flatten(stripInjected(turn.userMessage));
  if (!text) {
    const base = (turn.repository || turn.cwd || '').split(/[\\/]/).pop();
    text = base ? `(${base})` : '';
  }
  text = text.slice(0, 150);
  if (!text) return '';
  return when ? `${when} ${text}` : text;
}

function hhmm(date) {
  const p = (n) => String(n).padStart(2, '0');
  return `${p(date.getHours())}:${p(date.getMinutes())}`;
}

module.exports = { CopilotSource, stripInjected, formatEntry };

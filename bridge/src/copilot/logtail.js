'use strict';

const fs = require('fs');
const path = require('path');
const log = require('../util/log');

// Tails the Copilot CLI process logs (~/.copilot/logs/process-*.log) to derive
// *live* signals the session store can't give us:
//   - "running": how many model requests are open right now.
//   - tokens / model / effort: best-effort parse of the session detail lines.
//
// MULTIPLE LOGS, NOT ONE. Each CLI process writes its own process-*.log, so two
// concurrent sessions are two files. Following only the newest-mtime file loses
// state the moment the *other* file becomes newest: the previously tracked open
// AI groups were discarded on every switch, so an in-flight request could
// silently drop to "idle" (and back) as the two logs interleaved. We now track
// every recently-active file independently, keep its own group stack, and
// aggregate. Switching which file is newest is then purely cosmetic — it only
// moves which file supplies the *detail* fields.
//
// IMPORTANT: process-*.log is a human-readable log, not a stable API. The
// growth signal relies only on the file growing (format-independent and robust)
// and is used purely as a fallback. Token parsing is best-effort and may yield
// nothing across CLI versions; it never throws and degrades to "unknown".
//
// There is deliberately NO log-file -> Copilot session-id correlation here.
// The process logs contain no session id and no cwd (verified against a live
// install), so any mapping would be a guess. Session identity comes from the
// session-state event stream instead (see copilot/permwatch.js), which carries
// the id in its path.
class CopilotLogTail {
  constructor(cfg) {
    const l = (cfg && cfg.logs) || {};
    this._dir = cfg.logsDir;
    // Only follow logs touched this recently (plus any still holding an open AI
    // request). Keeps a laptop with months of logs from being walked in full.
    this._recentWindowMs = l.recentWindowMs || 30 * 60 * 1000;
    // Hard cap on tracked files. Newest-mtime wins, except that a file with an
    // open AI request is never evicted while the request is in flight.
    this._maxFiles = l.maxFiles || 8;
    this._maxReadBytes = 256 * 1024; // cap per-poll read

    // path -> per-file state (see _newState). Each file owns its own group
    // stack: groups are well-nested *within a process*, never across.
    this._files = new Map();
    // Newest-mtime tracked file. Deterministic single source for the detail
    // fields (model / effort / context tokens) so a two-session desk doesn't
    // flicker between two model names.
    this._focus = null;
    this._fileGeneration = 0;

    // Semantic "new AI request started" edge, global across files: the bridge
    // only needs to know that *something* new began, and a single monotonic
    // counter gives it a stable, collision-free identity.
    this._aiRequestGeneration = 0;
    this._aiRequestEdge = null;

    // Backing fields for the ad-hoc state (see _adhoc): a directly-driven
    // `_consume(text)` with no file behind it, used by tests and by nothing in
    // production. Exposed as plain properties so they stay pokeable.
    this._groupStack = [];
    this._aiOpen = 0;
    this._lastAiMs = 0;
    this._sawAiGroup = false;
    this._adhocState = null;
  }

  // Poll: rescan candidate logs, attach to new ones, consume appended bytes.
  update() {
    const candidates = this._candidates();
    for (const known of [...this._files.keys()]) {
      if (!candidates.has(known)) this._files.delete(known);
    }
    for (const [file, mtimeMs] of candidates) {
      try {
        this._follow(file, mtimeMs);
      } catch (err) {
        log.debug('log follow failed:', err.message);
      }
    }
    this._refocus(candidates);
  }

  // Which logs to track: everything modified within the recent window, newest
  // first, capped at _maxFiles — plus two exemptions:
  //
  //   * The newest log overall is ALWAYS tracked, even if it is older than the
  //     window. A session can sit idle for hours and then resume; if its log
  //     were untracked we would only attach on the poll *after* it resumed and
  //     would silently skip the bytes that opened the request (including the
  //     "Start of group" line). This also preserves the previous behaviour,
  //     which followed the newest log unconditionally.
  //   * Any already-tracked file with an open AI request, which must never be
  //     dropped mid-flight no matter how many newer logs appear.
  //
  // Returns Map<path, mtimeMs>.
  _candidates() {
    const found = [];
    this._walkLogs(this._dir, 0, found);
    const now = Date.now();
    const out = new Map();
    found.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.path < b.path ? -1 : 1));
    if (found.length) out.set(found[0].path, found[0].mtimeMs);
    for (const entry of found) {
      if (out.size >= this._maxFiles) break;
      if (now - entry.mtimeMs <= this._recentWindowMs) out.set(entry.path, entry.mtimeMs);
    }
    for (const entry of found) {
      if (out.has(entry.path)) continue;
      const st = this._files.get(entry.path);
      if (st && st.aiOpen > 0) out.set(entry.path, entry.mtimeMs);
    }
    return out;
  }

  _walkLogs(dir, depth, found) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        // Search recursively so a launcher that redirects logs into per-session
        // subdirectories (e.g. `--log-dir <root>/session_*/process-*.log`) is
        // still found. A flat ~/.copilot/logs works too (it's just depth 0).
        if (depth < 4) this._walkLogs(full, depth + 1, found);
      } else if (/^process-.*\.log$/.test(ent.name)) {
        try {
          found.push({ path: full, mtimeMs: fs.statSync(full).mtimeMs });
        } catch { /* skip */ }
      }
    }
  }

  _newState(file, fileIdentity = null) {
    return {
      path: file,
      fileIdentity,
      generation: ++this._fileGeneration,
      offset: 0,
      partial: '',
      lastGrowthMs: 0,
      mtimeMs: 0,
      // AI-request groups. The CLI brackets each model call with INFO lines:
      //   --- Start of group: Sending request to the AI model ---
      //   --- End of group ---
      // Groups are well-nested (LIFO) but "End of group" is generic, so we keep
      // a stack of booleans (isAiRequest) and count the open AI ones.
      groupStack: [],
      aiOpen: 0,
      lastAiMs: 0,
      sawAiGroup: false,
      // Detail fields, last-value-wins within this file.
      model: null,
      effort: null,
      tokens: 0,
      sawTokens: false,
      ctxUsed: 0,
      ctxMax: 0,
      sawCtx: false,
      detailAt: 0,
    };
  }

  _follow(file, mtimeMs) {
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      return;
    }
    const size = stat.size;
    const fileIdentity = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
    let st = this._files.get(file);
    if (!st) {
      // Attach at EOF: we only care about growth from now on, not historical
      // megabytes. Seed "last value wins" detail (model / effort / context
      // tokens) from the tail so they appear immediately on connect instead of
      // waiting for the next occurrence. Groups (the running count) stay
      // tail-only — replaying historical open/close groups would be misleading.
      st = this._newState(file, fileIdentity);
      this._files.set(file, st);
      this._seedFromHistory(st, file, size);
      st.offset = size;
      st.mtimeMs = mtimeMs;
      log.debug('Following log:', path.basename(file));
      return;
    }
    st.mtimeMs = mtimeMs;

    const replayingAfterTruncate =
      st.fileIdentity !== fileIdentity || size < st.offset;
    if (replayingAfterTruncate) {
      // Truncated/rotated in place; rebuild open-group state from the new file
      // without treating its historical starts as new semantic work edges.
      st.fileIdentity = fileIdentity;
      st.generation = ++this._fileGeneration;
      st.offset = 0;
      st.partial = '';
      st.groupStack = [];
      st.aiOpen = 0;
      st.model = null;
      st.effort = null;
      st.tokens = 0;
      st.sawTokens = false;
      st.ctxUsed = 0;
      st.ctxMax = 0;
      st.sawCtx = false;
      st.detailAt = 0;
    }
    if (size === st.offset) return;

    // The file grew => activity. This is the robust "busy" fallback signal.
    st.lastGrowthMs = Date.now();

    const start = Math.max(st.offset, size - this._maxReadBytes);
    const length = size - start;
    const buf = Buffer.allocUnsafe(length);
    let read = 0;
    try {
      const fd = fs.openSync(file, 'r');
      read = fs.readSync(fd, buf, 0, length, start);
      fs.closeSync(fd);
    } catch (err) {
      log.debug('log read failed:', err.message);
      return;
    }
    st.offset = size;
    this._consume(buf.subarray(0, read).toString('utf8'), !replayingAfterTruncate, st);
  }

  // Deterministic focus for the detail fields: the newest-mtime tracked file,
  // ties broken by path so the choice never depends on Map iteration order.
  _refocus(candidates) {
    let best = null;
    for (const [file, mtimeMs] of candidates) {
      if (!this._files.has(file)) continue;
      if (!best || mtimeMs > best.mtimeMs || (mtimeMs === best.mtimeMs && file < best.file)) {
        best = { file, mtimeMs };
      }
    }
    this._focus = best ? best.file : null;
  }

  // `st` defaults to the ad-hoc state so `_consume(text)` / `_consume(text,
  // false)` keep working against the tail's own `_groupStack` / `_aiOpen`
  // fields; production callers always pass a per-file state.
  _consume(text, advanceAiIdentity = true, st = this._adhoc()) {
    const data = st.partial + text;
    const lines = data.split(/\r?\n/);
    st.partial = lines.pop(); // last element is an incomplete line
    for (const line of lines) {
      this._parseGroups(line, advanceAiIdentity, st);
      this._parseTokens(line, st);
      this._parseModel(line, st);
      this._parseEffort(line, st);
    }
  }

  // A file-less state whose group fields alias the tail's own properties.
  _adhoc() {
    if (this._adhocState) return this._adhocState;
    const tail = this;
    const st = this._newState('<adhoc>');
    Object.defineProperties(st, {
      groupStack: {
        get() { return tail._groupStack; },
        set(v) { tail._groupStack = v; },
        enumerable: true,
      },
      aiOpen: {
        get() { return tail._aiOpen; },
        set(v) { tail._aiOpen = v; },
        enumerable: true,
      },
      lastAiMs: {
        get() { return tail._lastAiMs; },
        set(v) { tail._lastAiMs = v; },
        enumerable: true,
      },
      sawAiGroup: {
        get() { return tail._sawAiGroup; },
        set(v) { tail._sawAiGroup = v; },
        enumerable: true,
      },
    });
    this._adhocState = st;
    return st;
  }

  // Every state that contributes to the aggregate signals.
  * _states() {
    yield* this._files.values();
    if (this._adhocState) yield this._adhocState;
  }

  // Seed model / effort / context tokens from the tail of a freshly-attached
  // log so they're available on connect rather than only after the next
  // occurrence. Reads at most _maxReadBytes; never tails groups (running count).
  _seedFromHistory(st, file, size) {
    const start = Math.max(0, size - this._maxReadBytes);
    const length = size - start;
    if (length <= 0) return;
    let text = '';
    try {
      const fd = fs.openSync(file, 'r');
      const buf = Buffer.allocUnsafe(length);
      const read = fs.readSync(fd, buf, 0, length, start);
      fs.closeSync(fd);
      text = buf.subarray(0, read).toString('utf8');
    } catch (err) {
      log.debug('history seed read failed:', err.message);
      return;
    }
    for (const line of text.split(/\r?\n/)) {
      this._parseTokens(line, st);
      this._parseModel(line, st);
      this._parseEffort(line, st);
    }
  }

  // Track AI-request groups so "running" reflects actual generation rather than
  // any log activity. Groups are well-nested within a file, so we push on every
  // "Start of group" (flagging the AI-model ones) and pop on every "End of
  // group".
  _parseGroups(line, advanceAiIdentity, st) {
    const start = line.indexOf('Start of group: ');
    if (start !== -1) {
      const isAi = line.indexOf('Sending request to the AI model') !== -1;
      st.groupStack = st.groupStack.concat([isAi]);
      if (isAi) {
        st.sawAiGroup = true;
        st.aiOpen = st.aiOpen + 1;
        if (advanceAiIdentity) {
          this._aiRequestGeneration++;
          this._aiRequestEdge = {
            id: String(this._aiRequestGeneration),
            at: parseLogTimestamp(line) || Date.now(),
          };
        }
        st.lastAiMs = Date.now();
      }
      return;
    }
    if (line.indexOf('End of group') !== -1) {
      const stack = st.groupStack.slice();
      const wasAi = stack.pop();
      st.groupStack = stack;
      if (wasAi) {
        if (st.aiOpen > 0) st.aiOpen = st.aiOpen - 1;
        st.lastAiMs = Date.now();
      }
    }
  }

  // Context-window usage from the INFO line:
  //   CompactionProcessor: Utilization 35.0% (58817/168000 tokens) ...
  // This is the meaningful "tokens used" for a live session (used/total of the
  // window). We also keep the loose legacy match as a fallback for other lines.
  _parseTokens(line, st) {
    if (line.indexOf('token') === -1 && line.indexOf('Token') === -1) return;
    const ctx = /\((\d[\d,]*)\s*\/\s*(\d[\d,]*)\s+tokens\)/.exec(line);
    if (ctx) {
      const used = parseInt(ctx[1].replace(/,/g, ''), 10);
      const max = parseInt(ctx[2].replace(/,/g, ''), 10);
      if (Number.isFinite(used) && Number.isFinite(max)) {
        st.sawCtx = true;
        st.ctxUsed = used;
        st.ctxMax = max;
        st.sawTokens = true;
        st.tokens = used;
        st.detailAt = Date.now();
        return;
      }
    }
    const m =
      /"(?:total_tokens|output_tokens|outputTokens|cumulative_tokens|tokens)"\s*:\s*(\d+)/.exec(line) ||
      /\b(\d[\d,]*)\s+tokens\b/i.exec(line);
    if (!m) return;
    const n = parseInt(String(m[1]).replace(/,/g, ''), 10);
    if (!Number.isFinite(n)) return;
    st.sawTokens = true;
    if (n > st.tokens && !st.sawCtx) st.tokens = n;
    st.detailAt = Date.now();
  }

  // Active session model name. INFO logs "Using default model: <m>"; debug logs
  // carry currentModel="<m>". We deliberately ignore per-sub-agent
  // "model: <m> (override)" lines so the display reflects the session's model,
  // not a transient Task-tool sub-agent. Last session-level mention wins.
  _parseModel(line, st) {
    const m =
      /Using default model:\s*([A-Za-z0-9.\-]+)/.exec(line) ||
      /currentModel="([A-Za-z0-9.\-]+)"/.exec(line);
    if (m) { st.model = m[1]; st.detailAt = Date.now(); }
  }

  // Reasoning effort. Only emitted at DEBUG ("defaultReasoningEffort=medium" or
  // "reasoning_effort": "medium"), so this stays null on a normal INFO session.
  _parseEffort(line, st) {
    if (line.indexOf('ffort') === -1) return;
    const m =
      /defaultReasoningEffort[=:]\s*"?([A-Za-z]+)"?/.exec(line) ||
      /"reasoning_effort"\s*:\s*"([A-Za-z]+)"/.exec(line);
    if (m) { st.effort = m[1].toLowerCase(); st.detailAt = Date.now(); }
  }

  // True if any tracked log grew within the window.
  busy(windowMs) {
    const now = Date.now();
    for (const st of this._states()) {
      if (st.lastGrowthMs !== 0 && now - st.lastGrowthMs <= windowMs) return true;
    }
    return false;
  }

  // Accurate "running" count across every tracked session: open AI-request
  // groups, plus a short grace window per file so brief tool-execution gaps
  // between requests don't flap idle. Falls back to the file-growth heuristic
  // only if no tracked log ever used AI-request groups (e.g. an older CLI or a
  // different log format).
  runningCount(graceMs) {
    const now = Date.now();
    let open = 0;
    let graced = 0;
    let sawAi = false;
    for (const st of this._states()) {
      if (st.sawAiGroup) sawAi = true;
      if (st.aiOpen > 0) open += st.aiOpen;
      else if (st.sawAiGroup && st.lastAiMs !== 0 && now - st.lastAiMs <= graceMs) graced++;
    }
    if (open + graced > 0) return open + graced;
    if (sawAi) return 0;
    return this.busy(graceMs) ? 1 : 0;
  }

  get lastGrowthMs() {
    let newest = 0;
    for (const st of this._states()) {
      if (st.lastGrowthMs > newest) newest = st.lastGrowthMs;
    }
    return newest;
  }

  // Real-time: is a model request open *right now* anywhere (no grace window)?
  // Unlike runningCount(), this is the un-smoothed signal — used to detect a
  // genuine turn boundary and to cancel a just-finished "celebrate" the instant
  // new work actually starts.
  get aiActive() {
    for (const st of this._states()) {
      if (st.aiOpen > 0) return true;
    }
    return false;
  }

  get aiRequestGeneration() {
    return this._aiRequestGeneration;
  }

  get aiRequestEdge() {
    return this._aiRequestEdge ? { ...this._aiRequestEdge } : null;
  }

  // Basename of the log supplying the detail fields, for diagnostics. Null
  // before anything is tracked.
  get focusLog() {
    return this._focus ? path.basename(this._focus) : null;
  }

  // Number of logs currently tracked (bounded by cfg.logs.maxFiles).
  get trackedLogCount() {
    return this._files.size;
  }

  // Detail fields come from the focused log when it has a value, otherwise from
  // whichever tracked log most recently produced one. Preferring the focus (not
  // simply "newest value anywhere") keeps a background session from renaming
  // the model under the session you're actually watching.
  _detailState(has) {
    const focus = this._focus && this._files.get(this._focus);
    if (focus && has(focus)) return focus;
    let best = null;
    for (const st of this._states()) {
      if (!has(st)) continue;
      if (!best || st.detailAt > best.detailAt) best = st;
    }
    return best;
  }

  _detail(has, get) {
    const state = this._detailState(has);
    return state ? get(state) : null;
  }

  // Best-effort token usage (context-window "used" when available, else a loose
  // parse). null if we never parsed any.
  get tokens() {
    const sample = this.tokenSample;
    return sample ? sample.value : null;
  }

  // Counter value plus the process-log identity that owns it. Token counters
  // from concurrent CLI processes are independent, so consumers must not treat
  // focus changes as one continuous raw counter.
  get tokenSample() {
    const state = this._detailState((st) => st.sawTokens);
    return state
      ? {
          source: `${path.basename(state.path)}#${state.generation}`,
          value: state.tokens,
        }
      : null;
  }

  // Context-window usage {used, max} (null until parsed).
  get contextTokens() {
    return this._detail((st) => st.sawCtx, (st) => ({ used: st.ctxUsed, max: st.ctxMax }));
  }

  get model() {
    return this._detail((st) => !!st.model, (st) => st.model);
  }

  get effort() {
    return this._detail((st) => !!st.effort, (st) => st.effort);
  }
}

function parseLogTimestamp(line) {
  const match = /^\s*(\d{4}-\d{2}-\d{2}[T ][0-9:.+-Z]+)/.exec(String(line));
  if (!match) return null;
  const parsed = Date.parse(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

module.exports = { CopilotLogTail };

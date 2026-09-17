'use strict';

const fs = require('fs');
const path = require('path');
const { StringDecoder } = require('string_decoder');
const log = require('../util/log');
const { promptText } = require('./sanitize');

// Bound on the per-poll edge queue. One entry per (session, kind), so this is
// far more sessions than the recent-activity window can realistically hold;
// past it the oldest observation is dropped and the newest-per-kind `edgeIds`
// slot remains as the floor.
const MAX_PENDING_EDGES = 64;

// Passive detection of Copilot's *built-in* permission prompts so the buddy
// lights up whenever a session is actually waiting for the user — not only when
// an agent explicitly calls companion_confirm.
//
// Source: the Copilot CLI writes one event per line to
//   ~/.copilot/session-state/<session-id>/events.jsonl
// including a paired lifecycle we can follow without any DEBUG logging:
//   {"type":"permission.requested","data":{"requestId","permissionRequest":{
//        "kind":"shell|write|read|...","intention","fullCommandText","path"}}}
//   {"type":"permission.completed","data":{"requestId","result":{"kind":...}}}
// A request is *pending* when a `requested` has no matching `completed`.
//
// A session blocked on a prompt has a FROZEN events.jsonl mtime (stuck at the
// request line), so we can't just follow the newest file — we track every
// recently-active file plus any file that still has an unresolved request.
//
// The same stream also carries the *live* prompt:
//   {"type":"user.message","data":{"content":"...","transformedContent":"..."},
//    "id":"<event id>","timestamp":"<ISO>"}
// This is the only place the question you just asked exists while the turn is
// still running — the session store's `turns` row is written at turn *end*, so
// a completed-turn-only transcript is permanently one question behind. We
// capture it here (see _notePrompt) and hand it to copilot/source.js as a
// provisional newest transcript entry until the real row catches up.
//
// This is read-only/best-effort: the device only *reflects* the pending prompt
// (the buttons can't answer Copilot's terminal prompt — that's resolved when
// `completed` appears). Any parse/IO error degrades to "nothing pending".
class PermissionWatch {
  constructor(cfg) {
    const p = (cfg && cfg.perm) || {};
    this._dir = cfg.sessionStateDir;
    this._recentWindowMs = p.recentWindowMs || 30 * 60 * 1000;
    // Ignore requests younger than this so fast auto-approvals (e.g. --yolo,
    // session-approved tools) don't flash on the device for one tick.
    this._minAgeMs = p.minAgeMs != null ? p.minAgeMs : 1500;
    // Bound on a captured prompt. The device renders ~150 characters; this is
    // headroom for de-duplication against the persisted row, not a display cap.
    this._maxPromptChars = p.maxPromptChars || 600;
    // On first sight of a file we replay its tail (see _follow) to recover
    // pending/waiting state. Those replayed user.messages are *history*, not
    // current work, so they are only treated as a live prompt when they are
    // this recent — which is the window in which "the bridge just restarted
    // mid-turn" is the honest reading.
    this._promptPrimeWindowMs =
      finiteNonNegative(p.promptPrimeWindowMs, 2 * 60 * 1000);
    this._promptMaxQuietMs =
      finiteNonNegative(p.promptMaxQuietMs, this._recentWindowMs);
    // A session counts as "active" for focus ranking if anything happened in it
    // this recently.
    this._focusActiveWindowMs =
      finiteNonNegative(p.focusActiveWindowMs, 60 * 1000);
    this._maxReadBytes = 256 * 1024; // cap each filesystem read
    const requestedPrimeBytes = Number(p.primeMaxBytes);
    this._maxPrimeBytes = Number.isFinite(requestedPrimeBytes) && requestedPrimeBytes > 0
      ? Math.max(this._maxReadBytes, Math.min(64 * 1024 * 1024, Math.trunc(requestedPrimeBytes)))
      : 32 * 1024 * 1024;
    const requestedPrimeFiles = Number(p.maxPrimeFilesPerUpdate);
    this._maxPrimeFilesPerUpdate =
      Number.isFinite(requestedPrimeFiles) && requestedPrimeFiles > 0
        ? Math.max(1, Math.min(8, Math.trunc(requestedPrimeFiles)))
        : 2;
    // path -> { offset, partial, edgeNamespace, sessionId,
    //           pending: {requestId, ts, tool, hint}|null,
    //           prompt: {id, at, text, live}|null,
    //           lastEventAt, lastUserAt, humanUserSeen, delegatedUserSeen }
    // A request is "pending" only while it's the LAST event in the file; any
    // later event (completed, abort, session.shutdown, the next tool call...)
    // means the session is no longer blocked on it.
    this._files = new Map();
    this._edgeIds = { prompt: null, user: null, tool: null };
    // Newly observed semantic edges since the last drain, keyed by
    // "<session>\0<kind>" so concurrent conversations cannot overwrite one
    // another between polls. The single `_edgeIds` slot per kind could only
    // ever report one file's edge, so when two sessions appended a prompt/user/
    // tool event in the same poll the loser never reached the bridge — and the
    // bridge could not disarm that conversation's echo guard. Iteration order
    // is observation order, so the last entry of a kind is exactly what the
    // back-compatible `edgeIds` slot reports.
    this._pendingEdges = new Map();
    // Newest top-level `session.task_complete` observed after startup priming.
    // Copilot's SQLite turn row can lag until the next prompt, so this is the
    // timely completion edge used by the bridge.
    this._completionEdge = null;
  }

  // Poll: (re)scan candidate event files and consume any appended bytes.
  update() {
    let files;
    try {
      files = this._candidates();
    } catch (err) {
      log.debug('permwatch scan failed:', err.message);
      return;
    }
    // Drop state for files that vanished (session cleaned up).
    const candidates = new Set(files);
    for (const known of this._files.keys()) {
      if (!candidates.has(known)) this._files.delete(known);
    }
    let primed = 0;
    for (const file of files) {
      if (!this._files.has(file)) {
        if (primed >= this._maxPrimeFilesPerUpdate) continue;
        primed++;
      }
      try {
        this._follow(file);
      } catch (err) {
        log.debug('permwatch follow failed:', err.message);
      }
    }
  }

  // The most relevant pending request (newest, older than the debounce), or
  // null. Shape: { id, tool, hint, ts }.
  pending(now = Date.now()) {
    let best = null;
    for (const st of this._files.values()) {
      const req = st.pending;
      if (!req) continue;
      if (now - req.ts < this._minAgeMs) continue;
      if (!best || req.ts > best.ts) {
        best = { id: 'perm-' + req.requestId, tool: req.tool, hint: req.hint, ts: req.ts };
      }
    }
    return best;
  }

  // True if a session has finished its response and is now waiting on the user
  // (its last assistant.message carried no tool calls and nothing has happened
  // since). Debounced so a momentary state doesn't flicker the alert.
  waitingForUser(now = Date.now()) {
    for (const st of this._files.values()) {
      if (st.waitingUser && now - st.waitingSince >= this._minAgeMs) return true;
    }
    return false;
  }

  // The newest task-completion edge from a human-owned session. Stable until a
  // later completion replaces it; source.js de-duplicates by id.
  completionEdge() {
    return this._completionEdge ? { ...this._completionEdge } : null;
  }

  // --- live current prompt -------------------------------------------------

  // The newest *live* user.message — the question currently being worked on —
  // optionally scoped to one session. Returns null when the only prompts we
  // have are replayed history (see _notePrompt), which is what keeps a restart
  // from presenting a five-hour-old question as current work.
  //
  // Shape: { sessionId, id, at, text }. `text` is already sanitized (injected
  // <system_reminder>/<current_datetime> wrappers removed, whitespace collapsed)
  // and bounded, so the caller can compare it directly against a persisted
  // turn row that went through the same sanitizers.
  currentPrompt(sessionId = null) {
    const now = Date.now();
    let best = null;
    for (const st of this._files.values()) {
      if (!this._promptIsLive(st, now)) continue;
      const p = st.prompt;
      if (sessionId && st.sessionId !== sessionId) continue;
      if (!best || p.at > best.at || (p.at === best.at && st.sessionId < best.sessionId)) {
        best = { sessionId: st.sessionId, id: p.id, at: p.at, text: p.text };
      }
    }
    return best;
  }

  // Retire a provisional prompt once the completed `turns` row has caught up
  // (copilot/source.js calls this after it matches the two). Returns whether
  // anything changed, so a repeat call for an already-retired prompt is a
  // no-op. A newer prompt for the same session is never dropped.
  resolvePrompt(sessionId, promptId) {
    for (const st of this._files.values()) {
      if (st.sessionId !== sessionId) continue;
      if (st.prompt && st.prompt.live && st.prompt.id === promptId) {
        st.prompt = { ...st.prompt, live: false };
        return true;
      }
    }
    return false;
  }

  // Per-session view of everything we track, for focus selection and
  // diagnostics. Read-only copies; callers cannot mutate watcher state.
  sessionActivity() {
    const out = [];
    for (const [file, st] of this._files) {
      out.push({
        sessionId: st.sessionId,
        file,
        lastEventAt: st.lastEventAt || 0,
        lastUserAt: st.lastUserAt || 0,
        pending: !!st.pending,
        waitingUser: !!st.waitingUser,
        prompt: this._promptIsLive(st, Date.now())
          ? { id: st.prompt.id, at: st.prompt.at, text: st.prompt.text }
          : null,
      });
    }
    return out;
  }

  // Ownership evidence for a Copilot session. SQLite's `turns` table does not
  // distinguish a top-level conversation from a spawned agent, so source.js
  // consults the event stream before treating a new turn row as a completion.
  sessionOwnership(sessionId) {
    if (!sessionId) return 'unknown';
    let delegated = false;
    let tracked = false;
    for (const st of this._files.values()) {
      if (st.sessionId !== sessionId) continue;
      tracked = true;
      if (st.humanUserSeen) return 'human';
      if (st.delegatedUserSeen) delegated = true;
    }
    if (delegated) return 'delegated';
    if (tracked) return 'unknown';
    try {
      return fs.existsSync(path.join(this._dir, sessionId, 'events.jsonl'))
        ? 'unknown'
        : 'unavailable';
    } catch {
      return 'unavailable';
    }
  }

  // Deterministic "which conversation is the device showing" decision.
  //
  // Both the live state (thinking/waiting) and the transcript text must come
  // from the same session, otherwise the pal animates one conversation while
  // the screen quotes another — exactly the reported bug. Ranking, highest
  // first:
  //
  //   3  blocked on a permission request  (it is literally asking you something)
  //   2  waiting on the user              (it has handed the turn back)
  //   1  a live prompt, or activity inside the focus window (work in flight)
  //   0  merely tracked
  //
  // Ties break on the newest semantic edge (user message or any event), then on
  // session id, so the same inputs always choose the same session. Returns null
  // when nothing is tracked, and the caller falls back to store-only behaviour.
  focus(now = Date.now()) {
    let best = null;
    for (const st of this._files.values()) {
      if (!st.sessionId) continue;
      const at = Math.max(st.lastUserAt || 0, st.lastEventAt || 0);
      const live = this._promptIsLive(st, now);
      let tier = 0;
      let reason = 'tracked';
      if (st.pending) { tier = 3; reason = 'requesting'; }
      else if (st.waitingUser) { tier = 2; reason = 'waiting'; }
      else if (live) { tier = 1; reason = 'prompt'; }
      else if (at && now - at <= this._focusActiveWindowMs) { tier = 1; reason = 'active'; }
      const candidate = { sessionId: st.sessionId, at, tier, reason };
      if (!best || beatsFocus(candidate, best)) best = candidate;
    }
    if (!best) return null;
    return { sessionId: best.sessionId, at: best.at, reason: best.reason };
  }

  // List <dir>/*/events.jsonl worth scanning: modified within the recent
  // window, or already tracked with an unresolved request (a blocked session
  // whose mtime has gone stale).
  _candidates() {
    const out = [];
    const now = Date.now();
    let entries = [];
    try {
      entries = fs.readdirSync(this._dir, { withFileTypes: true });
    } catch {
      return out; // no session-state dir (e.g. fresh install) => nothing
    }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const file = path.join(this._dir, ent.name, 'events.jsonl');
      let mtimeMs;
      try {
        mtimeMs = fs.statSync(file).mtimeMs;
      } catch {
        continue; // no events.jsonl in this session dir
      }
      const tracked = this._files.get(file);
      const active = tracked &&
        (tracked.pending || tracked.waitingUser ||
         this._promptIsLive(tracked, now));
      if (now - mtimeMs <= this._recentWindowMs || active) {
        out.push({ file, mtimeMs });
      }
    }
    out.sort((a, b) => b.mtimeMs - a.mtimeMs || a.file.localeCompare(b.file));
    return out.map((item) => item.file);
  }

  _follow(file) {
    let size;
    try {
      size = fs.statSync(file).size;
    } catch {
      return;
    }
    let st = this._files.get(file);
    // First sight: seed from the tail so an already-pending request (which,
    // for a blocked session, is the LAST event at EOF) is caught immediately.
    // That replay is history, so the pass is flagged `priming` — see
    // _notePrompt, which refuses to present an old question as current work.
    // Edge identities are deliberately NOT suppressed during priming: they
    // carry their original event timestamps and the bridge's completion
    // watermark is what filters replayed history (see bridge._observePassiveEdges).
    const priming = !st;
    if (!st) {
      st = { offset: Math.max(0, size - this._maxReadBytes), partial: '', pending: null,
             waitingUser: false, waitingSince: 0, edgeNamespace: file,
             sessionId: sessionIdFor(file), prompt: null, lastEventAt: 0, lastUserAt: 0,
             humanUserSeen: false, delegatedUserSeen: false,
             priming: false };
      this._files.set(file, st);
    }
    if (size < st.offset) {
      // Truncated/rotated in place; restart.
      st.offset = 0;
      st.partial = '';
    }
    if (size === st.offset) return;

    const start = Math.max(st.offset, size - this._maxReadBytes);
    const length = size - start;
    let read = 0;
    let buf;
    try {
      const fd = fs.openSync(file, 'r');
      buf = Buffer.allocUnsafe(length);
      read = fs.readSync(fd, buf, 0, length, start);
      fs.closeSync(fd);
    } catch (err) {
      log.debug('permwatch read failed:', err.message);
      return;
    }
    st.offset = size;
    st.priming = priming;
    try {
      this._consume(st, buf.subarray(0, read).toString('utf8'));
      if (priming && !st.prompt && start > 0) {
        this._recoverLatestHumanPrompt(file, st, size);
      }
    } finally {
      if (priming && st.prompt && !st.prompt.live) {
        // A long-running turn can easily outlive promptPrimeWindowMs while
        // tools continue to append events. Recent activity after that prompt
        // is stronger evidence that it is still in flight than prompt age
        // alone. Completed history is still retired immediately by source.js
        // when the matching turns row is present.
        const activeAfterPrompt =
          st.lastEventAt > st.prompt.at &&
          Date.now() - st.lastEventAt <= this._focusActiveWindowMs;
        if (activeAfterPrompt) st.prompt = { ...st.prompt, live: true };
      }
      st.priming = false;
    }
  }

  // Search a bounded window behind the ordinary 256 KiB tail for the newest
  // human user.message. Reads stay chunked so a large session never requires a
  // correspondingly large allocation. Only prompt/user-edge state is recovered
  // here; pending/waiting state remains authoritative from the newest tail.
  _recoverLatestHumanPrompt(file, st, size) {
    const start = Math.max(0, size - this._maxPrimeBytes);
    const end = size;
    if (start >= end) return;

    let offset = start;
    let partial = '';
    let latest = null;
    let delegatedSeen = false;
    const decoder = new StringDecoder('utf8');
    let fd;
    try {
      fd = fs.openSync(file, 'r');
      while (offset < end) {
        const length = Math.min(this._maxReadBytes, end - offset);
        const buf = Buffer.allocUnsafe(length);
        const read = fs.readSync(fd, buf, 0, length, offset);
        if (!read) break;
        offset += read;

        const lines = (partial + decoder.write(buf.subarray(0, read))).split(/\r?\n/);
        partial = lines.pop();
        for (const line of lines) {
          if (!line.includes('"type":"user.message"')) continue;
          if (isDelegatedUserMessage(line)) {
            delegatedSeen = true;
            continue;
          }
          const candidate = promptCandidate(line, this._maxPromptChars);
          if (candidate && (!latest || candidate.at >= latest.at)) latest = candidate;
        }
      }
      partial += decoder.end();
    } catch (err) {
      log.debug('permwatch prompt recovery failed:', err.message);
      return;
    } finally {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {
          // Best-effort read path; the next poll can retry.
        }
      }
    }

    // `partial` is deliberately ignored: JSONL only commits a record at its
    // newline, so a writer-torn trailing fragment must not hide an earlier
    // valid prompt.
    if (!latest) {
      if (delegatedSeen) st.delegatedUserSeen = true;
      return;
    }
    const live = Date.now() - latest.at <= this._promptPrimeWindowMs;
    st.prompt = { id: latest.id, at: latest.at, text: latest.text, live };
    st.humanUserSeen = true;
    st.lastUserAt = Math.max(st.lastUserAt || 0, latest.at);
    this._noteEdge('user', edgeIdentity(
      latest.edgeId,
      latest.timestamp,
      st.edgeNamespace,
      st.sessionId
    ), st);
  }

  _promptIsLive(st, now) {
    const prompt = st && st.prompt;
    if (!prompt || !prompt.live || !prompt.text) return false;
    const activityAt = Math.max(prompt.at || 0, st.lastEventAt || 0);
    if (activityAt && now - activityAt > this._promptMaxQuietMs) {
      st.prompt = { ...prompt, live: false };
      return false;
    }
    return true;
  }

  // Replay appended events, tracking two things per session:
  //  - pending: a permission.requested that is the most recent event (any later
  //    event clears it — avoids stale prompts from crashed/aborted sessions).
  //  - waitingUser: the agent finished its response and is waiting on the user.
  //    An assistant.message with no tool calls ("toolRequests":[]) ends the
  //    turn; any tool.execution_start / user.message means it's not waiting.
  _consume(st, text) {
    const data = st.partial + text;
    const lines = data.split(/\r?\n/);
    st.partial = lines.pop(); // incomplete trailing line
    for (const line of lines) {
      if (!line || line.indexOf('"type":"') === -1) continue;
      const at = lineTimestamp(line);
      if (at) st.lastEventAt = Math.max(st.lastEventAt || 0, at);
      if (line.indexOf('"type":"permission.requested"') !== -1) {
        let ev;
        try {
          ev = JSON.parse(line);
        } catch {
          continue; // unparseable: leave current state untouched
        }
        const d = ev && ev.data;
        if (d && d.requestId) {
          st.pending = this._describe(d, ev.requestId, ev.timestamp);
          this._noteEdge('prompt', edgeIdentity(
            String(d.requestId), ev.timestamp, st.edgeNamespace, st.sessionId
          ), st);
        }
        st.waitingUser = false; // a permission ask is its own kind of wait
        continue;
      }
      // Any other event supersedes a pending permission request (last-event model).
      st.pending = null;
      if (line.indexOf('"type":"assistant.message"') !== -1) {
        if (line.indexOf('"toolRequests":[]') !== -1) {
          if (!st.waitingUser) { st.waitingUser = true; st.waitingSince = Date.now(); }
        } else {
          st.waitingUser = false; // message carries tool calls => still working
        }
      } else if (line.indexOf('"type":"tool.execution_start"') !== -1) {
        const identity = eventIdentity(
          line,
          ['toolCallId', 'requestId'],
          st.edgeNamespace,
          st.sessionId
        );
        this._noteEdge('tool', identity, st);
        // ask_user / elicit block on the user's answer; any other tool is real
        // work the agent is doing (don't alert for those).
        if (line.indexOf('"toolName":"ask_user"') !== -1 ||
            line.indexOf('"toolName":"elicit"') !== -1) {
          if (!st.waitingUser) { st.waitingUser = true; st.waitingSince = Date.now(); }
        } else {
          st.waitingUser = false;
        }
      } else if (line.indexOf('"type":"user.message"') !== -1) {
        // Spawned/background agents receive their instructions through the same
        // event type. Their data.source is "agent-<id>"; those instructions are
        // internal work, not the human's current question, and must not replace
        // the transcript or clear a completion latch as a new user prompt.
        if (isDelegatedUserMessage(line)) {
          st.delegatedUserSeen = true;
          continue;
        }
        st.humanUserSeen = true;
        const identity = eventIdentity(
          line,
          ['promptId', 'messageId'],
          st.edgeNamespace,
          st.sessionId
        );
        this._noteEdge('user', identity, st);
        st.waitingUser = false;
        if (at) st.lastUserAt = Math.max(st.lastUserAt || 0, at);
        this._notePrompt(st, line, at);
      } else if (line.indexOf('"type":"session.task_complete"') !== -1) {
        // Completion ends this session's user-waiting phase. State is tracked
        // per events file, so this cannot clear another concurrent session.
        st.waitingUser = false;
        st.waitingSince = 0;
        const completion = taskCompletionCandidate(line, st.edgeNamespace);
        if (!completion) continue;
        // Startup replay establishes capability but never celebrates history.
        // Requiring a human message also excludes spawned-agent sessions,
        // whose initial user.message carries data.source="agent-*".
        if (!st.priming && st.humanUserSeen) {
          const candidate = { ...completion, sessionId: st.sessionId };
          if (
            !this._completionEdge ||
            candidate.at > this._completionEdge.at ||
            (candidate.at === this._completionEdge.at &&
              candidate.sessionId === this._completionEdge.sessionId) ||
            (candidate.at === this._completionEdge.at &&
              candidate.id > this._completionEdge.id)
          ) {
            this._completionEdge = candidate;
          }
        }
      } else if (line.indexOf('"type":"tool.execution_complete"') !== -1) {
        st.waitingUser = false;
      }
    }
  }

  // Capture the question the user just asked, so the transcript can show it
  // while the turn is still running instead of waiting for the `turns` row that
  // is only written when the turn ends.
  //
  // `data.content` is what the user actually typed; `transformedContent` is the
  // same text with the harness's <current_datetime>/<system_reminder> wrappers
  // prepended. We prefer content, but sanitize either way — the wrappers have
  // shown up in both fields across CLI versions, and the persisted turn row is
  // sanitized identically, which is what lets source.js de-duplicate the two
  // with a plain string comparison.
  //
  // A newer prompt always supersedes an older one (last write wins). During a
  // priming replay the prompt is only marked `live` if it is recent enough to
  // plausibly still be in flight — otherwise a bridge restart would parade a
  // long-finished question as current work.
  _notePrompt(st, line, at) {
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      return;
    }
    const d = (ev && ev.data) || {};
    const raw = pickPromptText(d);
    if (!raw) return;
    const text = promptText(raw, this._maxPromptChars);
    if (!text) return; // message was pure injected wrapper
    const stamp = at || Date.now();
    const id = String(
      (ev && ev.id) || d.promptId || d.messageId || d.interactionId || stamp
    );
    const live = st.priming ? Date.now() - stamp <= this._promptPrimeWindowMs : true;
    if (st.prompt && st.prompt.at > stamp) return; // never go backwards in time
    st.prompt = { id, at: stamp, text, live };
  }

  // Record one semantic edge. The newest-per-kind slot is kept for the
  // level-triggered `edgeIds` contract; the queue additionally keeps the newest
  // edge of that kind *per session*, so two conversations appending in the same
  // poll both reach the bridge instead of the second overwriting the first.
  _noteEdge(kind, identity, st) {
    if (!identity) return;
    this._edgeIds[kind] = identity;
    const scope = (st && (st.sessionId || st.edgeNamespace)) || '';
    const key = `${scope}\u0000${kind}`;
    // Delete before set so iteration order tracks observation order.
    this._pendingEdges.delete(key);
    this._pendingEdges.set(key, { kind, ...identity });
    while (this._pendingEdges.size > MAX_PENDING_EDGES) {
      this._pendingEdges.delete(this._pendingEdges.keys().next().value);
    }
  }

  // Drain every semantic edge observed since the last call, oldest observation
  // first. Edge-triggered: an edge is reported exactly once, so the caller can
  // forward the whole batch without de-duplicating it against previous polls.
  // Shape per entry: { kind, id, at, session }.
  takeEdges() {
    if (!this._pendingEdges.size) return [];
    const out = [...this._pendingEdges.values()];
    this._pendingEdges.clear();
    return out;
  }

  // Newest edge of each kind, whichever session produced it. Level-triggered
  // and retained across polls; `takeEdges()` is the per-session view.
  get edgeIds() {
    return { ...this._edgeIds };
  }

  // Build the device-facing { requestId, ts, tool, hint } from a request event.
  _describe(data, requestId, timestamp) {
    const pr = data.permissionRequest || {};
    const kind = pr.kind || 'permission';
    const tool = TOOL_LABELS[kind] || kind;
    let hint = pr.fullCommandText || pr.path || pr.url || pr.intention || '';
    hint = String(hint).replace(/\s+/g, ' ').trim();
    let ts = Date.parse(timestamp);
    if (!Number.isFinite(ts)) ts = Date.now();
    return { requestId: data.requestId || requestId, ts, tool, hint };
  }
}

function edgeIdentity(id, timestamp, namespace, sessionId = null) {
  const parsed = Date.parse(timestamp);
  const scopedId = namespace == null
    ? String(id)
    : JSON.stringify([String(namespace), String(id)]);
  return {
    id: scopedId,
    at: Number.isFinite(parsed) ? parsed : Date.now(),
    session: sessionId ? String(sessionId) : null,
  };
}

// Session id == the directory the events file lives in, which is exactly the
// `turns.session_id` / `sessions.id` value in the session store. That shared
// identity is what makes state and transcript correlatable at all: there is no
// session id anywhere in the process-*.log files (verified), so the event
// stream is the only place the link exists.
function sessionIdFor(file) {
  const dir = path.basename(path.dirname(String(file || '')));
  return dir && dir !== '.' && dir !== path.sep ? dir : null;
}

// Cheap event timestamp extraction. Every CLI event carries a top-level
// "timestamp":"<ISO>"; pulling it with one regex avoids JSON.parse on lines
// (assistant messages, tool output) we otherwise never decode.
function lineTimestamp(line) {
  const m = /"timestamp":"([^"]{1,40})"/.exec(line);
  if (!m) return 0;
  const parsed = Date.parse(m[1]);
  return Number.isFinite(parsed) ? parsed : 0;
}

// The user's actual text, in the order of preference across CLI versions.
function pickPromptText(d) {
  for (const key of ['content', 'text', 'message', 'prompt', 'transformedContent']) {
    const v = d[key];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return '';
}

function isDelegatedUserMessage(line) {
  try {
    const event = JSON.parse(line);
    const source = event && event.data && event.data.source;
    return typeof source === 'string' && source.startsWith('agent-');
  } catch {
    return false;
  }
}

function taskCompletionCandidate(line, namespace) {
  try {
    const event = JSON.parse(line);
    if (!event || event.type !== 'session.task_complete') return null;
    const identity = edgeIdentity(
      event.id || (event.data && event.data.taskId) || event.timestamp || Date.now(),
      event.timestamp,
      namespace
    );
    return {
      id: identity.id,
      at: identity.at,
      outcome: event.data && event.data.success === false ? 'failed' : 'success',
    };
  } catch {
    return null;
  }
}

function promptCandidate(line, maxChars) {
  try {
    const event = JSON.parse(line);
    const data = (event && event.data) || {};
    const source = data.source;
    if (typeof source === 'string' && source.startsWith('agent-')) return null;
    const text = promptText(pickPromptText(data), maxChars);
    if (!text) return null;
    const at = lineTimestamp(line) || Date.now();
    const id = String(
      (event && event.id) ||
      data.promptId ||
      data.messageId ||
      data.interactionId ||
      at
    );
    return {
      id,
      edgeId: data.promptId || data.messageId || id,
      at,
      text,
      timestamp: event.timestamp,
    };
  } catch {
    return null;
  }
}

function finiteNonNegative(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

// Total, deterministic ordering for focus candidates: tier, then newest
// semantic edge, then session id.
function beatsFocus(candidate, current) {
  if (candidate.tier !== current.tier) return candidate.tier > current.tier;
  if (candidate.at !== current.at) return candidate.at > current.at;
  return String(candidate.sessionId) < String(current.sessionId);
}

function eventIdentity(line, dataKeys, namespace, sessionId = null) {
  try {
    const event = JSON.parse(line);
    for (const key of dataKeys) {
      if (event.data && event.data[key] != null) {
        return edgeIdentity(event.data[key], event.timestamp, namespace, sessionId);
      }
    }
    if (event.id != null) return edgeIdentity(event.id, event.timestamp, namespace, sessionId);
  } catch {
    return null;
  }
  return null;
}

// Short, device-friendly labels (firmware prompt "tool" field is 19 chars).
const TOOL_LABELS = {
  shell: 'run command',
  write: 'edit file',
  read: 'read file',
  fetch: 'fetch url',
  network: 'network',
};

module.exports = { PermissionWatch };

'use strict';

const { ENDED } = require('./registry');

// Deterministic composition of the device-facing activity model from the two
// evidence sources:
//
//   explicit  — the bridge-owned session registry (top-level orchestrators
//               reporting one lifecycle per user conversation over MCP/HTTP).
//               Timely and precise, but only covers sessions that opted in,
//               and only while their TTL is valid.
//   passive   — the Copilot session store / log tail / permission watch model.
//               Always available, laggier, count-only (no per-session identity).
//
// Both are kept: explicit state *overrides presentation* (the `msg` line) while
// it is live, and passive evidence remains the floor for the counts and the
// fallback whenever no explicit session is reporting.
//
// ---------------------------------------------------------------------------
// Counts
// ---------------------------------------------------------------------------
// The passive side reports bare counts with no session identity, so explicit
// and passive records cannot be correlated 1:1. Summing them would double-count
// the common case (a conversation reported explicitly *and* observed in the
// log), so each count is the union-by-maximum of the two sources:
//
//   total   = max(passive.total,   live explicit sessions)
//   running = max(passive.running, explicit thinking|working)
//   waiting = max(passive.waiting, explicit waiting|blocked)
//
// Maximum (rather than sum) means neither source can double-count, and neither
// source can suppress the other's evidence. `total` is then floored at
// max(running, waiting): it is a session count, so it can never be smaller than
// the sessions we just reported as running or waiting.
//
// ---------------------------------------------------------------------------
// msg priority (highest first)
// ---------------------------------------------------------------------------
//   1. confirmation   — an MCP/device confirm prompt is on screen
//   2. notice         — a transient companion_notify flash (still on its TTL)
//   3. explicit blocked / waiting
//   4. explicit working / thinking
//   5. passive msg    — whatever the log/store heuristics derived
//
// Within a tier, the candidate with the most recent `updated_at` wins, then the
// lowest session id. Selection is a pure function of the inputs, so the same
// registry + passive model always produces the same line (no flapping).

const MSG_CONFIRM = 'confirm on device';

const STATE_PRIORITY = Object.freeze({
  blocked: 4,
  waiting: 3,
  working: 2,
  thinking: 1,
  idle: 0,
});

const DEFAULT_MSG = {
  blocked: 'blocked',
  waiting: 'your turn',
  working: 'working...',
  thinking: 'thinking...',
};

const EMPTY_PASSIVE = Object.freeze({
  total: 0,
  running: 0,
  waiting: 0,
  completed: false,
  msg: 'idle',
  entries: [],
});

// Reduce the registry listing to counts plus the best msg candidate.
function projectSessions(sessions = []) {
  let live = 0;
  let running = 0;
  let waiting = 0;
  let best = null;

  for (const s of sessions) {
    if (!s || s.state === ENDED) continue;
    live++;
    const prio = STATE_PRIORITY[s.state] || 0;
    if (s.state === 'thinking' || s.state === 'working') running++;
    if (s.state === 'waiting' || s.state === 'blocked') waiting++;
    if (!prio) continue; // idle contributes to `total` only
    if (!best || beats(s, prio, best)) best = { ...s, _prio: prio };
  }

  return {
    live,
    running,
    waiting,
    msg: best ? best.message || DEFAULT_MSG[best.state] : null,
    leader: best ? { session_id: best.session_id, state: best.state } : null,
  };
}

// Select the bounded, display-facing roster without changing aggregate
// composition. Ranking is deliberately separate from the wire state codes in
// protocol/snapshot.js: attention-worthy states sort first here, while the
// firmware enum encodes idle at zero and blocked at four. Reusing one table for
// both would make the compact values look convenient but silently reverse the
// carousel order.
//
// Timestamps arrive as ISO strings from registry.list(). Invalid timestamps
// are treated as the oldest possible value; the creation and id tie-breaks
// still make the result total and deterministic instead of relying on the
// engine's input-order stability.
function rankSessions(sessions = [], limit = 8) {
  const max = Math.max(0, Math.trunc(Number(limit) || 0));
  return sessions
    .filter((session) => session && session.state !== ENDED)
    .slice()
    .sort((a, b) => {
      const state = (STATE_PRIORITY[b.state] || 0) - (STATE_PRIORITY[a.state] || 0);
      if (state !== 0) return state;

      const aUpdated = Date.parse(a.updated_at) || 0;
      const bUpdated = Date.parse(b.updated_at) || 0;
      if (aUpdated !== bUpdated) return bUpdated - aUpdated;

      const aCreated = Date.parse(a.created_at) || 0;
      const bCreated = Date.parse(b.created_at) || 0;
      if (aCreated !== bCreated) return aCreated - bCreated;

      const aId = String(a.session_id);
      const bId = String(b.session_id);
      return aId < bId ? -1 : aId > bId ? 1 : 0;
    })
    .slice(0, max);
}

function beats(candidate, prio, current) {
  if (prio !== current._prio) return prio > current._prio;
  const a = Date.parse(candidate.updated_at) || 0;
  const b = Date.parse(current.updated_at) || 0;
  if (a !== b) return a > b;
  return candidate.session_id < current.session_id;
}

// Build the model handed to protocol/snapshot.buildSnapshot().
//
//   passive         — latest model from CopilotSource, or null before first tick
//   sessions        — registry.list() output (already pruned of expired records)
//   projectionLimit — maximum rich rows retained for snapshot shaping
//   notice          — { text, until } transient notify flash, or null
//   confirm         — { id, tool, hint } active device confirmation, or null
function composeModel({
  passive,
  sessions = [],
  projectionLimit = 8,
  notice = null,
  confirm = null,
  now = Date.now(),
} = {}) {
  const base = passive || EMPTY_PASSIVE;
  const explicit = projectSessions(sessions);

  const model = {
    total: Math.max(int(base.total), explicit.live),
    running: Math.max(int(base.running), explicit.running),
    waiting: Math.max(int(base.waiting), explicit.waiting),
    completed: !!base.completed,
    msg: base.msg || 'idle',
    entries: base.entries || [],
    sessionRows: rankSessions(sessions, projectionLimit),
  };

  // Carry through the optional telemetry fields untouched — they are passive
  // facts (token counters, model/effort) that explicit state has no opinion on.
  for (const key of ['tokens', 'tokensToday', 'tokensUsed', 'tokensMax', 'model', 'effort']) {
    if (base[key] != null) model[key] = base[key];
  }

  // msg, in documented priority order.
  if (confirm) model.msg = MSG_CONFIRM;
  else if (notice && notice.text && now < notice.until) model.msg = notice.text;
  else if (explicit.msg) model.msg = explicit.msg;

  // prompt: an active confirmation outranks a passively-detected Copilot
  // permission prompt (the confirm can actually be answered with the buttons).
  if (confirm) model.prompt = confirm;
  else if (base.prompt && base.prompt.id) model.prompt = base.prompt;

  // A live confirmation always means someone is waiting on a human.
  if (confirm && model.waiting < 1) model.waiting = 1;

  // `total` is the session count, so it can never be smaller than the number of
  // sessions we just claimed are running or waiting. Before the first passive
  // tick a confirmation would otherwise project `total:0, waiting:1` — a state
  // the device can't render coherently. Raise the floor (max, never a sum, so
  // the union-by-maximum rule above still holds and existing counts are
  // untouched whenever `total` is already the largest of the three).
  model.total = Math.max(model.total, model.running, model.waiting);

  return model;
}

function int(n) {
  n = Math.trunc(Number(n) || 0);
  return n > 0 ? n : 0;
}

module.exports = {
  composeModel,
  projectSessions,
  rankSessions,
  STATE_PRIORITY,
  MSG_CONFIRM,
  EMPTY_PASSIVE,
};

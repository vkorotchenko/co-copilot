'use strict';

const crypto = require('crypto');
const { DEFAULT_THEME, isTheme, paletteFor, validatePalette } = require('./palettes');
const { isSpecies, defaultSpeciesFor } = require('./species');
const { SUMMARY_MAX, normalizeSummary, validateSummary } = require('./summary');

// In-memory, bridge-owned registry of explicitly reported top-level Copilot
// conversation sessions.
//
// Passive observation (session store + log tail + permission watch) tells us
// what Copilot is doing after the fact; it is accurate but laggy and blind to
// anything that doesn't touch those files. The session orchestrator can instead
// announce the conversation's lifecycle over MCP/HTTP:
//
//   begin(label)  -> session_id        (bridge mints the id; opaque to callers)
//   update(id, state, message?)        (thinking | working | waiting | blocked | idle)
//   completeTask(id, outcome?)          (returns the live conversation to idle)
//   end(id, outcome?, message?)        (success | failed | aborted)
//
// `message` means different things on update() and end(). On update() it is
// *ambient* state text ("compiling") that describes what the session is doing
// right now. On end() it is a *closing* message ("build broke") that the bridge
// is allowed to flash. The two are kept in separate fields — `message` and
// `closing_message` — because conflating them re-flashes stale activity after a
// silent end and can mask another session that is genuinely blocked.
//
// Active work carries an expiry. A caller that crashes, hangs, or simply stops
// reporting falls back to idle once the TTL lapses, so the device is not pinned
// to stale work. Idle conversations remain registered: a session is long-lived
// and can handle many tasks until it is explicitly ended, evicted for capacity,
// or the in-memory bridge restarts.
//
// One record is intended per user conversation, not per spawned agent. Child
// agents report back to the orchestrator; they do not call begin, update,
// completeTask, or end. Concurrent child requests can still contribute to
// passive aggregate activity, but the registry projects a single pal for their
// parent conversation.
//
// The registry is deliberately in-memory only: after a bridge restart the
// passive observers reconstruct state within a tick or two, and resurrecting
// stale session rows from disk would be worse than starting clean.

const STATES = Object.freeze(['thinking', 'working', 'waiting', 'blocked', 'idle']);
const OUTCOMES = Object.freeze(['success', 'failed', 'aborted']);
const ACTIVE_STATES = new Set(['thinking', 'working', 'waiting', 'blocked']);

// Terminal marker used internally once end() is called. Not a caller-settable
// state: ended records linger briefly (so `companion_status` can report the
// outcome) but never contribute to running/waiting counts.
const ENDED = 'ended';

const LABEL_MAX = 64;
const MESSAGE_MAX = 120;
const CWD_MAX = 256;
const CONVERSATION_ID_MAX = 128;

class SessionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SessionError';
    this.code = code;
  }
}

function unknownSession(id) {
  return new SessionError(
    'unknown_session',
    `Unknown or expired session_id: ${id}. Call companion_session_begin to start a new one.`
  );
}

function invalid(message) {
  return new SessionError('invalid_argument', message);
}

function isTaskActiveState(state) {
  return ACTIVE_STATES.has(state);
}

function normalizeOutcome(outcome) {
  let cleanOutcome = 'success';
  if (outcome !== undefined && outcome !== null && outcome !== '') {
    cleanOutcome = String(outcome).toLowerCase().trim();
    if (!OUTCOMES.includes(cleanOutcome)) {
      throw invalid(`outcome must be one of: ${OUTCOMES.join(', ')}.`);
    }
  }
  return cleanOutcome;
}

function clampText(value, max) {
  if (value == null) return '';
  const s = String(value).replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max) : s;
}

function requireSessionId(value) {
  const id = String(value == null ? '' : value);
  if (!id.trim()) throw invalid('session_id is required and must be a non-empty string.');
  return id;
}

function normalizeConversationId(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw invalid('conversation_id must be a string when provided.');
  }
  const id = value.trim();
  if (!id) throw invalid('conversation_id must be a non-empty string when provided.');
  if (id.length > CONVERSATION_ID_MAX) {
    throw invalid(`conversation_id must contain at most ${CONVERSATION_ID_MAX} characters.`);
  }
  return id;
}

function speciesOccupancy(records, exclude = null) {
  const automaticTaken = [];
  const explicitTaken = [];
  for (const record of records) {
    if (record === exclude || record.state === ENDED) continue;
    if (record.palAssignment === 'explicit') explicitTaken.push(record.palId);
    else automaticTaken.push(record.palId);
  }
  return { automaticTaken, explicitTaken };
}

class SessionRegistry {
  // opts mirrors cfg.sessions; `now` is injectable so tests can drive time
  // without sleeping.
  constructor(opts = {}) {
    this._defaultTtlMs = opts.defaultTtlMs || 90 * 1000;
    this._minTtlMs = opts.minTtlMs || 5 * 1000;
    this._maxTtlMs = opts.maxTtlMs || 60 * 60 * 1000;
    this._maxSessions = opts.maxSessions || 64;
    this._endedLingerMs = opts.endedLingerMs || 10 * 1000;
    this._now = opts.now || (() => Date.now());
    this._sessions = new Map(); // id -> record
    this._conversationIds = new Map(); // stable conversation_id -> live record id
  }

  get defaultTtlMs() {
    return this._defaultTtlMs;
  }

  // Normalize a caller-supplied TTL (seconds) into a bounded millisecond value.
  // Out-of-range values are clamped rather than rejected: a caller asking for a
  // day-long TTL gets the maximum, not an error in the middle of its work.
  ttlMsFor(ttlSeconds) {
    if (ttlSeconds == null || ttlSeconds === '') return this._defaultTtlMs;
    const n = Number(ttlSeconds);
    if (!Number.isFinite(n)) throw invalid('ttl_seconds must be a number.');
    const ms = Math.trunc(n * 1000);
    if (ms < this._minTtlMs) return this._minTtlMs;
    if (ms > this._maxTtlMs) return this._maxTtlMs;
    return ms;
  }

  // --- lifecycle -----------------------------------------------------------

  begin({ label, cwd, source, ttlSeconds, conversationId } = {}) {
    const now = this._now();
    this.prune(now);

    const cleanLabel = clampText(label, LABEL_MAX);
    if (!cleanLabel) throw invalid('label is required and must be a non-empty string.');

    const ttlMs = this.ttlMsFor(ttlSeconds);
    const cleanCwd = clampText(cwd, CWD_MAX) || null;
    const cleanConversationId = normalizeConversationId(conversationId);

    // A stable conversation identity makes begin idempotent. This is the
    // runtime enforcement for "one pal per top-level Copilot conversation":
    // retries refresh the lease but do not mint a second record, reset state,
    // or replace presentation configured earlier in the same conversation.
    if (cleanConversationId) {
      const existingId = this._conversationIds.get(cleanConversationId);
      const existing = existingId ? this._sessions.get(existingId) : null;
      if (existing && existing.state !== ENDED) {
        existing.ttlMs = ttlMs;
        existing.updatedAt = now;
        existing.expiresAt = isTaskActiveState(existing.state) ? now + ttlMs : null;
        return snapshotOf(existing, now);
      }
      this._conversationIds.delete(cleanConversationId);
    }

    if (this._sessions.size >= this._maxSessions) this._evictForCapacity();

    const occupancy = speciesOccupancy(this._sessions.values());
    const record = {
      id: 'cs-' + crypto.randomBytes(8).toString('hex'),
      conversationId: cleanConversationId,
      label: cleanLabel,
      cwd: cleanCwd,
      source: clampText(source, LABEL_MAX) || null,
      palId: defaultSpeciesFor({ label: cleanLabel, cwd: cleanCwd, ...occupancy }),
      palAssignment: 'automatic',
      themeId: DEFAULT_THEME,
      palette: paletteFor(DEFAULT_THEME),
      summary: normalizeSummary(cleanLabel),
      assignment: 'derived',
      configuredAt: null,
      state: 'working',
      message: '',
      // Set only by end(), and only from a message supplied on that call.
      closingMessage: null,
      outcome: null,
      taskStartedAt: now,
      taskCompletedAt: null,
      taskOutcome: null,
      idleSince: null,
      usage: null,
      createdAt: now,
      updatedAt: now,
      endedAt: null,
      ttlMs,
      expiresAt: now + ttlMs,
    };
    this._sessions.set(record.id, record);
    if (cleanConversationId) this._conversationIds.set(cleanConversationId, record.id);
    return snapshotOf(record, now);
  }

  update({ id, state, message, ttlSeconds } = {}) {
    const now = this._now();
    this.prune(now);

    const record = this._sessions.get(requireSessionId(id));
    if (!record || record.state === ENDED) throw unknownSession(id);

    const cleanState = String(state || '').toLowerCase().trim();
    if (!STATES.includes(cleanState)) {
      throw invalid(`state must be one of: ${STATES.join(', ')}.`);
    }

    const wasActive = isTaskActiveState(record.state);
    const willBeActive = isTaskActiveState(cleanState);
    record.state = cleanState;
    if (!wasActive && willBeActive) {
      record.taskStartedAt = now;
      record.taskCompletedAt = null;
      record.taskOutcome = null;
      record.idleSince = null;
      // Ambient text belongs to one task cycle. A new cycle that reports no
      // message of its own must not inherit the previous task's "compiling":
      // the caller supplying `message` below is the only thing that sets it.
      record.message = '';
    } else if (wasActive && !willBeActive) {
      // A direct active -> idle report abandons the current task without
      // completing it. A repeated idle report must preserve the prior
      // completion marker so companion_task_complete retries stay idempotent.
      record.taskStartedAt = null;
      record.taskCompletedAt = null;
      record.taskOutcome = null;
      record.idleSince = now;
      // Abandonment leaves nothing in flight, so the task-local message is no
      // longer true of anything. Leaving it behind kept a finished task's text
      // on an idle conversation and leaked it into the next task cycle.
      record.message = '';
    }
    if (message !== undefined) record.message = clampText(message, MESSAGE_MAX);
    if (ttlSeconds !== undefined && ttlSeconds !== null) record.ttlMs = this.ttlMsFor(ttlSeconds);
    record.updatedAt = now;
    record.expiresAt = willBeActive ? now + record.ttlMs : null;
    return snapshotOf(record, now);
  }

  completeTask({ id, outcome } = {}) {
    const now = this._now();
    this.prune(now);

    const record = this._sessions.get(requireSessionId(id));
    if (!record || record.state === ENDED) throw unknownSession(id);
    const cleanOutcome = normalizeOutcome(outcome);
    if (!isTaskActiveState(record.state)) {
      // A retry after a successful completion is idempotent. A plain idle
      // transition, however, did not complete a task and must not fabricate one.
      if (record.taskCompletedAt !== null) return snapshotOf(record, now);
      throw invalid('Session has no active task to complete.');
    }

    record.state = 'idle';
    record.message = '';
    record.taskOutcome = cleanOutcome;
    record.taskCompletedAt = now;
    record.idleSince = now;
    record.updatedAt = now;
    record.expiresAt = null;
    return snapshotOf(record, now);
  }

  configure({ id, palId, themeId, colors, summary } = {}) {
    const now = this._now();
    this.prune(now);

    const record = this._sessions.get(requireSessionId(id));
    if (!record || record.state === ENDED) throw unknownSession(id);

    const hasPal = palId !== undefined;
    const hasTheme = themeId !== undefined;
    const hasColors = colors !== undefined;
    const hasSummary = summary !== undefined;
    if (!hasPal && !hasTheme && !hasColors && !hasSummary) {
      throw invalid('At least one of pal, theme, colors, or summary must be provided.');
    }

    // Resolve into local values first. Configuration is one logical mutation:
    // a bad field later in the request must not leave an earlier pal or theme
    // applied even though the caller received an error.
    let nextPal = record.palId;
    let nextPalAssignment = record.palAssignment;
    let nextTheme = record.themeId;
    let nextPalette = { ...record.palette };
    let nextSummary = record.summary;

    if (hasPal) {
      if (palId === null) {
        const occupancy = speciesOccupancy(this._sessions.values(), record);
        nextPal = defaultSpeciesFor({ label: record.label, cwd: record.cwd, ...occupancy });
        nextPalAssignment = 'automatic';
      } else if (!isSpecies(palId)) {
        throw invalid(`pal must be a catalog species; received ${JSON.stringify(palId)}.`);
      } else {
        // Explicit choices are authoritative. A duplicate may be deliberate
        // (for example, a team using the same animal with different colors),
        // so configuration never silently probes to a different species.
        nextPal = palId;
        nextPalAssignment = 'explicit';
      }
    }

    // Theme is applied before colors on purpose: a caller can select a preset
    // and override one complete palette in the same atomic call, with the
    // explicit colors winning rather than being unexpectedly discarded.
    if (hasTheme) {
      nextTheme = themeId === null ? DEFAULT_THEME : themeId;
      if (!isTheme(nextTheme)) {
        throw invalid(`theme must be a known preset; received ${JSON.stringify(themeId)}.`);
      }
      nextPalette = paletteFor(nextTheme);
    }

    if (hasColors) {
      if (colors === null) {
        nextPalette = paletteFor(nextTheme);
      } else {
        const result = validatePalette(colors);
        if (!result.ok) throw invalid(result.reason);
        nextPalette = { ...colors };
      }
    }

    if (hasSummary) {
      if (summary !== null && typeof summary !== 'string') {
        throw invalid('summary must be a string or null.');
      }
      if (summary === null) nextSummary = normalizeSummary(record.label);
      else {
        const result = validateSummary(summary);
        if (!result.ok) throw invalid(result.reason);
        nextSummary = result.value;
      }
    }

    record.palId = nextPal;
    record.palAssignment = nextPalAssignment;
    record.themeId = nextTheme;
    record.palette = nextPalette;
    record.summary = nextSummary;
    record.assignment = 'user';
    record.configuredAt = now;
    record.updatedAt = now;
    // Cosmetic writes must not extend an active task lease. Only a lifecycle
    // update proves active work is still running, so expiresAt is left exactly
    // as it was; otherwise repeated palette/summary writes could pin stale work
    // on the device indefinitely.
    return snapshotOf(record, now);
  }

  // Attach authoritative Copilot usage to the pal owning this conversation.
  // Usage updates are telemetry, not lifecycle activity: they must not renew a
  // task lease, re-rank the carousel, or change updated_at.
  setUsageByConversationId(conversationId, usage) {
    const now = this._now();
    const normalized = normalizeConversationId(conversationId);
    if (!normalized) return null;
    this.prune(now);
    const id = this._conversationIds.get(normalized);
    const record = id ? this._sessions.get(id) : null;
    if (!record || record.state === ENDED) return null;
    record.usage = normalizeUsage(usage);
    return snapshotOf(record, now);
  }

  // Start a task from a passive Copilot user.message only when it belongs to
  // this exact conversation and postdates the moment the pal became idle.
  activateForUserEdge(conversationId, observedAt) {
    const at = Number(observedAt);
    if (!Number.isFinite(at) || at <= 0) return null;
    const normalized = normalizeConversationId(conversationId);
    if (!normalized) return null;

    const now = this._now();
    this.prune(now);
    const id = this._conversationIds.get(normalized);
    const record = id ? this._sessions.get(id) : null;
    if (!record || record.state !== 'idle') return null;
    if (record.idleSince === null || at <= record.idleSince) return null;
    return this.update({ id: record.id, state: 'thinking' });
  }

  end({ id, outcome, message } = {}) {
    const now = this._now();
    this.prune(now);

    const record = this._sessions.get(requireSessionId(id));
    if (!record || record.state === ENDED) throw unknownSession(id);

    const cleanOutcome = normalizeOutcome(outcome);

    record.state = ENDED;
    record.outcome = cleanOutcome;
    record.taskStartedAt = null;
    record.taskCompletedAt = null;
    record.taskOutcome = null;
    // Closing-message semantics are explicit: a closing message exists only if
    // one was supplied *on this call*. The record's in-flight state text is not
    // a closing message, and must not be promoted into one — doing so re-flashes
    // stale activity ("compiling") for the duration of the notify TTL, which can
    // mask another session that is actually blocked or waiting on the human.
    // A blank/whitespace-only message counts as "none supplied".
    const closing =
      message === undefined || message === null ? null : clampText(message, MESSAGE_MAX) || null;
    record.closingMessage = closing;
    // Drop the in-flight state text so no reader can mistake it for a result.
    record.message = closing || '';
    record.updatedAt = now;
    record.endedAt = now;
    // Linger briefly so status readers can observe the outcome, then vanish.
    record.expiresAt = now + Math.min(this._endedLingerMs, record.ttlMs);
    this._releaseConversation(record);
    return snapshotOf(record, now);
  }

  // --- capacity ------------------------------------------------------------

  // Make room for one more record when the cap is reached.
  //
  // The obvious policy — shed whatever is closest to expiry — is exactly wrong
  // under pressure, because expiry distance is *caller-controlled*. A caller
  // that opens sessions with the maximum ttl_seconds (1h) and then goes silent
  // is always the furthest from expiry, so it survives every eviction while
  // legitimate reporters on the 90s default are shed first. That inverts the
  // intent: the abandoned records win and the live ones lose.
  //
  // Least-recently-*updated* removes the lever. A lease says nothing about
  // whether anyone is still behind it; only a fresh companion_state does. A
  // squatter's records stop being updated the moment it stops reporting, so
  // they sort to the front of the eviction order no matter how long a lease
  // they asked for, while an actively reporting session keeps refreshing its
  // way to the back.
  //
  // Ended records go first regardless: they are terminal and only linger so a
  // status reader can observe the outcome, which is never worth a live session.
  //
  // Ties break on createdAt and then id, so the choice is fully deterministic
  // (and therefore testable) even when several records share a timestamp.
  _evictForCapacity() {
    // A loop, not a single delete: `maxSessions` can be configured lower than
    // the number of records already held, and one pass would leave it over cap.
    while (this._sessions.size >= this._maxSessions) {
      let victim = null;
      for (const record of this._sessions.values()) {
        if (victim === null || evictionOrder(record, victim) < 0) victim = record;
      }
      if (!victim) break;
      this._deleteRecord(victim);
    }
  }

  // --- reads ---------------------------------------------------------------
  get(id, now = this._now()) {
    this.prune(now);
    const record = this._sessions.get(String(id || ''));
    return record ? snapshotOf(record, now) : null;
  }

  getByConversationId(conversationId, now = this._now()) {
    const normalized = normalizeConversationId(conversationId);
    if (!normalized) return null;
    this.prune(now);
    const id = this._conversationIds.get(normalized);
    const record = id ? this._sessions.get(id) : null;
    return record && record.state !== ENDED ? snapshotOf(record, now) : null;
  }

  // All live records, deterministically ordered (oldest first) so repeated
  // reads and the msg tie-breaks in compose.js are stable.
  list(now = this._now()) {
    this.prune(now);
    return [...this._sessions.values()]
      .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))
      .map((r) => snapshotOf(r, now));
  }

  get size() {
    return this._sessions.size;
  }

  // Drop every record whose lease has lapsed. Called on every mutation and on
  // every read, so expiry needs no timer of its own. Active-task expiry returns
  // a conversation to idle instead of deleting it; only ended records expire.
  prune(now = this._now()) {
    let dropped = 0;
    for (const record of this._sessions.values()) {
      if (record.expiresAt === null || record.expiresAt > now) continue;
      if (record.state === ENDED) {
        this._deleteRecord(record);
        dropped++;
      } else {
        const expiredAt = record.expiresAt;
        record.state = 'idle';
        record.message = '';
        record.taskStartedAt = null;
        record.taskCompletedAt = null;
        record.taskOutcome = null;
        record.idleSince = expiredAt;
        record.updatedAt = expiredAt;
        record.expiresAt = null;
      }
    }
    return dropped;
  }

  clear() {
    this._sessions.clear();
    this._conversationIds.clear();
  }

  _releaseConversation(record) {
    if (
      record.conversationId &&
      this._conversationIds.get(record.conversationId) === record.id
    ) {
      this._conversationIds.delete(record.conversationId);
    }
  }

  _deleteRecord(record) {
    this._releaseConversation(record);
    this._sessions.delete(record.id);
  }
}

// Eviction comparator: "should `a` be shed before `b`?" (negative = yes).
// Ended-first, then least-recently-updated, then oldest, then lowest id.
function evictionOrder(a, b) {
  const aEnded = a.state === ENDED ? 0 : 1;
  const bEnded = b.state === ENDED ? 0 : 1;
  if (aEnded !== bEnded) return aEnded - bEnded;
  if (a.updatedAt !== b.updatedAt) return a.updatedAt - b.updatedAt;
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
  return a.id < b.id ? -1 : 1;
}

function snapshotOf(record, now) {
  return {
    session_id: record.id,
    conversation_id: record.conversationId,
    label: record.label,
    cwd: record.cwd,
    source: record.source,
    pal_id: record.palId,
    theme_id: record.themeId,
    palette: {
      body: record.palette.body,
      bg: record.palette.bg,
      text: record.palette.text,
      text_dim: record.palette.textDim,
      ink: record.palette.ink,
    },
    summary: record.summary,
    assignment: record.assignment,
    configured_at: record.configuredAt === null ? null : new Date(record.configuredAt).toISOString(),
    state: record.state,
    message: record.message || '',
    // null unless end() was called with an explicit closing message. Callers
    // (and the bridge) must use this — never `message` — to decide what to
    // flash on the device when a session finishes.
    closing_message: record.closingMessage || null,
    outcome: record.outcome,
    task_outcome: record.taskOutcome,
    task_started_at:
      record.taskStartedAt === null ? null : new Date(record.taskStartedAt).toISOString(),
    task_completed_at:
      record.taskCompletedAt === null ? null : new Date(record.taskCompletedAt).toISOString(),
    usage: copyUsage(record.usage),
    created_at: new Date(record.createdAt).toISOString(),
    updated_at: new Date(record.updatedAt).toISOString(),
    ended_at: record.endedAt ? new Date(record.endedAt).toISOString() : null,
    expires_at: record.expiresAt === null ? null : new Date(record.expiresAt).toISOString(),
    expires_in_seconds:
      record.expiresAt === null ? null : Math.max(0, Math.round((record.expiresAt - now) / 1000)),
  };
}

function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const counters = [
    'api_calls',
    'input_tokens',
    'output_tokens',
    'cache_read_tokens',
    'cache_write_tokens',
    'reasoning_tokens',
    'total_nano_aiu',
  ];
  const out = {
    source: 'assistant_usage_events',
    experimental: true,
    updated_at:
      typeof usage.updated_at === 'string' && !Number.isNaN(Date.parse(usage.updated_at))
        ? new Date(usage.updated_at).toISOString()
        : null,
    latest_model: clampText(usage.latest_model, 64) || null,
    context_used: usageCounter(usage.context_used),
    context_max: usageCounter(usage.context_max),
    models: {},
  };
  for (const key of counters) out[key] = usageCounter(usage[key]);

  if (usage.models && typeof usage.models === 'object' && !Array.isArray(usage.models)) {
    for (const [model, value] of Object.entries(usage.models)) {
      if (!model || !value || typeof value !== 'object') continue;
      const item = {};
      for (const key of counters) item[key] = usageCounter(value[key]);
      item.updated_at =
        typeof value.updated_at === 'string' && !Number.isNaN(Date.parse(value.updated_at))
          ? new Date(value.updated_at).toISOString()
          : null;
      out.models[model] = item;
    }
  }
  if (!out.context_max || out.context_used > out.context_max) {
    out.context_used = 0;
    out.context_max = 0;
  }
  return out;
}

function copyUsage(usage) {
  if (!usage) return null;
  return {
    source: usage.source,
    experimental: usage.experimental,
    api_calls: usage.api_calls,
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    cache_read_tokens: usage.cache_read_tokens,
    cache_write_tokens: usage.cache_write_tokens,
    reasoning_tokens: usage.reasoning_tokens,
    total_nano_aiu: usage.total_nano_aiu,
    updated_at: usage.updated_at,
    latest_model: usage.latest_model,
    context_used: usage.context_used,
    context_max: usage.context_max,
    models: Object.fromEntries(
      Object.entries(usage.models || {}).map(([model, value]) => [model, { ...value }])
    ),
  };
}

function usageCounter(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(n));
}

module.exports = {
  SessionRegistry,
  SessionError,
  STATES,
  OUTCOMES,
  ENDED,
  isTaskActiveState,
  SUMMARY_MAX,
  normalizeSummary,
};

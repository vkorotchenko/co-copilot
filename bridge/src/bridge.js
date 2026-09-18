'use strict';

const crypto = require('crypto');
const snapshot = require('./protocol/snapshot');
const commands = require('./protocol/commands');
const { SessionRegistry, isTaskActiveState } = require('./sessions/registry');
const { CompletionLatch } = require('./sessions/completionLatch');
const { composeModel } = require('./sessions/compose');
const log = require('./util/log');

// Single normalizer for the confirmation queue depth, shared by config.js (for
// COMPANION_CONFIRM_QUEUE) and the Bridge constructor (for a cfg passed in
// programmatically, e.g. by tests). Having one function means the env var and
// an injected cfg cannot disagree about what `0`, a negative, a fraction or a
// typo means.
//
// The floor is 1 because the device can only show one prompt at a time: a depth
// of 1 means "no queueing" (just the question on screen), which is the smallest
// configuration that still lets `companion_confirm` do its job. A configured 0
// would turn every confirmation into `unavailable` and silently disable the
// hardware approval gate, so it is clamped up rather than honoured. Anything
// that isn't a number at all — including a whitespace-only env var — falls back
// to the default rather than being coerced to 0 and then clamped.
const DEFAULT_CONFIRM_QUEUE = 8;
const MIN_CONFIRM_QUEUE = 1;
const DEFAULT_DEVICE_PROJECTION_MAX = 8;

// An explicit `companion_task_complete` can latch before the CLI publishes its
// passive completion evidence. That later event/turn-row edge is the same task
// seen from another source; applying it would downgrade an owned failed/aborted
// card to an anonymous success one and replay the introduction.
//
// An echo guard is therefore armed at *every* explicit task completion, and each guard
// answers exactly one passive completion edge (one-shot, per guard). Several
// sessions can complete tasks inside the same window, so the guards live in a
// small bounded FIFO rather than a single slot: two task completions must
// suppress two echoes, one each, and neither may eat the other's.
//
// A guard records the completing session's identity (owner + the generation it
// latched), its working directory, and when it expires. Correlation of an
// incoming passive completion edge against the armed guards is *positive
// only*: an edge is a guard's echo when the two sides agree on something, never
// merely because neither side disagreed.
//   * exact Copilot session identity (guard conversation_id == edge session) is
//     the strongest match, and a known disagreement removes the guard from the
//     running entirely — that row belongs to another conversation,
//   * otherwise an exact cwd match on both known sides correlates,
//   * anything else — both identities unknown, only one side known, cwd known
//     on one side only — is *not* a candidate. Suppressing on an uncorrelated
//     guard let a completion that positively identified a different session eat
//     an unrelated guard and vanish from the display,
//   * within the same tier the *oldest* armed guard wins (FIFO), so out-of-order
//     A/B echoes still consume one guard each and the result does not depend on
//     which echo lands first,
//   * the chosen guard is removed; no other guard is touched. An edge that
//     matches nothing latches normally.
// Deliberately independent of whether the guard's own completion is still the
// one on the latch: a later explicit task completion replaces the card but must
// not disarm the earlier session's pending echo.
//
// Guards are disarmed only by evidence from the same conversation: a semantic
// interaction edge (prompt/user/tool) carrying that conversation identity and
// postdating the protected completion, or an idle-to-active explicit cycle for
// the same registry owner. Unknown-session events can clear the visible card,
// but they cannot safely retire another conversation's guard.
//
// "Postdates what is protected" is measured against the completion times each
// guard carries, never against whatever card happens to be on screen. The
// screen is not evidence: a device dismissal takes the finished card off it,
// the turn it belongs to is still finished, and its echo is still pending.
// Reading newness off the displayed card meant that after a dismissal *every*
// newly observed edge — including an old one replayed out of a session file
// discovered late — looked like new work and disarmed the guards, so the
// dismissed completion walked back on a second later as a fresh anonymous
// success card with a new generation, replaying the introduction the user just
// dismissed and downgrading a failed/aborted outcome.
//
// Two different questions are asked of an interaction edge, and they use
// different floors:
//   * "does this edge disarm a guard?" is answered per guard, against that
//     guard's own completedAt (see _disarmExplicitEchoesForInteraction). A
//     session-A interaction is A's new work whether or not session B completed
//     something more recently; the global watermark used to hide it and strand
//     A's guard until it expired.
//   * "does this edge clear the displayed card?" is answered against
//     _protectedCompletionAt() — the newest of the card and every armed guard —
//     so a dismissal cannot lower the display bar and let replayed history
//     masquerade as new work.
//
// An edge with no timestamp proves nothing about ordering, so it disarms
// nothing; the bounded window below is its backstop. Individually guards lapse
// when that window expires, and the FIFO drops its oldest entry when more than
// MAX_EXPLICIT_ECHO_GUARDS task completions are outstanding, so memory stays bounded, the
// protection floor decays with the guards, and no session is retained
// indefinitely.
//
// The window is the deterministic fallback for the case where the two sources
// share no identity at all: the CLI turn row carries no explicit session
// identity, so cwd is often the strongest correlation available — and when even
// that is missing, the edge is simply not correlated and latches normally.
const EXPLICIT_ECHO_WINDOW_MS = 30000;
const MAX_EXPLICIT_ECHO_GUARDS = 8;

function normalizeConfirmQueue(value) {
  if (value == null) return DEFAULT_CONFIRM_QUEUE;
  const raw = typeof value === 'string' ? value.trim() : value;
  if (raw === '') return DEFAULT_CONFIRM_QUEUE;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_CONFIRM_QUEUE;
  return Math.max(MIN_CONFIRM_QUEUE, Math.trunc(n));
}

function normalizeDeviceProjectionMax(value) {
  if (value == null) return DEFAULT_DEVICE_PROJECTION_MAX;
  const raw = typeof value === 'string' ? value.trim() : value;
  if (raw === '') return DEFAULT_DEVICE_PROJECTION_MAX;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_DEVICE_PROJECTION_MAX;
  return Math.max(1, Math.min(DEFAULT_DEVICE_PROJECTION_MAX, Math.trunc(n)));
}

// Orchestrates the device link: owns snapshot send/diff/keepalive, the one-shot
// time/owner handshake, the explicit session registry, and the bidirectional
// "write" surface (notify + confirm) that the MCP server and the plain HTTP
// mirror both drive.
//
// State model
// -----------
// Every outgoing snapshot is composed from two sources (see sessions/compose.js
// for the full priority rules):
//   * passive telemetry — the model CopilotSource derives from the session
//     store, the live log tail, and the permission watch.
//   * explicit events   — the TTL'd session registry that agents drive through
//     companion_session_begin / companion_state / companion_task_complete /
//     companion_session_end.
// Active explicit state wins the display line while its task lease is valid;
// passive evidence remains the floor for counts. When a lease lapses, the
// conversation returns to idle instead of disappearing. Composition happens at
// send time (once a second on the keepalive), so stale work self-heals within a
// tick without any extra timers.
//
// Confirmations
// -------------
// confirm() reuses the firmware's existing permission-prompt UI: we inject a
// `prompt` into the outgoing snapshot, the device shows it (A=approve, B=deny),
// and replies with {"cmd":"permission","id","decision"}. We correlate by id and
// resolve the pending promise. No firmware changes required. Concurrent
// confirmations are served FIFO — only the queue head is on screen, and each
// caller's promise resolves with *its own* answer.
class Bridge {
  constructor(transport, cfg, deps = {}) {
    this._t = transport;
    this._cfg = cfg;
    this._now = deps.now || (() => Date.now());

    this._passive = null;     // latest raw activity model from the source
    this._passiveEdgesPrimed = false;
    this._passiveEdgeIds = Object.create(null);
    this._passiveCompletionId = null;
    this._explicitEchoes = [];   // bounded FIFO of armed echo guards
    this._explicitEchoSeq = 0;
    this._lastSent = null;
    this._lastSentAt = 0;
    this._statusTimer = null;
    this._keepalive = null;

    this._ownerName = null;
    // FIFO of pending confirmations. Index 0 is the one on screen; the rest
    // wait their turn. Entries: { id, tool, hint, resolve, timer, enqueuedAt }.
    this._confirmQueue = [];
    this._maxConfirmQueue = normalizeConfirmQueue(cfg.confirm && cfg.confirm.maxQueue);
    this._notice = null;        // transient one-line override for msg
    this._noticeUntil = 0;

    this._registry = new SessionRegistry({ ...((cfg && cfg.sessions) || {}), now: this._now });
    this._completion = new CompletionLatch({
      now: this._now,
      randomUint32: deps.randomUint32,
    });
    this._completionCapable = false;
    this._deviceProjectionMax = normalizeDeviceProjectionMax(
      cfg && cfg.sessions && cfg.sessions.deviceProjectionMax
    );

    this._wire();
  }

  _wire() {
    this._t.on('connected', (name) => this._onConnected(name));
    this._t.on('disconnected', () => this._onDisconnected());
    this._t.on('line', (msg) => this._onDeviceMessage(msg));
    this._t.on('scanning', () => log.info('Waiting for a co-copilot device...'));
  }

  start() {
    commands.resolveOwnerName().then((n) => {
      this._ownerName = n;
      log.debug('Owner name:', n);
      if (this._t.connected) this._t.writeLine(commands.ownerMessage(n));
    });
    // Guarantee a push at least every keepaliveMs. This tick also re-composes
    // the snapshot, which is what makes session TTL expiry take effect.
    this._keepalive = setInterval(() => this._push(false), 1000);
  }

  stop() {
    if (this._keepalive) clearInterval(this._keepalive);
    if (this._statusTimer) clearInterval(this._statusTimer);
    this._drainConfirms('unavailable');
    this._registry.clear();
  }

  get connected() {
    return this._t.connected;
  }

  // --- telemetry (read) ----------------------------------------------------

  // Called by the orchestrator whenever the source emits a fresh activity model.
  setModel(model) {
    this._observePassiveEdges(model || {});
    this._passive = model;
    this._syncSessionUsage(model && model.officialUsage);
    this._push(false);
  }

  // Current composed wire snapshot (what the device is being shown).
  get status() {
    return (
      this._composed(true) || { total: 0, running: 0, waiting: 0, msg: 'idle', entries: [] }
    );
  }

  // Which Copilot conversation the passive transcript and state currently
  // describe, and why it was chosen. Additive diagnostic only — it is not part
  // of the wire snapshot (composeModel drops it) and callers may ignore it.
  get passiveFocus() {
    const focus = this._passive && this._passive.focus;
    return focus ? { ...focus } : null;
  }

  get usageStatus() {
    const usage = this._passive && this._passive.officialUsage;
    if (!usage) {
      return {
        available: false,
        experimental: true,
        source: 'assistant_usage_events',
        tracked_sessions: 0,
      };
    }
    return {
      available: !!usage.available,
      experimental: usage.experimental !== false,
      source: usage.source || 'assistant_usage_events',
      tracked_sessions:
        usage.sessions && typeof usage.sessions === 'object'
          ? Object.keys(usage.sessions).length
          : 0,
    };
  }

  // Explicit session registry (bridge-owned; see sessions/registry.js).
  get registry() {
    return this._registry;
  }

  // Number of confirmations waiting on a button press (head included).
  get pendingConfirmations() {
    return this._confirmQueue.length;
  }

  get deviceProjectionMax() {
    return this._deviceProjectionMax;
  }

  get completionLatch() {
    return this._completion;
  }

  get completionCapable() {
    return this._completionCapable;
  }

  // --- explicit session lifecycle ------------------------------------------
  // Thin wrappers so every mutation refreshes the device immediately instead of
  // waiting for the next keepalive tick. Registry errors (unknown/expired
  // session, invalid state) propagate to the caller untouched.

  beginSession(args) {
    const existing =
      args && args.conversationId
        ? this._registry.getByConversationId(args.conversationId)
        : null;
    let record = this._registry.begin(args);
    const created = !existing || existing.session_id !== record.session_id;
    record = this._syncOneSessionUsage(record) || record;
    if (created) {
      this._completion.clear();
    }
    log.debug(`Session ${created ? 'begin' : 'refresh'} ${record.session_id} (${record.label})`);
    this._push(true);
    return record;
  }

  updateSession(args) {
    const before = this._registry.get(args && args.id);
    const record = this._registry.update(args);
    if (isExplicitWorkStart(before && before.state, record.state)) {
      this._completion.clear();
    }
    if (isNewExplicitCycle(before && before.state, record.state)) {
      this._disarmExplicitEchoesForOwner(record.session_id);
    }
    log.debug(`Session ${record.session_id} -> ${record.state}`);
    this._push(true);
    return record;
  }

  configureSession(args) {
    const record = this._registry.configure(args);
    log.debug(`Session configure ${record.session_id} (${record.pal_id}/${record.theme_id})`);
    this._push(true);
    return record;
  }

  completeTask(args) {
    const before = this._registry.get(args && args.id);
    const record = this._registry.completeTask(args);
    // Retries are idempotent. Only an active -> idle task boundary creates a
    // new generation; the conversation record and configured pal remain live.
    if (before && isTaskActiveState(before.state)) {
      this._completion.completeExplicit(before, record.task_outcome);
      this._armExplicitEcho(before);
    }
    log.debug(`Task complete ${record.session_id} (${record.task_outcome})`);
    this._push(true);
    return record;
  }

  endSession(args) {
    const record = this._registry.end(args);
    log.debug(`Session end ${record.session_id} (${record.outcome})`);
    // Only an *explicit* closing message is flashed, and it behaves like a
    // notify: shown briefly, then we fall back to whatever the remaining
    // sessions / passive telemetry say. Ending without one must fall back
    // immediately — re-flashing the session's last in-flight message would
    // show stale activity and could mask another session that is blocked.
    if (record.closing_message) this.notify(record.closing_message);
    else this._push(true);
    return record;
  }

  _syncSessionUsage(officialUsage) {
    const sessions = officialUsage && officialUsage.sessions;
    const available =
      !!(officialUsage && officialUsage.available) &&
      !!sessions &&
      typeof sessions === 'object' &&
      !Array.isArray(sessions);
    let updated = 0;
    for (const record of this._registry.list()) {
      const conversationId = record.conversation_id;
      if (!conversationId) continue;
      const usage =
        available && Object.prototype.hasOwnProperty.call(sessions, conversationId)
          ? sessions[conversationId]
          : null;
      if (this._registry.setUsageByConversationId(conversationId, usage)) {
        updated++;
      }
    }
    return updated;
  }

  _syncOneSessionUsage(record) {
    const conversationId = record && record.conversation_id;
    const sessions =
      this._passive &&
      this._passive.officialUsage &&
      this._passive.officialUsage.sessions;
    if (!conversationId || !sessions || typeof sessions !== 'object') return null;
    const usage = sessions[conversationId];
    if (!usage) return null;
    return this._registry.setUsageByConversationId(conversationId, usage);
  }

  // --- writes (notify / confirm) -------------------------------------------

  // Flash a short message on the device for a few seconds.
  notify(text, ttlMs = 6000) {
    this._notice = String(text || '').slice(0, snapshot.MSG_MAX);
    this._noticeUntil = this._now() + ttlMs;
    this._push(true);
    return this._t.connected;
  }

  // Ask the device a yes/no question, reusing the permission-prompt UI.
  // Resolves to { decision: 'approved'|'denied'|'timeout'|'unavailable' }.
  //
  // Concurrent calls queue FIFO: each caller gets the answer to *its own*
  // question, in the order the questions were asked. `timeoutMs` bounds the
  // total wait (queueing included), so a slow question ahead in line can never
  // strand the ones behind it — they time out on their own schedule and leave
  // the queue without disturbing the head.
  confirm({ title, detail, timeoutMs = 60000 } = {}) {
    if (!this._t.connected) {
      return Promise.resolve({ decision: 'unavailable' });
    }
    if (this._confirmQueue.length >= this._maxConfirmQueue) {
      log.warn(
        `Confirmation queue full (${this._maxConfirmQueue}); rejecting "${title}" as unavailable.`
      );
      return Promise.resolve({ decision: 'unavailable' });
    }

    const id = 'mcp-' + crypto.randomBytes(6).toString('hex');
    const entry = {
      id,
      tool: String(title || 'Confirm').slice(0, 19),
      hint: String(detail || '').slice(0, 43),
      enqueuedAt: Date.now(),
      resolve: null,
      timer: null,
    };

    return new Promise((resolve) => {
      entry.resolve = resolve;
      entry.timer = setTimeout(() => this._settleConfirm(id, 'timeout'), timeoutMs);
      const wasIdle = this._confirmQueue.length === 0;
      this._confirmQueue.push(entry);
      // Only the head is rendered; a queued entry changes nothing on screen.
      if (wasIdle) this._push(true);
      else log.debug(`Confirm ${id} queued behind ${this._confirmQueue.length - 1} question(s).`);
    });
  }

  // Remove a confirmation from the queue and resolve its caller. Safe for any
  // position: settling a queued (non-head) entry leaves the visible prompt
  // untouched; settling the head promotes the next question.
  _settleConfirm(id, decision) {
    const idx = this._confirmQueue.findIndex((e) => e.id === id);
    if (idx === -1) return false;
    const [entry] = this._confirmQueue.splice(idx, 1);
    clearTimeout(entry.timer);
    entry.resolve({ decision });
    if (idx === 0) this._push(true); // head changed: show the next (or clear)
    return true;
  }

  // Resolve every outstanding confirmation with the same decision (link down,
  // shutdown). Nothing is left holding a promise.
  _drainConfirms(decision) {
    const queued = this._confirmQueue;
    this._confirmQueue = [];
    for (const entry of queued) {
      clearTimeout(entry.timer);
      entry.resolve({ decision });
    }
    return queued.length;
  }

  // --- snapshot send -------------------------------------------------------

  _activeConfirm() {
    const head = this._confirmQueue[0];
    return head ? { id: head.id, tool: head.tool, hint: head.hint } : null;
  }

  // Compose passive telemetry + explicit sessions + notice + confirm into the
  // wire snapshot. Returns null when there is genuinely nothing to say yet (no
  // telemetry, no sessions, no prompt, no notice) so we never push an empty
  // frame before the first source tick. `force` bypasses that guard for the
  // status reader, which always wants a concrete object.
  _composed(force = false) {
    const now = this._now();
    const sessions = this._registry.list(now);
    const confirm = this._activeConfirm();
    const noticeLive = !!(this._notice && now < this._noticeUntil);
    if (!force && !this._passive && !sessions.length && !confirm && !noticeLive) return null;

    const model = composeModel({
        passive: this._passive,
        sessions,
        projectionLimit: this._deviceProjectionMax,
        notice: noticeLive ? { text: this._notice, until: this._noticeUntil } : null,
        confirm,
        now,
      });
    if (this._completionCapable) {
      model.completionEpoch = this._completion.epoch;
      model.completion = this._completion.wire();
    }
    return snapshot.buildSnapshot(model);
  }

  _push(force) {
    if (!this._t.connected) return;
    const snap = this._composed();
    if (!snap) return;
    const changed = !this._lastSent || !snapshot.equal(snap, this._lastSent);
    const stale = this._now() - this._lastSentAt >= this._cfg.keepaliveMs;
    if (!force && !changed && !stale) return;
    // Snapshot heartbeats are replaceable state; commands are discrete events.
    // Transports without a specialized path retain the ordinary writeLine API.
    if (typeof this._t.writeSnapshot === 'function') this._t.writeSnapshot(snap);
    else this._t.writeLine(snap);
    this._lastSent = snap;
    this._lastSentAt = this._now();
    log.debug('TX snapshot:', JSON.stringify(snap));
  }

  // --- device link events --------------------------------------------------

  async _onConnected(name) {
    this._completionCapable = false;
    log.info(`Link up: ${name}. Sending time + owner.`);
    await this._t.writeLine(commands.timeMessage());
    if (this._ownerName) await this._t.writeLine(commands.ownerMessage(this._ownerName));
    // Ask for capability immediately rather than waiting up to a full poll
    // interval. Until the `cl:1` ack lands every heartbeat is legacy-shaped
    // (no `sg`), and a device that still holds this process's latch would spend
    // that whole window being told, in the legacy dialect, that nothing modern
    // is on the link.
    await this._t.writeLine(commands.statusRequest());
    this._lastSent = null;
    this._push(true);

    if (this._statusTimer) clearInterval(this._statusTimer);
    this._statusTimer = setInterval(() => {
      if (this._t.connected) this._t.writeLine(commands.statusRequest());
    }, this._cfg.statusPollMs);
  }

  _onDisconnected() {
    this._completionCapable = false;
    if (this._statusTimer) { clearInterval(this._statusTimer); this._statusTimer = null; }
    this._lastSent = null;
    // Fail every in-flight confirm — queued ones included, so nobody is left
    // waiting on a screen that isn't there. Callers can re-ask on reconnect.
    const drained = this._drainConfirms('unavailable');
    if (drained) log.debug(`Link down: released ${drained} pending confirmation(s).`);
  }

  _observePassiveEdges(model) {
    // Every newly observed edge is processed, not just the newest of each kind:
    // concurrent conversations each produce their own prompt/user/tool edges,
    // and a per-kind slot silently drops all but one of them.
    const observed = collectPassiveEdges(model);
    let interactionOccurred = false;
    let newestInteractionAt = null;
    for (const edge of observed) {
      if (this._passiveEdgeIds[edge.kind] === edge.id) continue;
      this._passiveEdgeIds[edge.kind] = edge.id;
      if (!this._passiveEdgesPrimed) continue;
      // Guard lifecycle is per guard, against that guard's own completion:
      // session A's interaction is A's new work even when an unrelated session
      // completed something more recently.
      this._disarmExplicitEchoesForInteraction(edge);
      if (edge.kind === 'user') this._activateExplicitSessionForUserEdge(edge);
      // Display newness is measured against the completions still under
      // protection — the card on screen *and* every armed guard — so a
      // dismissal cannot lower the bar and let replayed history (an old event
      // found in a session file discovered late) masquerade as new work.
      const protectedAt = this._protectedCompletionAt();
      if (edge.at != null && protectedAt != null && edge.at <= protectedAt) continue;
      interactionOccurred = true;
      if (edge.at != null) {
        newestInteractionAt = newestInteractionAt == null
          ? edge.at
          : Math.max(newestInteractionAt, edge.at);
      }
      this._completion.clear();
    }
    this._passiveEdgesPrimed = true;

    const completion = model.completionEdge;
    if (!completion || completion.id == null || completion.id === this._passiveCompletionId) return;
    this._passiveCompletionId = completion.id;
    // One-shot-per-guard, correlated suppression of an explicit task's own
    // turn-row echo. Deliberately independent of the edge timestamp (the real
    // turn row is written *after* task completion, so a timestamp comparison
    // would never match the case it exists to cover) *and* of whatever else
    // arrived in this model: an unrelated session's newer interaction means
    // this completion should not be displayed, but it is still this guard's
    // echo and must retire it rather than leave it armed for a later,
    // genuinely independent completion to fall into.
    const guard = this._consumeExplicitEcho(completion);
    if (guard) {
      log.debug(`Passive completion ${completion.id} suppressed as the task echo ` +
        `of ${guard.owner} (g${guard.generation}).`);
      return;
    }
    const completionAt = Number.isFinite(completion.at) ? completion.at : null;
    if (!interactionOccurred || (completionAt != null && newestInteractionAt != null &&
        completionAt > newestInteractionAt)) {
      this._completion.completePassive(completion);
    }
  }

  // A real Copilot user.message is also a reliable task-cycle boundary. When
  // it carries the exact conversation UUID of an idle explicit pal, start that
  // pal in thinking immediately instead of waiting for the orchestrator's next
  // MCP state call. Never guess from cwd or labels, and never override an
  // already-active waiting/working state.
  _activateExplicitSessionForUserEdge(edge) {
    const conversationId = normalizeSessionIdentity(edge && edge.session);
    if (!conversationId) return null;
    const updated = this._registry.activateForUserEdge(conversationId, edge.at);
    if (!updated) return null;
    log.debug(`Passive user edge started task cycle for ${updated.session_id}.`);
    return updated;
  }

  // Number of armed (possibly expired) echo guards. Bounded by
  // MAX_EXPLICIT_ECHO_GUARDS; exposed so the boundedness is assertable.
  get explicitEchoGuardCount() {
    this._pruneExplicitEchoes(this._now());
    return this._explicitEchoes.length;
  }

  // Starting a new task invalidates only the previous task guard owned by that
  // conversation. Other conversations can still have delayed completion rows
  // in flight and must keep their protection.
  _disarmExplicitEchoesForOwner(owner) {
    if (!owner) return 0;
    const had = this._explicitEchoes.length;
    this._explicitEchoes = this._explicitEchoes.filter((guard) => guard.owner !== owner);
    return had - this._explicitEchoes.length;
  }

  // Newest completion time still protected from replayed history: the card on
  // screen, plus the completion every armed guard is holding an echo for. The
  // guards are what keeps this floor up after a device dismissal — the card
  // leaves the screen, the fact that those turns finished does not. Expired
  // guards are pruned first, so protection is bounded by
  // EXPLICIT_ECHO_WINDOW_MS past the last task completion and never goes stale
  // indefinitely. Returns null when nothing is protected.
  _protectedCompletionAt() {
    this._pruneExplicitEchoes(this._now());
    const current = this._completion.current;
    let newest = current ? current.completedAt : null;
    for (const guard of this._explicitEchoes) {
      if (newest == null || guard.completedAt > newest) newest = guard.completedAt;
    }
    return newest;
  }

  // Disarm only guards from the conversation identified by a semantic
  // interaction edge. Timestamp alone cannot identify ownership when several
  // sessions run concurrently. Unknown-session edges clear the visible card
  // but leave guards to their bounded expiry.
  _disarmExplicitEchoesForInteraction(edge) {
    if (!edge || edge.at == null || !edge.session) return 0;
    const had = this._explicitEchoes.length;
    this._explicitEchoes = this._explicitEchoes.filter((guard) => (
      guard.conversationId !== edge.session || guard.completedAt >= edge.at
    ));
    return had - this._explicitEchoes.length;
  }

  _pruneExplicitEchoes(now) {
    if (!this._explicitEchoes.length) return;
    this._explicitEchoes = this._explicitEchoes.filter((guard) => now <= guard.expiresAt);
  }

  // Arm an echo guard for a completion just latched by an explicit task event.
  // The guard is keyed by the live session (owner + latched generation) and
  // correlated by cwd, so concurrent tasks never share one slot. It also
  // carries the completion's own timestamp: that, not the displayed card, is
  // what an interaction edge has to postdate before it may disarm this guard,
  // so the protection survives a device dismissal.
  _armExplicitEcho(record) {
    const current = this._completion.current;
    // Nothing owned to protect: an unowned latch cannot be downgraded by an
    // echo. Other sessions' guards are none of this task's business.
    if (!current || !current.owner) return null;
    const now = this._now();
    this._pruneExplicitEchoes(now);
    const guard = {
      seq: ++this._explicitEchoSeq,
      owner: current.owner,
      generation: current.g,
      conversationId: record && record.conversation_id
        ? String(record.conversation_id)
        : null,
      cwd: normalizeCwd(record && record.cwd),
      completedAt: current.completedAt,
      armedAt: now,
      expiresAt: now + EXPLICIT_ECHO_WINDOW_MS,
    };
    this._explicitEchoes.push(guard);
    // Bounded memory: past the cap the oldest outstanding guard is evicted
    // first, so the most recent ends — whose echoes are still in flight — are
    // the ones that keep their protection.
    while (this._explicitEchoes.length > MAX_EXPLICIT_ECHO_GUARDS) {
      const evicted = this._explicitEchoes.shift();
      log.debug(`Echo guard for ${evicted.owner} evicted (more than ` +
        `${MAX_EXPLICIT_ECHO_GUARDS} explicit task completions outstanding).`);
    }
    return guard;
  }

  // Answer one passive completion edge with at most one armed guard. Returns
  // the consumed guard, or null when this edge matches none of them (in which
  // case it is ordinary evidence and latches). A non-matching edge consumes
  // nothing, so another session's guard survives it intact.
  //
  // Correlation is positive only. A guard is a candidate when it *agrees* with
  // the edge on Copilot session identity or on cwd; "neither side said
  // anything" is not agreement. Treating an uncorrelated guard as a generic
  // match meant a completion that positively identified session B could be
  // swallowed by a guard armed for session A, so B's completion silently
  // disappeared and A's real echo later latched as anonymous passive evidence.
  _consumeExplicitEcho(edge) {
    this._pruneExplicitEchoes(this._now());
    if (!this._explicitEchoes.length) return null;
    const edgeSession = normalizeSessionIdentity(edge && edge.session);
    const edgeCwd = normalizeCwd(edge && edge.cwd);
    let best = null;
    let bestRank = 0;
    for (const guard of this._explicitEchoes) {
      let rank;
      if (guard.conversationId && edgeSession) {
        // Identity is authoritative in both directions: a disagreement is
        // another conversation's row, never this guard's echo.
        if (guard.conversationId !== edgeSession) continue;
        rank = 2;
      } else if (guard.cwd && edgeCwd && guard.cwd === edgeCwd) {
        rank = 1;
      } else {
        continue; // nothing positively ties this edge to this guard
      }
      // Strictly greater keeps the oldest guard of the best tier (FIFO).
      if (rank > bestRank) { best = guard; bestRank = rank; }
    }
    if (!best) return null;
    this._explicitEchoes.splice(this._explicitEchoes.indexOf(best), 1);
    return best;
  }

  _onDeviceMessage(msg) {
    if (typeof msg === 'string') {
      log.debug('RX (raw):', msg);
      return;
    }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return;
    if (msg.cmd === 'completion') {
      if (msg.action === 'dismiss' && this._completion.dismiss(msg)) {
        // Dismissal only takes the card off the screen. The turn that produced
        // it is still finished, so its pending echo is still an echo: leaving
        // the guards armed is what stops the dismissed completion from walking
        // back on as a fresh anonymous card a second later.
        log.info(`Device dismissed completion ${msg.sg}/${msg.g}.`);
        this._push(true);
      } else {
        log.debug('Stale or malformed completion dismissal ignored.');
      }
      return;
    }
    if (msg.cmd === 'permission' && msg.id) {
      const decision = msg.decision === 'deny' ? 'denied' : 'approved';
      if (this._settleConfirm(msg.id, decision)) {
        log.info(`Device answered ${msg.id}: ${decision}`);
      } else if (String(msg.id).startsWith('perm-')) {
        // Passively-detected Copilot prompt: the buttons can't answer the real
        // terminal prompt, so a press just acknowledges/dismisses on-device.
        // The prompt clears authoritatively when `permission.completed` lands.
        log.debug(`Device acknowledged passive prompt ${msg.id} (answer in terminal).`);
      } else {
        log.debug(`Permission reply for unknown id ${msg.id} (ignored).`);
      }
      return;
    }
    if (msg.ack) {
      if (msg.ack === 'status' && msg.data) {
        const d = msg.data;
        if (!this._completionCapable && d.cl === 1) {
          this._completionCapable = true;
          this._lastSent = null;
          this._push(true);
        }
        const bat = d.bat ? `${d.bat.pct}%${d.bat.usb ? '+' : ''}` : '?';
        log.info(`Device status: name=${d.name} bat=${bat} ` +
          `appr=${d.stats ? d.stats.appr : '?'} deny=${d.stats ? d.stats.deny : '?'}`);
      } else {
        log.debug(`ack ${msg.ack} ok=${msg.ok}`);
      }
      return;
    }
    log.debug('RX:', JSON.stringify(msg));
  }
}

function normalizeEdge(value) {
  if (value == null) return null;
  if (typeof value === 'object') {
    if (value.id == null) return null;
    return {
      id: String(value.id),
      at: Number.isFinite(value.at) ? value.at : null,
      session: normalizeSessionIdentity(value.session || value.sessionId),
    };
  }
  return { id: String(value), at: null, session: null };
}

// Semantic interaction kinds the bridge reacts to, in the order a model
// reports them.
const PASSIVE_EDGE_KINDS = ['prompt', 'user', 'tool', 'aiRequest'];

// Flatten a model's semantic edges into one observation-ordered list.
//
// `model.edges` is the edge-triggered, per-session stream: every edge the
// watchers newly observed in this poll, including several of the same kind from
// different conversations. `model.edgeIds` is the older level-triggered map of
// "newest of each kind", kept for sources (and test doubles) that do not
// publish the list, and for the AI-request edge that the log tail owns. The map
// is appended last and de-duplicated by the same per-kind slot, so a source
// publishing both never has its edges counted twice.
function collectPassiveEdges(model) {
  const out = [];
  if (Array.isArray(model.edges)) {
    for (const raw of model.edges) {
      if (!raw || !PASSIVE_EDGE_KINDS.includes(raw.kind)) continue;
      const edge = normalizeEdge(raw);
      if (edge) out.push({ ...edge, kind: raw.kind });
    }
  }
  const map = model.edgeIds || {};
  for (const kind of PASSIVE_EDGE_KINDS) {
    const edge = normalizeEdge(map[kind]);
    if (edge) out.push({ ...edge, kind });
  }
  return out;
}

function normalizeSessionIdentity(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}

// Working directories are the only identity the explicit registry and the CLI
// turn rows genuinely share. Compared as opaque strings minus trailing
// separators — never resolved against the filesystem, so the comparison stays
// deterministic and side-effect free.
function normalizeCwd(value) {
  if (value == null) return null;
  const text = String(value).trim().replace(/[\\/]+$/, '');
  return text || null;
}

function isNewExplicitCycle(previous, next) {
  return previous === 'idle' && isTaskActiveState(next);
}

function isExplicitWorkStart(previous, next) {
  if (!previous || !isTaskActiveState(next) || previous === next) return false;
  if (previous === 'idle') return true;
  return (previous === 'waiting' || previous === 'blocked') &&
    (next === 'thinking' || next === 'working');
}

module.exports = {
  Bridge,
  isNewExplicitCycle,
  normalizeConfirmQueue,
  normalizeDeviceProjectionMax,
  normalizeCwd,
  EXPLICIT_ECHO_WINDOW_MS,
  MAX_EXPLICIT_ECHO_GUARDS,
  DEFAULT_CONFIRM_QUEUE,
  MIN_CONFIRM_QUEUE,
  DEFAULT_DEVICE_PROJECTION_MAX,
};

'use strict';

// Unit tests for the explicit session registry and the state composition that
// merges it with passive telemetry.
//
// Time is injected, so TTL expiry is exercised deterministically without
// sleeping. Run: node test/sessions.js   (exits non-zero on failure)

const assert = require('assert');

process.env.COMPANION_LOG = process.env.COMPANION_LOG || 'error';

const { SessionRegistry, STATES, OUTCOMES, normalizeSummary } = require('../src/sessions/registry');
const { SPECIES, isSpecies, fnv1a32, defaultSpeciesFor } = require('../src/sessions/species');
const { DEFAULT_THEME, paletteFor } = require('../src/sessions/palettes');
const { composeModel, projectSessions, MSG_CONFIRM } = require('../src/sessions/compose');
const cfg = require('../src/config');
const { Bridge, normalizeDeviceProjectionMax } = require('../src/bridge');
const { FakeDeviceTransport } = require('../src/transport/fakeDevice');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function clockRig(opts = {}) {
  let now = 1_000_000;
  const registry = new SessionRegistry(Object.assign({ now: () => now }, opts));
  return {
    registry,
    advance(ms) { now += ms; return now; },
    now: () => now,
  };
}

function throwsCode(fn, code, what) {
  try {
    fn();
  } catch (err) {
    assert.strictEqual(err.code, code, `${what}: expected code ${code}, got ${err.code}`);
    return;
  }
  assert.fail(`${what}: expected a ${code} error, but nothing was thrown`);
}

// --- lifecycle --------------------------------------------------------------

{
  const { registry } = clockRig();
  const s = registry.begin({ label: 'build the bridge', cwd: '/tmp/x', source: 'mcp' });
  assert.match(s.session_id, /^cs-[0-9a-f]{16}$/, 'begin should mint an opaque id');
  assert.strictEqual(s.conversation_id, null, 'legacy callers need no conversation identity');
  assert.strictEqual(s.label, 'build the bridge');
  assert.strictEqual(s.cwd, '/tmp/x');
  assert.strictEqual(s.source, 'mcp');
  assert.strictEqual(s.state, 'working', 'a new session starts in "working"');
  assert.strictEqual(s.outcome, null);
  assert.ok(s.task_started_at, 'the first task starts with the session');
  assert.strictEqual(s.task_completed_at, null);
  assert.strictEqual(s.task_outcome, null);
  assert.strictEqual(s.expires_in_seconds, 90, 'default TTL is 90s');
  assert.strictEqual(registry.size, 1);

  const updated = registry.update({ id: s.session_id, state: 'waiting', message: 'need input' });
  assert.strictEqual(updated.state, 'waiting');
  assert.strictEqual(updated.message, 'need input');

  const completed = registry.completeTask({ id: s.session_id, outcome: 'failed' });
  assert.strictEqual(completed.state, 'idle');
  assert.strictEqual(completed.task_outcome, 'failed');
  assert.ok(completed.task_completed_at);
  assert.strictEqual(completed.expires_at, null, 'idle conversations have no active-task lease');

  const next = registry.update({ id: s.session_id, state: 'working', message: 'next task' });
  assert.strictEqual(next.task_outcome, null, 'starting another task clears the prior task result');
  assert.ok(next.task_started_at, 'the next task gets a fresh start time');

  const ended = registry.end({ id: s.session_id, outcome: 'failed', message: 'boom' });
  assert.strictEqual(ended.state, 'ended');
  assert.strictEqual(ended.outcome, 'failed');
  assert.strictEqual(ended.closing_message, 'boom', 'an explicit closing message is exposed');
  assert.ok(ended.ended_at, 'end should stamp ended_at');
}

// A stable top-level conversation ID makes begin idempotent. Retries refresh
// the lease without minting a second pal or resetting lifecycle/presentation.
{
  const rig = clockRig({ defaultTtlMs: 10000 });
  const first = rig.registry.begin({
    label: 'parent conversation',
    cwd: '/repo',
    source: 'mcp',
    conversationId: 'conversation-a',
  });
  rig.registry.configure({ id: first.session_id, palId: 'owl', summary: 'reviewing changes' });
  rig.registry.update({ id: first.session_id, state: 'blocked', message: 'need input' });

  rig.advance(9000);
  const retried = rig.registry.begin({
    label: 'ignored retry label',
    cwd: '/different',
    source: 'http',
    conversationId: '  conversation-a  ',
    ttlSeconds: 30,
  });
  assert.strictEqual(retried.session_id, first.session_id, 'same conversation reuses one record');
  assert.strictEqual(retried.conversation_id, 'conversation-a');
  assert.strictEqual(retried.state, 'blocked', 'retry does not reset lifecycle state');
  assert.strictEqual(retried.pal_id, 'owl', 'retry preserves the configured pal');
  assert.strictEqual(retried.summary, 'reviewing changes', 'retry preserves presentation');
  assert.strictEqual(retried.label, 'parent conversation', 'retry does not rewrite record identity');
  assert.strictEqual(retried.source, 'mcp', 'retry preserves original provenance');
  assert.strictEqual(retried.expires_in_seconds, 30, 'retry refreshes the requested lease');
  assert.strictEqual(rig.registry.size, 1, 'a retry cannot create another projected pal');
  assert.strictEqual(
    rig.registry.getByConversationId('conversation-a').session_id,
    first.session_id
  );

  const beforeUsageUpdate = rig.registry.get(first.session_id);
  const withUsage = rig.registry.setUsageByConversationId('conversation-a', {
    api_calls: 3,
    input_tokens: 1200,
    output_tokens: 150,
    cache_read_tokens: 900,
    cache_write_tokens: 80,
    reasoning_tokens: 25,
    total_nano_aiu: 4500,
    updated_at: '2026-09-17T08:00:00.000Z',
    latest_model: 'gpt-test',
    context_used: 42000,
    context_max: 128000,
    models: {
      'gpt-test': {
        api_calls: 3,
        input_tokens: 1200,
        output_tokens: 150,
        cache_read_tokens: 900,
        cache_write_tokens: 80,
        reasoning_tokens: 25,
        total_nano_aiu: 4500,
        updated_at: '2026-09-17T08:00:00.000Z',
      },
    },
  });
  assert.strictEqual(withUsage.usage.output_tokens, 150);
  assert.strictEqual(withUsage.usage.models['gpt-test'].input_tokens, 1200);
  assert.strictEqual(withUsage.usage.latest_model, 'gpt-test');
  assert.strictEqual(withUsage.usage.context_used, 42000);
  assert.strictEqual(withUsage.usage.context_max, 128000);
  assert.strictEqual(
    withUsage.usage.models['gpt-test'].updated_at,
    '2026-09-17T08:00:00.000Z'
  );
  assert.strictEqual(
    withUsage.updated_at,
    beforeUsageUpdate.updated_at,
    'usage telemetry does not renew or re-rank the lifecycle record'
  );
  assert.strictEqual(
    rig.registry.setUsageByConversationId('missing-conversation', { output_tokens: 1 }),
    null,
    'usage for an unregistered conversation is ignored'
  );

  const sibling = rig.registry.begin({
    label: 'another conversation',
    cwd: '/repo',
    conversationId: 'conversation-b',
  });
  assert.notStrictEqual(
    sibling.session_id,
    first.session_id,
    'different conversations in the same cwd remain independent'
  );

  rig.registry.end({ id: first.session_id });
  const nextCycle = rig.registry.begin({
    label: 'same conversation later',
    cwd: '/repo',
    conversationId: 'conversation-a',
  });
  assert.notStrictEqual(
    nextCycle.session_id,
    first.session_id,
    'ending releases the identity for a later conversation lifecycle'
  );
}

// Active-task expiry preserves the stable conversation identity; capacity
// eviction still releases it.
{
  const rig = clockRig({ defaultTtlMs: 5000, maxSessions: 1 });
  const expired = rig.registry.begin({ label: 'old', conversationId: 'conversation-expired' });
  rig.advance(5001);
  const restarted = rig.registry.begin({ label: 'new', conversationId: 'conversation-expired' });
  assert.strictEqual(
    restarted.session_id,
    expired.session_id,
    'an expired task lease returns the same conversation and pal'
  );
  assert.strictEqual(restarted.state, 'idle');

  const evicted = rig.registry.begin({ label: 'other', conversationId: 'conversation-other' });
  assert.strictEqual(rig.registry.get(restarted.session_id), null, 'capacity evicted the older row');
  const returned = rig.registry.begin({ label: 'returning', conversationId: 'conversation-expired' });
  assert.notStrictEqual(returned.session_id, restarted.session_id, 'eviction clears the identity');
  assert.strictEqual(rig.registry.get(evicted.session_id), null);
}

// --- ambient message is task-cycle local -------------------------------------
// `message` describes what the session is doing *right now*. A task that is
// abandoned (a direct active -> idle report) or a new task cycle that reports
// no message of its own must not keep showing the previous task's text.

{
  const { registry } = clockRig();

  // Abandonment: active -> idle without completeTask.
  const abandoned = registry.begin({ label: 'abandoned' });
  registry.update({ id: abandoned.session_id, state: 'working', message: 'compiling' });
  const idled = registry.update({ id: abandoned.session_id, state: 'idle' });
  assert.strictEqual(idled.message, '', 'abandoning a task drops its ambient message');
  assert.strictEqual(idled.task_outcome, null, 'and does not fabricate a completion');

  // The next task inherits nothing.
  const resumed = registry.update({ id: abandoned.session_id, state: 'working' });
  assert.strictEqual(resumed.message, '', 'a new task cycle does not inherit stale text');
  assert.ok(resumed.task_started_at, 'and starts a fresh task');

  // A caller that does supply text still wins.
  const spoken = registry.update({
    id: abandoned.session_id, state: 'thinking', message: 'reading the diff',
  });
  assert.strictEqual(spoken.message, 'reading the diff');
  assert.strictEqual(
    registry.update({ id: abandoned.session_id, state: 'working' }).message,
    'reading the diff',
    'phase changes inside one active cycle keep the ambient message'
  );

  // The same leak through the completeTask path: completion clears the text,
  // and the next cycle must not resurrect it either.
  const completed = registry.begin({ label: 'completed' });
  registry.update({ id: completed.session_id, state: 'working', message: 'linking' });
  assert.strictEqual(registry.completeTask({ id: completed.session_id }).message, '');
  const nextCycle = registry.update({ id: completed.session_id, state: 'working' });
  assert.strictEqual(nextCycle.message, '', 'a new task after completion starts quiet');
  assert.strictEqual(nextCycle.task_outcome, null, 'and clears the previous outcome');

  // Repeated idle reports still preserve the completed-task metadata.
  registry.update({ id: completed.session_id, state: 'waiting', message: 'need input' });
  const done = registry.completeTask({ id: completed.session_id, outcome: 'failed' });
  const repeated = registry.update({ id: completed.session_id, state: 'idle' });
  assert.strictEqual(repeated.task_outcome, 'failed', 'idle repeat keeps the outcome');
  assert.strictEqual(repeated.task_completed_at, done.task_completed_at,
    'and the completion timestamp');
  assert.strictEqual(repeated.message, '', 'while staying quiet');
}

// --- closing-message semantics ----------------------------------------------
// `message` on update() is ambient state text; `message` on end() is a closing
// message. Only the latter may ever be flashed, so end() must never promote the
// retained state text into `closing_message`.

{
  const { registry } = clockRig();

  // end() with no message: nothing to flash, and the stale state text is gone.
  const quiet = registry.begin({ label: 'quiet' });
  registry.update({ id: quiet.session_id, state: 'working', message: 'compiling' });
  const endedQuiet = registry.end({ id: quiet.session_id });
  assert.strictEqual(endedQuiet.closing_message, null, 'no message supplied -> no closing message');
  assert.strictEqual(
    endedQuiet.message,
    '',
    'the in-flight state text must not survive end() as a result'
  );

  // A blank / whitespace-only message is "none supplied", not an empty flash.
  const blank = registry.begin({ label: 'blank' });
  registry.update({ id: blank.session_id, state: 'waiting', message: 'need a decision' });
  assert.strictEqual(registry.end({ id: blank.session_id, message: '   ' }).closing_message, null);

  // An explicit message is preserved on both fields.
  const loud = registry.begin({ label: 'loud' });
  registry.update({ id: loud.session_id, state: 'working', message: 'compiling' });
  const endedLoud = registry.end({ id: loud.session_id, message: 'build broke' });
  assert.strictEqual(endedLoud.closing_message, 'build broke');
  assert.strictEqual(endedLoud.message, 'build broke');
}

// Every documented state and outcome is accepted.
{
  const { registry } = clockRig();
  for (const state of STATES) {
    const s = registry.begin({ label: `s-${state}` });
    assert.strictEqual(registry.update({ id: s.session_id, state }).state, state);
  }
  for (const outcome of OUTCOMES) {
    const s = registry.begin({ label: `o-${outcome}` });
    assert.strictEqual(registry.end({ id: s.session_id, outcome }).outcome, outcome);
  }
  // Omitting the outcome defaults to success.
  const s = registry.begin({ label: 'default outcome' });
  assert.strictEqual(registry.end({ id: s.session_id }).outcome, 'success');
}

// --- validation -------------------------------------------------------------

{
  const { registry } = clockRig();
  throwsCode(() => registry.begin({}), 'invalid_argument', 'begin without a label');
  throwsCode(() => registry.begin({ label: '   ' }), 'invalid_argument', 'begin with a blank label');
  throwsCode(
    () => registry.begin({ label: 'bad conversation', conversationId: '   ' }),
    'invalid_argument',
    'blank conversation id'
  );
  throwsCode(
    () => registry.begin({ label: 'bad conversation', conversationId: 'x'.repeat(129) }),
    'invalid_argument',
    'oversized conversation id'
  );
  throwsCode(
    () => registry.begin({ label: 'bad conversation', conversationId: 42 }),
    'invalid_argument',
    'non-string conversation id'
  );
  throwsCode(() => registry.update({ id: 'nope', state: 'working' }), 'unknown_session', 'update unknown id');
  throwsCode(() => registry.update({ id: '   ', state: 'working' }), 'invalid_argument', 'blank id');
  throwsCode(() => registry.end({ id: 'nope' }), 'unknown_session', 'end unknown id');

  const s = registry.begin({ label: 'validation' });
  throwsCode(() => registry.update({ id: s.session_id, state: 'dancing' }), 'invalid_argument', 'bogus state');
  throwsCode(() => registry.completeTask({ id: s.session_id, outcome: 'maybe' }), 'invalid_argument', 'bogus task outcome');
  assert.strictEqual(
    registry.get(s.session_id).state,
    'working',
    'invalid task completion must not mutate the active task'
  );
  throwsCode(() => registry.end({ id: s.session_id, outcome: 'maybe' }), 'invalid_argument', 'bogus outcome');
  throwsCode(
    () => registry.begin({ label: 'bad ttl', ttlSeconds: 'soon' }),
    'invalid_argument',
    'non-numeric ttl'
  );

  registry.completeTask({ id: s.session_id });
  const repeatedIdle = registry.update({ id: s.session_id, state: 'idle' });
  assert.strictEqual(
    repeatedIdle.task_outcome,
    'success',
    'a repeated idle report preserves the completed-task marker'
  );
  assert.strictEqual(
    registry.completeTask({ id: s.session_id }).task_outcome,
    'success',
    'task completion remains idempotent after a repeated idle report'
  );
  throwsCode(
    () => registry.completeTask({ id: s.session_id, outcome: 'maybe' }),
    'invalid_argument',
    'idempotent retry still validates outcome'
  );
  registry.end({ id: s.session_id });
  throwsCode(() => registry.end({ id: s.session_id }), 'unknown_session', 'double end');
  throwsCode(
    () => registry.update({ id: s.session_id, state: 'working' }),
    'unknown_session',
    'update after end'
  );
}

// TTL is clamped into the configured bounds rather than rejected.
{
  const { registry } = clockRig({ minTtlMs: 5000, maxTtlMs: 60000 });
  assert.strictEqual(registry.begin({ label: 'tiny', ttlSeconds: 1 }).expires_in_seconds, 5);
  assert.strictEqual(registry.begin({ label: 'huge', ttlSeconds: 99999 }).expires_in_seconds, 60);
  assert.strictEqual(registry.begin({ label: 'fine', ttlSeconds: 30 }).expires_in_seconds, 30);
}

// --- active-task expiry -----------------------------------------------------

{
  const rig = clockRig({ defaultTtlMs: 10000 });
  const s = rig.registry.begin({ label: 'leaky agent' });

  rig.advance(9000);
  assert.strictEqual(rig.registry.list().length, 1, 'still alive before the lease lapses');

  // An update renews the lease, so the original deadline no longer applies.
  rig.registry.update({ id: s.session_id, state: 'thinking' });
  rig.advance(9000);
  assert.strictEqual(rig.registry.list().length, 1, 'update should refresh expiry');

  // Go quiet: the active-task lease lapses back to idle, but the conversation
  // identity and configured pal stay registered for the next user request.
  rig.advance(1001);
  const idle = rig.registry.get(s.session_id);
  assert.strictEqual(idle.state, 'idle', 'expired active work falls back to idle');
  assert.strictEqual(idle.expires_at, null, 'idle conversation no longer has an active lease');
  assert.strictEqual(rig.registry.size, 1);
  assert.strictEqual(
    rig.registry.update({ id: s.session_id, state: 'working' }).state,
    'working',
    'the same long-lived session can start another task after an idle gap'
  );
}

// Passive activation uses the actual lease deadline, not the later time when a
// read happens to prune the expired record.
{
  const rig = clockRig({ defaultTtlMs: 100 });
  const session = rig.registry.begin({
    label: 'expiry boundary',
    conversationId: 'expiry-conversation',
  });
  const deadline = Date.parse(session.expires_at);
  rig.advance(200);

  assert.strictEqual(
    rig.registry.activateForUserEdge('expiry-conversation', deadline),
    null,
    'an edge at the lease deadline still belongs to the expired task'
  );
  const reactivated = rig.registry.activateForUserEdge('expiry-conversation', deadline + 50);
  assert.strictEqual(reactivated.state, 'thinking',
    'an edge after expiry starts the next task even when pruning happened later');
  assert.strictEqual(reactivated.session_id, session.session_id);
}

// An ended session lingers just long enough to report its outcome, then goes.
{
  const rig = clockRig({ defaultTtlMs: 90000, endedLingerMs: 5000 });
  const s = rig.registry.begin({ label: 'short-lived' });
  rig.registry.end({ id: s.session_id, outcome: 'aborted' });
  assert.strictEqual(rig.registry.list().length, 1, 'ended session lingers for status readers');
  rig.advance(5001);
  assert.strictEqual(rig.registry.list().length, 0, 'ended session expires after the linger window');
}

// --- capacity pressure ------------------------------------------------------
//
// The eviction policy has to survive an adversarial caller, not just a leaky
// one. Expiry distance is caller-controlled (ttl_seconds), so shedding whatever
// is closest to expiry hands the attacker the lever: max out the lease, go
// quiet, and every legitimate reporter on the default 90s TTL is shed first.
// Least-recently-updated removes that lever — a lease says nothing about
// liveness, only a fresh update does.
{
  const rig = clockRig({ maxSessions: 3 });
  // Two squatters take the longest lease the registry allows, then go silent.
  const squat1 = rig.registry.begin({ label: 'squatter one', ttlSeconds: 3600 });
  rig.advance(1000);
  const squat2 = rig.registry.begin({ label: 'squatter two', ttlSeconds: 3600 });
  rig.advance(1000);
  // A legitimate short-lease session that is actively reporting.
  const worker = rig.registry.begin({ label: 'worker', ttlSeconds: 30 });
  rig.advance(1000);
  rig.registry.update({ id: worker.session_id, state: 'working', message: 'compiling' });
  rig.advance(1000);

  const newcomer = rig.registry.begin({ label: 'newcomer' });

  assert.strictEqual(rig.registry.size, 3, 'registry is still capped');
  assert.strictEqual(
    rig.registry.get(squat1.session_id),
    null,
    'the least-recently-updated record is shed, however long a lease it holds'
  );
  assert.ok(
    rig.registry.get(worker.session_id),
    'an actively-reporting short-lease session must survive a long-lease squatter'
  );
  assert.ok(rig.registry.get(squat2.session_id), 'the next squatter is still in line, not gone');
  assert.ok(rig.registry.get(newcomer.session_id), 'the new session was admitted');

  // Keep reporting and you keep your place: the next eviction takes squatter
  // two, not the worker, because the worker just refreshed.
  rig.advance(1000);
  rig.registry.update({ id: worker.session_id, state: 'working' });
  rig.advance(1000);
  rig.registry.begin({ label: 'another' });
  assert.strictEqual(rig.registry.get(squat2.session_id), null, 'the next-stalest goes next');
  assert.ok(rig.registry.get(worker.session_id), 'the worker held its place by reporting');
}

// Ended records are terminal — they only linger so a status reader can observe
// the outcome — so they are shed ahead of anything live even when a plain
// least-recently-updated ordering would have spared them.
{
  const rig = clockRig({ maxSessions: 2, endedLingerMs: 60000 });
  const done = rig.registry.begin({ label: 'done', ttlSeconds: 600 });
  rig.advance(10);
  const live = rig.registry.begin({ label: 'live', ttlSeconds: 600 });
  rig.advance(10);
  // end() stamps updatedAt, so `done` is now the *most* recently touched record
  // and pure LRU would evict `live` instead.
  rig.registry.end({ id: done.session_id, outcome: 'success' });
  rig.advance(10);

  rig.registry.begin({ label: 'fresh' });
  assert.strictEqual(rig.registry.get(done.session_id), null, 'the ended record is shed first');
  assert.ok(rig.registry.get(live.session_id), 'the live session is kept over a terminal one');
}

// Lowering the cap below the number of records held must converge in one call,
// not leave the registry permanently over its limit.
{
  const rig = clockRig({ maxSessions: 5 });
  for (let i = 0; i < 4; i++) {
    rig.registry.begin({ label: `s${i}` });
    rig.advance(10);
  }
  rig.registry._maxSessions = 2; // as if reconfigured under us
  rig.registry.begin({ label: 'after shrink' });
  assert.strictEqual(rig.registry.size, 2, 'capacity converges to the new cap');
}

// list() is deterministically ordered (oldest first).
{
  const rig = clockRig();
  const a = rig.registry.begin({ label: 'a' });
  rig.advance(10);
  const b = rig.registry.begin({ label: 'b' });
  rig.advance(10);
  const c = rig.registry.begin({ label: 'c' });
  const ids = rig.registry.list().map((s) => s.session_id);
  assert.deepStrictEqual(ids, [a.session_id, b.session_id, c.session_id], 'list order is stable');
}

// --- presentation metadata --------------------------------------------------

{
  assert.strictEqual(normalizeDeviceProjectionMax(undefined), 8);
  assert.strictEqual(normalizeDeviceProjectionMax('garbage'), 8);
  assert.strictEqual(normalizeDeviceProjectionMax(0), 1);
  assert.strictEqual(normalizeDeviceProjectionMax(4.9), 4);
  assert.strictEqual(normalizeDeviceProjectionMax(99), 8);
}

{
  const { registry } = clockRig();
  const s = registry.begin({ label: '  build   the bridge  ', cwd: '/tmp/x', source: 'mcp' });
  assert.ok(isSpecies(s.pal_id), 'begin resolves a catalog pal');
  assert.strictEqual(s.theme_id, DEFAULT_THEME);
  assert.deepStrictEqual(s.palette, {
    body: paletteFor(DEFAULT_THEME).body,
    bg: paletteFor(DEFAULT_THEME).bg,
    text: paletteFor(DEFAULT_THEME).text,
    text_dim: paletteFor(DEFAULT_THEME).textDim,
    ink: paletteFor(DEFAULT_THEME).ink,
  });
  assert.strictEqual(s.summary, 'build the bridge');
  assert.strictEqual(s.assignment, 'derived');
  assert.strictEqual(s.configured_at, null);
}

// The hash is standard FNV-1a over bytes, and collision probing distributes
// automatic assignments without making the 19th concurrent session fail.
{
  assert.strictEqual(fnv1a32('hello'), 0x4f9f2cab, 'FNV-1a matches the standard vector');
  const rig = clockRig({ maxSessions: 32 });
  const first = [];
  for (let i = 0; i < SPECIES.length; i++) {
    first.push(rig.registry.begin({ label: 'same label', cwd: '/same' }).pal_id);
  }
  assert.strictEqual(new Set(first).size, SPECIES.length, 'the first 18 pals are distinct');
  const nineteenth = rig.registry.begin({ label: 'same label', cwd: '/same' });
  assert.ok(isSpecies(nineteenth.pal_id), 'the least-used fallback returns a valid pal');
}

// Explicit choices are soft occupancy: they are avoided while another species
// is free, but never force automatic sessions to duplicate each other early.
{
  const rig = clockRig({ maxSessions: 32 });
  const explicit = rig.registry.begin({ label: 'explicit capybara' });
  rig.registry.configure({ id: explicit.session_id, palId: 'capybara' });
  const automatic = [];
  for (let i = 0; i < SPECIES.length; i++) {
    automatic.push(rig.registry.begin({ label: `automatic-${i}` }).pal_id);
  }
  assert.strictEqual(
    new Set(automatic).size,
    SPECIES.length,
    'one explicit choice must not reduce automatic uniqueness below 18'
  );
}

// If every species is explicitly held, an automatic assignment still succeeds
// and the hash-order tie break remains pure and deterministic.
{
  function assignedPal() {
    const rig = clockRig({ maxSessions: 32 });
    SPECIES.forEach((palId, index) => {
      const session = rig.registry.begin({ label: `explicit-${index}` });
      rig.registry.configure({ id: session.session_id, palId });
    });
    return rig.registry.begin({ label: 'deterministic automatic', cwd: '/repo' }).pal_id;
  }
  assert.strictEqual(assignedPal(), assignedPal());
}

// Assignment is record metadata, not a projection-time choice: lifecycle
// updates, lease renewal, and repeated reads cannot make the animal flap.
{
  const rig = clockRig();
  const begun = rig.registry.begin({ label: 'stable pal', cwd: '/repo' });
  const pal = begun.pal_id;
  rig.advance(1000);
  const updated = rig.registry.update({ id: begun.session_id, state: 'thinking', ttlSeconds: 120 });
  assert.strictEqual(updated.pal_id, pal);
  assert.strictEqual(rig.registry.list()[0].pal_id, pal);
  assert.strictEqual(rig.registry.list()[0].pal_id, pal);
}

// Explicit choices are authoritative, even when two sessions intentionally
// choose the same species. Configuration marks the record as user-controlled
// and leaves provenance untouched.
{
  const rig = clockRig();
  const a = rig.registry.begin({ label: 'a', source: 'http' });
  const b = rig.registry.begin({ label: 'b', source: 'mcp' });
  const configured = rig.registry.configure({
    id: b.session_id,
    palId: a.pal_id,
    themeId: 'cyan',
    colors: paletteFor('green'),
    summary: '  reviewing   APIs  ',
  });
  assert.strictEqual(configured.pal_id, a.pal_id, 'explicit duplicate pal is accepted');
  assert.strictEqual(configured.theme_id, 'cyan', 'theme identity is retained');
  assert.strictEqual(configured.palette.body, paletteFor('green').body, 'colors override theme');
  assert.strictEqual(configured.summary, 'reviewing APIs');
  assert.strictEqual(configured.assignment, 'user');
  assert.ok(configured.configured_at);
  assert.strictEqual(configured.source, 'mcp', 'configure never changes transport provenance');
}

// Null resets each configurable field. Pal re-derivation excludes the record's
// own old assignment, allowing it to reclaim its deterministic candidate.
{
  const rig = clockRig();
  const other = rig.registry.begin({ label: 'other', cwd: '/repo' });
  const begun = rig.registry.begin({ label: 'reset me', cwd: '/repo', source: 'http' });
  const expectedPal = defaultSpeciesFor({
    label: begun.label,
    cwd: begun.cwd,
    automaticTaken: [other.pal_id],
  });
  rig.registry.configure({
    id: begun.session_id,
    palId: 'chonk',
    themeId: 'magenta',
    colors: paletteFor('green'),
    summary: 'custom',
  });
  const reset = rig.registry.configure({
    id: begun.session_id,
    palId: null,
    themeId: null,
    colors: null,
    summary: null,
  });
  assert.strictEqual(reset.pal_id, expectedPal);
  assert.strictEqual(reset.theme_id, DEFAULT_THEME);
  assert.strictEqual(reset.palette.body, paletteFor(DEFAULT_THEME).body);
  assert.strictEqual(reset.summary, begun.label);
  assert.strictEqual(reset.state, 'working');
  assert.strictEqual(reset.source, 'http');
  assert.strictEqual(reset.assignment, 'user');
}

// A cosmetic write updates presentation timestamps but never proves liveness.
{
  const rig = clockRig({ defaultTtlMs: 10000 });
  const begun = rig.registry.begin({ label: 'stale config' });
  const expiry = begun.expires_at;
  rig.advance(9000);
  const configured = rig.registry.configure({ id: begun.session_id, summary: 'almost expired' });
  assert.strictEqual(configured.expires_at, expiry, 'configure must not renew expiresAt');
  rig.advance(1001);
  const idle = rig.registry.get(begun.session_id);
  assert.strictEqual(idle.state, 'idle', 'the original active-task lease still expires');
  assert.strictEqual(idle.summary, 'almost expired', 'idle fallback preserves configured presentation');
}

// Configure validation is coded, complete, and applies before any partial
// mutation. Ended rows are deliberately treated the same as unknown rows.
{
  const { registry } = clockRig();
  throwsCode(() => registry.configure({ id: 'nope', summary: 'x' }), 'unknown_session', 'configure unknown');
  const ended = registry.begin({ label: 'ended' });
  registry.end({ id: ended.session_id });
  throwsCode(
    () => registry.configure({ id: ended.session_id, summary: 'x' }),
    'unknown_session',
    'configure ended'
  );

  const s = registry.begin({ label: 'validate configure' });
  throwsCode(() => registry.configure({ id: s.session_id }), 'invalid_argument', 'configure empty');
  throwsCode(() => registry.configure({ id: s.session_id, palId: 'horse' }), 'invalid_argument', 'bad pal');
  throwsCode(() => registry.configure({ id: s.session_id, themeId: 'blue' }), 'invalid_argument', 'bad theme');
  throwsCode(
    () => registry.configure({ id: s.session_id, colors: { body: 1 } }),
    'invalid_argument',
    'partial palette'
  );
  const valid = paletteFor('cyan');
  throwsCode(
    () => registry.configure({ id: s.session_id, colors: { ...valid, body: 65536 } }),
    'invalid_argument',
    'out-of-range color'
  );
  throwsCode(
    () => registry.configure({ id: s.session_id, colors: { ...valid, body: 1.5 } }),
    'invalid_argument',
    'non-integer color'
  );
  throwsCode(
    () => registry.configure({ id: s.session_id, colors: { ...valid, bg: 1 } }),
    'invalid_argument',
    'non-black background'
  );
  const before = registry.get(s.session_id);
  throwsCode(
    () => registry.configure({ id: s.session_id, palId: 'owl', themeId: 'invalid' }),
    'invalid_argument',
    'atomic configure validation'
  );
  assert.strictEqual(registry.get(s.session_id).pal_id, before.pal_id, 'failed configure is atomic');
}

// Summary normalization collapses whitespace, replaces invalid UTF-16 with
// U+FFFD, and applies one 96-code-point validation contract.
{
  assert.strictEqual(normalizeSummary('  one\n\t two   three  '), 'one two three');
  assert.strictEqual(normalizeSummary('left\ud800right'), 'left\ufffdright');

  const { registry } = clockRig();
  const session = registry.begin({ label: 'summary validation' });
  const accepted = registry.configure({ id: session.session_id, summary: '😀'.repeat(96) });
  assert.strictEqual(Array.from(accepted.summary).length, 96);
  throwsCode(
    () => registry.configure({ id: session.session_id, summary: '😀'.repeat(97) }),
    'invalid_argument',
    '97-code-point summary'
  );
  const scalar = registry.configure({ id: session.session_id, summary: 'left\ud800right' });
  assert.strictEqual(scalar.summary, 'left\ufffdright');
}

// --- projection -------------------------------------------------------------

{
  const rig = clockRig();
  const work = rig.registry.begin({ label: 'worker' });
  const wait = rig.registry.begin({ label: 'waiter' });
  const idle = rig.registry.begin({ label: 'idler' });
  const done = rig.registry.begin({ label: 'finisher' });
  rig.registry.update({ id: wait.session_id, state: 'waiting' });
  rig.registry.update({ id: idle.session_id, state: 'idle' });
  rig.registry.end({ id: done.session_id });

  const p = projectSessions(rig.registry.list());
  assert.strictEqual(p.live, 3, 'ended sessions are not live');
  assert.strictEqual(p.running, 1, 'only thinking/working count as running');
  assert.strictEqual(p.waiting, 1, 'only waiting/blocked count as waiting');
  assert.strictEqual(p.leader.session_id, wait.session_id, 'waiting outranks working');
  assert.strictEqual(p.msg, 'your turn', 'default message for waiting');
  assert.ok(work.session_id && idle.session_id);
}

// --- composition: counts ----------------------------------------------------

{
  const passive = { total: 3, running: 2, waiting: 0, msg: 'working...', entries: ['10:00 hi'] };
  const rig = clockRig();
  const a = rig.registry.begin({ label: 'explicit a' });
  rig.registry.begin({ label: 'explicit b' });
  rig.registry.update({ id: a.session_id, state: 'blocked' });

  const m = composeModel({ passive, sessions: rig.registry.list() });
  // Union by maximum: passive sees 3 sessions, explicit knows about 2 of them.
  assert.strictEqual(m.total, 3, 'total is the max of both sources, not the sum');
  assert.strictEqual(m.running, 2, 'passive running is the floor');
  assert.strictEqual(m.waiting, 1, 'explicit blocked raises waiting above passive 0');
  assert.deepStrictEqual(m.entries, ['10:00 hi'], 'passive transcript is preserved');
}

{
  // Explicit sessions the passive side cannot see raise the counts.
  const rig = clockRig();
  rig.registry.begin({ label: 'one' });
  rig.registry.begin({ label: 'two' });
  rig.registry.begin({ label: 'three' });
  const m = composeModel({
    passive: { total: 0, running: 0, waiting: 0, msg: 'idle', entries: [] },
    sessions: rig.registry.list(),
  });
  assert.strictEqual(m.total, 3);
  assert.strictEqual(m.running, 3);
}

// --- composition: msg priority ---------------------------------------------

{
  const passive = { total: 1, running: 1, waiting: 0, msg: 'passive line', entries: [] };
  const rig = clockRig();
  const s = rig.registry.begin({ label: 'prio' });
  const confirm = { id: 'mcp-1', tool: 'git push', hint: 'origin main' };
  const notice = { text: 'build passed', until: Date.now() + 5000 };

  // 5. passive only
  assert.strictEqual(composeModel({ passive, sessions: [] }).msg, 'passive line');

  // 4. explicit working/thinking beats passive
  rig.registry.update({ id: s.session_id, state: 'thinking' });
  assert.strictEqual(composeModel({ passive, sessions: rig.registry.list() }).msg, 'thinking...');
  rig.registry.update({ id: s.session_id, state: 'working', message: 'compiling' });
  assert.strictEqual(composeModel({ passive, sessions: rig.registry.list() }).msg, 'compiling');

  // 3. explicit waiting/blocked beats working
  const blocker = rig.registry.begin({ label: 'blocker' });
  rig.registry.update({ id: blocker.session_id, state: 'blocked', message: 'needs review' });
  assert.strictEqual(composeModel({ passive, sessions: rig.registry.list() }).msg, 'needs review');

  // 2. a transient notify flash beats ambient state
  assert.strictEqual(
    composeModel({ passive, sessions: rig.registry.list(), notice }).msg,
    'build passed'
  );
  // ...but only while its TTL holds.
  assert.strictEqual(
    composeModel({
      passive,
      sessions: rig.registry.list(),
      notice: { text: 'stale', until: Date.now() - 1 },
    }).msg,
    'needs review',
    'an expired notice falls back to explicit state'
  );

  // 1. an active confirmation outranks everything
  const withConfirm = composeModel({ passive, sessions: rig.registry.list(), notice, confirm });
  assert.strictEqual(withConfirm.msg, MSG_CONFIRM);
  assert.deepStrictEqual(withConfirm.prompt, confirm, 'confirm rides the prompt field');
  assert.ok(withConfirm.waiting >= 1, 'a live confirmation means someone is waiting');
}

// --- composition: counts stay internally consistent -------------------------
// `total` is a session count, so it can never be below running/waiting. The
// confirmation bump used to be able to project `total:0, waiting:1` before the
// first passive tick, which the device cannot render coherently.

{
  const confirm = { id: 'mcp-1', tool: 'deploy', hint: 'prod' };
  const cold = composeModel({ passive: null, sessions: [], confirm });
  assert.strictEqual(cold.waiting, 1, 'a confirmation still means someone is waiting');
  assert.ok(cold.total >= cold.waiting, `total (${cold.total}) must cover waiting (${cold.waiting})`);
  assert.strictEqual(cold.total, 1, 'one thing is waiting, so one thing is in flight');

  // The floor is a max, not a sum: a larger passive total is left untouched.
  const warm = composeModel({
    passive: { total: 5, running: 2, waiting: 1, msg: 'busy', entries: [] },
    sessions: [],
    confirm,
  });
  assert.strictEqual(warm.total, 5, 'the floor never inflates an already-larger total');
  assert.strictEqual(warm.running, 2);
  assert.strictEqual(warm.waiting, 1);
}

// A confirmation outranks a passively-detected Copilot permission prompt.
{
  const passive = {
    total: 1, running: 0, waiting: 1, msg: 'approval waiting', entries: [],
    prompt: { id: 'perm-abc', tool: 'bash', hint: 'rm -rf' },
  };
  assert.strictEqual(composeModel({ passive, sessions: [] }).prompt.id, 'perm-abc');
  const confirm = { id: 'mcp-9', tool: 'deploy', hint: 'prod' };
  assert.strictEqual(composeModel({ passive, sessions: [], confirm }).prompt.id, 'mcp-9');
}

// Explicit active state decays to an idle pal once the lease lapses — the
// device must never be pinned to stale work, but the conversation persists.
{
  const rig = clockRig({ defaultTtlMs: 10000 });
  const passive = { total: 0, running: 0, waiting: 0, msg: 'idle', entries: [] };
  const s = rig.registry.begin({ label: 'crashed agent' });
  rig.registry.update({ id: s.session_id, state: 'working', message: 'long job' });

  assert.strictEqual(composeModel({ passive, sessions: rig.registry.list() }).msg, 'long job');
  rig.advance(10001);
  const after = composeModel({ passive, sessions: rig.registry.list() });
  assert.strictEqual(after.msg, 'idle', 'expired explicit state falls back to passive');
  assert.strictEqual(after.running, 0);
  assert.strictEqual(after.total, 1, 'the idle conversation remains projected');
}

// Passive telemetry extras ride through untouched (firmware compatibility).
{
  const passive = {
    total: 1, running: 1, waiting: 0, msg: 'working...', entries: [],
    tokens: 1234, tokensUsed: 50, tokensMax: 100, model: 'claude-sonnet-4.5', effort: 'medium',
    completed: true,
  };
  const m = composeModel({ passive, sessions: [] });
  assert.strictEqual(m.tokens, 1234);
  assert.strictEqual(m.tokensUsed, 50);
  assert.strictEqual(m.tokensMax, 100);
  assert.strictEqual(m.model, 'claude-sonnet-4.5');
  assert.strictEqual(m.effort, 'medium');
  assert.strictEqual(m.completed, true);
}

// No passive model yet (before the first source tick) still composes cleanly.
{
  const rig = clockRig();
  rig.registry.begin({ label: 'first' });
  const m = composeModel({ passive: null, sessions: rig.registry.list() });
  assert.strictEqual(m.total, 1);
  assert.strictEqual(m.running, 1);
  assert.strictEqual(m.msg, 'working...');
}

// --- bridge-level: task completion versus conversation retirement -----------
// The registry semantics above only matter if the bridge honours them, so these
// drive a real Bridge over a fake device and assert on the composed snapshot.

async function withBridge(fn) {
  const transport = new FakeDeviceTransport({ autoAnswer: false });
  const bridge = new Bridge(transport, cfg);
  bridge.start();
  transport.start();
  await sleep(20); // let the fake device "connect"
  bridge.setModel({ total: 0, running: 0, waiting: 0, msg: 'idle', entries: [] });
  try {
    await fn(bridge, transport);
  } finally {
    bridge.stop();
    await transport.stop();
  }
}

// A session that ends without a closing message must fall back immediately.
// Re-flashing its last state text pins the device to stale activity for the
// whole notify TTL, long after the session is gone.
async function testEndWithoutMessageFallsBack() {
  await withBridge(async (bridge) => {
    const s = bridge.beginSession({ label: 'builder' });
    bridge.updateSession({ id: s.session_id, state: 'working', message: 'compiling' });
    assert.strictEqual(bridge.status.msg, 'compiling', 'the live state is shown while it runs');

    bridge.endSession({ id: s.session_id });
    assert.strictEqual(
      bridge.status.msg,
      'idle',
      'ending without a message falls straight back to passive state'
    );
    assert.strictEqual(bridge.status.running, 0, 'the ended session stops counting immediately');

    // ...and it stays fallen back; nothing is queued to flash later.
    await sleep(30);
    assert.strictEqual(bridge.status.msg, 'idle', 'no delayed flash of the stale message');
  });
}

async function testTaskCompletionKeepsTheSessionAndEndDoesNotCelebrate() {
  await withBridge(async (bridge, transport) => {
    transport.emit('line', {
      ack: 'status', ok: true, data: { name: 'test-device', cl: 1 },
    });
    const session = bridge.beginSession({ label: 'long conversation' });
    const completed = bridge.completeTask({ id: session.session_id, outcome: 'success' });
    assert.strictEqual(completed.state, 'idle', 'task completion leaves the session alive');
    assert.strictEqual(bridge.registry.get(session.session_id).state, 'idle');
    assert.ok(bridge.status.sc, 'task completion creates the completion card');
    const generation = bridge.status.sc.g;

    bridge.updateSession({ id: session.session_id, state: 'working', message: 'next request' });
    assert.ok(!bridge.status.sc, 'the next task clears the previous completion');
    bridge.endSession({ id: session.session_id, outcome: 'success' });
    assert.ok(!bridge.status.sc, 'ending the conversation itself does not celebrate');
    assert.strictEqual(
      bridge.completionLatch.current,
      null,
      `session end must not create a generation after task generation ${generation}`
    );
  });
}

// The masking case: a silent end must not bury another session that is blocked
// and actually needs the human.
async function testEndWithoutMessageDoesNotMaskLiveSession() {
  await withBridge(async (bridge) => {
    const worker = bridge.beginSession({ label: 'worker' });
    const blocked = bridge.beginSession({ label: 'reviewer' });
    bridge.updateSession({ id: worker.session_id, state: 'working', message: 'compiling' });
    bridge.updateSession({ id: blocked.session_id, state: 'blocked', message: 'need a decision' });
    assert.strictEqual(bridge.status.msg, 'need a decision', 'blocked outranks working');

    bridge.endSession({ id: worker.session_id });
    assert.strictEqual(
      bridge.status.msg,
      'need a decision',
      'the finished session must not re-flash "compiling" over a blocked session'
    );
    assert.strictEqual(bridge.status.waiting, 1, 'the blocked session is still waiting');

    await sleep(30);
    assert.strictEqual(bridge.status.msg, 'need a decision', 'and it stays visible');
  });
}

// An explicitly supplied closing message is still flashed — that is the whole
// point of the parameter, and the fix must not regress it.
async function testExplicitClosingMessageStillFlashes() {
  await withBridge(async (bridge) => {
    const s = bridge.beginSession({ label: 'builder' });
    bridge.updateSession({ id: s.session_id, state: 'working', message: 'compiling' });

    const ended = bridge.endSession({ id: s.session_id, outcome: 'failed', message: 'build broke' });
    assert.strictEqual(ended.closing_message, 'build broke');
    assert.strictEqual(bridge.status.msg, 'build broke', 'the closing message is flashed');

    // A blank closing message is "none supplied", not an empty flash.
    const t = bridge.beginSession({ label: 'quiet' });
    bridge.updateSession({ id: t.session_id, state: 'working', message: 'linking' });
    bridge.endSession({ id: t.session_id, message: '  ' });
    assert.notStrictEqual(bridge.status.msg, 'linking', 'a blank message flashes nothing stale');
  });
}

async function main() {
  await testTaskCompletionKeepsTheSessionAndEndDoesNotCelebrate();
  await testEndWithoutMessageFallsBack();
  await testEndWithoutMessageDoesNotMaskLiveSession();
  await testExplicitClosingMessageStillFlashes();
  console.log(
    'PASS: session registry task cycles, idle fallback, conversation retirement, ' +
      'closing-message semantics, and state composition'
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('FAIL:', err.stack || err.message);
    process.exit(1);
  });

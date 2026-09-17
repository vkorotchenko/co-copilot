'use strict';

const assert = require('assert');

process.env.COMPANION_LOG = process.env.COMPANION_LOG || 'error';

const { applyLegacyJson } = require('./snapshot-backcompat');
const {
  buildSnapshot,
  enforceBudget,
  serialize,
  serializedBytes,
  shapeSessionRows,
  INTERNAL_TARGET,
  HARD_CEILING,
  MSG_MAX,
  ENTRY_MAX,
  ENTRIES_MAX,
  MODEL_MAX,
  EFFORT_MAX,
  PROMPT_ID_MAX,
  PROMPT_TOOL_MAX,
  PROMPT_HINT_MAX,
} = require('../src/protocol/snapshot');

const NO_LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function sessionRow(index, summary) {
  return {
    session_id: `budget-session-${index}`,
    pal_id: 'chonk',
    palette: { body: 0xffff, bg: 0x0000, text: 0xffff, text_dim: 0xffff, ink: 0xffff },
    state: 'blocked',
    summary,
  };
}

function maximumModel(entry, summary) {
  return {
    total: 255,
    running: 255,
    waiting: 255,
    completed: true,
    msg: 'M'.repeat(MSG_MAX),
    entries: Array(ENTRIES_MAX).fill(entry),
    tokens: 0xffffffff,
    tokensToday: 0xffffffff,
    tokensUsed: 0xffffffff,
    tokensMax: 0xffffffff,
    model: 'D'.repeat(MODEL_MAX),
    effort: 'E'.repeat(EFFORT_MAX),
    prompt: {
      id: 'I'.repeat(PROMPT_ID_MAX),
      tool: 'T'.repeat(PROMPT_TOOL_MAX),
      hint: 'H'.repeat(PROMPT_HINT_MAX),
    },
    sessionRows: Array.from({ length: 8 }, (_, index) => sessionRow(index, summary)),
  };
}

function assertValidLine(snapshot, label) {
  const line = serialize(snapshot);
  assert.ok(line.endsWith('\n'), `${label}: line must be newline terminated`);
  assert.ok(serializedBytes(snapshot) <= HARD_CEILING, `${label}: hard ceiling exceeded`);
  assert.strictEqual(Buffer.from(line, 'utf8').toString('utf8'), line, `${label}: invalid UTF-8`);
  const parsed = JSON.parse(line);
  const visit = (value) => {
    if (typeof value === 'string') {
      assert.ok(!NO_LONE_SURROGATE.test(value), `${label}: lone surrogate survived`);
    } else if (Array.isArray(value)) {
      value.forEach(visit);
    } else if (value && typeof value === 'object') {
      Object.values(value).forEach(visit);
    }
  };
  visit(parsed);
  return parsed;
}

// Ordinary ASCII maximum. The proposal's arithmetic estimated ~2,702 bytes;
// the real compact JSON produced by the approved key set is 2,670 bytes.
const ordinary = buildSnapshot(maximumModel('L'.repeat(ENTRY_MAX), 'S'.repeat(48)));
const ordinaryBytes = serializedBytes(ordinary);
assert.strictEqual(ordinaryBytes, 2670, 'ordinary maximum changed; re-evaluate the wire budget');
assert.ok(ordinaryBytes <= INTERNAL_TARGET);
assert.strictEqual(ordinary.ss.length, 8);
assertValidLine(ordinary, 'ordinary maximum');

// Escaped worst case: quotes and backslashes double, controls become six-byte
// escapes, and astral/CJK text consumes multiple UTF-8 bytes. The final object
// must remain complete JSON; degradation, never raw string truncation, makes it
// fit. Tail-first entry trimming is visible in the surviving array.
const hostile = '"\\\u0001😀漢';
const escapedInput = maximumModel(hostile.repeat(40), hostile.repeat(20));
const initialEscaped = {
  total: 255,
  running: 255,
  waiting: 255,
  completed: true,
  msg: escapedInput.msg,
  entries: escapedInput.entries.map((entry) => entry.slice(0, ENTRY_MAX)),
  tokens: 0xffffffff,
  tokens_today: 0xffffffff,
  tokens_used: 0xffffffff,
  tokens_max: 0xffffffff,
  model: escapedInput.model,
  effort: escapedInput.effort,
  prompt: escapedInput.prompt,
  sv: 1,
  ss: shapeSessionRows(escapedInput.sessionRows),
};
assert.ok(serializedBytes(initialEscaped) > HARD_CEILING, 'hostile pre-degradation case must overflow');
const escaped = buildSnapshot(escapedInput);
const escapedBytes = serializedBytes(escaped);
assert.strictEqual(escapedBytes, 2999, 'escaped case should deterministically fill the target');
const escapedParsed = assertValidLine(escaped, 'escaped maximum');
for (const key of ['total', 'running', 'waiting', 'msg', 'prompt']) {
  assert.ok(Object.prototype.hasOwnProperty.call(escapedParsed, key), `escaped: core ${key} missing`);
}
assert.ok(!escaped.ss, 'session rows shed before legacy telemetry');
assert.ok(escaped.entries[0].length > escaped.entries[escaped.entries.length - 1].length);

// Exercise the complete degradation ladder on a deliberately pre-shaped
// candidate. Production buildSnapshot() bounds these fields first, but keeping
// enforceBudget() correct for any candidate makes the post-condition local and
// testable instead of relying on upstream assumptions.
{
  const candidate = {
    total: 1,
    running: 1,
    waiting: 1,
    completed: true,
    msg: 'm'.repeat(5000),
    entries: ['a'.repeat(1000), 'b'.repeat(1000)],
    tokens: 1,
    tokens_today: 2,
    tokens_used: 3,
    tokens_max: 4,
    model: 'x'.repeat(5000),
    effort: 'y'.repeat(5000),
    prompt: { id: 'p'.repeat(1000), tool: 't'.repeat(1000), hint: 'h'.repeat(1000) },
    sv: 1,
    ss: [
      {
        i: '000000000001', p: 0, c: [0, 0, 0, 0, 0], s: 0, m: 'z'.repeat(1000),
        u: 2, q: 3, d: 'gpt-test', v: 1, x: [4, 5],
      },
      {
        i: '000000000002', p: 0, c: [0, 0, 0, 0, 0], s: 0, m: 'z'.repeat(1000),
        u: 2, q: 3, d: 'gpt-test', v: 1, x: [4, 5],
      },
    ],
  };
  const labels = [];
  enforceBudget(candidate, (label) => {
    if (labels[labels.length - 1] !== label) labels.push(label);
  });
  assert.deepStrictEqual(labels, [
    'omit-session-context',
    'omit-session-stats',
    'omit-session-usage',
    'ss-tail',
    'entries-tail',
    'omit-entries',
    'omit-token-counters',
    'omit-model',
    'omit-effort',
    'omit-completed',
    'core-msg',
    'core-hint',
  ]);
  assert.ok(!candidate.ss && !candidate.sv);
  assert.ok(!Object.prototype.hasOwnProperty.call(candidate, 'entries'));
  assert.ok(!Object.prototype.hasOwnProperty.call(candidate, 'tokens'));
  assert.ok(!Object.prototype.hasOwnProperty.call(candidate, 'model'));
  assert.ok(!Object.prototype.hasOwnProperty.call(candidate, 'effort'));
  assert.ok(!Object.prototype.hasOwnProperty.call(candidate, 'completed'));
  for (const key of ['total', 'running', 'waiting', 'msg', 'prompt']) {
    assert.ok(Object.prototype.hasOwnProperty.call(candidate, key), `ladder: core ${key} missing`);
  }
  assertValidLine(candidate, 'complete degradation ladder');
}

// Legacy-only overflow still degrades after discovering there are no session
// rows to drop. Old firmware ignores nothing essential and reconstructs a
// coherent aggregate TamaState from the final line.
{
  const legacyModel = maximumModel(hostile.repeat(40), 'unused');
  delete legacyModel.sessionRows;
  const legacy = buildSnapshot(legacyModel);
  assert.ok(!legacy.ss && !legacy.sv);
  assert.ok(serializedBytes(legacy) <= INTERNAL_TARGET);
  for (const key of ['total', 'running', 'waiting', 'msg', 'prompt']) {
    assert.ok(Object.prototype.hasOwnProperty.call(legacy, key), `legacy overflow: core ${key} missing`);
  }
  const state = applyLegacyJson(serialize(legacy), {});
  assert.strictEqual(state.sessionsTotal, 255);
  assert.strictEqual(state.sessionsRunning, 255);
  assert.strictEqual(state.sessionsWaiting, 255);
  assert.strictEqual(state.msg.toString('utf8'), 'M'.repeat(MSG_MAX));
  assert.strictEqual(state.promptId.toString('utf8'), 'I'.repeat(PROMPT_ID_MAX));
  assertValidLine(legacy, 'legacy-only overflow');
}

// A spread of hostile scalar boundaries and escape patterns must always return
// parseable, valid UTF-8 JSON without lone surrogates.
{
  const adversarial = [
    '\uD800'.repeat(200),
    '\uDC00'.repeat(200),
    '"'.repeat(500),
    '\\'.repeat(500),
    '\u0001'.repeat(500),
    '😀漢字"\\\u0002'.repeat(100),
  ];
  for (let i = 0; i < adversarial.length; i++) {
    const model = maximumModel(adversarial[i], adversarial[i]);
    model.msg = adversarial[i];
    model.prompt = { id: adversarial[i], tool: adversarial[i], hint: adversarial[i] };
    assertValidLine(buildSnapshot(model), `adversarial ${i}`);
  }
}

console.log(
  `PASS: snapshot budget ordinary=${ordinaryBytes}, escaped-worst=${escapedBytes} non-newline bytes`
);

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

process.env.COMPANION_LOG = process.env.COMPANION_LOG || 'error';

const { buildSnapshot, serialize } = require('../src/protocol/snapshot');

const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'legacy-snapshots.json');

function fixtureModels() {
  const promptId = 'permission-request-id-that-is-deliberately-longer-than-thirty-nine-characters';
  return [
    { name: 'empty', model: { total: 0, running: 0, waiting: 0, completed: false, msg: 'idle', entries: [] } },
    { name: 'idle_one_session', model: { total: 1, running: 0, waiting: 0, completed: false, msg: 'idle', entries: [] } },
    { name: 'busy_counts', model: { total: 7, running: 4, waiting: 2, completed: true, msg: 'working...', entries: [] } },
    {
      name: 'with_entries',
      model: {
        total: 2, running: 1, waiting: 0, completed: false, msg: 'reading transcript',
        entries: ['short entry', 'E'.repeat(159), 'O'.repeat(175), 'final entry'],
      },
    },
    {
      name: 'with_telemetry',
      model: {
        total: 3, running: 2, waiting: 1, completed: false, msg: 'measuring tokens', entries: [],
        tokens: 123456789, tokensToday: 987654321, tokensUsed: 654321, tokensMax: 1048576,
        model: 'claude-opus-4.8-long-model-name', effort: 'extra-high-effort',
      },
    },
    {
      name: 'with_prompt',
      expected_to_change: true,
      change_note: 'prompt.id will gain a 39-character clamp per the approved session-pals proposal.',
      model: {
        total: 2, running: 1, waiting: 1, completed: true, msg: 'confirm on device',
        entries: ['13:00 awaiting approval'], tokens: 42, tokensToday: 84, tokensUsed: 21,
        tokensMax: 128, model: 'test-model', effort: 'medium',
        prompt: {
          id: promptId,
          tool: 'dangerously-long-tool-name',
          hint: 'Approve this deliberately overlong permission hint for the compatibility fixture',
        },
      },
    },
    {
      name: 'msg_overlong',
      model: {
        total: 1, running: 0, waiting: 1, completed: false,
        msg: 'this message is definitely longer than twenty-three characters', entries: [],
      },
    },
    {
      name: 'clamp_extremes',
      model: {
        total: 9999, running: 512, waiting: 256, completed: true, msg: 'extremes', entries: [],
        tokens: 0x1ffffffff, tokensToday: Number.MAX_SAFE_INTEGER,
        tokensUsed: 0x100000000, tokensMax: 0x200000000,
      },
    },
    {
      name: 'unicode_and_escapes',
      model: {
        total: 2, running: 1, waiting: 1, completed: false,
        msg: 'say "hi" \\ ctrl:\u0001 😀 漢字 tail',
        entries: [
          'quote: "double"', 'backslash: \\ path \\ file', 'control:\u0002 end',
          'emoji: 😀😢🚀', 'CJK: 你好世界 漢字',
        ],
      },
    },
  ];
}

function loadFixtures() {
  return JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
}

function fixedBytes(value, maxBytes) {
  return Buffer.from(String(value == null ? '' : value), 'utf8').subarray(0, maxBytes);
}

function uint(doc, key, current, max) {
  const value = doc[key];
  if (!Number.isFinite(value)) return current;
  const n = Math.trunc(value);
  return n < 0 || n > max ? current : n;
}

function prepareState(state) {
  const out = state || {};
  for (const key of ['sessionsTotal', 'sessionsRunning', 'sessionsWaiting', 'tokens', 'tokensToday', 'tokensUsed', 'tokensMax', 'nLines', 'lineGen']) {
    if (!Number.isInteger(out[key])) out[key] = 0;
  }
  if (typeof out.recentlyCompleted !== 'boolean') out.recentlyCompleted = false;
  for (const key of ['msg', 'model', 'effort', 'promptId', 'promptTool', 'promptHint']) {
    if (!Buffer.isBuffer(out[key])) out[key] = Buffer.alloc(0);
  }
  if (!Array.isArray(out.lines)) out.lines = [];
  return out;
}

// Mirrors firmware/src/data.h::_applyJson(): recognized legacy keys mutate the
// fixed-width state, while unknown fields are ignored by ArduinoJson.
function applyLegacyJson(line, state) {
  const doc = JSON.parse(line);
  const out = prepareState(state);
  out.sessionsTotal = uint(doc, 'total', out.sessionsTotal, 0xff);
  out.sessionsRunning = uint(doc, 'running', out.sessionsRunning, 0xff);
  out.sessionsWaiting = uint(doc, 'waiting', out.sessionsWaiting, 0xff);
  out.recentlyCompleted = typeof doc.completed === 'boolean' ? doc.completed : false;
  out.tokens = uint(doc, 'tokens', out.tokens, 0xffffffff);
  out.tokensToday = uint(doc, 'tokens_today', out.tokensToday, 0xffffffff);
  out.tokensUsed = uint(doc, 'tokens_used', out.tokensUsed, 0xffffffff);
  out.tokensMax = uint(doc, 'tokens_max', out.tokensMax, 0xffffffff);
  if (typeof doc.msg === 'string') out.msg = fixedBytes(doc.msg, 23);
  if (typeof doc.model === 'string') out.model = fixedBytes(doc.model, 23);
  if (typeof doc.effort === 'string') out.effort = fixedBytes(doc.effort, 9);
  if (Array.isArray(doc.entries)) {
    const lines = doc.entries.slice(0, 8).map((entry) => fixedBytes(typeof entry === 'string' ? entry : '', 159));
    if (lines.length !== out.nLines || (lines.length > 0 && !lines[lines.length - 1].equals(out.msg))) out.lineGen++;
    out.lines = lines;
    out.nLines = lines.length;
  }
  if (doc.prompt && typeof doc.prompt === 'object' && !Array.isArray(doc.prompt)) {
    out.promptId = fixedBytes(typeof doc.prompt.id === 'string' ? doc.prompt.id : '', 39);
    out.promptTool = fixedBytes(typeof doc.prompt.tool === 'string' ? doc.prompt.tool : '', 19);
    out.promptHint = fixedBytes(typeof doc.prompt.hint === 'string' ? doc.prompt.hint : '', 43);
  } else {
    out.promptId = Buffer.alloc(0);
    out.promptTool = Buffer.alloc(0);
    out.promptHint = Buffer.alloc(0);
  }
  return out;
}

function withoutPromptId(value) {
  const copy = JSON.parse(JSON.stringify(value));
  if (copy.prompt) delete copy.prompt.id;
  return copy;
}

function run() {
  const fixtures = loadFixtures();
  for (const fixture of fixtures.cases) {
    const actualSnapshot = buildSnapshot(fixture.model);
    if (!fixture.expected_to_change) {
      assert.deepStrictEqual(actualSnapshot, fixture.snapshot, `${fixture.name}: legacy snapshot changed`);
      assert.strictEqual(serialize(actualSnapshot), fixture.serialized, `${fixture.name}: serialized legacy line changed`);
      continue;
    }
    // The approved proposal changes only prompt.id here: today it is copied
    // verbatim, while the new implementation may clamp it to 39 characters.
    assert.deepStrictEqual(withoutPromptId(actualSnapshot), withoutPromptId(fixture.snapshot), `${fixture.name}: a legacy field other than prompt.id changed`);
    const originalId = fixture.snapshot.prompt.id;
    assert.ok(
      actualSnapshot.prompt.id === originalId || actualSnapshot.prompt.id === originalId.slice(0, 39),
      `${fixture.name}: prompt.id must be legacy-unclamped or the approved 39-character prefix`
    );
  }

  const legacy = fixtures.cases.find((fixture) => fixture.name === 'with_prompt');
  assert.ok(legacy, 'with_prompt fixture is required for old-firmware simulation');
  const expectedState = {
    sessionsTotal: 2, sessionsRunning: 1, sessionsWaiting: 1, recentlyCompleted: true,
    tokens: 42, tokensToday: 84, tokensUsed: 21, tokensMax: 128,
    msg: fixedBytes('confirm on device', 23), model: fixedBytes('test-model', 23),
    effort: fixedBytes('medium', 9), lines: [fixedBytes('13:00 awaiting approval', 159)],
    nLines: 1, lineGen: 1, promptId: fixedBytes(legacy.model.prompt.id, 39),
    promptTool: fixedBytes(legacy.model.prompt.tool, 19), promptHint: fixedBytes(legacy.model.prompt.hint, 43),
  };
  const legacyState = applyLegacyJson(legacy.serialized, {});
  assert.deepStrictEqual(legacyState, expectedState, 'legacy line should populate the firmware state');

  const extended = JSON.parse(legacy.serialized);
  extended.sv = 1;
  extended.ss = [{ i: '0123456789ab', p: 7, c: [2047, 0, 65535, 33808, 0], s: 4, m: 'waiting' }];
  extended.future_flag = true;
  extended.junk = { nested: ['ignored', 123] };
  const extendedState = applyLegacyJson(`${JSON.stringify(extended)}\n`, {});
  assert.deepStrictEqual(extendedState, legacyState, 'old firmware must ignore additive and unknown top-level fields byte-for-byte');

  let maxObserved = 0;
  for (const fixture of fixtures.cases) {
    assert.ok(fixture.byte_length_no_newline <= 4095, `${fixture.name}: ${fixture.byte_length_no_newline} bytes exceeds the firmware line ceiling`);
    maxObserved = Math.max(maxObserved, fixture.byte_length_no_newline);
  }
  console.log(`PASS: legacy snapshots are backward compatible; max fixture is ${maxObserved} non-newline bytes`);
}

if (require.main === module) run();

module.exports = { applyLegacyJson, loadFixtures };

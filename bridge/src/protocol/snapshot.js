'use strict';

const crypto = require('crypto');
const { speciesIndex } = require('../sessions/species');
const { scalarValues } = require('../sessions/summary');

// Builds the newline-delimited heartbeat object parsed by firmware. The legacy
// aggregate fields remain mandatory; `sv`/`ss` are additive and disappear
// completely when no live rows survive projection or budgeting.

// Firmware fixed-width contracts. These remain character caps for legacy
// compatibility; scalar-safe clamping prevents JavaScript from cutting an
// astral character into a lone UTF-16 surrogate. The serialized whole-line
// guard below is authoritative when escaping makes those characters consume
// more wire bytes than their source representation suggests.
const MSG_MAX = 23;
const ENTRY_MAX = 159;
const ENTRIES_MAX = 8;
const MODEL_MAX = 23;
const EFFORT_MAX = 9;
const PROMPT_ID_MAX = 39;
const PROMPT_TOOL_MAX = 19;
const PROMPT_HINT_MAX = 43;

const SESSION_SCHEMA_VERSION = 1;
const SUMMARY_MAX_BYTES = 48;
const INTERNAL_TARGET = 3000;
const HARD_CEILING = 4095;
const DISPLAY_ID_HEX_LENGTH = 12;
const DISPLAY_ID_COLLISION_LIMIT = 65536;
const SESSION_MODEL_MAX = 23;

// This is the firmware enum, not the ranking table. Ranking is intentionally
// the inverse priority (blocked first) and lives in sessions/compose.js; sharing
// the two tables would encode the right state but sort the roster backwards.
const SESSION_STATE_CODES = Object.freeze({
  idle: 0,
  thinking: 1,
  working: 2,
  waiting: 3,
  blocked: 4,
});

function byteLen(str) {
  return Buffer.byteLength(String(str), 'utf8');
}

function clamp(str, max) {
  let out = '';
  let units = 0;
  for (const point of scalarValues(str)) {
    if (units + point.length > max) break;
    out += point;
    units += point.length;
  }
  return out;
}

function clampBytes(str, maxBytes) {
  let out = '';
  let used = 0;
  for (const point of scalarValues(str)) {
    const size = byteLen(point);
    if (used + size > maxBytes) break;
    out += point;
    used += size;
  }
  return out;
}

function defaultDisplayHash(value) {
  return crypto.createHash('sha256')
    .update(String(value))
    .digest('hex')
    .slice(0, DISPLAY_ID_HEX_LENGTH);
}

// A 48-bit hash collision is unlikely, but the display identity is also the
// firmware's selection key. Treating "unlikely" as "impossible" could make two
// visible sessions indistinguishable and cause carousel selection to jump. We
// therefore detect duplicates inside the selected set and deterministically
// rehash the colliding full id with a counter suffix until it is unique.
function displayIdsFor(rows, hash = defaultDisplayHash) {
  const used = new Set();
  const resolved = new Array(rows.length);
  const ordered = rows
    .map((row, index) => ({ id: String(row.session_id || ''), index }))
    .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : a.index - b.index);

  for (const row of ordered) {
    for (let counter = 0; counter < DISPLAY_ID_COLLISION_LIMIT; counter++) {
      const input = counter === 0 ? row.id : `${row.id}\0${counter}`;
      const candidate = String(hash(input)).slice(0, DISPLAY_ID_HEX_LENGTH).toLowerCase();
      if (!/^[0-9a-f]{12}$/.test(candidate)) {
        throw new Error('Display identity hash must return at least 12 hexadecimal characters.');
      }
      if (!used.has(candidate)) {
        used.add(candidate);
        resolved[row.index] = candidate;
        break;
      }
    }
    if (!resolved[row.index]) {
      throw new Error('Unable to derive a unique 48-bit display identity.');
    }
  }
  return resolved;
}

function shapeSessionRows(rows = [], hash) {
  const ids = displayIdsFor(rows, hash);
  return rows.map((row, index) => {
    const shaped = {
      i: ids[index],
      p: clampInt(speciesIndex(row.pal_id), 17),
      c: [
        clampInt(row.palette && row.palette.body, 0xffff),
        clampInt(row.palette && row.palette.bg, 0xffff),
        clampInt(row.palette && row.palette.text, 0xffff),
        clampInt(row.palette && row.palette.text_dim, 0xffff),
        clampInt(row.palette && row.palette.ink, 0xffff),
      ],
      s: SESSION_STATE_CODES[row.state],
      m: clampBytes(row.summary, SUMMARY_MAX_BYTES),
    };
    if (row.usage && Number.isFinite(row.usage.output_tokens)) {
      // UINT32_MAX is the firmware's "usage unknown" sentinel.
      shaped.u = clampInt(row.usage.output_tokens, 0xfffffffe);
    }
    if (row.usage && Number.isFinite(row.usage.input_tokens)) {
      shaped.q = clampInt(row.usage.input_tokens, 0xfffffffe);
    }
    if (row.usage && row.usage.latest_model) {
      shaped.d = clamp(row.usage.latest_model, SESSION_MODEL_MAX);
    }
    if (row.usage && row.usage.models && typeof row.usage.models === 'object') {
      shaped.v = clampInt(Object.keys(row.usage.models).length);
    }
    if (
      row.usage &&
      Number.isFinite(row.usage.context_used) &&
      Number.isFinite(row.usage.context_max) &&
      row.usage.context_used >= 0 &&
      row.usage.context_max > 0 &&
      row.usage.context_used <= row.usage.context_max
    ) {
      shaped.x = [
        clampInt(row.usage.context_used, 0xfffffffe),
        clampInt(row.usage.context_max, 0xfffffffe),
      ];
    }
    return shaped;
  });
}

function buildSnapshot(model) {
  const snap = {
    total: clampInt(model.total),
    running: clampInt(model.running),
    waiting: clampInt(model.waiting),
    completed: !!model.completed,
    msg: clamp(model.msg, MSG_MAX),
    entries: (model.entries || [])
      .slice(0, ENTRIES_MAX)
      .map((entry) => clamp(entry, ENTRY_MAX)),
  };
  if (Number.isFinite(model.tokens)) snap.tokens = clampInt(model.tokens, 0xffffffff);
  if (Number.isFinite(model.tokensToday)) {
    snap.tokens_today = clampInt(model.tokensToday, 0xffffffff);
  }
  if (Number.isFinite(model.tokensUsed)) {
    snap.tokens_used = clampInt(model.tokensUsed, 0xffffffff);
  }
  if (Number.isFinite(model.tokensMax)) {
    snap.tokens_max = clampInt(model.tokensMax, 0xffffffff);
  }
  if (model.model) snap.model = clamp(model.model, MODEL_MAX);
  if (model.effort) snap.effort = clamp(model.effort, EFFORT_MAX);
  if (model.prompt && model.prompt.id) {
    snap.prompt = {
      id: clamp(model.prompt.id, PROMPT_ID_MAX),
      tool: clamp(model.prompt.tool, PROMPT_TOOL_MAX),
      hint: clamp(model.prompt.hint, PROMPT_HINT_MAX),
    };
  }

  const sessionRows = shapeSessionRows(model.sessionRows || []);
  if (sessionRows.length > 0) {
    snap.sv = SESSION_SCHEMA_VERSION;
    snap.ss = sessionRows;
  }

  if (Number.isInteger(model.completionEpoch) && model.completionEpoch > 0) {
    snap.sg = model.completionEpoch >>> 0;
    if (model.completion) snap.sc = shapeCompletion(model.completion);
  }

  return enforceBudget(snap);
}

function shapeCompletion(completion) {
  const out = {
    g: clampUint32(completion.g),
    o: clampInt(completion.o, 2),
  };
  const metadata = ['i', 'p', 'c', 'm'];
  const identity = String(completion.i || '');
  const colors = completion.c;
  const validIdentity = /^[0-9a-f]{12}$/.test(identity);
  if (metadata.every((key) => Object.prototype.hasOwnProperty.call(completion, key)) &&
      validIdentity && Array.isArray(colors) && colors.length === 5) {
    out.i = identity;
    out.p = clampInt(completion.p, 17);
    out.c = colors.map((value) => clampInt(value, 0xffff));
    out.m = clampBytes(completion.m, SUMMARY_MAX_BYTES);
  }
  if (Number.isFinite(completion.d)) out.d = clampUint32(completion.d);
  return out;
}

function clampInt(n, max = 255) {
  n = Math.trunc(Number(n) || 0);
  if (n < 0) n = 0;
  if (n > max) n = max;
  return n;
}

function clampUint32(n) {
  return clampInt(n, 0xffffffff) >>> 0;
}

// serialize() appends exactly one ASCII newline byte. Firmware's _LineBuf<4096>
// limit concerns the bytes before that delimiter, hence the deliberate -1.
function serializedBytes(snapshot) {
  return byteLen(serialize(snapshot)) - 1;
}

function withinTarget(snapshot) {
  return serializedBytes(snapshot) <= INTERNAL_TARGET;
}

function omitSessionFields(snapshot, fields, label, onStep) {
  if (!Array.isArray(snapshot.ss)) return;
  let changed = false;
  for (const row of snapshot.ss) {
    for (const field of fields) {
      if (!Object.prototype.hasOwnProperty.call(row, field)) continue;
      delete row[field];
      changed = true;
    }
  }
  if (changed) onStep(label, snapshot);
}

function dropSessionTail(snapshot, onStep) {
  while (!withinTarget(snapshot) && snapshot.ss && snapshot.ss.length > 0) {
    snapshot.ss.pop();
    if (snapshot.ss.length === 0) {
      delete snapshot.ss;
      delete snapshot.sv;
    }
    onStep('ss-tail', snapshot);
  }
}

function truncateEntryTail(snapshot, onStep) {
  if (!Array.isArray(snapshot.entries)) return;
  for (let i = snapshot.entries.length - 1; i >= 0 && !withinTarget(snapshot); i--) {
    let points = scalarValues(snapshot.entries[i]);
    while (points.length > 0 && !withinTarget(snapshot)) {
      points.pop();
      snapshot.entries[i] = points.join('');
      onStep('entries-tail', snapshot);
    }
  }
}

function omitOptionalTelemetry(snapshot, onStep) {
  const groups = [
    ['entries'],
    ['sc.d'],
    ['sc.pal'],
    ['tokens', 'tokens_today', 'tokens_used', 'tokens_max'],
    ['model'],
    ['effort'],
    ['completed'],
  ];
  for (const keys of groups) {
    if (withinTarget(snapshot)) break;
    if (keys[0] === 'sc.d') {
      if (!snapshot.sc || !Object.prototype.hasOwnProperty.call(snapshot.sc, 'd')) continue;
      delete snapshot.sc.d;
      onStep('omit-sc-duration', snapshot);
    } else if (keys[0] === 'sc.pal') {
      if (!snapshot.sc || !Object.prototype.hasOwnProperty.call(snapshot.sc, 'i')) continue;
      for (const key of ['i', 'p', 'c', 'm']) delete snapshot.sc[key];
      onStep('omit-sc-pal', snapshot);
    } else {
      for (const key of keys) delete snapshot[key];
      onStep(keys.length === 1 ? `omit-${keys[0]}` : 'omit-token-counters', snapshot);
    }
  }
}

function clampCoreStrings(snapshot, onStep) {
  const fields = [
    [snapshot, 'msg'],
    [snapshot.prompt, 'hint'],
    [snapshot.prompt, 'tool'],
    [snapshot.prompt, 'id'],
  ];
  for (const [owner, key] of fields) {
    if (!owner || typeof owner[key] !== 'string') continue;
    let points = scalarValues(owner[key]);
    while (points.length > 0 && !withinTarget(snapshot)) {
      points.pop();
      owner[key] = points.join('');
      onStep(`core-${key}`, snapshot);
    }
    if (withinTarget(snapshot)) return;
  }
}

function enforceBudget(snapshot, trace) {
  if (withinTarget(snapshot)) return snapshot;

  // Every mutation below is followed by a complete remeasurement. Estimating
  // field sizes is unsafe because JSON escaping can turn one source character
  // into two or six wire bytes, and because legacy fields share the same line.
  const onStep = typeof trace === 'function' ? trace : () => {};
  omitSessionFields(snapshot, ['x'], 'omit-session-context', onStep);
  omitSessionFields(snapshot, ['d', 'v', 'q'], 'omit-session-stats', onStep);
  omitSessionFields(snapshot, ['u'], 'omit-session-usage', onStep);
  dropSessionTail(snapshot, onStep);
  truncateEntryTail(snapshot, onStep);
  omitOptionalTelemetry(snapshot, onStep);
  clampCoreStrings(snapshot, onStep);

  const finalBytes = serializedBytes(snapshot);
  if (finalBytes > HARD_CEILING) {
    throw new Error(`Snapshot exceeds firmware hard ceiling: ${finalBytes} bytes.`);
  }
  return snapshot;
}

// Serialize to a single newline-terminated line. The firmware only parses
// lines whose first byte is '{', so a compact object is exactly right.
function serialize(obj) {
  return JSON.stringify(obj) + '\n';
}

// Cheap structural equality so we only push when something actually changed.
function equal(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

module.exports = {
  buildSnapshot,
  serialize,
  equal,
  clampBytes,
  byteLen,
  displayIdsFor,
  shapeSessionRows,
  serializedBytes,
  enforceBudget,
  INTERNAL_TARGET,
  HARD_CEILING,
  SESSION_SCHEMA_VERSION,
  SUMMARY_MAX_BYTES,
  SESSION_STATE_CODES,
  MSG_MAX,
  ENTRY_MAX,
  ENTRIES_MAX,
  MODEL_MAX,
  EFFORT_MAX,
  PROMPT_ID_MAX,
  PROMPT_TOOL_MAX,
  PROMPT_HINT_MAX,
  SESSION_MODEL_MAX,
  shapeCompletion,
};

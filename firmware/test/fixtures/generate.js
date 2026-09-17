'use strict';

// Regenerates firmware/test/fixtures/session-lines.json from the *real* bridge
// projection pipeline, so the firmware parser is tested against bytes the
// bridge actually emits rather than a hand-written approximation.
//
//   node firmware/test/fixtures/generate.js
//
// Checked in on purpose: the C++ host test must run without Node, and a
// regenerated diff is the early-warning signal for catalog or schema drift.

const fs = require('fs');
const path = require('path');

const bridge = path.join(__dirname, '..', '..', '..', 'bridge', 'src');
const { composeModel } = require(path.join(bridge, 'sessions', 'compose'));
const { buildSnapshot, serialize } = require(path.join(bridge, 'protocol', 'snapshot'));
const { SPECIES } = require(path.join(bridge, 'sessions', 'species'));

const PALETTE = { body: 0x07ff, bg: 0x0000, text: 0xffff, text_dim: 0x8410, ink: 0x0000 };

function session(n, over = {}) {
  const t = Date.UTC(2026, 0, 1, 12, 0, n);
  return {
    session_id: `cs-${String(n).padStart(16, '0')}`,
    state: 'working',
    created_at: new Date(t).toISOString(),
    updated_at: new Date(t).toISOString(),
    pal_id: SPECIES[n % SPECIES.length],
    palette: { ...PALETTE },
    summary: `session ${n} doing work`,
    ...over,
  };
}

function build(sessions) {
  const model = composeModel({ passive: null, sessions });
  const snap = buildSnapshot(model);
  return { line: serialize(snap), snap };
}

// The expectation mirrors what the firmware parser must produce. It is derived
// from the serialized snapshot itself, so it can never drift from the bytes.
function expectationOf(snap) {
  if (!snap.ss) return { version: 0, count: 0, pals: [] };
  return {
    version: snap.sv,
    count: snap.ss.length,
    pals: snap.ss.map((r) => ({
      id: r.i,
      species: r.p,
      state: r.s,
      colors: r.c,
      summary: r.m,
      output_tokens: Object.prototype.hasOwnProperty.call(r, 'u') ? r.u : null,
      input_tokens: Object.prototype.hasOwnProperty.call(r, 'q') ? r.q : null,
      model: Object.prototype.hasOwnProperty.call(r, 'd') ? r.d : null,
      model_count: Object.prototype.hasOwnProperty.call(r, 'v') ? r.v : null,
      context: Object.prototype.hasOwnProperty.call(r, 'x') ? r.x : null,
    })),
  };
}

const cases = [];
function add(name, sessions, note) {
  const { line, snap } = build(sessions);
  cases.push({ name, note, line, expect: expectationOf(snap) });
}

add('legacy-no-sessions', [], 'no explicit sessions: sv/ss absent entirely');
add(
  'single-working',
  [session(1, {
    usage: {
      input_tokens: 654321,
      output_tokens: 123456,
      latest_model: 'gpt-5.6-sol',
      models: { 'gpt-5.6-sol': {} },
      context_used: 42000,
      context_max: 128000,
    },
  })],
  'one session with full official stats and no carousel chrome on device',
);
add(
  'eight-max',
  Array.from({ length: 8 }, (_, i) => session(i + 1)),
  'exactly the device projection cap',
);
add(
  'nine-truncated',
  Array.from({ length: 9 }, (_, i) => session(i + 1)),
  'bridge drops the lowest-ranked row; device still sees 8',
);
add(
  'ranking-blocked-first',
  [
    session(1, { state: 'idle' }),
    session(2, { state: 'blocked' }),
    session(3, { state: 'waiting' }),
    session(4, { state: 'thinking' }),
    session(5, { state: 'working' }),
  ],
  'ranking is the inverse of the numeric state codes',
);
add(
  'utf8-summary',
  [session(1, { summary: 'héllo wörld ✅ ünïcode padding text that runs long' })],
  '48-byte UTF-8 clamp must not split a code point',
);
add(
  'ended-excluded',
  [session(1), session(2, { state: 'ended' })],
  'ended rows never reach the wire',
);

const out = {
  generated_by: 'firmware/test/fixtures/generate.js',
  species: SPECIES,
  cases,
};
const dest = path.join(__dirname, 'session-lines.json');
fs.writeFileSync(dest, `${JSON.stringify(out, null, 2)}\n`);
console.log(`wrote ${dest} (${cases.length} cases)`);

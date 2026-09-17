'use strict';

// Unit tests for parseUtc() and the HH:MM transcript prefix it feeds.
//
// Regression: the session store switched from SQLite's `datetime('now')` text
// ('2026-09-16 21:08:56') to JavaScript ISO-8601 ('2026-09-16T21:08:56.212Z').
// The old parser did `new Date(ts.replace(' ', 'T') + 'Z')`, which turns an
// already-ISO value into '...212ZZ' -> Invalid Date. Every transcript line then
// lost its clock prefix and every completion edge carried at:0.

const assert = require('assert');
const { parseUtc } = require('../src/copilot/store');
const { formatEntry } = require('../src/copilot/source');

const ISO_MS = Date.UTC(2026, 8, 16, 21, 8, 56, 212); // 2026-09-16T21:08:56.212Z

// --- current CLI format ------------------------------------------------------
assert.strictEqual(
  parseUtc('2026-09-16T21:08:56.212Z').getTime(), ISO_MS,
  'ISO-8601 with T, milliseconds and Z must parse (this is the live format)'
);
assert.strictEqual(
  parseUtc('2026-09-16T21:08:56Z').getTime(), ISO_MS - 212,
  'ISO-8601 without milliseconds must parse'
);
assert.strictEqual(
  parseUtc('2026-09-16t21:08:56.212z').getTime(), ISO_MS,
  'lowercase t/z separators must parse'
);

// --- legacy SQLite datetime('now') text -------------------------------------
assert.strictEqual(
  parseUtc('2026-09-16 21:08:56').getTime(), ISO_MS - 212,
  "legacy 'YYYY-MM-DD HH:MM:SS' is UTC and must still parse"
);
assert.strictEqual(
  parseUtc('2026-09-16 21:08:56.212').getTime(), ISO_MS,
  'legacy space format with milliseconds must parse'
);
assert.strictEqual(
  parseUtc('2026-09-16T21:08:56.212').getTime(), ISO_MS,
  'a zone-less ISO value is interpreted as UTC, matching the store contract'
);
assert.strictEqual(
  parseUtc('2026-09-16').getTime(), Date.UTC(2026, 8, 16),
  'a date-only value is midnight UTC'
);

// --- explicit offsets --------------------------------------------------------
assert.strictEqual(
  parseUtc('2026-09-16T14:08:56.212-07:00').getTime(), ISO_MS,
  'an explicit negative offset must normalize to the same instant'
);
assert.strictEqual(
  parseUtc('2026-09-16T14:08:56.212-0700').getTime(), ISO_MS,
  'a compact (no colon) offset must parse too'
);
assert.strictEqual(
  parseUtc('2026-09-17T02:38:56.212+05:30').getTime(), ISO_MS,
  'a positive half-hour offset must parse'
);
assert.strictEqual(
  parseUtc('2026-09-30T23:00:00-07:00').getTime(), Date.UTC(2026, 9, 1, 6),
  'an offset that crosses a month boundary is valid, not a rollover to reject'
);

// --- Date / numeric passthrough ---------------------------------------------
const asDate = new Date(ISO_MS);
assert.strictEqual(parseUtc(asDate), asDate, 'a valid Date passes through unchanged');
assert.strictEqual(parseUtc(new Date('nope')), null, 'an Invalid Date is rejected');
assert.strictEqual(parseUtc(ISO_MS).getTime(), ISO_MS, 'a finite number is epoch milliseconds');

// --- garbage -----------------------------------------------------------------
for (const bad of [
  null, undefined, '', '   ', 'not-a-date', 'yesterday', '2026', '2026-09',
  '16/09/2026', '2026-13-01T00:00:00Z', '2026-02-30T00:00:00Z',
  '2026-09-16T25:00:00Z', '2026-09-16T21:60:00Z', '2026-09-16T21:08:61Z',
  '2026-09-16T21:08:56.212ZZ', '2026-09-16T21:08:56.212Z trailing',
  NaN, Infinity, {}, [], true,
]) {
  assert.strictEqual(
    parseUtc(bad), null, `garbage must be rejected, not silently coerced: ${String(bad)}`
  );
}

// The exact string the old implementation produced from a current timestamp.
// Keeping it in the reject list documents the bug that made every entry
// timeless.
assert.strictEqual(parseUtc('2026-09-16T21:08:56.212Z'.replace(' ', 'T') + 'Z'), null);

// --- formatted HH:MM output --------------------------------------------------
// The device shows wall-clock time, so the prefix is local. Compute the
// expectation the same way rather than hard-coding a timezone.
function localHhmm(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

const isoEntry = formatEntry({
  time: parseUtc('2026-09-16T21:08:56.212Z'),
  userMessage: 'i plugged in the hardware',
  repository: '', cwd: '',
});
assert.strictEqual(
  isoEntry, `${localHhmm(ISO_MS)} i plugged in the hardware`,
  'an ISO timestamp must produce an HH:MM-prefixed entry'
);

const legacyEntry = formatEntry({
  time: parseUtc('2026-09-16 21:08:56'),
  userMessage: 'test',
  repository: '', cwd: '',
});
assert.strictEqual(
  legacyEntry, `${localHhmm(ISO_MS - 212)} test`,
  'a legacy timestamp must produce the same HH:MM prefix'
);

// An unparseable timestamp degrades to a prefix-less entry rather than "NaN:NaN".
assert.strictEqual(
  formatEntry({ time: parseUtc('garbage'), userMessage: 'still shown', repository: '', cwd: '' }),
  'still shown',
  'an unusable timestamp drops the prefix instead of rendering NaN'
);

// Injected wrappers are still stripped, and a pure-wrapper turn collapses away.
assert.strictEqual(
  formatEntry({
    time: parseUtc('2026-09-16T21:08:56.212Z'),
    userMessage: '<current_datetime>2026-09-16T14:08:56-07:00</current_datetime>\nrun the build',
    repository: '', cwd: '',
  }),
  `${localHhmm(ISO_MS)} run the build`
);
assert.strictEqual(
  formatEntry({
    time: parseUtc('2026-09-16T21:08:56.212Z'),
    userMessage: '<system_reminder>only noise</system_reminder>',
    repository: '', cwd: '/work/co-mpanion',
  }),
  `${localHhmm(ISO_MS)} (co-mpanion)`,
  'a pure-wrapper turn falls back to the repo/cwd label'
);

console.log('PASS: parseUtc accepts current/legacy/offset timestamps, rejects garbage, and HH:MM renders');

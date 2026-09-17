'use strict';

const crypto = require('crypto');
const { speciesIndex } = require('./species');
const { scalarValues, normalizeSummary } = require('./summary');

const UINT32_MAX = 0xffffffff;
const FIRST_GENERATION = 1;
const SUMMARY_MAX_BYTES = 48;
const OUTCOME_CODES = Object.freeze({ success: 0, failed: 1, aborted: 2 });

function secureUint32() {
  return crypto.randomBytes(4).readUInt32BE(0);
}

function nonzeroEpoch(randomUint32, previous = 0) {
  for (let attempts = 0; attempts < 1024; attempts++) {
    const value = Number(randomUint32()) >>> 0;
    if (value !== 0 && value !== previous) return value;
  }
  throw new Error('Unable to generate a nonzero completion epoch.');
}

function clampBytes(value, maxBytes) {
  let out = '';
  let used = 0;
  for (const point of scalarValues(normalizeSummary(value))) {
    const bytes = Buffer.byteLength(point, 'utf8');
    if (used + bytes > maxBytes) break;
    out += point;
    used += bytes;
  }
  return out;
}

function displayIdentity(sessionId) {
  return crypto.createHash('sha256').update(String(sessionId || '')).digest('hex').slice(0, 12);
}

function completedPal(record) {
  if (!record || !record.session_id || !record.palette) return null;
  const p = speciesIndex(record.pal_id);
  const c = [
    record.palette.body,
    record.palette.bg,
    record.palette.text,
    record.palette.text_dim,
    record.palette.ink,
  ];
  if (p < 0 || c.some((value) => !Number.isInteger(value) || value < 0 || value > 0xffff)) {
    return null;
  }
  return {
    i: displayIdentity(record.session_id),
    p,
    c,
    m: clampBytes(record.summary || record.label || '', SUMMARY_MAX_BYTES),
  };
}

function isUint32(value) {
  return Number.isInteger(value) && value >= 0 && value <= UINT32_MAX;
}

class CompletionLatch {
  constructor({ now = () => Date.now(), randomUint32 = secureUint32 } = {}) {
    this._now = now;
    this._randomUint32 = randomUint32;
    this._epoch = nonzeroEpoch(randomUint32);
    this._generation = 0;
    this._current = null;
  }

  get epoch() {
    return this._epoch;
  }

  get current() {
    if (!this._current) return null;
    return {
      ...this._current,
      pal: this._current.pal && {
        ...this._current.pal,
        c: [...this._current.pal.c],
      },
    };
  }

  completeExplicit(record, outcome = 'success') {
    const started = Date.parse(
      record && (record.task_started_at || record.created_at)
    );
    const duration = Number.isFinite(started)
      ? Math.max(0, Math.floor((this._now() - started) / 1000))
      : null;
    return this._replace({ outcome, duration, pal: completedPal(record), owner: record.session_id });
  }

  completePassive({ outcome = 'success' } = {}) {
    return this._replace({ outcome, duration: null, pal: null, owner: null });
  }

  clear() {
    const had = this._current !== null;
    this._current = null;
    return had;
  }

  dismiss({ sg, g } = {}) {
    if (!this._current) return false;
    if (!isUint32(sg) || !isUint32(g)) return false;
    if (sg !== this._epoch || g !== this._current.g) return false;
    this._current = null;
    return true;
  }

  wire() {
    if (!this._current) return null;
    const out = { g: this._current.g, o: this._current.o };
    if (this._current.pal) Object.assign(out, this._current.pal);
    if (this._current.d != null) out.d = this._current.d;
    return out;
  }

  _replace({ outcome, duration, pal, owner }) {
    const o = OUTCOME_CODES[outcome];
    if (o === undefined) throw new Error(`Unsupported completion outcome: ${outcome}`);
    if (this._generation === UINT32_MAX) {
      this._epoch = nonzeroEpoch(this._randomUint32, this._epoch);
      this._generation = 0;
    }
    this._generation++;
    this._current = {
      g: this._generation >>> 0,
      o,
      d: Number.isFinite(duration) ? Math.min(UINT32_MAX, Math.trunc(duration)) : null,
      pal,
      owner: owner || null,
      completedAt: this._now(),
    };
    return this.current;
  }
}

module.exports = {
  CompletionLatch,
  OUTCOME_CODES,
  FIRST_GENERATION,
  UINT32_MAX,
  SUMMARY_MAX_BYTES,
  completedPal,
  displayIdentity,
};

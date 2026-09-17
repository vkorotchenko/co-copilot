'use strict';

const SUMMARY_MAX = 96;

// JavaScript strings may contain isolated UTF-16 surrogates even though they
// are not Unicode scalar values. Replace them explicitly with U+FFFD before
// counting or storing text so every transport, JSON serialization, and UTF-8
// projection observes the same valid string.
function scalarValues(value) {
  const str = String(value == null ? '' : value);
  const out = [];
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = str.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        out.push(str.slice(i, i + 2));
        i++;
      } else {
        out.push('\ufffd');
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      out.push('\ufffd');
    } else {
      out.push(str[i]);
    }
  }
  return out;
}

function normalizeSummary(value) {
  return scalarValues(value).join('').replace(/\s+/g, ' ').trim();
}

function validateSummary(value) {
  if (typeof value !== 'string') {
    return { ok: false, reason: 'summary must be a string or null.' };
  }
  const normalized = normalizeSummary(value);
  if (scalarValues(normalized).length > SUMMARY_MAX) {
    return {
      ok: false,
      reason: `summary must contain at most ${SUMMARY_MAX} Unicode code points, or null.`,
    };
  }
  return { ok: true, value: normalized };
}


module.exports = { SUMMARY_MAX, scalarValues, normalizeSummary, validateSummary };

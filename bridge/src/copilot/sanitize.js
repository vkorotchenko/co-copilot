'use strict';

// Shared text sanitizers for anything that becomes device transcript text.
//
// Two sources feed the transcript now — the session store's completed
// `turns.user_message` and the live `user.message` event in
// session-state/<id>/events.jsonl — and both carry the same CLI/harness
// injections. Keeping the sanitizers here means the provisional (live) prompt
// and the persisted (completed) row are normalized identically, which is what
// makes the de-duplication in copilot/source.js a plain string comparison.

// Hard ceiling applied before any regex work so a pathological prompt (a pasted
// file, a giant tool dump) can never turn transcript formatting into an
// unbounded scan. The device only renders ~150 characters anyway; this is just
// the safety valve.
const MAX_SANITIZE_INPUT = 16 * 1024;

// The CLI/harness injects wrappers into a user message — <system_reminder>
// blocks (custom instructions, todo status, sql tables...) and <current_datetime>
// stamps — that aren't anything the user typed. Strip them so the device
// transcript shows the real prompt; a message that is *only* injected content
// collapses to empty and is dropped by the caller.
function stripInjected(s) {
  if (!s) return '';
  return clampInput(s)
    // Paired blocks anywhere in the message.
    .replace(/<system[_-]?reminder>[\s\S]*?<\/system[_-]?reminder>/gi, ' ')
    .replace(/<current_datetime>[\s\S]*?<\/current_datetime>/gi, ' ')
    // An unclosed block appended to the end (no closing tag before EOF).
    .replace(/<system[_-]?reminder>[\s\S]*$/i, ' ')
    .replace(/<current_datetime>[\s\S]*$/i, ' ');
}

// Collapse a multi-line message into one whitespace-normalized string.
function flatten(s) {
  if (!s) return '';
  return clampInput(s).replace(/\s+/g, ' ').trim();
}

// stripInjected + flatten, optionally truncated. This is the canonical form
// both transcript sources are reduced to before they are compared or rendered.
function promptText(s, maxChars = 0) {
  const out = flatten(stripInjected(s));
  if (maxChars > 0 && out.length > maxChars) return out.slice(0, maxChars);
  return out;
}

function clampInput(s) {
  const str = String(s);
  return str.length > MAX_SANITIZE_INPUT ? str.slice(0, MAX_SANITIZE_INPUT) : str;
}

module.exports = { stripInjected, flatten, promptText, MAX_SANITIZE_INPUT };

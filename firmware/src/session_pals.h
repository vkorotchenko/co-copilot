#pragma once
#include <stdint.h>
#include <string.h>
#include <stddef.h>
#include <stdio.h>
#include <ArduinoJson.h>
#include "utf8_clamp.h"

// ---------------------------------------------------------------------------
// Per-session pal projection (wire schema `sv:1` / `ss`).
//
// This header is deliberately free of Arduino/M5 dependencies so the parser,
// the UTF-8 clamps, the selection tracker, and the text wrapper can be compiled
// and exercised on the host (see firmware/test/). data.h owns the storage,
// main.cpp owns the pixels; everything decision-shaped lives here.
//
// Contract (REFERENCE.md "Session projection"):
//   sv : integer schema version, currently 1. Absent => no projection.
//   ss : ranked array of at most 8 live rows, already ordered by the bridge
//        (blocked, waiting, working, thinking, idle). Firmware never re-ranks.
//   row.i : exactly 12 lowercase hex chars (48-bit display identity)
//   row.p : species index 0..17 into SPECIES_TABLE
//   row.c : exactly five uint16 RGB565 values [body, bg, text, textDim, ink]
//   row.s : state code 0..4
//   row.m : valid UTF-8 summary, at most 48 encoded bytes
//   row.u : optional cumulative output tokens for this Copilot session
//   row.q : optional cumulative input tokens for this Copilot session
//   row.d : optional most recently used model, at most 23 characters
//   row.v : optional count of models used by the session
//   row.x : optional [used,max] context-window tokens when attribution is safe
// ---------------------------------------------------------------------------

static const uint8_t MAX_SESSION_PALS       = 8;
static const uint8_t SESSION_ID_LEN         = 12;
static const uint8_t SESSION_SUMMARY_BYTES  = 48;
static const uint8_t SESSION_SCHEMA_VERSION = 1;
static const uint8_t SESSION_SPECIES_MAX    = 17;   // inclusive
static const uint8_t SESSION_STATE_MAX      = 4;    // inclusive
static const uint8_t SESSION_MODEL_BYTES    = 23;
static const uint32_t SESSION_USAGE_UNKNOWN = UINT32_MAX;
static const uint16_t SESSION_TOKENS_PER_HEART = 100;
static const uint8_t MAX_SESSION_HEART_AWARDS = 8;

// Wire state codes. The ranking order is the inverse (4 ranks first).
enum {
  SESS_IDLE     = 0,
  SESS_THINKING = 1,
  SESS_WORKING  = 2,
  SESS_WAITING  = 3,
  SESS_BLOCKED  = 4,
};

// Mirrors PersonaState in main.cpp / the B_* enum in buddy.cpp.
enum {
  SESS_PERSONA_SLEEP = 0,
  SESS_PERSONA_IDLE,
  SESS_PERSONA_BUSY,
  SESS_PERSONA_ATTENTION,
};

struct SessionPal {
  char     id[SESSION_ID_LEN + 1];
  uint8_t  species;
  uint8_t  state;
  uint16_t colors[5];                              // body, bg, text, textDim, ink
  char     summary[SESSION_SUMMARY_BYTES + 1];
  char     model[SESSION_MODEL_BYTES + 1];
  uint32_t outputTokens;                           // UINT32_MAX = unavailable
  uint32_t inputTokens;                            // UINT32_MAX = unavailable
  uint32_t contextUsed;                            // UINT32_MAX = unavailable
  uint32_t contextMax;                             // UINT32_MAX = unavailable
  uint8_t  modelCount;
};

struct SessionPalSet {
  uint8_t    version;                              // 0 = no projection present
  uint8_t    count;                                // 0..MAX_SESSION_PALS
  SessionPal pals[MAX_SESSION_PALS];
};

struct SessionHeartAward {
  char     id[SESSION_ID_LEN + 1];
  uint16_t remaining;
};

struct SessionHeartQueue {
  uint8_t count;
  SessionHeartAward awards[MAX_SESSION_HEART_AWARDS];
};

struct SessionHeartProgress {
  char     id[SESSION_ID_LEN + 1];
  uint32_t lastTokens;
  uint8_t  remainder;
};

struct SessionHeartTracker {
  uint8_t count;
  SessionHeartProgress progress[MAX_SESSION_PALS];
};

// Flatten a stored UTF-8 summary into a single-byte display string. The M5GFX
// built-in font has no multibyte glyphs, so each non-ASCII code point collapses
// to one '?'. Collapsing per code point (not per byte) is what keeps the column
// arithmetic in sessionWrap() honest — byte length is not display width.
// Control characters become spaces. Returns the display length.
inline size_t sessionSummaryDisplay(const char* src, char* dst, size_t cap) {
  if (cap == 0) return 0;
  dst[0] = 0;
  if (!src || cap == 1) return 0;
  size_t len = strlen(src);
  size_t in = 0, out = 0;
  const uint8_t* p = (const uint8_t*)src;
  while (in < len && out < cap - 1) {
    uint32_t cp = 0;
    uint8_t  n  = sessionUtf8Decode(p + in, len - in, &cp);
    if (n == 0) break;
    in += n;
    char ch;
    if (cp == '\t' || cp == '\n' || cp == '\r') ch = ' ';
    else if (cp < 0x20 || cp == 0x7F)           ch = ' ';
    else if (cp < 0x80)                         ch = (char)cp;
    else                                        ch = '?';
    dst[out++] = ch;
  }
  dst[out] = 0;
  return out;
}

// ──────────────── text layout ────────────────

// Greedy word wrap into a caller-owned row buffer. `stride` is the byte size of
// one row (including its NUL); `width` is the usable column count. Words longer
// than `width` are hard-broken instead of clipped. Returns the number of rows
// written. When the text does not fit in `maxRows`, the final row is ellipsised
// with ".." so the user can tell the summary continued.
inline uint8_t sessionWrap(const char* text, char* rows, uint8_t maxRows,
                           uint8_t stride, uint8_t width) {
  if (!rows || maxRows == 0 || stride == 0) return 0;
  if (width > stride - 1) width = (uint8_t)(stride - 1);
  for (uint8_t r = 0; r < maxRows; r++) rows[r * stride] = 0;
  if (!text || !*text || width == 0) return 0;

  size_t len = strlen(text);
  size_t i = 0;
  uint8_t row = 0;
  while (i < len && row < maxRows) {
    while (i < len && text[i] == ' ') i++;          // skip leading blanks
    if (i >= len) break;
    size_t take = len - i;
    if (take > width) {
      // Prefer the last space inside the window; hard-break if there is none.
      size_t brk = 0;
      for (size_t k = 0; k <= width && i + k < len; k++) {
        if (text[i + k] == ' ') brk = k;
      }
      take = brk ? brk : width;
    }
    char* dst = rows + row * stride;
    memcpy(dst, text + i, take);
    dst[take] = 0;
    i += take;
    row++;
  }
  // Mark truncation on the last emitted row.
  while (i < len && text[i] == ' ') i++;
  if (i < len && row > 0) {
    char* last = rows + (row - 1) * stride;
    size_t n = strlen(last);
    if (n >= 2 && width >= 2) {
      size_t at = (n + 2 <= width) ? n : (size_t)(width - 2);
      last[at] = '.'; last[at + 1] = '.'; last[at + 2] = 0;
    }
  }
  return row;
}

// ──────────────── parsing ────────────────

inline void sessionPalsClear(SessionPalSet& set) {
  set.version = 0;
  set.count   = 0;
}

static const uint8_t SESSION_DEMO_SCENARIOS = 6;
static const uint8_t SESSION_DEMO_PALS = 5;
static const uint8_t SESSION_DEMO_ASSERTIVE = 5;

// Stable synthetic projection used by the on-device demo. IDs and roster order
// never change, so the real selection tracker and encoder path can be exercised
// exactly as they are with bridge-projected sessions.
inline void sessionPalsDemoApply(uint8_t scenario, SessionPalSet& set) {
  static const char* const ids[SESSION_DEMO_PALS] = {
    "000000000001", "000000000002", "000000000003",
    "000000000004", "000000000005",
  };
  static const uint8_t species[SESSION_DEMO_PALS] = { 10, 6, 1, 7, 14 };
  static const uint16_t colors[SESSION_DEMO_PALS][5] = {
    { 48465, 0, 65535, 33808, 0 },
    { 2047, 0, 65535, 33808, 0 },
    { 65504, 0, 65535, 33808, 0 },
    { 31727, 0, 65535, 33808, 0 },
    { 64495, 0, 65535, 33808, 0 },
  };
  static const char* const summaries[SESSION_DEMO_PALS] = {
    "Reviewing a pull request",
    "Planning the architecture",
    "Running firmware tests",
    "Waiting for your approval",
    "Build needs attention",
  };
  static const char* const models[SESSION_DEMO_PALS] = {
    "gpt-5.6-sol", "gpt-5.6-sol", "claude-haiku-4.5",
    "gpt-5.4", "claude-opus-5",
  };
  static const uint32_t outputTokens[SESSION_DEMO_PALS] = {
    12450, 28720, 6350, 9100, 48100,
  };
  static const uint32_t inputTokens[SESSION_DEMO_PALS] = {
    86400, 142800, 41900, 53700, 310500,
  };
  static const uint8_t modelCounts[SESSION_DEMO_PALS] = { 1, 2, 1, 1, 3 };
  static const uint8_t states[SESSION_DEMO_SCENARIOS][SESSION_DEMO_PALS] = {
    { SESS_IDLE,     SESS_IDLE,    SESS_IDLE,    SESS_IDLE,    SESS_IDLE },
    { SESS_THINKING, SESS_IDLE,    SESS_IDLE,    SESS_IDLE,    SESS_IDLE },
    { SESS_WORKING,  SESS_WORKING, SESS_WORKING, SESS_IDLE,    SESS_IDLE },
    { SESS_WORKING,  SESS_IDLE,    SESS_IDLE,    SESS_WAITING, SESS_BLOCKED },
    { SESS_IDLE,     SESS_IDLE,    SESS_IDLE,    SESS_IDLE,    SESS_IDLE },
    { SESS_IDLE,     SESS_IDLE,    SESS_IDLE,    SESS_IDLE,    SESS_IDLE },
  };

  scenario %= SESSION_DEMO_SCENARIOS;
  memset(&set, 0, sizeof(set));
  set.version = SESSION_SCHEMA_VERSION;
  set.count = SESSION_DEMO_PALS;
  for (uint8_t i = 0; i < SESSION_DEMO_PALS; i++) {
    SessionPal& pal = set.pals[i];
    memcpy(pal.id, ids[i], SESSION_ID_LEN + 1);
    pal.species = species[i];
    pal.state = states[scenario][i];
    memcpy(pal.colors, colors[i], sizeof(pal.colors));
    strncpy(pal.summary, summaries[i], SESSION_SUMMARY_BYTES);
    pal.summary[SESSION_SUMMARY_BYTES] = 0;
    strncpy(pal.model, models[i], SESSION_MODEL_BYTES);
    pal.model[SESSION_MODEL_BYTES] = 0;
    pal.outputTokens = outputTokens[i];
    pal.inputTokens = inputTokens[i];
    pal.contextUsed = SESSION_USAGE_UNKNOWN;
    pal.contextMax = SESSION_USAGE_UNKNOWN;
    pal.modelCount = modelCounts[i];
  }
}

inline bool sessionIdValid(const char* id) {
  if (!id) return false;
  for (uint8_t i = 0; i < SESSION_ID_LEN; i++) {
    char c = id[i];
    bool hex = (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f');
    if (!hex) return false;
  }
  return id[SESSION_ID_LEN] == 0;                  // exactly 12, no more
}

// Validate and copy one `ss` row. Returns false for any malformed field; the
// caller skips the row rather than aborting the whole array, so one bad row
// cannot hide the healthy sessions behind it.
inline bool sessionPalRowParse(JsonVariantConst v, SessionPal& out) {
  JsonObjectConst row = v.as<JsonObjectConst>();
  if (row.isNull()) return false;

  const char* id = row["i"];
  if (!sessionIdValid(id)) return false;

  JsonVariantConst pv = row["p"];
  if (!pv.is<uint32_t>()) return false;
  uint32_t species = pv.as<uint32_t>();
  if (species > SESSION_SPECIES_MAX) return false;

  JsonVariantConst svv = row["s"];
  if (!svv.is<uint32_t>()) return false;
  uint32_t state = svv.as<uint32_t>();
  if (state > SESSION_STATE_MAX) return false;

  JsonArrayConst c = row["c"];
  if (c.isNull() || c.size() != 5) return false;
  uint16_t colors[5];
  uint8_t ci = 0;
  for (JsonVariantConst cv : c) {
    if (!cv.is<uint32_t>()) return false;
    uint32_t val = cv.as<uint32_t>();
    if (val > 0xFFFFu) return false;
    colors[ci++] = (uint16_t)val;
  }

  uint32_t outputTokens = SESSION_USAGE_UNKNOWN;
  JsonVariantConst uv = row["u"];
  if (!uv.isNull()) {
    if (!uv.is<uint32_t>()) return false;
    outputTokens = uv.as<uint32_t>();
    if (outputTokens == SESSION_USAGE_UNKNOWN) return false;
  }

  uint32_t inputTokens = SESSION_USAGE_UNKNOWN;
  JsonVariantConst qv = row["q"];
  if (!qv.isNull()) {
    if (!qv.is<uint32_t>()) return false;
    inputTokens = qv.as<uint32_t>();
    if (inputTokens == SESSION_USAGE_UNKNOWN) return false;
  }

  char model[SESSION_MODEL_BYTES + 1] = "";
  JsonVariantConst dv = row["d"];
  if (!dv.isNull()) {
    if (!dv.is<const char*>()) return false;
    sessionUtf8Clamp(dv.as<const char*>(), model, sizeof(model));
  }

  uint8_t modelCount = 0;
  JsonVariantConst vv = row["v"];
  if (!vv.isNull()) {
    if (!vv.is<uint32_t>()) return false;
    uint32_t count = vv.as<uint32_t>();
    if (count > UINT8_MAX) return false;
    modelCount = (uint8_t)count;
  }

  uint32_t contextUsed = SESSION_USAGE_UNKNOWN;
  uint32_t contextMax = SESSION_USAGE_UNKNOWN;
  JsonVariantConst xv = row["x"];
  if (!xv.isNull()) {
    JsonArrayConst context = xv.as<JsonArrayConst>();
    if (context.isNull() || context.size() != 2) return false;
    if (!context[0].is<uint32_t>() || !context[1].is<uint32_t>()) return false;
    contextUsed = context[0].as<uint32_t>();
    contextMax = context[1].as<uint32_t>();
    if (contextUsed == SESSION_USAGE_UNKNOWN || contextMax == SESSION_USAGE_UNKNOWN ||
        contextMax == 0 || contextUsed > contextMax) return false;
  }

  memcpy(out.id, id, SESSION_ID_LEN);
  out.id[SESSION_ID_LEN] = 0;
  out.species = (uint8_t)species;
  out.state   = (uint8_t)state;
  memcpy(out.colors, colors, sizeof(colors));
  sessionUtf8Clamp(row["m"] | "", out.summary, sizeof(out.summary));
  memcpy(out.model, model, sizeof(model));
  out.outputTokens = outputTokens;
  out.inputTokens = inputTokens;
  out.contextUsed = contextUsed;
  out.contextMax = contextMax;
  out.modelCount = modelCount;
  return true;
}

inline bool sessionUsageKnown(const SessionPal& pal) {
  return pal.outputTokens != SESSION_USAGE_UNKNOWN;
}

inline bool sessionInputUsageKnown(const SessionPal& pal) {
  return pal.inputTokens != SESSION_USAGE_UNKNOWN;
}

inline bool sessionContextKnown(const SessionPal& pal) {
  return pal.contextUsed != SESSION_USAGE_UNKNOWN
      && pal.contextMax != SESSION_USAGE_UNKNOWN
      && pal.contextMax > 0
      && pal.contextUsed <= pal.contextMax;
}

inline uint8_t sessionContextPercent(const SessionPal& pal) {
  if (!sessionContextKnown(pal)) return 0;
  return (uint8_t)(((uint64_t)pal.contextUsed * 100u) / pal.contextMax);
}

inline uint32_t sessionHeartCount(const SessionPal& pal) {
  return sessionUsageKnown(pal) ? pal.outputTokens / SESSION_TOKENS_PER_HEART : 0;
}

inline uint8_t sessionHeartProgress(const SessionPal& pal) {
  return sessionUsageKnown(pal)
    ? (uint8_t)(pal.outputTokens % SESSION_TOKENS_PER_HEART)
    : 0;
}

// Compact cumulative output tokens for the session-card header. The value is
// telemetry, not an accounting report, so one decimal at the K/M thresholds is
// enough while keeping the longest animal name inside the round display.
inline void sessionFormatTokens(uint32_t tokens, char* out, size_t cap) {
  if (!out || cap == 0) return;
  if (tokens < 1000u) {
    snprintf(out, cap, "%lu", (unsigned long)tokens);
  } else if (tokens < 999500u) {
    uint32_t tenths = (uint32_t)(((uint64_t)tokens + 50u) / 100u);
    if (tenths < 100u) {
      snprintf(out, cap, "%lu.%luK",
               (unsigned long)(tenths / 10u), (unsigned long)(tenths % 10u));
    } else {
      snprintf(out, cap, "%luK", (unsigned long)((tokens + 500u) / 1000u));
    }
  } else {
    uint32_t tenths = (uint32_t)(((uint64_t)tokens + 50000u) / 100000u);
    if (tenths < 100u) {
      snprintf(out, cap, "%lu.%luM",
               (unsigned long)(tenths / 10u), (unsigned long)(tenths % 10u));
    } else {
      snprintf(out, cap, "%luM",
               (unsigned long)(((uint64_t)tokens + 500000u) / 1000000u));
    }
  }
  out[cap - 1] = 0;
}

inline int sessionPalFind(const SessionPalSet& set, const char* id) {
  if (!id || !id[0]) return -1;
  for (uint8_t i = 0; i < set.count; i++) {
    if (strncmp(set.pals[i].id, id, SESSION_ID_LEN + 1) == 0) return (int)i;
  }
  return -1;
}

// Apply the optional projection carried by one heartbeat.
//
// Absent `sv`, a version we do not understand, or an absent `ss` all mean "no
// per-session view" and reset to legacy aggregate behaviour. That is the same
// answer an old build gives, so a bridge rollback degrades cleanly.
//
// Rows are written in place and `count` is published only after the loop, so a
// render that interleaves with parsing still sees a consistent set. Duplicate
// display IDs are dropped (the bridge de-duplicates, but an ambiguous selection
// key would silently break carousel tracking, so we defend the invariant here).
inline void sessionPalsApply(JsonVariantConst doc, SessionPalSet& set) {
  JsonVariantConst sv = doc["sv"];
  if (!sv.is<uint32_t>() || sv.as<uint32_t>() != SESSION_SCHEMA_VERSION) {
    sessionPalsClear(set);
    return;
  }
  JsonArrayConst ss = doc["ss"];
  if (ss.isNull()) { sessionPalsClear(set); return; }

  uint8_t n = 0;
  for (JsonVariantConst row : ss) {
    if (n >= MAX_SESSION_PALS) break;
    SessionPal& slot = set.pals[n];
    if (!sessionPalRowParse(row, slot)) continue;
    bool dup = false;
    for (uint8_t j = 0; j < n; j++) {
      if (strncmp(set.pals[j].id, slot.id, SESSION_ID_LEN + 1) == 0) { dup = true; break; }
    }
    if (dup) continue;
    n++;
  }
  set.version = SESSION_SCHEMA_VERSION;
  set.count   = n;
}

// Detect a row that is newly thinking or working without treating row reorder or
// disappearance as new work. The old and new sets are both bounded at eight.
inline bool sessionPalsNewWorking(const SessionPalSet& before, const SessionPalSet& after) {
  for (uint8_t i = 0; i < after.count; i++) {
    const SessionPal& next = after.pals[i];
    if (next.state != SESS_THINKING && next.state != SESS_WORKING) continue;
    int old = sessionPalFind(before, next.id);
    if (old < 0 || (before.pals[old].state != SESS_THINKING
                    && before.pals[old].state != SESS_WORKING)) return true;
  }
  return false;
}

// ──────────────── selection ────────────────

// Keep the carousel pinned to a session across re-ranking.
//
// `selId` is the sticky key (empty = nothing chosen yet). If it is still
// present, follow it to its new index. If it vanished — ended, expired, or
// pushed past the projection cap — fall back to the highest-ranked row, which
// the bridge has already sorted to the front. Returns the resolved index, or -1
// when there is nothing to show.
inline int sessionSelectionResolve(const SessionPalSet& set, char* selId, size_t selCap) {
  if (set.count == 0) {
    if (selCap) selId[0] = 0;
    return -1;
  }
  int idx = sessionPalFind(set, selId);
  if (idx < 0) idx = 0;
  if (selCap) {
    strncpy(selId, set.pals[idx].id, selCap - 1);
    selId[selCap - 1] = 0;
  }
  return idx;
}

// Move `steps` detents through the ranked array with wraparound.
inline int sessionSelectionStep(const SessionPalSet& set, char* selId, size_t selCap, int steps) {
  if (set.count == 0) return -1;
  int idx = sessionSelectionResolve(set, selId, selCap);
  if (idx < 0) return -1;
  int n = (int)set.count;
  idx = (int)(((long)idx + steps) % n);
  if (idx < 0) idx += n;
  if (selCap) {
    strncpy(selId, set.pals[idx].id, selCap - 1);
    selId[selCap - 1] = 0;
  }
  return idx;
}

// ──────────────── token-heart awards ────────────────

inline void sessionHeartQueueClear(SessionHeartQueue& queue) {
  queue.count = 0;
}

inline void sessionHeartTrackerClear(SessionHeartTracker& tracker) {
  tracker.count = 0;
}

inline void sessionHeartQueuePush(SessionHeartQueue& queue, const char* id,
                                  uint32_t awards) {
  if (!id || !id[0] || awards == 0) return;
  for (uint8_t i = 0; i < queue.count; i++) {
    if (strncmp(queue.awards[i].id, id, SESSION_ID_LEN + 1) != 0) continue;
    uint32_t total = (uint32_t)queue.awards[i].remaining + awards;
    queue.awards[i].remaining = (uint16_t)(total > UINT16_MAX ? UINT16_MAX : total);
    return;
  }
  if (queue.count >= MAX_SESSION_HEART_AWARDS) return;
  SessionHeartAward& slot = queue.awards[queue.count++];
  strncpy(slot.id, id, SESSION_ID_LEN);
  slot.id[SESSION_ID_LEN] = 0;
  slot.remaining = (uint16_t)(awards > UINT16_MAX ? UINT16_MAX : awards);
}

inline SessionHeartProgress* sessionHeartProgressFor(
    SessionHeartTracker& tracker, const SessionPalSet& current, const char* id) {
  for (uint8_t i = 0; i < tracker.count; i++) {
    if (strncmp(tracker.progress[i].id, id, SESSION_ID_LEN + 1) == 0) {
      return &tracker.progress[i];
    }
  }
  uint8_t slot = tracker.count;
  if (slot >= MAX_SESSION_PALS) {
    slot = MAX_SESSION_PALS;
    for (uint8_t i = 0; i < tracker.count; i++) {
      if (sessionPalFind(current, tracker.progress[i].id) < 0) {
        slot = i;
        break;
      }
    }
    if (slot >= MAX_SESSION_PALS) return nullptr;
  } else {
    tracker.count++;
  }
  SessionHeartProgress& progress = tracker.progress[slot];
  strncpy(progress.id, id, SESSION_ID_LEN);
  progress.id[SESSION_ID_LEN] = 0;
  progress.lastTokens = SESSION_USAGE_UNKNOWN;
  progress.remainder = 0;
  return &progress;
}

// Queue one animation for every 100 newly observed output tokens. The tracker
// keeps its own raw baseline and sub-100 remainder, so temporary omission of
// `u` cannot lose progress and a decreased/rebuilt counter only starts a new
// raw generation—it never replays milestones from the old value.
inline void sessionHeartObserve(const SessionPalSet& current,
                                SessionHeartTracker& tracker,
                                SessionHeartQueue& queue) {
  for (uint8_t i = 0; i < current.count; i++) {
    const SessionPal& next = current.pals[i];
    if (!sessionUsageKnown(next)) continue;
    SessionHeartProgress* progress = sessionHeartProgressFor(tracker, current, next.id);
    if (!progress) continue;
    if (progress->lastTokens == SESSION_USAGE_UNKNOWN || next.outputTokens < progress->lastTokens) {
      progress->lastTokens = next.outputTokens;
      continue;
    }
    uint32_t delta = next.outputTokens - progress->lastTokens;
    progress->lastTokens = next.outputTokens;
    if (delta == 0) continue;
    uint64_t accumulated = (uint64_t)progress->remainder + delta;
    uint32_t awards = (uint32_t)(accumulated / SESSION_TOKENS_PER_HEART);
    progress->remainder = (uint8_t)(accumulated % SESSION_TOKENS_PER_HEART);
    sessionHeartQueuePush(queue, next.id, awards);
  }
}

inline bool sessionHeartQueuePop(SessionHeartQueue& queue, char* id, size_t idCap) {
  if (queue.count == 0 || !id || idCap == 0) return false;
  SessionHeartAward& first = queue.awards[0];
  strncpy(id, first.id, idCap - 1);
  id[idCap - 1] = 0;
  if (first.remaining > 0) first.remaining--;
  if (first.remaining == 0) {
    for (uint8_t i = 1; i < queue.count; i++) queue.awards[i - 1] = queue.awards[i];
    queue.count--;
  }
  return true;
}

// ──────────────── state mapping ────────────────

inline uint8_t sessionStateToPersona(uint8_t state) {
  switch (state) {
    case SESS_THINKING:
    case SESS_WORKING:  return SESS_PERSONA_BUSY;
    case SESS_WAITING:
    case SESS_BLOCKED:  return SESS_PERSONA_ATTENTION;
    case SESS_IDLE:
    default:            return SESS_PERSONA_IDLE;
  }
}

inline bool sessionStateNeedsAttention(uint8_t state) {
  return state == SESS_WAITING || state == SESS_BLOCKED;
}

// Fold the aggregate persona and the selected pal's persona into the state the
// renderer should use. A selected pal normally owns the card, but a live prompt
// is an attention floor: browsing an idle/working pal cannot make the modal
// question look merely idle/busy. Higher one-shot/decorative states survive.
inline uint8_t sessionEffectivePersona(uint8_t globalPersona, bool promptLive,
                                       bool selectedPersonaActive,
                                       uint8_t selectedPersona) {
  uint8_t effective = selectedPersonaActive ? selectedPersona : globalPersona;
  if (promptLive && effective < SESS_PERSONA_ATTENTION) {
    return SESS_PERSONA_ATTENTION;
  }
  return effective;
}

// These consumers check promptLive independently rather than relying on the
// effective persona. That keeps a future persona refactor from suppressing the
// safety signal while a modal question is still present.
inline bool sessionNeedsHuman(bool promptLive, bool anySessionNeedsAttention,
                              uint8_t effectivePersona) {
  return promptLive || anySessionNeedsAttention
         || effectivePersona == SESS_PERSONA_ATTENTION;
}

inline uint32_t sessionChirpIntervalMs(bool promptLive) {
  return promptLive ? 2000u : 20000u;
}

inline bool sessionAttentionRingVisible(bool promptLive,
                                        bool anySessionNeedsAttention,
                                        uint8_t effectivePersona) {
  return sessionNeedsHuman(promptLive, anySessionNeedsAttention, effectivePersona);
}

inline bool sessionAttentionRingUrgent(bool promptLive, bool anySessionBlocked) {
  return promptLive || anySessionBlocked;
}

// ──────────────── palette ────────────────

// Resolve one colour a species asked for against an optional session palette.
//
// Every species file paints its body with exactly the RGB565 literal recorded
// in its own Species::bodyColor, so that field is a reliable key for "this ink
// is the animal" and is what makes a per-session body colour possible without
// threading an argument through all 18 renderers. BUDDY_DIM is a text-role
// colour and follows textDim. Other colours pass through unchanged unless they
// are numerically identical to bodyColor. Body matching intentionally runs
// first, so a species whose body aliases a semantic colour (for example white,
// yellow, or heart red) has that body ink remapped too; this helper cannot
// distinguish two roles represented by the same RGB565 value.
//
// `pal` is [body, bg, text, textDim, ink]; nullptr means no override, which is
// what keeps legacy rendering byte-identical.
inline uint16_t sessionMapColor(uint16_t c, uint16_t bodyColor, uint16_t dimColor,
                                const uint16_t* pal) {
  if (!pal) return c;
  if (c == bodyColor) return pal[0];
  if (c == dimColor)  return pal[3];
  return c;
}

inline const char* sessionStateName(uint8_t state) {
  switch (state) {
    case SESS_IDLE:     return "idle";
    case SESS_THINKING: return "thinking";
    case SESS_WORKING:  return "working";
    case SESS_WAITING:  return "waiting";
    case SESS_BLOCKED:  return "blocked";
    default:            return "?";
  }
}

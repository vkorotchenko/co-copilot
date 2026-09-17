#pragma once
#include <stdint.h>
#include <stddef.h>
#include <stdio.h>
#include <string.h>

static const uint32_t COMPLETION_WATCHDOG_MS = 24u * 60u * 60u * 1000u;
static const uint32_t COMPLETION_SUCCESS_INTRO_MS = 5600u;
static const uint32_t COMPLETION_FAILED_INTRO_MS = 800u;
static const uint32_t COMPLETION_ABORTED_INTRO_MS = 400u;
static const uint32_t COMPLETION_AFFORDANCE_MS = 1000u;
static const uint32_t WAKE_INPUT_QUIET_MS = 150u;

enum CompletionOutcome : uint8_t {
  COMPLETION_SUCCESS = 0,
  COMPLETION_FAILED = 1,
  COMPLETION_ABORTED = 2,
};

enum CompletionApplyResult : uint8_t {
  COMPLETION_NO_MODERN,
  COMPLETION_UNCHANGED,
  COMPLETION_NEW,
  COMPLETION_RESTORED,
  COMPLETION_CLEARED,
  COMPLETION_STALE,
  COMPLETION_MALFORMED,
};

enum CompletionFlags : uint8_t {
  COMPLETION_HAS_OWNER = 1u << 0,
  COMPLETION_HAS_DURATION = 1u << 1,
};

#if defined(__GNUC__)
#define COMPLETION_PACKED __attribute__((packed))
#else
#define COMPLETION_PACKED
#endif

struct COMPLETION_PACKED CompletionLatch {
  uint32_t generation;
  uint32_t durationSeconds;
  uint32_t startedAt;
  uint16_t colors[5];
  char id[13];
  char summary[49];
  uint8_t species;
  uint8_t outcome;
  uint8_t flags;
};

static_assert(sizeof(CompletionLatch) <= 88, "completion slot must stay bounded");

inline void completionLatchClearValue(CompletionLatch& latch) {
  memset(&latch, 0, sizeof(latch));
}

inline bool completionIdValid(const char* id) {
  if (!id) return false;
  for (uint8_t i = 0; i < 12; i++) {
    const char c = id[i];
    if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return false;
  }
  return id[12] == 0;
}

inline uint8_t completionUtf8Sequence(const uint8_t* s, size_t avail) {
  if (!s || avail == 0) return 0;
  uint8_t n;
  uint32_t cp;
  if (s[0] < 0x80) { n = 1; cp = s[0]; }
  else if ((s[0] & 0xe0) == 0xc0) { n = 2; cp = s[0] & 0x1f; }
  else if ((s[0] & 0xf0) == 0xe0) { n = 3; cp = s[0] & 0x0f; }
  else if ((s[0] & 0xf8) == 0xf0) { n = 4; cp = s[0] & 0x07; }
  else return 0;
  if (avail < n) return 0;
  for (uint8_t i = 1; i < n; i++) {
    if ((s[i] & 0xc0) != 0x80) return 0;
    cp = (cp << 6) | (s[i] & 0x3f);
  }
  static const uint32_t minimum[5] = { 0, 0, 0x80, 0x800, 0x10000 };
  if (cp < minimum[n] || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return 0;
  return n;
}

inline bool completionUtf8Valid48(const char* value, size_t len) {
  if (!value || len > 48) return false;
  size_t at = 0;
  while (at < len) {
    if (value[at] == 0) return false;
    uint8_t n = completionUtf8Sequence((const uint8_t*)value + at, len - at);
    if (!n) return false;
    at += n;
  }
  return true;
}

// Human duration for the completion card: "45s" below a minute, "3m 5s" above.
// Kept here (free of Arduino/M5 headers) so the exact text is host-testable and
// so the format string and its arguments can never drift apart — the card used
// to pick the format with a ternary while always passing `seconds / 60` first,
// which printed "0s" for every sub-minute run.
static const size_t COMPLETION_DURATION_TEXT_MAX = 16;

inline void completionFormatDuration(uint32_t seconds, char* out, size_t size) {
  if (!out || size == 0) return;
  if (seconds < 60u) {
    snprintf(out, size, "%lus", (unsigned long)seconds);
    return;
  }
  snprintf(out, size, "%lum %lus",
           (unsigned long)(seconds / 60u), (unsigned long)(seconds % 60u));
}

struct CompletionMirror {
  CompletionLatch latch;
  uint32_t epoch;
  uint32_t highestGeneration;
  uint32_t suppressedGeneration;
  uint32_t pendingEpoch;
  uint32_t pendingGeneration;
  bool epochKnown;
  bool active;
  bool introConsumed;
  bool pendingDismiss;
  bool legacyPrimed;
  bool legacyCompleted;
  bool modern;

  void clearPendingDismiss() {
    pendingEpoch = pendingGeneration = 0;
    pendingDismiss = false;
  }

  void reset() {
    completionLatchClearValue(latch);
    epoch = highestGeneration = suppressedGeneration = 0;
    clearPendingDismiss();
    epochKnown = active = introConsumed = false;
    legacyPrimed = legacyCompleted = modern = false;
  }

  bool observeEpoch(uint32_t nextEpoch) {
    modern = true;
    legacyPrimed = false;
    if (epochKnown && epoch == nextEpoch) return false;
    epoch = nextEpoch;
    epochKnown = true;
    highestGeneration = suppressedGeneration = 0;
    clearPendingDismiss();
    active = introConsumed = false;
    completionLatchClearValue(latch);
    return true;
  }

  CompletionApplyResult authoritativeClear() {
    modern = true;
    if (highestGeneration) suppressedGeneration = highestGeneration;
    const bool changed = active || pendingDismiss;
    active = false;
    introConsumed = true;
    clearPendingDismiss();
    return changed ? COMPLETION_CLEARED : COMPLETION_UNCHANGED;
  }

  CompletionApplyResult apply(const CompletionLatch& candidate, uint32_t now) {
    modern = true;
    const uint32_t g = candidate.generation;
    if (g < highestGeneration) return COMPLETION_STALE;
    if (g == highestGeneration) {
      if (g == suppressedGeneration) return COMPLETION_STALE;
      if (active) return COMPLETION_UNCHANGED;
      active = true;
      introConsumed = true;
      return COMPLETION_RESTORED;
    }
    highestGeneration = g;
    suppressedGeneration = 0;
    clearPendingDismiss();
    latch = candidate;
    latch.startedAt = now;
    active = true;
    introConsumed = false;
    return COMPLETION_NEW;
  }

  void onDisconnect() {
    active = false;
    introConsumed = true;
    legacyPrimed = false;
    legacyCompleted = false;
  }

  void clearForOta() {
    if (active && modern) suppressedGeneration = highestGeneration;
    active = false;
    introConsumed = true;
    clearPendingDismiss();
  }

  CompletionApplyResult observeLegacy(bool completed, bool newWork, uint32_t now) {
    // A heartbeat without `sg` is only authoritative while this boot has never
    // seen a modern epoch. Once one is known, a no-`sg` snapshot means the
    // bridge has not (yet) re-learned that this device is completion-capable —
    // the reconnect window before the `cl:1` status ack lands — not that the
    // authority downgraded. Shadow the pulse so a later rising edge is not
    // replayed, but never touch the modern latch, its epoch, or its floors.
    // A truly legacy authority (no known modern epoch, e.g. an old bridge
    // against new firmware) keeps the full legacy behaviour below.
    if (epochKnown) {
      legacyPrimed = true;
      legacyCompleted = completed;
      return COMPLETION_UNCHANGED;
    }
    modern = false;
    if (!legacyPrimed) {
      legacyPrimed = true;
      legacyCompleted = completed;
      return COMPLETION_UNCHANGED;
    }
    if (newWork) {
      const bool changed = active;
      active = false;
      introConsumed = true;
      legacyCompleted = completed;
      return changed ? COMPLETION_CLEARED : COMPLETION_UNCHANGED;
    }
    CompletionApplyResult result = COMPLETION_UNCHANGED;
    if (completed && !legacyCompleted) {
      completionLatchClearValue(latch);
      latch.outcome = COMPLETION_SUCCESS;
      latch.startedAt = now;
      active = true;
      introConsumed = false;
      result = COMPLETION_NEW;
    }
    legacyCompleted = completed;
    return result;
  }

  bool dismissLocal() {
    if (!active) return false;
    active = false;
    introConsumed = true;
    if (!epochKnown) return true;   // legacy authority: nothing to acknowledge
    // Only a card that *is* the modern floor can be acknowledged by epoch and
    // generation. A generation-0 (legacy) card under a known-modern epoch can
    // never be matched by the bridge, so acking it would strand an unanswerable
    // command — and leaving the floor unsuppressed would let the next snapshot
    // restore a card the user already dismissed.
    if (modern && latch.generation != 0 && latch.generation == highestGeneration) {
      suppressedGeneration = latch.generation;
      pendingEpoch = epoch;
      pendingGeneration = latch.generation;
      pendingDismiss = true;
    } else if (highestGeneration) {
      // No ack is queued here (none could match), but an ack already owed for
      // the modern floor stays owed and is still retried on reconnect.
      suppressedGeneration = highestGeneration;
    }
    return true;
  }

  bool watchdog(uint32_t now) {
    if (!active || (uint32_t)(now - latch.startedAt) < COMPLETION_WATCHDOG_MS) return false;
    if (modern) suppressedGeneration = highestGeneration;
    active = false;
    introConsumed = true;
    return true;
  }
};

inline uint32_t completionIntroDuration(uint8_t outcome) {
  if (outcome == COMPLETION_SUCCESS) return COMPLETION_SUCCESS_INTRO_MS;
  if (outcome == COMPLETION_FAILED) return COMPLETION_FAILED_INTRO_MS;
  return COMPLETION_ABORTED_INTRO_MS;
}

inline bool completionIntroActive(const CompletionMirror& mirror, uint32_t now) {
  return mirror.active && !mirror.introConsumed
      && (uint32_t)(now - mirror.latch.startedAt) < completionIntroDuration(mirror.latch.outcome);
}

inline bool completionAffordanceVisible(const CompletionMirror& mirror, uint32_t now) {
  return mirror.active && (uint32_t)(now - mirror.latch.startedAt) >= COMPLETION_AFFORDANCE_MS;
}

inline bool completionCardVisible(bool active, bool normalDisplay, bool screenOn,
                                  bool ota, bool passkey, bool prompt,
                                  bool blockedOrWaiting, bool overlay) {
  return active && normalDisplay && screenOn && !ota && !passkey && !prompt
      && !blockedOrWaiting && !overlay;
}

inline bool completionDismissGestureAllowed(bool cardVisible, bool shortClick,
                                            bool pillTap, bool encoderMoved,
                                            bool longPress) {
  return cardVisible && !encoderMoved && !longPress && (shortClick || pillTap);
}

enum WakeGuardState : uint8_t { WAKE_READY, WAKE_WAIT_RELEASE, WAKE_QUIET };

struct WakeInputGuard {
  WakeGuardState state;
  uint32_t quietSince;

  void reset() { state = WAKE_READY; quietSince = 0; }

  void woke(uint32_t now, bool buttonDown) {
    state = buttonDown ? WAKE_WAIT_RELEASE : WAKE_QUIET;
    quietSince = now;
  }

  bool consume(uint32_t now, bool buttonDown, bool encoderMoved, bool touchActive) {
    if (state == WAKE_READY) return false;
    if (state == WAKE_WAIT_RELEASE) {
      if (!buttonDown) { state = WAKE_QUIET; quietSince = now; }
      return true;
    }
    if (buttonDown) {
      state = WAKE_WAIT_RELEASE;
      return true;
    }
    if (encoderMoved || touchActive) quietSince = now;
    if ((uint32_t)(now - quietSince) < WAKE_INPUT_QUIET_MS) return true;
    state = WAKE_READY;
    return false;
  }
};

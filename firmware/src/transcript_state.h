#pragma once

#include <stddef.h>
#include <stdint.h>
#include <string.h>

#include "utf8_clamp.h"

enum ActivityContentKind : uint8_t {
  ACTIVITY_DISCONNECTED,
  ACTIVITY_MESSAGE,
  ACTIVITY_TRANSCRIPT,
};

struct TranscriptLinkState {
  bool wasConnected = false;
};

enum DisplayPage : uint8_t {
  DISPLAY_PAGE_NORMAL,
  DISPLAY_PAGE_ACTIVITY,
  DISPLAY_PAGE_PET,
  DISPLAY_PAGE_INFO,
  DISPLAY_PAGE_COUNT,
};

enum DisplaySurfaceOwner : uint8_t {
  DISPLAY_SURFACE_NONE,
  DISPLAY_SURFACE_UI_OVERLAY,
  DISPLAY_SURFACE_PASSKEY,
  DISPLAY_SURFACE_PROMPT,
  DISPLAY_SURFACE_CLOCK,
  DISPLAY_SURFACE_INFO,
  DISPLAY_SURFACE_PET,
  DISPLAY_SURFACE_TRANSCRIPT,
  DISPLAY_SURFACE_HUD,
  DISPLAY_SURFACE_COMPLETION,
  DISPLAY_SURFACE_LIVE_CARD,
};

struct DisplayOwnershipState {
  bool screenVisible = false;
  bool uiOverlayVisible = false;
  bool passkeyVisible = false;
  bool promptVisible = false;
  bool clockVisible = false;
  DisplayPage page = DISPLAY_PAGE_NORMAL;
  bool completionVisible = false;
  bool liveCardVisible = false;
  bool hudEnabled = false;
  bool connected = false;
  uint8_t transcriptRows = 0;
};

inline ActivityContentKind activityContentKind(bool connected, uint8_t lineCount) {
  if (!connected) return ACTIVITY_DISCONNECTED;
  return lineCount == 0 ? ACTIVITY_MESSAGE : ACTIVITY_TRANSCRIPT;
}

inline bool activityShowsTranscript(bool connected, uint8_t lineCount) {
  return activityContentKind(connected, lineCount) == ACTIVITY_TRANSCRIPT;
}

inline DisplaySurfaceOwner displaySurfaceOwner(const DisplayOwnershipState& state) {
  if (!state.screenVisible) return DISPLAY_SURFACE_NONE;
  if (state.uiOverlayVisible) return DISPLAY_SURFACE_UI_OVERLAY;
  if (state.passkeyVisible) return DISPLAY_SURFACE_PASSKEY;
  if (state.promptVisible) return DISPLAY_SURFACE_PROMPT;
  if (state.clockVisible) return DISPLAY_SURFACE_CLOCK;
  if (state.page == DISPLAY_PAGE_INFO) return DISPLAY_SURFACE_INFO;
  if (state.page == DISPLAY_PAGE_PET) return DISPLAY_SURFACE_PET;
  if (state.page == DISPLAY_PAGE_NORMAL && state.completionVisible)
    return DISPLAY_SURFACE_COMPLETION;
  if (state.page == DISPLAY_PAGE_NORMAL && state.liveCardVisible)
    return DISPLAY_SURFACE_LIVE_CARD;

  bool hudVisible = state.page == DISPLAY_PAGE_ACTIVITY
                 || (state.page == DISPLAY_PAGE_NORMAL && state.hudEnabled);
  if (!hudVisible) return DISPLAY_SURFACE_NONE;
  return activityShowsTranscript(state.connected, state.transcriptRows)
       ? DISPLAY_SURFACE_TRANSCRIPT : DISPLAY_SURFACE_HUD;
}

inline bool transcriptOwnsDisplay(const DisplayOwnershipState& state) {
  return displaySurfaceOwner(state) == DISPLAY_SURFACE_TRANSCRIPT;
}

template<size_t Bytes>
inline size_t transcriptCopyRow(char (&stored)[Bytes], const char* incoming) {
  return sessionUtf8Clamp(incoming ? incoming : "", stored, Bytes);
}

template<size_t Rows, size_t Bytes>
inline bool transcriptAppendParsedRow(char (&stored)[Rows][Bytes], uint8_t& storedCount,
                                      const char* incoming) {
  if (storedCount >= Rows) return false;
  transcriptCopyRow(stored[storedCount], incoming);
  storedCount++;
  return true;
}

inline bool transcriptRowIsCurrent(uint8_t sourceRow, uint8_t rowCount,
                                   uint8_t scroll) {
  return rowCount > 0 && sourceRow == rowCount - 1 && scroll == 0;
}

inline bool transcriptScroll(bool actionable, uint8_t& scroll, int direction,
                             uint8_t maximum) {
  if (!actionable || direction == 0) return false;
  int next = (int)scroll + (direction > 0 ? 1 : -1);
  if (next < 0) next = 0;
  if (next > maximum) next = maximum;
  if (next == scroll) return false;
  scroll = (uint8_t)next;
  return true;
}

inline bool transcriptClose(bool actionable, uint8_t& scroll) {
  if (!actionable || scroll == 0) return false;
  scroll = 0;
  return true;
}

template<size_t Rows, size_t Bytes>
inline bool transcriptApplyRows(char (&stored)[Rows][Bytes], uint8_t& storedCount,
                                uint16_t& generation,
                                const char (&incoming)[Rows][Bytes], uint8_t incomingCount) {
  if (incomingCount > Rows) incomingCount = Rows;
  bool changed = storedCount != incomingCount;
  for (uint8_t i = 0; !changed && i < incomingCount; i++) {
    changed = memcmp(stored[i], incoming[i], Bytes) != 0;
  }
  if (!changed) return false;

  memset(stored, 0, sizeof(stored));
  if (incomingCount > 0) memcpy(stored, incoming, incomingCount * Bytes);
  storedCount = incomingCount;
  generation++;
  return true;
}

template<size_t Rows, size_t Bytes>
inline bool transcriptObserveConnection(TranscriptLinkState& link, bool connected,
                                        char (&stored)[Rows][Bytes], uint8_t& storedCount,
                                        uint16_t& generation) {
  if (connected) {
    link.wasConnected = true;
    return false;
  }
  if (!link.wasConnected) return false;

  link.wasConnected = false;
  memset(stored, 0, sizeof(stored));
  storedCount = 0;
  generation++;
  return true;
}

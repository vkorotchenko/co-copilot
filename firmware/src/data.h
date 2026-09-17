#pragma once
#include <Arduino.h>
#include <ArduinoJson.h>
#include "ble_bridge.h"
#include "xfer.h"
#include "ota.h"
#include "hw.h"
#include "session_pals.h"
#include "completion_latch_json.h"
#include "transcript_state.h"

struct TamaState {
  uint8_t  sessionsTotal;
  uint8_t  sessionsRunning;
  uint8_t  sessionsWaiting;
  bool     recentlyCompleted;
  uint32_t tokensToday;
  uint32_t tokensUsed;       // context-window tokens in use (live session)
  uint32_t tokensMax;        // context-window size
  uint32_t lastUpdated;
  char     msg[24];
  char     model[24];        // active AI model, e.g. "claude-opus-4.8"
  char     effort[10];       // reasoning effort, e.g. "medium" (may be empty)
  bool     connected;
  char     lines[8][160];
  uint8_t  nLines;
  uint16_t lineGen;          // bumps when lines change — lets UI reset scroll
  TranscriptLinkState transcriptLink;
  char     promptId[40];     // pending permission request ID; empty = no prompt
  char     promptTool[20];
  char     promptHint[44];
  // Optional per-session projection (wire `sv`/`ss`). count == 0 means the
  // bridge sent a legacy aggregate-only heartbeat and the UI stays legacy.
  SessionPalSet sessions;
  SessionHeartTracker heartTracker;
  SessionHeartQueue heartAwards;
  CompletionMirror completion;
};

// ---------------------------------------------------------------------------
// Three modes, checked in priority order:
//   demo   → auto-cycle a browsable fake pal roster every 5s, ignore live data
//   live   → JSON arrived in the last 10s over USB or BT
//   asleep → no data, all zeros, "No Copilot connected"
// ---------------------------------------------------------------------------

static uint32_t _lastLiveMs = 0;
static uint32_t _lastBtByteMs = 0;   // hasClient() lies; track actual BT traffic
static bool     _demoMode   = false;
static uint8_t  _demoIdx    = 0;
static uint32_t _demoNext   = 0;
static const uint32_t DEMO_DWELL_MS = 5000;

struct _Fake { const char* n; uint8_t t,r,w; bool c; uint32_t tok; };
static const _Fake _FAKES[] = {
  {"idle",5,0,0,false,12000},
  {"thinking",5,5,0,false,32000},
  {"working",5,5,0,false,89000},
  {"waiting",5,0,5,false,112000},
  {"blocked",5,0,5,false,128000},
  {"completed",5,0,0,true,142000},
  {"assertive",5,0,0,false,155000},
};
static_assert(sizeof(_FAKES) / sizeof(_FAKES[0]) == SESSION_DEMO_SCENARIOS,
              "demo aggregate scenarios must match the pal projection");

inline void dataSetDemo(bool on) {
  _demoMode = on;
  if (on) { _demoIdx = 0; _demoNext = millis() + DEMO_DWELL_MS; }
}
inline bool dataDemo() { return _demoMode; }
inline bool dataDemoCompleted() {
  return _demoMode && _demoIdx == SESSION_DEMO_COMPLETED;
}
inline bool dataDemoAssertive() {
  return _demoMode && _demoIdx == SESSION_DEMO_ASSERTIVE;
}

inline bool dataConnected() {
  return _lastLiveMs != 0 && (millis() - _lastLiveMs) <= 30000;
}

inline bool dataBtActive() {
  // Desktop's idle keepalive is ~10s; give it 1.5x headroom.
  return _lastBtByteMs != 0 && (millis() - _lastBtByteMs) <= 15000;
}

inline const char* dataScenarioName() {
  if (_demoMode) return _FAKES[_demoIdx].n;
  if (dataConnected()) return dataBtActive() ? "bt" : "usb";
  return "none";
}

// Set true once the bridge sends a time sync — until then the RTC may
// hold whatever was on the coin cell (or 2000-01-01 if it lost power).
static bool _rtcValid = false;
inline bool dataRtcValid() { return _rtcValid; }

static void _applyJson(const char* line, TamaState* out) {
  JsonDocument doc;
  if (deserializeJson(doc, line)) return;
  const uint32_t now = millis();
  const char* incomingCmd = doc["cmd"];
  if (incomingCmd && strcmp(incomingCmd, "ota_begin") == 0) out->completion.clearForOta();
  if (otaCommand(doc)) { _lastLiveMs = millis(); return; }
  if (xferCommand(doc)) { _lastLiveMs = millis(); return; }

  // Bridge sends {"time":[epoch_sec, tz_offset_sec]}; the RTC8563 is set from
  // the tz-adjusted (local) epoch via the hw layer.
  JsonArray t = doc["time"];
  if (!t.isNull() && t.size() == 2) {
    time_t local = (time_t)t[0].as<uint32_t>() + (int32_t)t[1];
    hwSetClockLocalEpoch(local);
    extern uint32_t _clkLastRead;
    _clkLastRead = 0;   // force re-read so the cached clock and _rtcValid agree
    _rtcValid = true;
    _lastLiveMs = millis();
    return;
  }

  const uint8_t previousRunning = out->sessionsRunning;
  char previousPromptId[sizeof(out->promptId)];
  memcpy(previousPromptId, out->promptId, sizeof(previousPromptId));
  SessionPalSet previousSessions = out->sessions;
  const bool completedPulse = doc["completed"] | false;

  out->sessionsTotal     = doc["total"]     | out->sessionsTotal;
  out->sessionsRunning   = doc["running"]   | out->sessionsRunning;
  out->sessionsWaiting   = doc["waiting"]   | out->sessionsWaiting;
  if (doc["tokens"].is<uint32_t>()) {
    statsOnBridgeTokens(doc["tokens"].as<uint32_t>());
  }
  out->tokensToday = doc["tokens_today"] | out->tokensToday;
  out->tokensUsed  = doc["tokens_used"]  | out->tokensUsed;
  out->tokensMax   = doc["tokens_max"]   | out->tokensMax;
  const char* m = doc["msg"];
  if (m) { strncpy(out->msg, m, sizeof(out->msg)-1); out->msg[sizeof(out->msg)-1]=0; }
  const char* mdl = doc["model"];
  if (mdl) { strncpy(out->model, mdl, sizeof(out->model)-1); out->model[sizeof(out->model)-1]=0; }
  const char* eff = doc["effort"];
  if (eff) { strncpy(out->effort, eff, sizeof(out->effort)-1); out->effort[sizeof(out->effort)-1]=0; }
  JsonArray la = doc["entries"];
  if (!la.isNull()) {
    char nextLines[8][160] = {};
    uint8_t n = 0;
    for (JsonVariant v : la) {
      if (!transcriptAppendParsedRow(nextLines, n, v.as<const char*>())) break;
    }
    transcriptApplyRows(out->lines, out->nLines, out->lineGen, nextLines, n);
  }
  JsonObject pr = doc["prompt"];
  if (!pr.isNull()) {
    const char* pid = pr["id"]; const char* pt = pr["tool"]; const char* ph = pr["hint"];
    strncpy(out->promptId,   pid ? pid : "", sizeof(out->promptId)-1);   out->promptId[sizeof(out->promptId)-1]=0;
    strncpy(out->promptTool, pt  ? pt  : "", sizeof(out->promptTool)-1); out->promptTool[sizeof(out->promptTool)-1]=0;
    strncpy(out->promptHint, ph  ? ph  : "", sizeof(out->promptHint)-1); out->promptHint[sizeof(out->promptHint)-1]=0;
  } else {
    out->promptId[0] = 0; out->promptTool[0] = 0; out->promptHint[0] = 0;
  }
  // Additive per-session projection. Absent or unknown `sv` resets to the
  // legacy aggregate view, which is exactly what an older build would show.
  SessionPalSet nextSessions = out->sessions;
  sessionPalsApply(doc.as<JsonVariantConst>(), nextSessions);
  const bool projectedWork = sessionPalsNewWorking(previousSessions, nextSessions);
  sessionHeartObserve(nextSessions, out->heartTracker, out->heartAwards);
  out->sessions = nextSessions;

  CompletionApplyResult completionResult = completionApplySnapshot(
    doc.as<JsonVariantConst>(), out->completion, now);
  if (completionResult == COMPLETION_NO_MODERN) {
    const bool legacyAuthority = !out->completion.epochKnown;
    const bool newPrompt = out->promptId[0] && strcmp(previousPromptId, out->promptId) != 0;
    const bool runningEdge = previousRunning == 0 && out->sessionsRunning > 0;
    out->completion.observeLegacy(completedPulse, newPrompt || runningEdge || projectedWork, now);
    // A legacy pulse observed during a modern bridge's capability gap must not
    // drive the legacy celebration either: the modern latch still owns it.
    out->recentlyCompleted = legacyAuthority && completedPulse;
  } else {
    out->recentlyCompleted = false;
  }
  out->lastUpdated = now;
  _lastLiveMs = millis();
}

template<size_t N>
struct _LineBuf {
  char buf[N];
  uint16_t len = 0;
  void feed(Stream& s, TamaState* out) {
    while (s.available()) {
      char c = s.read();
      if (c == '\n' || c == '\r') {
        if (len > 0) { buf[len]=0; if (buf[0]=='{') _applyJson(buf, out); len=0; }
      } else if (len < N-1) {
        buf[len++] = c;
      }
    }
  }
};

static _LineBuf<4096> _usbLine, _btLine;

inline void dataPoll(TamaState* out) {
  uint32_t now = millis();

  if (_demoMode) {
    if ((int32_t)(now - _demoNext) >= 0) {
      _demoIdx = (_demoIdx + 1) % SESSION_DEMO_SCENARIOS;
      _demoNext = now + DEMO_DWELL_MS;
    }
    const _Fake& s = _FAKES[_demoIdx];
    out->sessionsTotal=s.t; out->sessionsRunning=s.r; out->sessionsWaiting=s.w;
    out->recentlyCompleted=s.c; out->tokensToday=s.tok; out->lastUpdated=now;
    out->connected = true;
    sessionPalsDemoApply(_demoIdx, out->sessions);
    sessionHeartTrackerClear(out->heartTracker);
    sessionHeartQueueClear(out->heartAwards);
    out->promptId[0] = 0;
    out->promptTool[0] = 0;
    out->promptHint[0] = 0;
    snprintf(out->msg, sizeof(out->msg), "demo: %s", s.n);
    return;
  }

  _usbLine.feed(Serial, out);
  // BLE ring buffer is drained manually since it's not a Stream.
  while (bleAvailable()) {
    int c = bleRead();
    if (c < 0) break;
    _lastBtByteMs = millis();
    if (c == '\n' || c == '\r') {
      if (_btLine.len > 0) {
        _btLine.buf[_btLine.len] = 0;
        if (_btLine.buf[0] == '{') _applyJson(_btLine.buf, out);
        _btLine.len = 0;
      }
    } else if (_btLine.len < sizeof(_btLine.buf) - 1) {
      _btLine.buf[_btLine.len++] = (char)c;
    }
  }

  static bool wasBleConnected = false;
  bool isBleConnected = bleConnected();
  if (wasBleConnected && !isBleConnected) out->completion.onDisconnect();
  wasBleConnected = isBleConnected;
  out->completion.watchdog(now);

  out->connected = dataConnected();
  transcriptObserveConnection(
    out->transcriptLink, out->connected, out->lines, out->nLines, out->lineGen);
  if (!out->connected) {
    out->sessionsTotal=0; out->sessionsRunning=0; out->sessionsWaiting=0;
    out->recentlyCompleted=false; out->lastUpdated=now;
    sessionPalsClear(out->sessions);
    sessionHeartTrackerClear(out->heartTracker);
    sessionHeartQueueClear(out->heartAwards);
    strncpy(out->msg, "No Copilot connected", sizeof(out->msg)-1);
    out->msg[sizeof(out->msg)-1]=0;
  }
}

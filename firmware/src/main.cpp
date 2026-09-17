#include <M5Dial.h>
#include <LittleFS.h>
#include <stdarg.h>
#include "hw.h"
#include "ble_bridge.h"
#include "data.h"
#include "buddy.h"

// Full-screen canvas. The round GC9A01 is 240x240; off-circle pixels simply
// aren't shown, so we draw into a square sprite and keep content centered.
M5Canvas spr(&M5Dial.Display);

// Advertise as "Copilot-XXXX" (last two MAC bytes) so multiple devices in one
// room are distinguishable in the bridge's picker. Name persists in btName for
// the BLUETOOTH info page.
static char btName[16] = "Copilot";
static void startBt() {
  uint8_t mac[6] = {0};
  hwReadMac(mac);
  snprintf(btName, sizeof(btName), "Copilot-%02X%02X", mac[4], mac[5]);
  bleInit(btName);
}

#include "character.h"
#include "stats.h"

// Round 240x240 geometry.
const int W = 240, H = 240;
const int CX = W / 2;     // 120
const int CY = H / 2;     // 120
const int RAD = 120;

// Colors used across multiple UI surfaces. (GREEN/RED come from M5GFX's
// ili9341_colors; only the custom shades are defined here.)
const uint16_t HOT   = 0xFA20;   // red-orange: warnings, impatience, deny
const uint16_t PANEL = 0x2104;   // overlay panel background

enum PersonaState { P_SLEEP, P_IDLE, P_BUSY, P_ATTENTION, P_CELEBRATE, P_DIZZY, P_HEART };
static_assert((uint8_t)P_SLEEP == SESS_PERSONA_SLEEP
              && (uint8_t)P_IDLE == SESS_PERSONA_IDLE
              && (uint8_t)P_BUSY == SESS_PERSONA_BUSY
              && (uint8_t)P_ATTENTION == SESS_PERSONA_ATTENTION,
              "session and firmware persona numbering must stay aligned");
const char* stateNames[] = { "sleep", "idle", "busy", "attention", "celebrate", "dizzy", "heart" };

TamaState    tama;
PersonaState baseState   = P_SLEEP;
PersonaState activeState = P_SLEEP;
uint32_t     oneShotUntil = 0;
unsigned long t = 0;

// Menu / overlay state
bool    menuOpen    = false;
uint8_t menuSel     = 0;
uint8_t brightLevel = 4;           // 0..4 -> hw brightness
bool    btnALong    = false;

enum DisplayMode { DISP_NORMAL, DISP_ACTIVITY, DISP_PET, DISP_INFO, DISP_COUNT };
static_assert((uint8_t)DISP_NORMAL == (uint8_t)DISPLAY_PAGE_NORMAL
              && (uint8_t)DISP_ACTIVITY == (uint8_t)DISPLAY_PAGE_ACTIVITY
              && (uint8_t)DISP_PET == (uint8_t)DISPLAY_PAGE_PET
              && (uint8_t)DISP_INFO == (uint8_t)DISPLAY_PAGE_INFO
              && (uint8_t)DISP_COUNT == (uint8_t)DISPLAY_PAGE_COUNT,
              "display page numbering must stay aligned");
uint8_t displayMode = DISP_NORMAL;
uint8_t infoPage = 0;
uint8_t petPage = 0;
const uint8_t PET_PAGES = 1;
uint8_t msgScroll = 0;
uint16_t lastLineGen = 0;
char     lastPromptId[40] = "";
uint32_t lastInteractMs = 0;
bool     screenOff = false;
bool     buddyMode = false;
bool     gifAvailable = false;
const uint8_t SPECIES_GIF = 0xFF;   // species NVS sentinel: use the installed GIF

// ── session carousel ──────────────────────────────────────────────────────
// The bridge ranks `ss`, so index 0 is always the most urgent row. We track the
// viewed session by its stable 12-hex display ID rather than by index, because
// a re-rank between heartbeats would otherwise slide a different pal under the
// user's eyes without them touching anything.
char     selSessionId[SESSION_ID_LEN + 1] = "";
int      selSessionIdx = -1;
uint32_t lastCarouselMs = 0;                 // last manual carousel move
const uint32_t CAROUSEL_HOLD_MS = 15000;     // manual browsing suppresses auto-focus
bool     sessionStatsOpen = false;            // click toggles selected pal / stats
char     tokenHeartOwnerId[SESSION_ID_LEN + 1] = "";
uint32_t tokenHeartUntil = 0;
// Previous-frame snapshot, used only to spot a row *entering* waiting/blocked.
char     prevSessIds[MAX_SESSION_PALS][SESSION_ID_LEN + 1];
uint8_t  prevSessStates[MAX_SESSION_PALS];
uint8_t  prevSessCount = 0;

// The pal card owns DISP_NORMAL whenever the bridge projected any session.
static inline bool sessionsProjected() { return tama.sessions.count > 0; }
static inline bool completionPresentationActive() {
  return tama.completion.active && !dataDemo();
}

extern bool settingsOpen;
extern bool resetOpen;

static bool clockOwnsDisplay(bool inPrompt) {
  return displayMode == DISP_NORMAL
      && !menuOpen && !settingsOpen && !resetOpen && !inPrompt
      && tama.connected
      && !sessionsProjected()
      && !completionPresentationActive()
      && tama.sessionsRunning == 0 && tama.sessionsWaiting == 0
      && dataRtcValid();
}

static DisplayOwnershipState currentDisplayOwnership(
    bool clocking, bool completionVisible, bool liveCardVisible) {
  DisplayOwnershipState state;
  state.screenVisible = !screenOff;
  state.uiOverlayVisible = menuOpen || settingsOpen || resetOpen;
  state.passkeyVisible = blePasskey() != 0;
  state.promptVisible = tama.promptId[0] != 0;
  state.clockVisible = clocking;
  state.page = (DisplayPage)displayMode;
  state.completionVisible = completionVisible;
  state.liveCardVisible = liveCardVisible;
  state.hudEnabled = settings().hud;
  state.connected = tama.connected;
  state.transcriptRows = tama.nLines;
  return state;
}

// On a prompt, the encoder toggles which choice is highlighted; the button
// confirms it. Touch can also hit the on-screen buttons directly.
bool     promptDeny = false;        // false = approve highlighted, true = deny

// Cycle GIF (if installed) -> ASCII species 0..N-1 -> GIF.
static void nextPet() {
  uint8_t n = buddySpeciesCount();
  if (!buddyMode) {
    buddyMode = true;
    buddySetSpeciesIdx(0);
    speciesIdxSave(0);
  } else if (buddySpeciesIdx() + 1 >= n && gifAvailable) {
    buddyMode = false;
    speciesIdxSave(SPECIES_GIF);
  } else {
    buddyNextSpecies();
  }
  characterInvalidate();
  if (buddyMode) buddyInvalidate();
}

uint32_t wakeTransitionUntil = 0;
const uint32_t SCREEN_OFF_MS = 30000;

uint32_t promptArrivedMs = 0;
bool     responseSent = false;
WakeInputGuard wakeInputGuard;
bool lastBleLink = false;

static void applyBrightness() { hwSetBrightness(brightLevel); }

static void wake() {
  lastInteractMs = millis();
  if (screenOff) {
    hwScreenOn(brightLevel);
    screenOff = false;
    wakeTransitionUntil = millis() + 12000;
    statsOnWake();            // waking from rest tops up "energy"
  }
}

static void beep(uint16_t freq, uint16_t dur) {
  if (settings().sound) hwTone(freq, dur);
}

static bool sendCmd(const char* json) {
  Serial.println(json);
  size_t n = strlen(json);
  size_t sent = bleWrite((const uint8_t*)json, n);
  sent += bleWrite((const uint8_t*)"\n", 1);
  return bleConnected() && sent == n + 1;
}

static bool sendCompletionDismiss() {
  if (!tama.completion.pendingDismiss) return true;
  char cmd[112];
  snprintf(cmd, sizeof(cmd),
    "{\"cmd\":\"completion\",\"sg\":%lu,\"g\":%lu,\"action\":\"dismiss\"}",
    (unsigned long)tama.completion.pendingEpoch,
    (unsigned long)tama.completion.pendingGeneration);
  return sendCmd(cmd);
}

static void dismissCompletion() {
  if (!tama.completion.dismissLocal()) return;
  sendCompletionDismiss();
  buddyInvalidate();
  characterInvalidate();
}

const uint8_t INFO_PAGES = 7;
const uint8_t INFO_PG_CONTROLS = 1;
const uint8_t INFO_PG_CREDITS = 6;

void applyDisplayMode() {
  // Secondary pages and the selected-pal stats surface shrink the pet into the
  // header strip. The primary pal card keeps the full-size character.
  bool peek = displayMode == DISP_PET || displayMode == DISP_INFO
           || (displayMode == DISP_NORMAL && sessionStatsOpen && sessionsProjected());
  characterSetPeek(peek);
  buddySetPeek(peek);
  spr.fillSprite(0x0000);
  characterInvalidate();
}

// --- centered text helpers (round-safe: keep strings short) ----------------
static void cline(int y, uint16_t col, uint16_t bg, const char* fmt, ...) {
  char b[40]; va_list a; va_start(a, fmt); vsnprintf(b, sizeof(b), fmt, a); va_end(a);
  spr.setTextDatum(MC_DATUM);
  spr.setTextColor(col, bg);
  spr.drawString(b, CX, y);
  spr.setTextDatum(TL_DATUM);
}

// ---------------------------------------------------------------------------
// Menus — centered panels sized to stay inside the circle.
// ---------------------------------------------------------------------------
const char* menuItems[] = {
  "activity", "pet care", "info", "settings", "demo", "turn off", "close"
};
const uint8_t MENU_N = 7;

bool    settingsOpen = false;
uint8_t settingsSel  = 0;
// Dropped vs the Stick: "led" (no user LED) and "clock rot" (round, no
// orientation). Indices below map to applySetting().
const char* settingsItems[] = {
  "brightness", "attitude", "sound", "bluetooth", "wifi",
  "transcript", "ascii pet", "reset", "back"
};
const uint8_t SETTINGS_N = 9;

bool    resetOpen = false;
uint8_t resetSel  = 0;
const char* resetItems[] = { "delete char", "factory reset", "back" };
const uint8_t RESET_N = 3;
static uint32_t resetConfirmUntil = 0;
static uint8_t  resetConfirmIdx = 0xFF;

static void applySetting(uint8_t idx) {
  Settings& s = settings();
  switch (idx) {
    case 0: brightLevel = (brightLevel + 1) % 5; applyBrightness(); return;
    case 1:
      s.attitude = s.attitude == ATTITUDE_KIND ? ATTITUDE_ASSERTIVE : ATTITUDE_KIND;
      break;
    case 2: s.sound = !s.sound; break;
    case 3: s.bt = !s.bt; break;     // stored preference only — BLE stays live
    case 4: s.wifi = !s.wifi; break; // stored only — no WiFi stack linked
    case 5: s.hud = !s.hud; break;
    case 6: nextPet(); return;
    case 7: resetOpen = true; resetSel = 0; resetConfirmIdx = 0xFF; return;
    case 8: settingsOpen = false; characterInvalidate(); return;
  }
  settingsSave();
}

// Tap-twice confirm: first tap arms ("really?"), second within 3s executes.
static void applyReset(uint8_t idx) {
  uint32_t now = millis();
  bool armed = (resetConfirmIdx == idx) && (int32_t)(now - resetConfirmUntil) < 0;
  if (idx == 2) { resetOpen = false; return; }
  if (!armed) { resetConfirmIdx = idx; resetConfirmUntil = now + 3000; beep(1400, 60); return; }

  beep(800, 200);
  if (idx == 0) {
    File d = LittleFS.open("/characters");
    if (d && d.isDirectory()) {
      File e;
      while ((e = d.openNextFile())) {
        char path[80];
        snprintf(path, sizeof(path), "/characters/%s", e.name());
        if (e.isDirectory()) {
          File f;
          while ((f = e.openNextFile())) {
            char fp[128]; snprintf(fp, sizeof(fp), "%s/%s", path, f.name());
            f.close(); LittleFS.remove(fp);
          }
          e.close(); LittleFS.rmdir(path);
        } else { e.close(); LittleFS.remove(path); }
      }
      d.close();
    }
  } else {
    _prefs.begin("buddy", false); _prefs.clear(); _prefs.end();
    LittleFS.format();
    bleClearBonds();
  }
  delay(300);
  ESP.restart();
}

// A vertically-centered list panel. Returns nothing; selection highlighted.
static void drawListPanel(const char* const* items, uint8_t n, uint8_t sel,
                          uint16_t border, bool resetArm) {
  const Palette& p = characterPalette();
  const int rowH = 16;
  int mw = 150, mh = 14 + n * rowH + 8;
  int mx = (W - mw) / 2, my = (H - mh) / 2;
  spr.fillRoundRect(mx, my, mw, mh, 6, PANEL);
  spr.drawRoundRect(mx, my, mw, mh, 6, border);
  spr.setTextSize(1);
  Settings& s = settings();
  bool vals[] = { s.sound, s.bt, s.wifi, s.hud };
  for (int i = 0; i < n; i++) {
    bool seld = (i == sel);
    int ry = my + 12 + i * rowH;
    spr.setTextColor(seld ? p.text : p.textDim, PANEL);
    spr.setCursor(mx + 12, ry);
    spr.print(seld ? "> " : "  ");
    // reset-arm: items show "really?" when armed (only for the reset panel)
    if (resetArm && (i == resetConfirmIdx) && (int32_t)(millis() - resetConfirmUntil) < 0) {
      spr.setTextColor(HOT, PANEL); spr.print("really?");
      continue;
    }
    spr.print(items[i]);
    // settings value readouts on the right
    if (items == settingsItems) {
      if (i == 0) {
        spr.setCursor(mx + mw - 40, ry);
        spr.setTextColor(p.textDim, PANEL);
        spr.printf("%u/4", brightLevel);
      }
      else if (i == 1) {
        spr.setCursor(mx + mw - 58, ry);
        spr.setTextColor(p.textDim, PANEL);
        spr.print(s.attitude == ATTITUDE_KIND ? "kind" : "assertive");
      }
      else if (i >= 2 && i <= 5) {
        spr.setCursor(mx + mw - 40, ry);
        spr.setTextColor(vals[i-2] ? GREEN : p.textDim, PANEL);
        spr.print(vals[i-2] ? " on" : "off");
      }
      else if (i == 6) {
        spr.setCursor(mx + mw - 40, ry);
        uint8_t total = buddySpeciesCount() + (gifAvailable ? 1 : 0);
        uint8_t pos = buddyMode ? buddySpeciesIdx() + 1 : total;
        spr.setTextColor(p.textDim, PANEL); spr.printf("%u/%u", pos, total);
      }
    }
    if (items == menuItems && i == 4) { spr.setTextColor(p.textDim, PANEL); spr.print(dataDemo() ? "  on" : " off"); }
  }
  // hint footer
  const Palette& q = p;
  spr.setTextColor(q.textDim, PANEL);
  spr.setTextDatum(MC_DATUM);
  spr.drawString("turn: move   press: select", CX, my + mh - 2);
  spr.setTextDatum(TL_DATUM);
}

static void drawMenu()     { drawListPanel(menuItems, MENU_N, menuSel, characterPalette().textDim, false); }
static void drawSettings() { drawListPanel(settingsItems, SETTINGS_N, settingsSel, characterPalette().textDim, false); }
static void drawReset()    { drawListPanel(resetItems, RESET_N, resetSel, HOT, true); }

void menuConfirm() {
  switch (menuSel) {
    case 0:
      menuOpen = false;
      sessionStatsOpen = false;
      displayMode = DISP_ACTIVITY;
      applyDisplayMode();
      break;
    case 1:
      menuOpen = false;
      sessionStatsOpen = false;
      displayMode = DISP_PET;
      applyDisplayMode();
      break;
    case 2:
      menuOpen = false;
      sessionStatsOpen = false;
      displayMode = DISP_INFO;
      infoPage = INFO_PG_CONTROLS;
      applyDisplayMode();
      break;
    case 3: settingsOpen = true; menuOpen = false; settingsSel = 0; break;
    case 4:
      dataSetDemo(!dataDemo());
      menuOpen = false;
      sessionStatsOpen = false;
      displayMode = DISP_NORMAL;
      applyDisplayMode();
      break;
    case 5: hwPowerOff(); break;
    case 6: menuOpen = false; characterInvalidate(); break;
  }
}

// ---------------------------------------------------------------------------
// Clock — single centered layout (the round screen has no orientation).
// ---------------------------------------------------------------------------
static const char* const MON[] = { "Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec" };
static const char* const DOW[] = { "Sun","Mon","Tue","Wed","Thu","Fri","Sat" };

static m5::rtc_datetime_t _clk;
uint32_t _clkLastRead = 0;     // zeroed by data.h on time-sync
static bool _onUsb = false;
static void clockRefreshRtc() {
  if (millis() - _clkLastRead < 1000) return;
  _clkLastRead = millis();
  _onUsb = hwOnUsb();
  _clk = hwGetClock();
}
static uint8_t clockDow() { return ((_clk.date.weekDay % 7) + 7) % 7; }

static void drawClock() {
  const Palette& p = characterPalette();
  // Date+time pinned to the very top (above the full-size pet); session info
  // (model / effort / tokens) sits in a band at the very bottom.
  uint8_t mi = (_clk.date.month >= 1 && _clk.date.month <= 12) ? _clk.date.month - 1 : 0;
  char dt[28]; snprintf(dt, sizeof(dt), "%s %s %u  %02u:%02u",
                        DOW[clockDow()], MON[mi], _clk.date.date,
                        _clk.time.hours, _clk.time.minutes);

  spr.setTextDatum(MC_DATUM);
  // Top strip: date+time, small + dim, nudged down from the very edge.
  spr.fillRect(0, 0, W, 28, p.bg);
  spr.setTextSize(1); spr.setTextColor(p.textDim, p.bg); spr.drawString(dt, CX, 15);
  // Bottom band removed (model/effort live on the pet stats page); just clear
  // the area below the full-size pet so nothing stale lingers.
  spr.fillRect(0, 186, W, H - 186, p.bg);
  spr.setTextDatum(TL_DATUM);
}

PersonaState derive(const TamaState& s) {
  if (!s.connected)            return P_SLEEP;
  if (s.sessionsWaiting > 0)   return P_ATTENTION;
  if (s.recentlyCompleted)     return P_CELEBRATE;
  // "Thinking": the agent is actively running. The bridge's running count
  // already has a ~20s grace so brief tool-execution gaps don't drop us out of
  // busy; any open request => the buddy visibly thinks (P_BUSY). Otherwise it's
  // idle/bored and (via the idle clock + night decay) drifts to sleep.
  if (s.sessionsRunning >= 1)  return P_BUSY;
  return P_IDLE;
}

void triggerOneShot(PersonaState s, uint32_t durMs) {
  activeState = s;
  oneShotUntil = millis() + durMs;
}

// Present queued token milestones only while the pal surface is genuinely
// visible. Each award selects its owning pal and runs the existing heart
// animation; missing rows are discarded instead of animating the wrong pal.
static bool sessionHeartPoll(uint32_t now, bool canPresent) {
  if (!canPresent || (int32_t)(now - oneShotUntil) < 0) return false;
  char id[SESSION_ID_LEN + 1];
  while (sessionHeartQueuePop(tama.heartAwards, id, sizeof(id))) {
    int idx = sessionPalFind(tama.sessions, id);
    if (idx < 0) continue;
    strncpy(selSessionId, id, sizeof(selSessionId) - 1);
    selSessionId[sizeof(selSessionId) - 1] = 0;
    selSessionIdx = idx;
    triggerOneShot(P_HEART, 1600);
    strncpy(tokenHeartOwnerId, id, sizeof(tokenHeartOwnerId) - 1);
    tokenHeartOwnerId[sizeof(tokenHeartOwnerId) - 1] = 0;
    tokenHeartUntil = oneShotUntil;
    buddyInvalidate();
    beep(2600, 35);
    return true;
  }
  return false;
}

static bool tokenHeartActive(uint32_t now) {
  if (!tokenHeartOwnerId[0]) return false;
  bool withinAward = (int32_t)(now - tokenHeartUntil) < 0;
  int ownerIdx = sessionPalFind(tama.sessions, tokenHeartOwnerId);
  if (withinAward && ownerIdx >= 0) {
    strncpy(selSessionId, tokenHeartOwnerId, sizeof(selSessionId) - 1);
    selSessionId[sizeof(selSessionId) - 1] = 0;
    selSessionIdx = ownerIdx;
    return true;
  }
  if (withinAward && activeState == P_HEART && oneShotUntil == tokenHeartUntil) {
    oneShotUntil = now;
  }
  tokenHeartOwnerId[0] = 0;
  tokenHeartUntil = 0;
  return false;
}

// ---------------------------------------------------------------------------
// Session carousel bookkeeping.
//
// Selection is keyed on the stable display ID, so a re-rank between heartbeats
// never slides a different pal under the user. A row that *transitions* into
// waiting/blocked pulls focus once — but only if the user has not touched the
// dial in the last 15s, so browsing is never hijacked, and a session that sits
// blocked forever cannot re-grab focus on every frame.
// ---------------------------------------------------------------------------
static void sessionSelectionUpdate(uint32_t now) {
  SessionPalSet& set = tama.sessions;
  if (set.count == 0) {
    selSessionIdx = -1;
    selSessionId[0] = 0;
    prevSessCount = 0;
    return;
  }

  bool browsing = lastCarouselMs && (now - lastCarouselMs) < CAROUSEL_HOLD_MS;
  int focus = -1;
  for (uint8_t i = 0; i < set.count && focus < 0; i++) {
    if (!sessionStateNeedsAttention(set.pals[i].state)) continue;
    bool known = false, wasNeedy = false;
    for (uint8_t j = 0; j < prevSessCount; j++) {
      if (strcmp(prevSessIds[j], set.pals[i].id) != 0) continue;
      known = true;
      wasNeedy = sessionStateNeedsAttention(prevSessStates[j]);
      break;
    }
    if (!known || !wasNeedy) focus = i;
  }
  if (focus >= 0 && !browsing) {
    strncpy(selSessionId, set.pals[focus].id, sizeof(selSessionId) - 1);
    selSessionId[sizeof(selSessionId) - 1] = 0;
  }

  // Falls back to the highest-ranked row when the tracked ID disappeared.
  selSessionIdx = sessionSelectionResolve(set, selSessionId, sizeof(selSessionId));

  prevSessCount = set.count;
  for (uint8_t i = 0; i < set.count; i++) {
    memcpy(prevSessIds[i], set.pals[i].id, SESSION_ID_LEN + 1);
    prevSessStates[i] = set.pals[i].state;
  }
}

// Push (or withdraw) the selected session's species + palette on the renderer.
static void sessionPalApply(bool cardActive) {
  if (cardActive && selSessionIdx >= 0 && selSessionIdx < (int)tama.sessions.count) {
    const SessionPal& s = tama.sessions.pals[selSessionIdx];
    buddySetSessionPal(s.species, s.colors);
  } else {
    buddyClearSessionPal();
  }
}

// ---------------------------------------------------------------------------
// Info / pet / passkey / approval / HUD — centered for the round screen.
// ---------------------------------------------------------------------------
static void _infoHeader(const Palette& p, const char* section, uint8_t page) {
  cline(58, p.text, p.bg, "Info  %u/%u", page + 1, INFO_PAGES);
  cline(74, p.body, p.bg, "%s", section);
}

void drawPasskey() {
  const Palette& p = characterPalette();
  spr.fillSprite(p.bg);
  spr.setTextSize(1);
  cline(70, p.textDim, p.bg, "BLUETOOTH PAIRING");
  spr.setTextDatum(MC_DATUM);
  spr.setTextColor(p.text, p.bg);
  spr.setTextSize(3);
  char b[8]; snprintf(b, sizeof(b), "%06lu", (unsigned long)blePasskey());
  spr.drawString(b, CX, 120);
  spr.setTextSize(1);
  spr.setTextDatum(TL_DATUM);
  cline(170, p.textDim, p.bg, "enter on computer");
}

void drawInfo() {
  const Palette& p = characterPalette();
  const int TOP = 92;
  spr.fillRect(0, 50, W, H - 50, p.bg);
  spr.setTextSize(1);
  int y = TOP;
  auto ln = [&](uint16_t c, const char* fmt, ...) {
    char b[40]; va_list a; va_start(a, fmt); vsnprintf(b, sizeof(b), fmt, a); va_end(a);
    cline(y, c, p.bg, "%s", b); y += 11;
  };

  if (infoPage == 0) {
    _infoHeader(p, "ABOUT", infoPage);
    ln(p.textDim, "I watch your Copilot");
    ln(p.textDim, "CLI sessions.");
    y += 4;
    ln(p.textDim, "I wake when you work,");
    ln(p.textDim, "fret when approvals");
    ln(p.textDim, "pile up.");
    y += 4;
    ln(p.text, "Tap / press on a");
    ln(p.text, "prompt to approve.");

  } else if (infoPage == 1) {
    _infoHeader(p, "CONTROLS", infoPage);
    ln(p.text,    "rotary dial");
    ln(p.textDim, sessionsProjected() ? "browse pals / navigate"
                                      : "scroll / navigate");
    y += 3;
    ln(p.text,    "button (press)");
    ln(p.textDim, sessionsProjected() ? "pal stats / back"
                                      : "return to pals");
    y += 3;
    ln(p.text,    "hold button");
    ln(p.textDim, "open menu");
    y += 3;
    ln(p.text,    "touch");
    ln(p.textDim, "approve / deny, wake");

  } else if (infoPage == 2) {
    _infoHeader(p, "COPILOT", infoPage);
    ln(p.textDim, "sessions  %u", tama.sessionsTotal);
    ln(p.textDim, "running   %u", tama.sessionsRunning);
    ln(p.textDim, "waiting   %u", tama.sessionsWaiting);
    y += 6;
    ln(p.text,    "LINK");
    ln(p.textDim, "via   %s", dataScenarioName());
    ln(p.textDim, "ble   %s", !bleConnected() ? "-" : bleSecure() ? "encrypted" : "OPEN");
    ln(p.textDim, "state %s", stateNames[activeState]);

  } else if (infoPage == 3) {
    _infoHeader(p, "DEVICE", infoPage);
    int pct = hwBatteryPct();
    int vBat = hwBatteryVoltage_mV();
    if (hwBatteryKnown() && vBat > 0) {
      cline(100, p.text, p.bg, "%d%%  %s", pct, hwCharging() ? "charging" : "battery");
      y = 120;
      ln(p.textDim, "battery %d.%02dV", vBat/1000, (vBat%1000)/10);
    } else {
      cline(100, p.text, p.bg, "no fuel gauge");
      y = 120;
      ln(p.textDim, "battery: n/a");
    }
    uint32_t up = millis() / 1000;
    ln(p.textDim, "uptime  %luh %02lum", up/3600, (up/60)%60);
    ln(p.textDim, "heap    %uKB", ESP.getFreeHeap()/1024);
    if (ownerName()[0]) ln(p.textDim, "owner   %s", ownerName());

  } else if (infoPage == 4) {
    _infoHeader(p, "BLUETOOTH", infoPage);
    bool linked = settings().bt && dataBtActive();
    cline(100, linked ? GREEN : (settings().bt ? HOT : p.textDim), p.bg,
          "%s", linked ? "linked" : (settings().bt ? "discover" : "off"));
    y = 120;
    ln(p.text, "%s", btName);
    uint8_t mac[6] = {0}; hwReadMac(mac);
    ln(p.textDim, "%02X:%02X:%02X:%02X:%02X:%02X", mac[0],mac[1],mac[2],mac[3],mac[4],mac[5]);
    if (!linked && settings().bt) {
      y += 4;
      ln(p.text,    "run the co-mpanion");
      ln(p.text,    "bridge to connect");
    }

  } else if (infoPage == 5) {
    _infoHeader(p, "PET CARE", infoPage);
    ln(p.body,    "MOOD");
    ln(p.textDim, "approve fast = up");
    y += 3;
    ln(p.body,    "FED");
    ln(p.textDim, "50K tokens = level up");
    y += 3;
    ln(p.body,    "ENERGY");
    ln(p.textDim, "rest (sleep) refills");

  } else {
    _infoHeader(p, "CREDITS", infoPage);
    ln(p.textDim, "co-mpanion");
    ln(p.text,    "github.com/vkorotchenko");
    ln(p.text,    "/co-mpanion");
    y += 6;
    ln(p.textDim, "hardware");
    ln(p.text,    "M5Dial");
    ln(p.textDim, "ESP32-S3 + RTC8563");
  }
}

static void tinyHeart(int x, int y, bool filled, uint16_t col) {
  if (filled) {
    spr.fillCircle(x - 2, y, 2, col);
    spr.fillCircle(x + 2, y, 2, col);
    spr.fillTriangle(x - 4, y + 1, x + 4, y + 1, x, y + 5, col);
  } else {
    spr.drawCircle(x - 2, y, 2, col);
    spr.drawCircle(x + 2, y, 2, col);
    spr.drawLine(x - 4, y + 1, x, y + 5, col);
    spr.drawLine(x + 4, y + 1, x, y + 5, col);
  }
}

static void drawPetStats(const Palette& p) {
  spr.fillRect(0, 86, W, H - 86, p.bg);
  spr.setTextSize(1);
  int y = 96;

  // mood
  cline(y, p.textDim, p.bg, "mood"); y += 12;
  uint8_t mood = statsMoodTier();
  uint16_t moodCol = (mood >= 3) ? RED : (mood >= 2) ? HOT : p.textDim;
  for (int i = 0; i < 4; i++) tinyHeart(CX - 24 + i * 16, y, i < mood, moodCol);
  y += 16;

  // fed
  cline(y, p.textDim, p.bg, "fed"); y += 12;
  uint8_t fed = statsFedProgress();
  for (int i = 0; i < 10; i++) {
    int px = CX - 45 + i * 9;
    if (i < fed) spr.fillCircle(px, y, 2, p.body);
    else spr.drawCircle(px, y, 2, p.textDim);
  }
  y += 16;

  // energy
  cline(y, p.textDim, p.bg, "energy"); y += 12;
  uint8_t en = statsEnergyTier();
  uint16_t enCol = (en >= 4) ? 0x07FF : (en >= 2) ? 0xFFE0 : HOT;
  for (int i = 0; i < 5; i++) {
    int px = CX - 32 + i * 13;
    if (i < en) spr.fillRect(px, y - 3, 9, 6, enCol);
    else spr.drawRect(px, y - 3, 9, 6, p.textDim);
  }
  y += 18;

  cline(y, p.body, p.bg, "Lv %u  approved %u", stats().level, stats().approvals);

  // Active session model + reasoning effort (moved here from the home band).
  if (tama.model[0]) {
    y += 16;
    if (tama.effort[0]) cline(y, p.textDim, p.bg, "%s  %s", tama.model, tama.effort);
    else                cline(y, p.textDim, p.bg, "%s", tama.model);
  }
}

static void drawSessionStats(const SessionPal& s, uint8_t position, uint8_t total) {
  const uint16_t bg = s.colors[1];
  const uint16_t text = s.colors[2], dim = s.colors[3], body = s.colors[0];
  spr.fillRect(0, 68, W, H - 68, bg);
  spr.setTextSize(1);

  if (total > 1) {
    cline(76, text, bg, "%s  %u/%u", buddySpeciesNameAt(s.species), position, total);
  } else {
    cline(76, text, bg, "%s stats", buddySpeciesNameAt(s.species));
  }

  cline(92, dim, bg, "TOKENS");
  if (sessionUsageKnown(s) || sessionInputUsageKnown(s)) {
    char input[12] = "-", output[12] = "-";
    if (sessionInputUsageKnown(s)) sessionFormatTokens(s.inputTokens, input, sizeof(input));
    if (sessionUsageKnown(s)) sessionFormatTokens(s.outputTokens, output, sizeof(output));
    cline(104, text, bg, "in %s   out %s", input, output);
  } else {
    cline(104, dim, bg, "unavailable");
  }

  if (sessionUsageKnown(s)) {
    uint32_t hearts = sessionHeartCount(s);
    uint8_t progress = sessionHeartProgress(s);
    tinyHeart(CX - 48, 119, true, HOT);
    cline(119, text, bg, "%lu hearts  %u/100",
          (unsigned long)hearts, progress);
    const int barW = 106;
    spr.drawRoundRect(CX - barW / 2, 129, barW, 7, 3, dim);
    int fill = (barW - 2) * progress / SESSION_TOKENS_PER_HEART;
    if (fill > 0) spr.fillRoundRect(CX - barW / 2 + 1, 130, fill, 5, 2, body);
  }

  cline(148, dim, bg, s.modelCount > 1 ? "MODEL  (%u used)" : "MODEL",
        s.modelCount);
  if (s.model[0]) cline(160, text, bg, "%s", s.model);
  else            cline(160, dim, bg, "unavailable");

  if (sessionContextKnown(s)) {
    uint8_t pct = sessionContextPercent(s);
    cline(179, dim, bg, "CONTEXT  %u%%", pct);
    const int barW = 120;
    spr.drawRoundRect(CX - barW / 2, 190, barW, 9, 4, dim);
    int fill = (barW - 2) * pct / 100;
    if (fill > 0) {
      uint16_t color = pct >= 85 ? HOT : body;
      spr.fillRoundRect(CX - barW / 2 + 1, 191, fill, 7, 3, color);
    }
  } else {
    cline(181, dim, bg, "context unavailable");
  }

  cline(220, text, bg, "press: pal");
}

void drawPet() {
  const Palette& p = characterPalette();
  drawPetStats(p);
  spr.setTextSize(1);
  if (ownerName()[0]) cline(76, p.text, p.bg, "%s's %s", ownerName(), petName());
  else                cline(76, p.text, p.bg, "%s", petName());
}

// Approval prompt: tool name centered, two touch buttons below. The currently
// highlighted choice (encoder-selectable) gets a bright border.
static const int APPR_BTN_Y = 188, APPR_BTN_H = 34, APPR_BTN_W = 74;
static const int APPR_DENY_CX = 76, APPR_APPR_CX = 164;
static uint8_t wrapInto(const char* in, char out[][24], uint8_t maxRows, uint8_t width);
static void drawApproval() {
  const Palette& p = characterPalette();
  spr.fillRect(0, 96, W, H - 96, p.bg);

  uint32_t waited = (millis() - promptArrivedMs) / 1000;
  cline(108, waited >= 10 ? HOT : p.textDim, p.bg, "approve?  %lus", (unsigned long)waited);

  spr.setTextDatum(MC_DATUM);
  spr.setTextColor(p.text, p.bg);
  int toolLen = strlen(tama.promptTool);
  spr.setTextSize(toolLen <= 11 ? 2 : 1);
  spr.drawString(tama.promptTool, CX, 132);
  spr.setTextSize(1);
  spr.setTextColor(p.textDim, p.bg);
  if (tama.promptHint[0]) {
    // Word-wrap the hint onto up to two lines instead of clipping it — the
    // detail can be up to 43 chars and a single line only fit ~21.
    char wrapped[2][24];
    uint8_t rows = wrapInto(tama.promptHint, wrapped, 2, 22);
    for (uint8_t i = 0; i < rows; i++) spr.drawString(wrapped[i], CX, 150 + i * 11);
  }
  spr.setTextDatum(TL_DATUM);

  if (responseSent) {
    cline(190, p.textDim, p.bg, "sent...");
    return;
  }

  // buttons
  int by = APPR_BTN_Y - APPR_BTN_H / 2;
  // deny
  spr.fillRoundRect(APPR_DENY_CX - APPR_BTN_W/2, by, APPR_BTN_W, APPR_BTN_H, 6, PANEL);
  spr.drawRoundRect(APPR_DENY_CX - APPR_BTN_W/2, by, APPR_BTN_W, APPR_BTN_H, 6, promptDeny ? HOT : p.textDim);
  // approve
  spr.fillRoundRect(APPR_APPR_CX - APPR_BTN_W/2, by, APPR_BTN_W, APPR_BTN_H, 6, PANEL);
  spr.drawRoundRect(APPR_APPR_CX - APPR_BTN_W/2, by, APPR_BTN_W, APPR_BTN_H, 6, !promptDeny ? GREEN : p.textDim);
  spr.setTextDatum(MC_DATUM);
  spr.setTextColor(HOT, PANEL);   spr.drawString("deny",    APPR_DENY_CX, APPR_BTN_Y);
  spr.setTextColor(GREEN, PANEL); spr.drawString("approve", APPR_APPR_CX, APPR_BTN_Y);
  spr.setTextDatum(TL_DATUM);
}

// Greedy word-wrap into fixed-width rows.
static uint8_t wrapInto(const char* in, char out[][24], uint8_t maxRows, uint8_t width) {
  uint8_t row = 0, col = 0;
  const char* p = in;
  while (*p && row < maxRows) {
    while (*p == ' ') p++;
    const char* w = p;
    while (*p && *p != ' ') p++;
    uint8_t wlen = p - w;
    if (wlen == 0) break;
    uint8_t need = (col > 0 ? 1 : 0) + wlen;
    if (col + need > width) {
      out[row][col] = 0;
      if (++row >= maxRows) return row;
      col = 0;
    }
    if (col > 0) out[row][col++] = ' ';
    while (wlen > width - col) {
      uint8_t take = width - col;
      memcpy(&out[row][col], w, take); col += take; w += take; wlen -= take;
      out[row][col] = 0;
      if (++row >= maxRows) return row;
      col = 0;
    }
    memcpy(&out[row][col], w, wlen); col += wlen;
  }
  if (col > 0 && row < maxRows) { out[row][col] = 0; row++; }
  return row;
}

// Max wrapped transcript lines we buffer for scrolling. Longer (now
// untruncated) prompts wrap into several rows each, so keep generous headroom.
static const uint8_t HUD_ROWS_MAX = 48;

void drawHUD() {
  if (tama.promptId[0]) { drawApproval(); return; }
  const Palette& p = characterPalette();
  const int LH = 12, WIDTH = 20;
  spr.fillRect(0, 150, W, H - 150, p.bg);
  spr.setTextSize(1);

  if (tama.lineGen != lastLineGen) { msgScroll = 0; lastLineGen = tama.lineGen; wake(); }

  // Two layouts. Not scrolled: a compact "live" ticker up top of the lower band,
  // with the active model/effort/tokens pinned to the very bottom so they stay
  // visible during a session (not just on the idle clock). Scrolled back: a
  // taller reader takes the whole band and shows the full (untruncated) text of
  // past turns, paging line-by-line; a touch tap closes it.
  const bool reading = msgScroll > 0;
  const int SHOW = reading ? 6 : 3;
  const int BASE = reading ? 150 : 160;

  ActivityContentKind content = activityContentKind(tama.connected, tama.nLines);
  bool transcriptVisible = activityShowsTranscript(tama.connected, tama.nLines);
  if (content == ACTIVITY_DISCONNECTED) {
    cline(BASE + LH, p.text, p.bg, "No Copilot connected");
  } else if (content == ACTIVITY_MESSAGE) {
    cline(BASE + LH, p.text, p.bg, "%s", tama.msg);
  } else if (transcriptVisible) {
    static char disp[HUD_ROWS_MAX][24];
    static uint8_t srcOf[HUD_ROWS_MAX];
    uint8_t nDisp = 0;
    for (uint8_t i = 0; i < tama.nLines && nDisp < HUD_ROWS_MAX; i++) {
      uint8_t got = wrapInto(tama.lines[i], &disp[nDisp], HUD_ROWS_MAX - nDisp, WIDTH);
      for (uint8_t j = 0; j < got; j++) srcOf[nDisp + j] = i;
      nDisp += got;
    }

    uint8_t maxBack = (nDisp > SHOW) ? (nDisp - SHOW) : 0;
    if (msgScroll > maxBack) msgScroll = maxBack;
    int end = (int)nDisp - msgScroll;
    int start = end - SHOW; if (start < 0) start = 0;
    for (int i = 0; start + i < end; i++) {
      uint8_t row = start + i;
      bool fresh = transcriptRowIsCurrent(srcOf[row], tama.nLines, msgScroll);
      cline(BASE + i * LH, fresh ? p.text : p.textDim, p.bg, "%s", disp[row]);
    }
    if (reading) cline(BASE + SHOW * LH, p.body, p.bg, "tap to exit  -%u", msgScroll);
  }
}

// ---------------------------------------------------------------------------
// Session pal card — owns DISP_NORMAL whenever the bridge projected sessions.
// One 2× pal is already rendered above by buddyTick(); this draws the lower
// band: who it is, what it is doing, its state, and the roster.
// ---------------------------------------------------------------------------
static uint16_t sessionStateColor(const SessionPal& s) {
  switch (s.state) {
    case SESS_BLOCKED:  return HOT;
    case SESS_WAITING:  return 0xFD20;      // amber
    case SESS_WORKING:
    case SESS_THINKING: return s.colors[0]; // body
    default:            return s.colors[3]; // textDim
  }
}

static void drawSessionAttentionCount(uint8_t count) {
  if (count == 0) return;
  char value[4];
  snprintf(value, sizeof(value), "%u", count);
  spr.setTextDatum(MC_DATUM);
  spr.setTextSize(2);
  spr.setTextColor(RED);
  spr.drawCircle(190, 40, 11, RED);
  spr.drawString(value, 190, 40);
  spr.setTextDatum(TL_DATUM);
}

void drawSessionCard() {
  const SessionPalSet& set = tama.sessions;
  if (selSessionIdx < 0 || selSessionIdx >= (int)set.count) return;
  const SessionPal& s = set.pals[selSessionIdx];
  if (sessionStatsOpen) {
    drawSessionStats(s, (uint8_t)(selSessionIdx + 1), set.count);
    return;
  }
  const uint16_t bg = s.colors[1];
  const uint16_t text = s.colors[2], dim = s.colors[3], ink = s.colors[4];
  const bool solo = (set.count == 1);

  spr.fillRect(0, 146, W, H - 146, bg);
  spr.setTextSize(1);

  // Header: species, cumulative official output tokens when available, and
  // carousel position when there is anything to navigate.
  if (sessionUsageKnown(s)) {
    char tokens[12];
    sessionFormatTokens(s.outputTokens, tokens, sizeof(tokens));
    if (solo) cline(156, text, bg, "%s  %s tok", buddySpeciesNameAt(s.species), tokens);
    else      cline(156, text, bg, "%s  %s  %d/%u", buddySpeciesNameAt(s.species),
                    tokens, selSessionIdx + 1, set.count);
  } else if (solo) {
    cline(156, text, bg, "%s", buddySpeciesNameAt(s.species));
  } else {
    cline(156, text, bg, "%s  %d/%u", buddySpeciesNameAt(s.species),
          selSessionIdx + 1, set.count);
  }

  if (dataDemoAssertive()) {
    spr.fillRoundRect(24, 168, W - 48, 30, 7, text);
    spr.drawRoundRect(24, 168, W - 48, 30, 7, HOT);
    cline(183, ink, text, "GET BACK TO WORK!!");
    cline(207, GREEN, bg, "+ SUCCESS");
  } else {
    // Summary: UTF-8 flattened to display columns, then wrapped to two rows so
    // a long line degrades with ".." instead of running off the round edge.
    char flat[SESSION_SUMMARY_BYTES + 1];
    sessionSummaryDisplay(s.summary, flat, sizeof(flat));
    char rows[2][23];
    uint8_t n = sessionWrap(flat, &rows[0][0], 2, sizeof(rows[0]), 22);
    for (uint8_t i = 0; i < n; i++) cline(174 + i * 11, dim, bg, "%s", rows[i]);

    // State pill — filled in the state colour, labelled in the palette's ink.
    const bool demoCelebrate = dataDemoCompleted();
    const char* nm = demoCelebrate ? "celebrate" : sessionStateName(s.state);
    uint16_t pillBg = demoCelebrate ? GREEN : sessionStateColor(s);
    int pw = (int)strlen(nm) * 6 + 14;
    int py = solo ? 204 : 199;
    spr.fillRoundRect(CX - pw / 2, py, pw, 15, 7, pillBg);
    spr.setTextDatum(MC_DATUM);
    spr.setTextColor(ink, pillBg);
    spr.drawString(nm, CX, py + 7);
    spr.setTextDatum(TL_DATUM);
  }

  // Roster dots, one per projected session in bridge rank order. Body colour
  // identifies each pal; the selected one gets a white ring and an ink pip,
  // and anything needing a human gets a hot ring so it is visible while you
  // are looking at a different pal.
  if (solo) {
    cline(231, text, bg, "press: stats");
    return;
  }
  const int dy = 223, gap = 14;
  int x0 = CX - (int)(set.count - 1) * gap / 2;
  for (uint8_t i = 0; i < set.count; i++) {
    int cx = x0 + i * gap;
    uint16_t c = set.pals[i].colors[0];
    if ((int)i == selSessionIdx) {
      spr.fillCircle(cx, dy, 5, c);
      spr.drawCircle(cx, dy, 5, 0xFFFF);
      spr.fillCircle(cx, dy, 1, ink);
    } else {
      spr.fillCircle(cx, dy, 3, c);
      if (sessionStateNeedsAttention(set.pals[i].state)) spr.drawCircle(cx, dy, 5, HOT);
    }
  }
}

static const int COMPLETION_PILL_Y = 194;
static const int COMPLETION_PILL_H = 18;
static const int COMPLETION_PILL_W = 92;

static bool touchInCompletionPill(int x, int y) {
  return x >= CX - COMPLETION_PILL_W / 2 && x <= CX + COMPLETION_PILL_W / 2
      && y >= COMPLETION_PILL_Y && y <= COMPLETION_PILL_Y + COMPLETION_PILL_H;
}

static void drawCompletionCard(uint32_t now) {
  const CompletionLatch& c = tama.completion.latch;
  const bool owner = (c.flags & COMPLETION_HAS_OWNER) != 0;
  const bool assertive = c.outcome == COMPLETION_SUCCESS
                      && settings().attitude == ATTITUDE_ASSERTIVE;
  const Palette& saved = characterPalette();
  const uint16_t bg = owner ? c.colors[1] : saved.bg;
  const uint16_t text = owner ? c.colors[2] : saved.text;
  const uint16_t dim = owner ? c.colors[3] : saved.textDim;
  const uint16_t ink = owner ? c.colors[4] : saved.ink;

  spr.fillRect(0, 142, W, H - 142, bg);
  spr.setTextSize(1);
  if (owner) cline(151, text, bg, "%s", buddySpeciesNameAt(c.species));
  else cline(151, text, bg, "%s", buddyMode ? buddySpeciesName() : petName());

  if (assertive) {
    spr.fillRoundRect(24, 159, W - 48, 30, 7, text);
    spr.drawRoundRect(24, 159, W - 48, 30, 7, HOT);
    cline(174, ink, text, "GET BACK TO WORK!!");
  } else {
    char flat[49];
    const char* summary = owner && c.summary[0] ? c.summary : "Copilot finished";
    sessionSummaryDisplay(summary, flat, sizeof(flat));
    char rows[2][23];
    uint8_t rowCount = sessionWrap(flat, &rows[0][0], 2, sizeof(rows[0]), 22);
    for (uint8_t i = 0; i < rowCount; i++) cline(164 + i * 11, dim, bg, "%s", rows[i]);
  }

  const char* label = "FINISHED";
  const char* glyph = "=";
  uint16_t pill = dim;
  if (c.outcome == COMPLETION_SUCCESS && owner) { label = "SUCCESS"; glyph = "+"; pill = GREEN; }
  else if (c.outcome == COMPLETION_FAILED) { label = "FAILED"; glyph = "X"; pill = HOT; }
  else if (c.outcome == COMPLETION_ABORTED) { label = "ABORTED"; glyph = "-"; pill = dim; }
  char badge[20];
  snprintf(badge, sizeof(badge), "%s  %s", glyph, label);
  spr.fillRoundRect(CX - COMPLETION_PILL_W / 2, COMPLETION_PILL_Y,
                    COMPLETION_PILL_W, COMPLETION_PILL_H, 9, pill);
  spr.setTextDatum(MC_DATUM);
  spr.setTextColor(ink, pill);
  spr.drawString(badge, CX, COMPLETION_PILL_Y + COMPLETION_PILL_H / 2);
  spr.setTextDatum(TL_DATUM);

  if (c.flags & COMPLETION_HAS_DURATION) {
    char elapsed[COMPLETION_DURATION_TEXT_MAX];
    completionFormatDuration(c.durationSeconds, elapsed, sizeof(elapsed));
    cline(218, dim, bg, "%s", elapsed);
  }
  if (completionAffordanceVisible(tama.completion, now))
    cline(231, text, bg, "press: clear");
}

// Pulsing attention ring at the screen edge (replaces the Stick's red LED).
// `urgent` (a blocked session or a live prompt) pulses twice as fast.
static void drawAttentionRing(bool urgent) {
  const Palette& p = characterPalette();
  bool on = (millis() / (urgent ? 200 : 400)) % 2;
  uint16_t c = on ? HOT : p.bg;
  spr.drawCircle(CX, CY, RAD - 1, c);
  spr.drawCircle(CX, CY, RAD - 2, c);
  spr.drawCircle(CX, CY, RAD - 3, c);
}

// ---------------------------------------------------------------------------
// Input — rotary encoder, one button, capacitive touch.
// ---------------------------------------------------------------------------
static int32_t encPrev = 0;
static int32_t encAccum = 0;          // sub-detent accumulator
static uint32_t encLastStepMs = 0;
static int encFastCount = 0;

// Returns net detent steps since last call (one detent = 4 encoder counts) and
// flags a fast spin for the dizzy easter egg.
static int readEncoder(bool& fastSpin, bool& rawMoved) {
  fastSpin = false;
  rawMoved = false;
  int32_t now = M5Dial.Encoder.read();
  int32_t d = now - encPrev;
  encPrev = now;
  rawMoved = d != 0;
  if (d == 0) return 0;
  encAccum += d;
  int steps = encAccum / 4;
  encAccum -= steps * 4;
  if (steps != 0) {
    uint32_t t = millis();
    if (t - encLastStepMs < 90) { if (++encFastCount >= 6) { fastSpin = true; encFastCount = 0; } }
    else encFastCount = 0;
    encLastStepMs = t;
  }
  return steps;
}

static bool touchInButton(int tx, int ty, int bcx) {
  int by = APPR_BTN_Y - APPR_BTN_H / 2;
  return tx >= bcx - APPR_BTN_W/2 && tx <= bcx + APPR_BTN_W/2 &&
         ty >= by && ty <= by + APPR_BTN_H;
}

static void doApprove() {
  char cmd[96];
  snprintf(cmd, sizeof(cmd), "{\"cmd\":\"permission\",\"id\":\"%s\",\"decision\":\"once\"}", tama.promptId);
  sendCmd(cmd);
  responseSent = true;
  uint32_t tookS = (millis() - promptArrivedMs) / 1000;
  statsOnApproval(tookS);
  beep(2400, 60);
  if (tookS < 5) triggerOneShot(P_HEART, 2000);
}
static void doDeny() {
  char cmd[96];
  snprintf(cmd, sizeof(cmd), "{\"cmd\":\"permission\",\"id\":\"%s\",\"decision\":\"deny\"}", tama.promptId);
  sendCmd(cmd);
  responseSent = true;
  statsOnDenial();
  beep(600, 60);
}

void setup() {
  auto cfg = M5.config();
  M5Dial.begin(cfg, /*enableEncoder=*/true, /*enableRFID=*/false);
  M5Dial.Display.setRotation(0);
  M5Dial.Speaker.begin();
  M5Dial.Speaker.setVolume(160);
  M5Dial.BtnA.setHoldThresh(600);   // match the 600ms long-press used in loop()
  applyBrightness();
  lastInteractMs = millis();
  wakeInputGuard.reset();
  tama.completion.reset();
  sessionHeartTrackerClear(tama.heartTracker);
  sessionHeartQueueClear(tama.heartAwards);

  // Allocate the 240x240 canvas (~112KB) before BLE grabs heap, so the large
  // contiguous block isn't fragmented away.
  spr.setColorDepth(16);
  if (!spr.createSprite(W, H)) {
    Serial.println("sprite alloc failed");
  }

  startBt();

  statsLoad();
  settingsLoad();
  petNameLoad();
  buddyInit();

  characterInit(nullptr);
  gifAvailable = characterLoaded();
  buddyMode = !(gifAvailable && speciesIdxLoad() == SPECIES_GIF);
  applyDisplayMode();

  encPrev = M5Dial.Encoder.read();

  {
    const Palette& p = characterPalette();
    spr.fillSprite(p.bg);
    spr.setTextDatum(MC_DATUM);
    spr.setTextSize(2);
    if (ownerName()[0]) {
      char line[40]; snprintf(line, sizeof(line), "%s's", ownerName());
      spr.setTextColor(p.text, p.bg); spr.drawString(line, CX, CY - 12);
      spr.setTextColor(p.body, p.bg); spr.drawString(petName(), CX, CY + 12);
    } else {
      spr.setTextColor(p.body, p.bg); spr.drawString("Hello!", CX, CY - 12);
      spr.setTextSize(1);
      spr.setTextColor(p.textDim, p.bg); spr.drawString("a buddy appears", CX, CY + 14);
    }
    spr.setTextDatum(TL_DATUM); spr.setTextSize(1);
    spr.pushSprite(0, 0);
    delay(1800);
  }
  Serial.printf("buddy: %s\n", buddyMode ? "ASCII mode" : "GIF character loaded");
}

void loop() {
  M5Dial.update();
  t++;
  uint32_t now = millis();

  dataPoll(&tama);
  bool bleLink = bleConnected();
  if (bleLink && !lastBleLink && tama.completion.pendingDismiss) sendCompletionDismiss();
  lastBleLink = bleLink;

  // --- OTA in progress: take over the screen, suspend everything else -------
  // Each loop dataPoll() drained pending BLE bytes into Update.write(); just
  // show progress and keep the device awake until the device reboots on
  // ota_end (or the transfer aborts). A stall watchdog bails out if the bridge
  // vanishes mid-update so we don't hang on the progress screen forever.
  if (otaActive() && otaIdleMs() > 30000) {
    otaAbortLocal();
    applyDisplayMode();
    beep(600, 120);
  }
  if (otaActive()) {
    if (screenOff) { hwScreenOn(brightLevel); screenOff = false; }
    lastInteractMs = now;
    const Palette& p = characterPalette();
    spr.fillSprite(p.bg);
    cline(98, p.text, p.bg, "updating");
    uint32_t done = otaProgress(), total = otaTotal();
    int pct = total ? (int)((uint64_t)done * 100 / total) : 0;
    cline(132, p.body, p.bg, "%d%%", pct);
    int barW = 170;
    spr.drawRect(CX - barW/2, 150, barW, 10, p.textDim);
    if (total > 0) {
      int fill = (int)((uint64_t)(barW - 2) * done / total);
      if (fill > 0) spr.fillRect(CX - barW/2 + 1, 151, fill, 8, p.body);
    }
    cline(182, p.textDim, p.bg, "keep powered");
    spr.pushSprite(0, 0);
    delay(4);
    return;
  }

  if (statsPollLevelUp()) triggerOneShot(P_CELEBRATE, 3000);

  if (!sessionsProjected() && sessionStatsOpen) {
    sessionStatsOpen = false;
    applyDisplayMode();
  }

  baseState = derive(tama);

  // Per-session persona: the pal on screen animates its *own* lifecycle state,
  // not the aggregate. A passive "completed" celebration still wins, matching
  // the previous behaviour. A live prompt is an attention floor, so the
  // selected pal may decorate/raise that state but never lower it to idle/busy.
  bool promptLive = tama.promptId[0] != 0;
  SessionAttentionFacts sessionAttention = sessionAttentionFacts(tama.sessions);
  bool blockedAttention = tama.sessionsWaiting > 0 || sessionAttention.count > 0;
  bool overlayOpen = menuOpen || settingsOpen || resetOpen;
  bool completionVisible = completionCardVisible(
    completionPresentationActive(), displayMode == DISP_NORMAL, !screenOff, otaActive(),
    blePasskey() != 0, promptLive, blockedAttention, overlayOpen);
  bool tokenHeartPlaying = tokenHeartActive(now);
  if (!completionVisible && !tokenHeartPlaying) sessionSelectionUpdate(now);
  bool cardOwnsHome = sessionsProjected() && displayMode == DISP_NORMAL;
  bool selectedPersonaActive = cardOwnsHome && !completionVisible
                            && selSessionIdx >= 0
                            && selSessionIdx < (int)tama.sessions.count
                            && !tama.recentlyCompleted;
  uint8_t selectedPersona = selectedPersonaActive
    ? sessionStateToPersona(tama.sessions.pals[selSessionIdx].state)
    : (uint8_t)baseState;
  baseState = (PersonaState)sessionEffectivePersona(
    (uint8_t)baseState, promptLive, selectedPersonaActive, selectedPersona);

  if (!dataDemo() && baseState == P_IDLE
      && (int32_t)(now - wakeTransitionUntil) < 0) {
    baseState = P_SLEEP;
  }
  if (dataDemo() || (int32_t)(now - oneShotUntil) >= 0) activeState = baseState;

  // attention buzzer chirp (the ring is drawn in the render section)
  // Any projected session waiting on a human still chirps while you browse a
  // calmer pal — the point is that you notice, not that you are staring at it.
  bool needsHuman = sessionNeedsHuman(
    promptLive, blockedAttention, (uint8_t)activeState);
  if (needsHuman && settings().sound) {
    static uint32_t lastChirp = 0;
    // Urgent (a real approval prompt is up) chirps often; a plain "your turn"
    // wait just gives a gentle periodic reminder so it isn't naggy.
    uint32_t interval = sessionChirpIntervalMs(promptLive);
    if (now - lastChirp > interval) { lastChirp = now; hwTone(1200, 60); }
  }

  // Prompt arrival: beep, jump to the approval screen, reset response flag.
  if (strcmp(tama.promptId, lastPromptId) != 0) {
    strncpy(lastPromptId, tama.promptId, sizeof(lastPromptId)-1);
    lastPromptId[sizeof(lastPromptId)-1] = 0;
    responseSent = false;
    if (tama.promptId[0]) {
      promptArrivedMs = now;
      promptDeny = false;
      wake();
      beep(1200, 80);
      displayMode = DISP_NORMAL;
      menuOpen = settingsOpen = resetOpen = false;
      // Pet placement is handled by the unified "peek" block below, which
      // pins the pet above the approval panel (like the charging clock) so
      // its animation never repaints into the panel and flickers.
    }
  }

  bool inPrompt = tama.promptId[0] && !responseSent;
  bool assertiveSuccess = completionVisible
                       && tama.completion.latch.outcome == COMPLETION_SUCCESS
                       && settings().attitude == ATTITUDE_ASSERTIVE;
  if (!dataDemo()) {
    if (tama.completion.active
        && (assertiveSuccess || !completionIntroActive(tama.completion, now)))
      tama.completion.introConsumed = true;
    if (tama.completion.active && !completionVisible) tama.completion.introConsumed = true;
  }

  clockRefreshRtc();
  bool clocking = clockOwnsDisplay(inPrompt);
  bool inputLiveCard = sessionsProjected() && displayMode == DISP_NORMAL
                    && !clocking && !completionVisible;
  DisplayOwnershipState inputOwnership = currentDisplayOwnership(
    clocking, completionVisible, inputLiveCard);
  bool transcriptOwned = transcriptOwnsDisplay(inputOwnership);

  // --- read inputs ---------------------------------------------------------
  bool fastSpin = false, encoderMoved = false;
  int enc = readEncoder(fastSpin, encoderMoved);
  bool click = M5Dial.BtnA.wasClicked();
  bool longPress = M5Dial.BtnA.pressedFor(600) && !btnALong;
  bool released = M5Dial.BtnA.wasReleased();

  // touch
  bool touched = false; int tx = 0, ty = 0;
  bool touchActive = M5Dial.Touch.getCount() > 0;
  if (touchActive) {
    auto d = M5Dial.Touch.getDetail();
    if (d.wasPressed()) { touched = true; tx = d.x; ty = d.y; }
  }

  bool buttonDown = M5Dial.BtnA.isPressed();
  bool wasOff = screenOff;
  bool anyInput = encoderMoved || click || touched || buttonDown;
  if (anyInput) wake();
  if (wasOff && anyInput) wakeInputGuard.woke(now, buttonDown);
  if (wakeInputGuard.consume(now, buttonDown, encoderMoved, touchActive)) {
    enc = 0; click = false; touched = false; longPress = false; fastSpin = false;
  }

  // The carousel owns the encoder on the pal card, so a fast browse must not
  // also make the pal dizzy. Suppress *before* the global dizzy branch; dizzy
  // still works everywhere else, including the legacy home screen.
  bool carouselOwnsEncoder = cardOwnsHome && !sessionStatsOpen && !tokenHeartPlaying
                          && !completionVisible && !menuOpen && !settingsOpen
                          && !resetOpen && !inPrompt;

  // fast encoder spin -> dizzy (replaces the Stick's shake)
  if (fastSpin && !dataDemo() && !tokenHeartPlaying && !carouselOwnsEncoder
      && !menuOpen && !settingsOpen && !resetOpen && !inPrompt &&
      (int32_t)(now - oneShotUntil) >= 0) {
    triggerOneShot(P_DIZZY, 2000);
  }

  // --- long press: menu toggle / back -------------------------------------
  if (longPress) {
    btnALong = true;
    beep(800, 60);
    if (resetOpen) resetOpen = false;
    else if (settingsOpen) {
      settingsOpen = false;
      menuOpen = true;
      menuSel = 3;
      characterInvalidate();
    }
    else { menuOpen = !menuOpen; menuSel = 0; if (!menuOpen) characterInvalidate(); }
  }

  // --- encoder: navigate / scroll -----------------------------------------
  if (enc != 0) {
    if (inPrompt) {
      promptDeny = (enc > 0) ? true : false;   // right = deny, left = approve
      beep(1800, 20);
    } else if (resetOpen) {
      resetSel = (resetSel + (enc > 0 ? 1 : RESET_N - 1)) % RESET_N;
      resetConfirmIdx = 0xFF; beep(1800, 20);
    } else if (settingsOpen) {
      settingsSel = (settingsSel + (enc > 0 ? 1 : SETTINGS_N - 1)) % SETTINGS_N; beep(1800, 20);
    } else if (menuOpen) {
      menuSel = (menuSel + (enc > 0 ? 1 : MENU_N - 1)) % MENU_N; beep(1800, 20);
    } else if (displayMode == DISP_INFO) {
      infoPage = (infoPage + (enc > 0 ? 1 : INFO_PAGES - 1)) % INFO_PAGES; beep(1800, 20);
    } else if (displayMode == DISP_PET) {
      petPage = (petPage + (enc > 0 ? 1 : PET_PAGES - 1)) % PET_PAGES; applyDisplayMode(); beep(1800, 20);
    } else if (carouselOwnsEncoder) {
      // pal card: one detent = one pal, a fast spin jumps three.
      int step = (enc > 0 ? 1 : -1) * (fastSpin ? 3 : 1);
      selSessionIdx = sessionSelectionStep(tama.sessions, selSessionId,
                                           sizeof(selSessionId), step);
      lastCarouselMs = now;          // start the 15s auto-focus hold
      buddyInvalidate();
      beep(1800, 20);
    } else if (transcriptOwned) {
      // legacy home / activity: scroll transcript (line-by-line through history)
      if (transcriptScroll(transcriptOwned, msgScroll, enc, HUD_ROWS_MAX - 1))
        beep(1500, 15);
    }
  }

  // --- completion dismissal: short click or a tap on the visible pill ----
  bool completionPillTap = touched && touchInCompletionPill(tx, ty);
  bool dismissGesture = completionDismissGestureAllowed(
    completionVisible, click && !btnALong, completionPillTap, encoderMoved, longPress || btnALong);
  if (dismissGesture) {
    dismissCompletion();
    click = false;
    touched = false;
    completionVisible = false;
  }

  // --- button click: select / advance -------------------------------------
  if (click && !btnALong) {
    if (inPrompt) {
      if (promptDeny) doDeny(); else doApprove();
    } else if (resetOpen) {
      applyReset(resetSel); beep(2400, 30);
    } else if (settingsOpen) {
      applySetting(settingsSel); beep(2400, 30);
    } else if (menuOpen) {
      menuConfirm(); beep(2400, 30);
    } else if (cardOwnsHome) {
      sessionStatsOpen = !sessionStatsOpen;
      applyDisplayMode();
      beep(1800, 30);
    } else if (displayMode != DISP_NORMAL) {
      sessionStatsOpen = false;
      displayMode = DISP_NORMAL;
      applyDisplayMode();
      beep(1800, 30);
    } else {
      // The primary surface has no generic click action without a projected
      // pal. Secondary screens are intentionally reached from the long-press
      // menu instead of cycling through them accidentally.
    }
  }

  // A click can change the page or close a UI overlay. Re-derive ownership
  // before a simultaneous touch is allowed to act on transcript state.
  clocking = clockOwnsDisplay(tama.promptId[0] && !responseSent);
  completionVisible = completionCardVisible(
    completionPresentationActive(), displayMode == DISP_NORMAL, !screenOff, otaActive(),
    blePasskey() != 0, tama.promptId[0] != 0, blockedAttention,
    menuOpen || settingsOpen || resetOpen);
  inputLiveCard = sessionsProjected() && displayMode == DISP_NORMAL
               && !clocking && !completionVisible;
  inputOwnership = currentDisplayOwnership(
    clocking, completionVisible, inputLiveCard);
  transcriptOwned = transcriptOwnsDisplay(inputOwnership);

  // --- touch: approve/deny buttons, or wake -------------------------------
  if (touched && !inPrompt && menuOpen) {
    // tap a menu row to select it
  }
  if (touched && inPrompt && !responseSent) {
    if (touchInButton(tx, ty, APPR_APPR_CX)) doApprove();
    else if (touchInButton(tx, ty, APPR_DENY_CX)) doDeny();
  }
  if (released) btnALong = false;

  // Transcript reader: a tap closes the scrolled-back view and returns to live.
  // It lives on DISP_ACTIVITY once the pal card owns home, on home otherwise.
  if (touched && !inPrompt && !menuOpen && !settingsOpen && !resetOpen &&
      transcriptClose(transcriptOwned, msgScroll)) {
    beep(1500, 20);
  }

  bool browsing = lastCarouselMs && (now - lastCarouselMs) < CAROUSEL_HOLD_MS;
  sessionHeartPoll(
    now,
    sessionsProjected() && displayMode == DISP_NORMAL && !completionVisible
      && !inPrompt && !menuOpen && !settingsOpen && !resetOpen
      && !blockedAttention && !screenOff && !browsing);

  static uint32_t lastPasskey = 0;
  uint32_t pk = blePasskey();
  if (pk && !lastPasskey) { wake(); beep(1800, 60); }
  lastPasskey = pk;

  // --- charging clock ------------------------------------------------------
  // The M5Dial can't sense USB power (no PMIC via M5Unified), so the clock
  // shows whenever the link is idle and the RTC has been synced; the idle
  // screen-off timer below still sleeps it on battery after 30s.
  clocking = clockOwnsDisplay(tama.promptId[0] && !responseSent);
  // The pet only "peeks" (shrinks to the top band) for the approval prompt, so
  // its animation stays above the panel and never flickers. On the clock the
  // pet now stays full size (2×) — date/time sits above it, session info below.
  bool petPeek = tama.promptId[0]
              || (sessionStatsOpen && sessionsProjected()
                  && displayMode == DISP_NORMAL && !completionVisible);
  static bool wasPeek = false;
  if (petPeek != wasPeek) {
    if (petPeek) {
      // Entering peek: the pet shrinks to the top band. A prior full-size (2×)
      // body is taller than the 1× peek clear strip, so wipe the whole sprite
      // to avoid leaving the lower half of the old body behind the panel.
      characterSetPeek(true);
      buddySetPeek(true);
      spr.fillSprite(0x0000);
    } else {
      applyDisplayMode();   // restore full-size placement and clear
    }
    characterInvalidate();
    if (buddyMode) buddyInvalidate();
    wasPeek = petPeek;
  }
  // Entering/leaving the clock overlay: the idle clock uses a larger (3×) pet,
  // so set/restore the scale and clear once so the top date band and the bottom
  // info band don't leave stale text when switching to/from the home HUD.
  static bool wasClocking = false;
  if (clocking != wasClocking) {
    if (clocking) { if (buddyMode) buddySetScale(3); }  // bigger pet on the clock
    else applyDisplayMode();                            // restore home 2× placement
    spr.fillSprite(0x0000);
    characterInvalidate();
    if (buddyMode) buddyInvalidate();
    wasClocking = clocking;
  }
  if (clocking) {
    uint8_t dow = clockDow();
    bool weekend = (dow == 0 || dow == 6);
    uint8_t h = _clk.time.hours;
    if (h >= 1 && h < 7)        activeState = P_SLEEP;
    else if (weekend)           activeState = (now/8000 % 6 == 0) ? P_HEART : P_SLEEP;
    else if (h >= 22 || h == 0) activeState = (now/7000 % 3 == 0) ? P_DIZZY : P_SLEEP;
    else                        activeState = (now/10000 % 5 == 0) ? P_SLEEP : P_IDLE;
  }

  // --- render pet into the sprite -----------------------------------------
  completionVisible = completionCardVisible(
    completionPresentationActive(), displayMode == DISP_NORMAL, !screenOff, otaActive(),
    blePasskey() != 0, tama.promptId[0] != 0,
    blockedAttention,
    menuOpen || settingsOpen || resetOpen);
  bool completionOwner = completionVisible
                      && (tama.completion.latch.flags & COMPLETION_HAS_OWNER);
  bool liveCardActive = sessionsProjected() && displayMode == DISP_NORMAL
                     && !clocking && !completionVisible;
  DisplayOwnershipState renderOwnership = currentDisplayOwnership(
    clocking, completionVisible, liveCardActive);
  DisplaySurfaceOwner displayOwner = displaySurfaceOwner(renderOwnership);
  if (completionOwner) {
    buddySetSessionPal(tama.completion.latch.species, tama.completion.latch.colors);
  } else {
    sessionPalApply(liveCardActive);
  }
  uint8_t attentionBadgeCount =
    displayOwner != DISPLAY_SURFACE_NONE
    && displayOwner != DISPLAY_SURFACE_UI_OVERLAY
    && displayOwner != DISPLAY_SURFACE_PASSKEY
      ? sessionAttention.count
      : 0;
  static uint8_t previousAttentionBadgeCount = 0;
  if (attentionBadgeCount != previousAttentionBadgeCount) {
    previousAttentionBadgeCount = attentionBadgeCount;
    buddyInvalidate();
    characterInvalidate();
  }
  static bool wasCard = false;
  bool anyCard = liveCardActive || completionVisible;
  if (anyCard != wasCard) {
    spr.fillSprite(0x0000);
    characterInvalidate();
    buddyInvalidate();
    wasCard = anyCard;
  }

  bool completionIntro = completionVisible && completionIntroActive(tama.completion, now);
  bool completionSettled = completionVisible && !completionIntro;
  bool kindCompletion = completionVisible
                     && tama.completion.latch.outcome == COMPLETION_SUCCESS
                     && settings().attitude == ATTITUDE_KIND;
  PersonaState renderState = activeState;
  if (dataDemoAssertive() && liveCardActive) renderState = P_ATTENTION;
  if (completionVisible) {
    if (tama.completion.latch.outcome == COMPLETION_SUCCESS)
      renderState = kindCompletion ? P_CELEBRATE : P_ATTENTION;
    else if (tama.completion.latch.outcome == COMPLETION_FAILED)
      renderState = completionIntro ? P_ATTENTION : P_IDLE;
    else renderState = completionIntro ? P_BUSY : P_IDLE;
  }

  if (screenOff) {
    // nothing
  } else if (buddyMode || liveCardActive || completionOwner) {
    characterSetFrozen(false);
    if (completionSettled) buddyTickStill(renderState);
    else if (kindCompletion)
      buddyTickCompletionCelebrate((uint32_t)(now - tama.completion.latch.startedAt));
    else buddyTick(renderState);
  } else if (characterLoaded()) {
    characterSetState(renderState);
    if (completionSettled) {
      if (!characterFrameRendered()) {
        characterSetFrozen(false);
        characterTick();
      }
      characterSetFrozen(true);
    } else {
      characterSetFrozen(false);
      characterTick();
    }
  } else {
    characterSetFrozen(false);
    const Palette& p = characterPalette();
    spr.fillSprite(p.bg);
    if (xferActive()) {
      uint32_t done = xferProgress(), total = xferTotal();
      cline(110, p.textDim, p.bg, "installing");
      cline(126, p.textDim, p.bg, "%luK / %luK", done/1024, total/1024);
      int barW = 160;
      spr.drawRect(CX - barW/2, 140, barW, 8, p.textDim);
      if (total > 0) { int fill = (int)((uint64_t)barW * done / total); if (fill > 1) spr.fillRect(CX - barW/2 + 1, 141, fill - 1, 6, p.body); }
    } else {
      cline(120, p.textDim, p.bg, "no character loaded");
    }
  }

  // --- overlays ------------------------------------------------------------
  if (!screenOff) {
    switch (displayOwner) {
      case DISPLAY_SURFACE_PASSKEY:    drawPasskey(); break;
      case DISPLAY_SURFACE_PROMPT:     drawApproval(); break;
      case DISPLAY_SURFACE_CLOCK:      drawClock(); break;
      case DISPLAY_SURFACE_INFO:       drawInfo(); break;
      case DISPLAY_SURFACE_PET:        drawPet(); break;
      case DISPLAY_SURFACE_TRANSCRIPT:
      case DISPLAY_SURFACE_HUD:        drawHUD(); break;
      case DISPLAY_SURFACE_COMPLETION: drawCompletionCard(now); break;
      case DISPLAY_SURFACE_LIVE_CARD:  drawSessionCard(); break;
      case DISPLAY_SURFACE_UI_OVERLAY:
      case DISPLAY_SURFACE_NONE:       break;
    }

    // Show the number of projected pals that need the user while browsing any
    // ordinary surface. Pairing and local UI panels keep full display ownership.
    if (attentionBadgeCount > 0) drawSessionAttentionCount(attentionBadgeCount);

    // The full edge ring and chirp share the same current attention floor. A
    // calm selected pal cannot hide another row that is waiting or blocked.
    bool ringUrgent = sessionAttentionRingUrgent(
      promptLive, sessionAttention.anyBlocked);
    bool ringVisible = sessionAttentionRingVisible(
      promptLive, blockedAttention, (uint8_t)activeState);
    if (ringVisible && !menuOpen && !settingsOpen && !resetOpen)
      drawAttentionRing(ringUrgent);

    if (resetOpen) drawReset();
    else if (settingsOpen) drawSettings();
    else if (menuOpen) drawMenu();
    spr.pushSprite(0, 0);
  }

  // --- auto screen-off (battery only) -------------------------------------
  // Stay awake while charging, while a prompt is up, or while a BT host is
  // connected and streaming (so the buddy keeps watching during a session).
  if (!screenOff && !inPrompt && !_onUsb && !dataBtActive() &&
      millis() - lastInteractMs > SCREEN_OFF_MS) {
    hwScreenOff();
    screenOff = true;
  }

  delay(screenOff ? 100 : 16);
}

#include "buddy.h"
#include "buddy_common.h"
#include "session_pals.h"
#include <M5Dial.h>
#include <string.h>

extern M5Canvas spr;

// Mirrors PersonaState in main.cpp
enum { B_SLEEP, B_IDLE, B_BUSY, B_ATTENTION, B_CELEBRATE, B_DIZZY, B_HEART };

// ──────────────── shared geometry ────────────────
const int BUDDY_X_CENTER = 120;
const int BUDDY_CANVAS_W = 240;
const int BUDDY_Y_BASE   = 30;
const int BUDDY_Y_OVERLAY = 6;
const int BUDDY_CHAR_W   = 6;
const int BUDDY_CHAR_H   = 8;

// ──────────────── shared colors ────────────────
const uint16_t BUDDY_BG     = 0x0000;
const uint16_t BUDDY_HEART  = 0xF810;
const uint16_t BUDDY_DIM    = 0x8410;
const uint16_t BUDDY_YEL    = 0xFFE0;
const uint16_t BUDDY_WHITE  = 0xFFFF;
const uint16_t BUDDY_CYAN   = 0x07FF;
const uint16_t BUDDY_GREEN  = 0x07E0;
const uint16_t BUDDY_PURPLE = 0xA01F;
const uint16_t BUDDY_RED    = 0xF800;
const uint16_t BUDDY_BLUE   = 0x041F;

// ──────────────── session palette override ────────────────
// A projected session supplies its own five-colour palette. Rather than
// duplicating a colour argument through 18 species files, the override is
// resolved inside the shared print helpers below: every species paints its body
// with exactly the RGB565 literal recorded in its own Species::bodyColor, so
// that field is a reliable key for "this ink is the animal". It was previously
// dead; it is now the hinge of the whole palette path.
//
// Non-body colours normally survive remapping. If a species body uses the same
// RGB565 value as a semantic accent, body matching wins because the shared
// renderer has only the colour value, not the original drawing role.
static bool     _palActive = false;
static uint16_t _pal[5] = { 0, 0, 0, 0, 0 };   // body, bg, text, textDim, ink
static int16_t  _sessionSpecies = -1;          // -1 = use the user's saved pet
static bool     _celebrationEffects = true;

static uint16_t _mapColor(uint16_t c);         // defined below the species table
static uint16_t _bgColor();

// ──────────────── shared rendering helpers ────────────────
// Render target indirection: defaults to the sprite, but can retarget to
// M5Dial.Display for direct draws (both M5Canvas and the display inherit
// LovyanGFX). Coords stay
// fixed — species hardcode BUDDY_X_CENTER/BUDDY_Y_OVERLAY in their
// particle calls, so retargeting position would only move the body.
static LovyanGFX* _tgt = &spr;
// 2× on home screen, 1× in peek (PET/INFO) and landscape clock. Species
// art is space-padded to a fixed width for alignment at 1×; at 2× we trim
// and re-center per line so the padding doesn't push ink off-screen.
static uint8_t _scale = 1;

void buddyPrintLine(const char* line, int yPx, uint16_t color, int xOff) {
  int len = strlen(line);
  if (_scale > 1) {
    while (len && line[len-1] == ' ') len--;
    while (len && *line == ' ')       { line++; len--; }
  }
  int w = len * BUDDY_CHAR_W * _scale;
  int x = BUDDY_X_CENTER - w / 2 + xOff * _scale;
  _tgt->setTextColor(_mapColor(color), _bgColor());
  _tgt->setCursor(x, yPx);
  for (int i = 0; i < len; i++) _tgt->print(line[i]);
}

void buddyPrintSprite(const char* const* lines, uint8_t nLines, int yOffset, uint16_t color, int xOff) {
  _tgt->setTextSize(_scale);
  int yBase = BUDDY_Y_BASE * _scale - (_scale - 1) * 14;
  for (uint8_t i = 0; i < nLines; i++) {
    buddyPrintLine(lines[i], yBase + (yOffset + i * BUDDY_CHAR_H) * _scale, color, xOff);
  }
}

// Species pass 1× coords (relative to BUDDY_X_CENTER / BUDDY_Y_OVERLAY);
// transform here so all 18 species files stay scale-agnostic.
void buddySetCursor(int x, int y) {
  _tgt->setCursor(BUDDY_X_CENTER + (x - BUDDY_X_CENTER) * _scale, y * _scale);
}
void buddySetColor(uint16_t fg)   { _tgt->setTextColor(_mapColor(fg), _bgColor()); }
void buddyPrint(const char* s)    { _tgt->setTextSize(_scale); _tgt->print(s); }

// ──────────────── species registry ────────────────
extern const Species CAPYBARA_SPECIES;
extern const Species DUCK_SPECIES;
extern const Species GOOSE_SPECIES;
extern const Species BLOB_SPECIES;
extern const Species CAT_SPECIES;
extern const Species DRAGON_SPECIES;
extern const Species OCTOPUS_SPECIES;
extern const Species OWL_SPECIES;
extern const Species PENGUIN_SPECIES;
extern const Species TURTLE_SPECIES;
extern const Species SNAIL_SPECIES;
extern const Species GHOST_SPECIES;
extern const Species AXOLOTL_SPECIES;
extern const Species CACTUS_SPECIES;
extern const Species ROBOT_SPECIES;
extern const Species RABBIT_SPECIES;
extern const Species MUSHROOM_SPECIES;
extern const Species CHONK_SPECIES;

static const Species* SPECIES_TABLE[] = {
  &CAPYBARA_SPECIES, &DUCK_SPECIES, &GOOSE_SPECIES, &BLOB_SPECIES,
  &CAT_SPECIES, &DRAGON_SPECIES, &OCTOPUS_SPECIES, &OWL_SPECIES,
  &PENGUIN_SPECIES, &TURTLE_SPECIES, &SNAIL_SPECIES, &GHOST_SPECIES,
  &AXOLOTL_SPECIES, &CACTUS_SPECIES, &ROBOT_SPECIES, &RABBIT_SPECIES,
  &MUSHROOM_SPECIES, &CHONK_SPECIES,
};
static const uint8_t N_SPECIES = sizeof(SPECIES_TABLE) / sizeof(SPECIES_TABLE[0]);
static uint8_t currentSpeciesIdx = 0;

// Which species the renderer actually draws: the session override when one is
// active, otherwise the user's saved pet.
static inline uint8_t _effectiveSpeciesIdx() {
  return (_sessionSpecies >= 0 && _sessionSpecies < N_SPECIES)
       ? (uint8_t)_sessionSpecies : currentSpeciesIdx;
}

static uint16_t _bgColor() { return _palActive ? _pal[1] : BUDDY_BG; }

// Delegates to the host-tested resolver in session_pals.h so the rule that
// decides what a session palette may and may not repaint has exactly one
// definition and is covered by firmware/test.
static uint16_t _mapColor(uint16_t c) {
  return sessionMapColor(c, SPECIES_TABLE[_effectiveSpeciesIdx()]->bodyColor,
                         BUDDY_DIM, _palActive ? _pal : nullptr);
}

// Cheap change key so the tick gate redraws when the palette or the projected
// species changes mid-tick (a carousel step must feel instant, not up to 200ms
// late).
static uint32_t _palKey() {
  if (!_palActive) return 0;
  uint32_t k = 0x9E3779B9u ^ (uint32_t)(_sessionSpecies + 1);
  for (uint8_t i = 0; i < 5; i++) k = k * 31u + _pal[i];
  return k | 0x80000000u;               // never collide with the inactive key
}

void buddySetSessionPal(uint8_t speciesIdx, const uint16_t* colors5) {
  if (speciesIdx >= N_SPECIES || !colors5) return;
  _sessionSpecies = (int16_t)speciesIdx;
  _palActive = true;
  for (uint8_t i = 0; i < 5; i++) _pal[i] = colors5[i];
}

void buddyClearSessionPal() {
  _sessionSpecies = -1;
  _palActive = false;
}

bool buddySessionPalActive() { return _palActive; }

bool buddyCelebrationEffectsEnabled() { return _celebrationEffects; }

const char* buddySpeciesNameAt(uint8_t idx) {
  return (idx < N_SPECIES) ? SPECIES_TABLE[idx]->name : "?";
}

// ──────────────── tick state ────────────────
static uint32_t tickCount  = 0;
static uint32_t nextTickAt = 0;
static const uint32_t TICK_MS = 200;

#include "stats.h"

void buddyInit() {
  tickCount = 0;
  nextTickAt = 0;
  uint8_t saved = speciesIdxLoad();
  if (saved < N_SPECIES) currentSpeciesIdx = saved;
}

void buddySetSpeciesIdx(uint8_t idx) {
  if (idx < N_SPECIES) currentSpeciesIdx = idx;
}

void buddySetSpecies(const char* name) {
  for (uint8_t i = 0; i < N_SPECIES; i++) {
    if (strcmp(SPECIES_TABLE[i]->name, name) == 0) {
      currentSpeciesIdx = i;
      return;
    }
  }
}

const char* buddySpeciesName() {
  return SPECIES_TABLE[currentSpeciesIdx]->name;
}

uint8_t buddySpeciesCount() { return N_SPECIES; }

uint8_t buddySpeciesIdx() { return currentSpeciesIdx; }

void buddyNextSpecies() {
  currentSpeciesIdx = (currentSpeciesIdx + 1) % N_SPECIES;
  speciesIdxSave(currentSpeciesIdx);
}

// Only redraw when tickCount actually changes — animations run at TICK_MS
// (5 fps), the loop runs at 60 fps, and the redraw is identical between
// ticks. Gating saves ~12× the fillRect + sprite-print work. State changes
// also need a redraw even mid-tick so transitions appear instantly.
static uint8_t  lastDrawnState = 0xFF;
static uint8_t  lastDrawnSpecies = 0xFF;
static uint32_t lastDrawnPalKey = 0xFFFFFFFFu;
static bool lastDrawnSettled = false;
static uint8_t lastCompletionFrame = 0xFF;
void buddyInvalidate() {
  lastDrawnState = 0xFF;
  lastDrawnSettled = false;
  lastCompletionFrame = 0xFF;
}

void buddySetPeek(bool peek) {
  uint8_t s = peek ? 1 : 2;
  if (s == _scale) return;
  _scale = s;
  buddyInvalidate();
}

// Set an explicit integer scale (1–3). The idle clock uses 3× for a larger
// pet; home/peek use 1–2× via buddySetPeek. Geometry scales linearly, so the
// clear strip and centering follow automatically.
void buddySetScale(uint8_t scale) {
  if (scale < 1) scale = 1;
  if (scale > 3) scale = 3;
  if (scale == _scale) return;
  _scale = scale;
  buddyInvalidate();
}

// One-shot render to an arbitrary LovyanGFX surface (the display for the
// charging clock). Bypasses tick gating and the sprite fillRect — caller owns
// clearing. Advances the frame counter so animation runs even when
// buddyTick is bypassed.
// Clock callsite — always 1×.
void buddyRenderTo(LovyanGFX* tgt, uint8_t personaState) {
  uint8_t prevS = _scale; _scale = 1;
  if (personaState >= 7) personaState = B_IDLE;
  uint32_t now = millis();
  if ((int32_t)(now - nextTickAt) >= 0) { nextTickAt = now + TICK_MS; tickCount++; }
  LovyanGFX* prev = _tgt;
  _tgt = tgt;
  const Species* sp = SPECIES_TABLE[_effectiveSpeciesIdx()];
  if (sp->states[personaState]) sp->states[personaState](tickCount);
  _tgt = prev; _scale = prevS;
}

void buddyTickCompletionCelebrate(uint32_t elapsedMs) {
  uint8_t frame = elapsedMs >= 5600u ? 47u : (uint8_t)((uint64_t)elapsedMs * 48u / 5600u);
  uint8_t species = _effectiveSpeciesIdx();
  uint32_t palKey = _palKey();
  if (lastCompletionFrame == frame && lastDrawnSpecies == species
      && lastDrawnPalKey == palKey) return;
  lastCompletionFrame = frame;
  lastDrawnState = B_CELEBRATE;
  lastDrawnSpecies = species;
  lastDrawnPalKey = palKey;
  lastDrawnSettled = false;
  spr.fillRect(0, 0, BUDDY_CANVAS_W,
               (BUDDY_Y_BASE + 5 * BUDDY_CHAR_H + 12) * _scale, _bgColor());
  _celebrationEffects = true;
  const Species* sp = SPECIES_TABLE[species];
  if (sp->states[B_CELEBRATE]) sp->states[B_CELEBRATE](frame);
}

void buddyTickStill(uint8_t personaState) {
  if (personaState >= 7) personaState = B_IDLE;
  if (lastDrawnSettled && lastDrawnState == personaState
      && lastDrawnSpecies == _effectiveSpeciesIdx() && lastDrawnPalKey == _palKey()) return;
  lastDrawnState = personaState;
  lastDrawnSpecies = _effectiveSpeciesIdx();
  lastDrawnPalKey = _palKey();
  lastDrawnSettled = true;
  spr.fillRect(0, 0, BUDDY_CANVAS_W,
               (BUDDY_Y_BASE + 5 * BUDDY_CHAR_H + 12) * _scale, _bgColor());
  _celebrationEffects = false;
  const Species* sp = SPECIES_TABLE[lastDrawnSpecies];
  uint32_t frame = personaState == B_CELEBRATE ? 42u : 0u;
  if (sp->states[personaState]) sp->states[personaState](frame);
  _celebrationEffects = true;
}

void buddyTickSettledCelebrate() { buddyTickStill(B_CELEBRATE); }

void buddyTick(uint8_t personaState) {
  uint32_t now = millis();
  bool ticked = false;
  if ((int32_t)(now - nextTickAt) >= 0) {
    nextTickAt = now + TICK_MS;
    tickCount++;
    ticked = true;
  }

  if (personaState >= 7) personaState = B_IDLE;
  uint8_t  species = _effectiveSpeciesIdx();
  uint32_t palKey  = _palKey();
  if (!ticked && personaState == lastDrawnState
              && species == lastDrawnSpecies
              && palKey == lastDrawnPalKey) {
    return;
  }
  lastDrawnState = personaState;
  lastDrawnSettled = false;
  lastCompletionFrame = 0xFF;
  lastDrawnSpecies = species;
  lastDrawnPalKey = palKey;

  // Clear the whole render strip — at 2× the body reaches y≈126, at 1× ≈82.
  spr.fillRect(0, 0, BUDDY_CANVAS_W,
               (BUDDY_Y_BASE + 5 * BUDDY_CHAR_H + 12) * _scale, _bgColor());

  const Species* sp = SPECIES_TABLE[species];
  if (sp->states[personaState]) sp->states[personaState](tickCount);
}

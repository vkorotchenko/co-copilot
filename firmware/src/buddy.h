#pragma once
#include <stdint.h>
#include <M5GFX.h>

// Multi-species ASCII buddy renderer. Each species lives in its own
// src/buddies/<name>.cpp file and exposes 7 state functions matching
// the PersonaState enum order: sleep, idle, busy, attention, celebrate,
// dizzy, heart.
void buddyInit();
void buddyTick(uint8_t personaState);
void buddyTickCompletionCelebrate(uint32_t elapsedMs);
void buddyTickStill(uint8_t personaState);
void buddyTickSettledCelebrate();
bool buddyCelebrationEffectsEnabled();
void buddyInvalidate();
void buddyRenderTo(LovyanGFX* tgt, uint8_t personaState);
void buddySetSpecies(const char* name);
void buddySetSpeciesIdx(uint8_t idx);
void buddyNextSpecies();
void buddySetPeek(bool peek);
void buddySetScale(uint8_t scale);
uint8_t buddySpeciesIdx();
uint8_t buddySpeciesCount();
const char* buddySpeciesName();
const char* buddySpeciesNameAt(uint8_t idx);

// Per-session override. While active the renderer draws `speciesIdx` instead of
// the user's saved pet and recolors that species' body ink with colors[0]
// (RGB565 [body, bg, text, textDim, ink]). The user's own pet selection is left
// untouched, so leaving the session card restores it exactly.
void buddySetSessionPal(uint8_t speciesIdx, const uint16_t* colors5);
void buddyClearSessionPal();
bool buddySessionPalActive();

// Per-species state function: takes the global tickCount and renders
// the buddy + any overlays for the current state into the shared sprite.
typedef void (*StateFn)(uint32_t t);

struct Species {
  const char* name;
  uint16_t bodyColor;
  StateFn states[7];   // index by PersonaState (0=sleep .. 6=heart)
};

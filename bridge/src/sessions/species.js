'use strict';

// This order is a wire-level catalog, not a presentation preference. Firmware
// stores species as an index into SPECIES_TABLE, so reordering this list would
// make an otherwise-valid bridge assignment render as the wrong animal. New
// species may be appended in a future protocol revision; existing indices must
// remain stable.
const SPECIES = Object.freeze([
  'capybara',
  'duck',
  'goose',
  'blob',
  'cat',
  'dragon',
  'octopus',
  'owl',
  'penguin',
  'turtle',
  'snail',
  'ghost',
  'axolotl',
  'cactus',
  'robot',
  'rabbit',
  'mushroom',
  'chonk',
]);

const SPECIES_COUNT = SPECIES.length;

function speciesIndex(id) {
  return SPECIES.indexOf(id);
}

function isSpecies(id) {
  return speciesIndex(id) !== -1;
}

// FNV-1a is defined over bytes. Iterating JavaScript characters instead would
// hash UTF-16 code units, so labels containing emoji or non-ASCII text would
// disagree with every conventional FNV implementation and could even differ
// depending on how another language represented the same string.
function fnv1a32(str) {
  let hash = 0x811c9dc5;
  for (const byte of Buffer.from(String(str), 'utf8')) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function defaultSpeciesFor({ label, cwd, automaticTaken, explicitTaken, taken } = {}) {
  const start = fnv1a32(String(label || '') + '\0' + (cwd || '')) % SPECIES_COUNT;
  const automaticCounts = new Map(SPECIES.map((id) => [id, 0]));
  const explicitCounts = new Map(SPECIES.map((id) => [id, 0]));
  // The legacy taken input remains an automatic-occupancy alias for direct
  // callers written before the registry tracked explicit choices separately.
  for (const id of automaticTaken || taken || []) {
    if (automaticCounts.has(id)) automaticCounts.set(id, automaticCounts.get(id) + 1);
  }
  for (const id of explicitTaken || []) {
    if (explicitCounts.has(id)) explicitCounts.set(id, explicitCounts.get(id) + 1);
  }

  /*
   * Automatic occupancy is the hard constraint; explicit occupancy is soft.
   * The tempting alternative is one combined taken set, but then one user-
   * selected animal can force two automatic sessions to collide before all 18
   * automatic slots have been used. Prefer the lowest automatic count first,
   * then avoid explicit choices where possible. This lets the 18th automatic
   * session collide with an explicit choice instead of duplicating another
   * automatic assignment, while retaining deterministic hash-order ties.
   */
  let leastAutomatic = Infinity;
  for (const id of SPECIES) {
    leastAutomatic = Math.min(leastAutomatic, automaticCounts.get(id));
  }

  let leastExplicit = Infinity;
  for (const id of SPECIES) {
    if (automaticCounts.get(id) === leastAutomatic) {
      leastExplicit = Math.min(leastExplicit, explicitCounts.get(id));
    }
  }

  for (let offset = 0; offset < SPECIES_COUNT; offset++) {
    const id = SPECIES[(start + offset) % SPECIES_COUNT];
    if (
      automaticCounts.get(id) === leastAutomatic &&
      explicitCounts.get(id) === leastExplicit
    ) return id;
  }
  return SPECIES[start];
}

module.exports = {
  SPECIES,
  SPECIES_COUNT,
  isSpecies,
  speciesIndex,
  fnv1a32,
  defaultSpeciesFor,
};

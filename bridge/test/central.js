'use strict';

// Unit test for parseBondedAddress(): extract the bonded device's address from
// `blueutil --paired` output, matched by name prefix.

const assert = require('assert');
const { parseBondedAddress } = require('../src/ble/central');

const sample = [
  'address: 24-05-29-00-02-9c, not connected, not favourite, paired, name: "DG08"',
  'address: 48-27-e2-e3-c9-25, connected (master, 0 dBm), not favourite, paired, name: "Copilot-C924"',
  'address: c0-44-42-d9-66-88, not connected, paired, name: "Magic Mouse"',
].join('\n');

assert.strictEqual(
  parseBondedAddress(sample, 'Copilot'),
  '48-27-e2-e3-c9-25',
  'should pick the Copilot device address'
);

// No matching device => null.
assert.strictEqual(parseBondedAddress(sample, 'Nonexistent'), null);
assert.strictEqual(parseBondedAddress('', 'Copilot'), null);

console.log('PASS: parseBondedAddress extracts the bonded device address by name prefix');

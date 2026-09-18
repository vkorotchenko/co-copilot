'use strict';

// End-to-end test of the OTA flasher against the fake device transport.
// Generates a throwaway "firmware" blob, streams it via flashFirmware(), and
// asserts the device received every byte and acked begin/chunks/end.
//
// Run: node test/ota-flash.js   (exits non-zero on failure)

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

process.env.COMPANION_LOG = process.env.COMPANION_LOG || 'warn';

const { FakeDeviceTransport } = require('../src/transport/fakeDevice');
const { flashFirmware } = require('../src/ota/flasher');

async function main() {
  // a ~50KB random "image"
  const total = 50000;
  const bin = path.join(os.tmpdir(), `co-copilot-ota-test-${process.pid}.bin`);
  fs.writeFileSync(bin, crypto.randomBytes(total));
  const md5 = crypto.createHash('md5').update(fs.readFileSync(bin)).digest('hex');

  const transport = new FakeDeviceTransport();
  // capture how many bytes the device "wrote" via the last ota_chunk ack
  let lastN = 0;
  transport.on('line', (m) => { if (m && m.ack === 'ota_chunk') lastN = m.n; });

  await new Promise((resolve) => { transport.on('connected', resolve); transport.start(); });

  let progressCalls = 0;
  let lastProgress = 0;
  const res = await flashFirmware(transport, bin, {
    chunkSize: 384,
    onProgress: (written) => { progressCalls++; lastProgress = written; },
  });

  assert.strictEqual(res.total, total, 'reported total mismatch');
  assert.strictEqual(res.md5, md5, 'md5 mismatch');
  assert.strictEqual(lastProgress, total, `progress ended at ${lastProgress}, expected ${total}`);
  assert.strictEqual(lastN, total, `device acked ${lastN} bytes, expected ${total}`);
  assert.ok(progressCalls >= Math.ceil(total / 384), 'too few progress callbacks');

  await transport.stop();
  fs.unlinkSync(bin);
  console.log(`PASS: OTA flash round-trip (${total} bytes in ${progressCalls} chunks, md5 verified)`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('FAIL:', err.stack || err.message);
    process.exit(1);
  });

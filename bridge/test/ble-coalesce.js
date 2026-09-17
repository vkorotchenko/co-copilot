'use strict';

const assert = require('assert');

process.env.COMPANION_LOG = process.env.COMPANION_LOG || 'error';

const { BleCentral } = require('../src/ble/central');

function blockedCentral() {
  const central = new BleCentral({
    ble: {
      fallbackChunk: 20,
      recoverStallMs: 0,
    },
  });
  const chunks = [];
  let releaseFirst;
  const firstWriteBlocked = new Promise((resolve) => { releaseFirst = resolve; });
  central._rx = {
    async writeAsync(chunk) {
      chunks.push(Buffer.from(chunk));
      if (chunks.length === 1) await firstWriteBlocked;
    },
  };
  central._chunk = 20;
  return { central, chunks, releaseFirst };
}

function wireLines(chunks) {
  return Buffer.concat(chunks)
    .toString('utf8')
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line));
}

async function trogdorOrderingProbe() {
  const { central, chunks, releaseFirst } = blockedCentral();

  const s1 = central.writeSnapshot({ seq: 'S1', pad: 'a'.repeat(90) });
  const s2 = central.writeSnapshot({ seq: 'S2' });
  const status = central.writeLine({ cmd: 'status' });
  const s3 = central.writeSnapshot({ seq: 'S3' });
  const owner = central.writeLine({ cmd: 'owner' });

  assert.strictEqual(
    central._writeQueue.filter((item) => item.snapshot).length,
    1,
    'replacing a pending snapshot leaves exactly one unsent snapshot'
  );
  releaseFirst();
  assert.ok(
    (await Promise.all([s1, s2, status, s3, owner])).every(Boolean),
    'the exact interleaving probe settles every caller'
  );
  assert.deepStrictEqual(wireLines(chunks), [
    { seq: 'S1', pad: 'a'.repeat(90) },
    { cmd: 'status' },
    { seq: 'S3' },
    { cmd: 'owner' },
  ], 'snapshot replacement appends at the tail without overtaking status');
}

async function preservesChunkAndCommandOrder() {
  const { central, chunks, releaseFirst } = blockedCentral();

  const active = central.writeSnapshot({ seq: 1, state: 'working', pad: 'a'.repeat(90) });
  const writes = [
    central.writeLine({ time: [1, 0] }),
    central.writeSnapshot({ seq: 2, state: 'waiting', pad: 'b'.repeat(90) }),
    central.writeLine({ cmd: 'owner', name: 'Tester' }),
    central.writeLine({ cmd: 'status' }),
    central.writeLine({ cmd: 'ota_begin', size: 3, md5: 'abc' }),
    central.writeLine({ cmd: 'ota_chunk', d: 'YWJj' }),
    central.writeLine({ cmd: 'ota_end' }),
    central.writeLine({ cmd: 'xfer_begin', files: 1 }),
  ];

  for (let seq = 3; seq <= 25; seq++) {
    writes.push(central.writeSnapshot({ seq, state: seq === 25 ? 'blocked' : 'working' }));
    assert.ok(
      central._writeQueue.filter((item) => item.snapshot).length <= 1,
      'at most one unsent snapshot may remain queued'
    );
  }

  releaseFirst();
  assert.strictEqual(await active, true);
  assert.ok((await Promise.all(writes)).every(Boolean), 'every command and coalesced waiter resolves');

  const lines = wireLines(chunks);
  assert.deepStrictEqual(
    lines,
    [
      { seq: 1, state: 'working', pad: 'a'.repeat(90) },
      { time: [1, 0] },
      { cmd: 'owner', name: 'Tester' },
      { cmd: 'status' },
      { cmd: 'ota_begin', size: 3, md5: 'abc' },
      { cmd: 'ota_chunk', d: 'YWJj' },
      { cmd: 'ota_end' },
      { cmd: 'xfer_begin', files: 1 },
      { seq: 25, state: 'blocked' },
    ],
    'the complete wire stream preserves cross-type FIFO order while snapshots coalesce'
  );
  assert.strictEqual(lines[0].pad, 'a'.repeat(90), 'the in-flight chunk stream is not corrupted');
  assert.strictEqual(lines[lines.length - 1].state, 'blocked', 'the device receives the newest state');

  const final = await central.writeSnapshot({ seq: 26, state: 'idle' });
  assert.strictEqual(final, true, 'a snapshot enqueued into a drained queue is still delivered');
  const allLines = Buffer.concat(chunks).toString('utf8').trimEnd().split('\n');
  assert.strictEqual(JSON.parse(allLines[allLines.length - 1]).seq, 26);
}

async function chainsRapidReplacementResolvers() {
  const { central, chunks, releaseFirst } = blockedCentral();

  const active = central.writeSnapshot({ seq: 0, pad: 'a'.repeat(90) });
  const first = central.writeSnapshot({ seq: 1 });
  const status = central.writeLine({ cmd: 'status' });
  const second = central.writeSnapshot({ seq: 2 });
  const owner = central.writeLine({ cmd: 'owner' });
  const third = central.writeSnapshot({ seq: 3 });

  assert.strictEqual(
    central._writeQueue.filter((item) => item.snapshot).length,
    1,
    'rapid replacements still leave one pending snapshot'
  );
  assert.strictEqual(
    central._writeQueue.find((item) => item.snapshot).resolvers.length,
    3,
    'every superseded snapshot resolver follows the newest replacement'
  );
  releaseFirst();
  assert.ok(
    (await Promise.all([active, first, status, second, owner, third])).every(Boolean),
    'rapidly superseded snapshot callers all settle'
  );
  assert.deepStrictEqual(wireLines(chunks), [
    { seq: 0, pad: 'a'.repeat(90) },
    { cmd: 'status' },
    { cmd: 'owner' },
    { seq: 3 },
  ], 'each replacement returns to the tail behind intervening commands');
}

async function replacesLonePendingSnapshotAtTail() {
  const { central, chunks, releaseFirst } = blockedCentral();

  const active = central.writeSnapshot({ seq: 0, pad: 'a'.repeat(90) });
  const stale = central.writeSnapshot({ seq: 1 });
  const newest = central.writeSnapshot({ seq: 2 });

  assert.strictEqual(central._writeQueue.length, 1, 'the lone pending snapshot stays one entry');
  assert.strictEqual(central._writeQueue[0].resolvers.length, 2, 'the stale waiter is retained');
  releaseFirst();
  assert.ok(
    (await Promise.all([active, stale, newest])).every(Boolean),
    'both lone-pending snapshot callers settle'
  );
  assert.deepStrictEqual(wireLines(chunks), [
    { seq: 0, pad: 'a'.repeat(90) },
    { seq: 2 },
  ], 'tail replacement is unchanged when no command intervenes');
}

async function settlesSupersededResolversOnDisconnect() {
  const central = new BleCentral({
    ble: {
      fallbackChunk: 20,
      recoverStallMs: 0,
    },
  });
  let releaseFirst;
  const firstWriteBlocked = new Promise((resolve) => { releaseFirst = resolve; });
  let first = true;
  central._rx = {
    async writeAsync() {
      if (first) {
        first = false;
        await firstWriteBlocked;
      }
      if (!central.connected) throw new Error('disconnected');
    },
  };
  central._chunk = 20;
  central._peripheral = {};
  central._stopped = true;

  const active = central.writeSnapshot({ seq: 0, pad: 'a'.repeat(90) });
  const stale = central.writeSnapshot({ seq: 1 });
  const status = central.writeLine({ cmd: 'status' });
  const newest = central.writeSnapshot({ seq: 2 });

  central._onDisconnect();
  releaseFirst();
  let timer;
  const settled = await Promise.race([
    Promise.all([active, stale, status, newest]),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('write promises did not settle')), 250);
    }),
  ]).finally(() => clearTimeout(timer));
  assert.deepStrictEqual(
    settled,
    [false, false, false, false],
    'disconnect drains queued writes and settles every superseded resolver'
  );
  assert.strictEqual(central._writeQueue.length, 0, 'the failed queue drains completely');
  assert.strictEqual(central._writeActive, false, 'the failed drain releases the active flag');
}

async function main() {
  await trogdorOrderingProbe();
  await preservesChunkAndCommandOrder();
  await chainsRapidReplacementResolvers();
  await replacesLonePendingSnapshotAtTail();
  await settlesSupersededResolversOnDisconnect();

  console.log('PASS: BLE snapshot coalescing preserves interleaved FIFO order and settles waiters');
}

main().catch((err) => {
  console.error('FAIL:', err.stack || err.message);
  process.exit(1);
});

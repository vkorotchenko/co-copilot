'use strict';

// Concurrency tests for the device confirmation queue.
//
// The device can only show one prompt at a time, so simultaneous
// companion_confirm calls are served FIFO: each caller's promise must resolve
// with the answer to *its own* question, and no failure mode (timeout,
// disconnect, a full queue) may strand the questions behind it.
//
// Run: node test/confirm-queue.js   (exits non-zero on failure)

const assert = require('assert');

process.env.COMPANION_LOG = process.env.COMPANION_LOG || 'error';

const baseCfg = require('../src/config');
const { Bridge, normalizeConfirmQueue, DEFAULT_CONFIRM_QUEUE, MIN_CONFIRM_QUEUE } = require('../src/bridge');
const { FakeDeviceTransport } = require('../src/transport/fakeDevice');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A rig whose fake device never answers on its own — the test drives the
// button presses so it can control ordering precisely.
async function withRig(overrides, fn) {
  const cfg = Object.assign({}, baseCfg, overrides);
  const transport = new FakeDeviceTransport({ autoAnswer: false });
  const bridge = new Bridge(transport, cfg);
  bridge.start();
  transport.start();
  await sleep(20); // let the fake device "connect"
  bridge.setModel({ total: 1, running: 1, waiting: 0, msg: 'working...', entries: [] });
  try {
    await fn(bridge, transport);
  } finally {
    bridge.stop();
    await transport.stop();
  }
}

// Wait until a prompt is on screen (optionally a different one than `notId`).
async function promptOnScreen(transport, notId = null, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const p = transport.lastPrompt;
    if (p && p.id !== notId) return p;
    await sleep(10);
  }
  return null;
}

async function testFifoOrderAndCorrelation() {
  await withRig({}, async (bridge, transport) => {
    const first = bridge.confirm({ title: 'git push', detail: 'origin main', timeoutMs: 5000 });
    const second = bridge.confirm({ title: 'rm -rf', detail: '/tmp/foo', timeoutMs: 5000 });
    const third = bridge.confirm({ title: 'deploy', detail: 'prod', timeoutMs: 5000 });
    assert.strictEqual(bridge.pendingConfirmations, 3, 'all three questions are queued');

    const p1 = await promptOnScreen(transport);
    assert.ok(p1, 'the first question should be on screen');
    assert.strictEqual(p1.tool, 'git push', 'FIFO: the first question is shown first');

    // Answering the head must resolve the *first* caller only.
    transport.press(p1.id, 'once');
    assert.deepStrictEqual(await first, { decision: 'approved' });
    assert.strictEqual(bridge.pendingConfirmations, 2, 'the answered question left the queue');

    const p2 = await promptOnScreen(transport, p1.id);
    assert.ok(p2, 'the next question should be promoted automatically');
    assert.strictEqual(p2.tool, 'rm -rf', 'FIFO order is preserved');

    // A different decision for the second caller proves correlation by id.
    transport.press(p2.id, 'deny');
    assert.deepStrictEqual(await second, { decision: 'denied' });

    const p3 = await promptOnScreen(transport, p2.id);
    assert.strictEqual(p3.tool, 'deploy');
    transport.press(p3.id, 'once');
    assert.deepStrictEqual(await third, { decision: 'approved' });
    assert.strictEqual(bridge.pendingConfirmations, 0, 'queue drains completely');
  });
}

async function testStaleReplyIsIgnored() {
  await withRig({}, async (bridge, transport) => {
    const first = bridge.confirm({ title: 'one', timeoutMs: 5000 });
    const second = bridge.confirm({ title: 'two', timeoutMs: 5000 });

    const p1 = await promptOnScreen(transport);
    transport.press(p1.id, 'once');
    assert.deepStrictEqual(await first, { decision: 'approved' });

    // A duplicate/late reply for an already-answered id must not leak into the
    // question that is now on screen.
    transport.press(p1.id, 'deny');
    await sleep(30);
    assert.strictEqual(bridge.pendingConfirmations, 1, 'the second question is untouched');

    const p2 = await promptOnScreen(transport, p1.id);
    transport.press(p2.id, 'once');
    assert.deepStrictEqual(await second, { decision: 'approved' });
  });
}

async function testHeadTimeoutAdvancesQueue() {
  await withRig({}, async (bridge, transport) => {
    const first = bridge.confirm({ title: 'ignored', timeoutMs: 120 });
    const second = bridge.confirm({ title: 'answered', timeoutMs: 5000 });

    const p1 = await promptOnScreen(transport);
    assert.strictEqual(p1.tool, 'ignored');

    // Nobody presses a button: the head times out on its own schedule and the
    // next question must be promoted rather than stranded behind it.
    assert.deepStrictEqual(await first, { decision: 'timeout' });

    const p2 = await promptOnScreen(transport, p1.id);
    assert.ok(p2, 'the queued question is promoted after the head times out');
    assert.strictEqual(p2.tool, 'answered');
    transport.press(p2.id, 'once');
    assert.deepStrictEqual(await second, { decision: 'approved' });
  });
}

async function testQueuedTimeoutLeavesHeadAlone() {
  await withRig({}, async (bridge, transport) => {
    const head = bridge.confirm({ title: 'patient', timeoutMs: 5000 });
    const impatient = bridge.confirm({ title: 'impatient', timeoutMs: 100 });

    const p1 = await promptOnScreen(transport);
    assert.strictEqual(p1.tool, 'patient');

    // The queued caller gives up while still waiting in line.
    assert.deepStrictEqual(await impatient, { decision: 'timeout' });
    assert.strictEqual(bridge.pendingConfirmations, 1, 'only the head remains');
    assert.strictEqual(transport.lastPrompt.id, p1.id, 'the visible prompt did not change');

    transport.press(p1.id, 'once');
    assert.deepStrictEqual(await head, { decision: 'approved' });
  });
}

async function testDisconnectReleasesEveryone() {
  await withRig({}, async (bridge, transport) => {
    const a = bridge.confirm({ title: 'a', timeoutMs: 5000 });
    const b = bridge.confirm({ title: 'b', timeoutMs: 5000 });
    const c = bridge.confirm({ title: 'c', timeoutMs: 5000 });
    await promptOnScreen(transport);

    transport.disconnect();

    // Every caller — queued ones included — is released, not just the head.
    assert.deepStrictEqual(await a, { decision: 'unavailable' });
    assert.deepStrictEqual(await b, { decision: 'unavailable' });
    assert.deepStrictEqual(await c, { decision: 'unavailable' });
    assert.strictEqual(bridge.pendingConfirmations, 0, 'the queue is emptied on link loss');

    // With no device, a fresh confirm fails fast instead of hanging.
    assert.deepStrictEqual(
      await bridge.confirm({ title: 'after', timeoutMs: 5000 }),
      { decision: 'unavailable' }
    );
  });
}

async function testQueueCap() {
  await withRig({ confirm: { maxQueue: 2 } }, async (bridge, transport) => {
    const a = bridge.confirm({ title: 'a', timeoutMs: 2000 });
    const b = bridge.confirm({ title: 'b', timeoutMs: 2000 });
    // Beyond the cap, callers are told the device is unavailable rather than
    // piling up behind a screen that shows one prompt at a time.
    assert.deepStrictEqual(await bridge.confirm({ title: 'c', timeoutMs: 2000 }), {
      decision: 'unavailable',
    });
    assert.strictEqual(bridge.pendingConfirmations, 2);

    const p1 = await promptOnScreen(transport);
    transport.press(p1.id, 'once');
    assert.deepStrictEqual(await a, { decision: 'approved' });
    const p2 = await promptOnScreen(transport, p1.id);
    transport.press(p2.id, 'once');
    assert.deepStrictEqual(await b, { decision: 'approved' });
  });
}

async function testStopReleasesPending() {
  const cfg = Object.assign({}, baseCfg);
  const transport = new FakeDeviceTransport({ autoAnswer: false });
  const bridge = new Bridge(transport, cfg);
  bridge.start();
  transport.start();
  await sleep(20);
  const pending = bridge.confirm({ title: 'shutdown', timeoutMs: 10000 });
  bridge.stop();
  assert.deepStrictEqual(await pending, { decision: 'unavailable' }, 'stop() releases callers');
  await transport.stop();
}

// A configured queue depth of 0 must not silently become the default (the old
// `cfg.maxQueue || 8`), nor silently disable the hardware approval gate. It
// clamps up to the documented floor of 1: one question on screen, no queueing.
async function testQueueDepthFloor() {
  assert.strictEqual(normalizeConfirmQueue(0), MIN_CONFIRM_QUEUE, '0 clamps to the floor');
  assert.strictEqual(normalizeConfirmQueue(-5), MIN_CONFIRM_QUEUE, 'negatives clamp to the floor');
  assert.strictEqual(normalizeConfirmQueue(1), 1, 'the floor itself is honoured');
  assert.strictEqual(normalizeConfirmQueue(3), 3, 'ordinary values pass through');
  assert.strictEqual(normalizeConfirmQueue(2.7), 2, 'fractions truncate');
  // Only genuinely absent/unparseable values fall back to the default.
  assert.strictEqual(normalizeConfirmQueue(undefined), DEFAULT_CONFIRM_QUEUE);
  assert.strictEqual(normalizeConfirmQueue(null), DEFAULT_CONFIRM_QUEUE);
  assert.strictEqual(normalizeConfirmQueue(''), DEFAULT_CONFIRM_QUEUE);
  assert.strictEqual(normalizeConfirmQueue('nope'), DEFAULT_CONFIRM_QUEUE);

  // ...and a clamped bridge still asks the question rather than refusing it.
  await withRig({ confirm: { maxQueue: 0 } }, async (bridge, transport) => {
    assert.strictEqual(bridge._maxConfirmQueue, 1, 'a configured 0 clamps to 1');
    const head = bridge.confirm({ title: 'deploy', detail: 'prod', timeoutMs: 2000 });
    // The floor still means "no queueing": the second caller is turned away.
    assert.deepStrictEqual(await bridge.confirm({ title: 'queued', timeoutMs: 2000 }), {
      decision: 'unavailable',
    });
    const p = await promptOnScreen(transport);
    assert.ok(p, 'the question still reaches the screen');
    transport.press(p.id, 'once');
    assert.deepStrictEqual(await head, { decision: 'approved' });
  });
}

async function main() {
  await testFifoOrderAndCorrelation();
  await testStaleReplyIsIgnored();
  await testHeadTimeoutAdvancesQueue();
  await testQueuedTimeoutLeavesHeadAlone();
  await testDisconnectReleasesEveryone();
  await testQueueCap();
  await testQueueDepthFloor();
  await testStopReleasesPending();
  console.log(
    'PASS: confirmation queue (FIFO order, correlation, timeout/disconnect advancement, depth floor)'
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('FAIL:', err.stack || err.message);
    process.exit(1);
  });

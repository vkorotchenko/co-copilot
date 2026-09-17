'use strict';

const EventEmitter = require('events');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { LineFramer } = require('../protocol/lineframer');
const {
  resolveBlueutil,
  describeResolution,
  parseBondedDevice,
  parseBondedAddress,
} = require('./blueutil');
const log = require('../util/log');

const execFileP = promisify(execFile);

// blueutil blocks until the OS reports the state change it was asked for, and
// on a device that is already disconnected that event never arrives — the call
// then hangs indefinitely. An unbounded await would strand the _recovering
// guard and silently disable every later recovery attempt, i.e. exactly the
// class of failure this path exists to repair. Bound every invocation; the
// stall cadence is ~45s, so this stays well clear of the next attempt.
const BLUEUTIL_TIMEOUT_MS = 10000;

// Short, stable identifiers for the log-cadence key, plus a readable detail.
// Timeouts surface as `killed` rather than an exit code, so they need naming.
function execFailure(err, timeoutMs) {
  if (err.killed) {
    return {
      key: 'timeout',
      detail: `timed out after ${timeoutMs}ms ` +
        '(the Bluetooth stack never reported the state change)',
    };
  }
  const stderr = String(err.stderr || '').trim().split('\n')[0];
  const head = String(err.message || 'failed').split('\n')[0];
  return {
    key: err.code || err.signal || 'failed',
    detail: stderr ? `${head} — ${stderr}` : head,
  };
}

// BLE central transport. Scans for a peripheral advertising the Nordic UART
// Service whose name starts with the configured prefix ("Copilot"), connects,
// subscribes to TX notifications, and writes JSON lines to RX. Auto-reconnects
// on disconnect. noble is required lazily so console/simulate modes don't need
// the native dependency.
//
// Events:
//   'scanning'      -> ()                 scanning (re)started
//   'connected'     -> (name)             device link is up, characteristics ready
//   'disconnected'  -> ()                 link dropped
//   'line'          -> (obj|string)       a JSON object (or raw string) from device
class BleCentral extends EventEmitter {
  constructor(cfg) {
    super();
    this._cfg = cfg.ble;
    this._noble = null;
    this._peripheral = null;
    this._rx = null;
    this._tx = null;
    this._chunk = cfg.ble.fallbackChunk;
    this._writeQueue = [];
    this._writeActive = false;
    this._framer = new LineFramer((line) => this._onDeviceLine(line));
    this._stopped = false;
    // macOS self-heal: when noble keeps scanning without ever finding the
    // device, macOS has usually auto-reconnected to the bonded peripheral and
    // is holding the link (so it stops advertising and noble can't see it).
    // After this long stalled, we shell out to `blueutil --disconnect` to
    // release the OS hold; the device re-advertises and noble reclaims it.
    this._recoverStallMs = cfg.ble.recoverStallMs || 0;
    this._recoverTimer = null;
    this._recovering = false;
    // Absolute path to blueutil, resolved lazily and cached once found.
    this._blueutilPath = null;
    // Bound on every blueutil invocation. Overridable mainly so tests can
    // exercise the hang path quickly; there is no reason to tune it in
    // production, so it is deliberately not an environment variable.
    this._blueutilTimeoutMs = cfg.ble.blueutilTimeoutMs || BLUEUTIL_TIMEOUT_MS;
    // Last condition reported by the recovery path, so an unchanging failure is
    // announced once per stall episode instead of every retry. See
    // _reportRecovery().
    this._recoverWarnKey = null;
  }

  start() {
    try {
      // eslint-disable-next-line global-require
      this._noble = require('@abandonware/noble');
    } catch (err) {
      log.error('Failed to load @abandonware/noble. Install it, or run with ' +
        '--no-ble / --simulate for a hardware-free dry run.');
      throw err;
    }

    const noble = this._noble;
    noble.on('stateChange', (state) => {
      log.debug('BLE adapter state:', state);
      if (state === 'poweredOn') this._startScanning();
      else this._teardown();
    });
    noble.on('discover', (p) => this._onDiscover(p));

    if (noble.state === 'poweredOn') this._startScanning();
  }

  async _startScanning() {
    if (this._stopped) return;
    try {
      await this._noble.startScanningAsync([this._cfg.serviceUuid], false);
      log.info(`Scanning for "${this._cfg.namePrefix}*" devices...`);
      this.emit('scanning');
      this._scheduleRecovery();
    } catch (err) {
      log.error('startScanning failed:', err.message);
    }
  }

  // Arm the stall-recovery check (macOS only). Re-armed each time scanning
  // (re)starts; cleared once a link is up.
  _scheduleRecovery() {
    if (this._recoverTimer) { clearTimeout(this._recoverTimer); this._recoverTimer = null; }
    if (this._stopped || process.platform !== 'darwin' || this._recoverStallMs <= 0) return;
    this._recoverTimer = setTimeout(() => this._onScanStall(), this._recoverStallMs);
  }

  _cancelRecovery() {
    if (this._recoverTimer) { clearTimeout(this._recoverTimer); this._recoverTimer = null; }
    // A link came up (or we're shutting down): the stall episode is over, so a
    // future one reports its condition afresh rather than staying silent
    // because the same thing failed hours ago.
    this._recoverWarnKey = null;
  }

  async _onScanStall() {
    this._recoverTimer = null;
    if (this._stopped || this.connected || this._peripheral) return; // connected/connecting
    await this._attemptRecovery();
    // Still stuck? keep trying on the same cadence.
    if (!this._stopped && !this.connected && !this._peripheral) this._scheduleRecovery();
  }

  // Recovery retries on the stall cadence (~45s) for as long as the link stays
  // down, so an unchanging failure must not fill the log overnight. Warn the
  // first time a condition is seen in a stall episode and again whenever it
  // changes; identical repeats drop to debug. _cancelRecovery() clears the key
  // when a link comes up, which bounds this to "once per stall episode".
  _reportRecovery(key, message) {
    if (this._recoverWarnKey === key) { log.debug(message); return; }
    this._recoverWarnKey = key;
    log.warn(message);
  }

  // Resolve blueutil's absolute path, caching the hit. A *failure* is
  // deliberately not cached: blueutil may be installed while the service is
  // running, and re-probing costs a couple of stat() calls once per stall.
  _resolveBlueutilPath() {
    if (this._blueutilPath) return this._blueutilPath;
    const res = resolveBlueutil();
    if (!res.path) {
      this._reportRecovery(`resolve:${res.reason}`,
        `BLE recovery unavailable: ${describeResolution(res)}. ` +
        'Scanning continues; the bridge cannot release an OS-held bond without it.');
      return null;
    }
    log.debug(`BLE recovery: using blueutil at ${res.path} (via ${res.source}).`);
    this._blueutilPath = res.path;
    return res.path;
  }

  // Best-effort: ask blueutil to drop the OS-held connection so the device
  // re-advertises. No-ops harmlessly if blueutil is absent or the device isn't
  // actually held. The ongoing noble scan then rediscovers + connects.
  //
  // Every failure mode is reported distinctly so the log says whether blueutil
  // is missing, misconfigured, or present but failing.
  async _attemptRecovery() {
    if (this._recovering) return;
    this._recovering = true;
    try {
      const bin = this._resolveBlueutilPath();
      if (!bin) return; // already reported at a controlled cadence

      let stdout;
      try {
        ({ stdout } = await execFileP(bin, ['--paired'], { timeout: this._blueutilTimeoutMs }));
      } catch (err) {
        // Cached path went stale (e.g. `brew uninstall blueutil`): drop it so
        // the next stall re-resolves instead of retrying a dead path forever.
        if (err.code === 'ENOENT') this._blueutilPath = null;
        const f = execFailure(err, this._blueutilTimeoutMs);
        this._reportRecovery(`paired:${f.key}`,
          `BLE recovery failed: \`${bin} --paired\` ${f.detail}`);
        return;
      }

      const device = parseBondedDevice(stdout, this._cfg.namePrefix);
      if (!device) {
        this._reportRecovery('no-match',
          `BLE recovery skipped: no bonded device named "${this._cfg.namePrefix}*" in ` +
          `\`${bin} --paired\`, so macOS is not holding the link — this stall has ` +
          'another cause (device powered off, out of range, or never paired).');
        return;
      }

      // Only a link macOS is actually holding can be released. Disconnecting an
      // already-disconnected device is not merely a no-op: blueutil waits for a
      // disconnect event that never comes, burning the timeout every stall and
      // masking the real cause. `connected === null` means the output format was
      // unrecognised, in which case we still try — a redundant disconnect is a
      // cheaper mistake than skipping a recovery that was needed.
      if (device.connected === false) {
        this._reportRecovery('bonded-idle',
          `BLE recovery skipped: ${device.address} is bonded but not connected, so ` +
          'macOS is not holding the link — the device is likely powered off or out ' +
          'of range. Still scanning.');
        return;
      }

      this._reportRecovery(`disconnect:${device.address}`,
        `Scan stalled ~${Math.round(this._recoverStallMs / 1000)}s; ` +
        `releasing OS hold on ${device.address} (\`${bin} --disconnect\`).`);
      try {
        await execFileP(bin, ['--disconnect', device.address], { timeout: this._blueutilTimeoutMs });
      } catch (err) {
        if (err.code === 'ENOENT') this._blueutilPath = null;
        const f = execFailure(err, this._blueutilTimeoutMs);
        this._reportRecovery(`disconnect-failed:${f.key}`,
          `BLE recovery failed: \`${bin} --disconnect ${device.address}\` ${f.detail}`);
      }
    } finally {
      this._recovering = false;
    }
  }

  async _onDiscover(peripheral) {
    const name = (peripheral.advertisement && peripheral.advertisement.localName) || '';
    if (!name.startsWith(this._cfg.namePrefix)) return;
    if (this._peripheral) return; // already bound to one device

    log.info(`Found ${name} (${peripheral.address || peripheral.id}), connecting...`);
    this._peripheral = peripheral;
    try {
      await this._noble.stopScanningAsync();
      // noble caches Peripheral objects by id, so a failed connect attempt can
      // leave a stale 'disconnect' listener behind; clear them before binding
      // a fresh one (otherwise they accumulate -> MaxListeners warning).
      peripheral.removeAllListeners('disconnect');
      peripheral.once('disconnect', () => this._onDisconnect());
      // connectAsync (and characteristic discovery) can hang indefinitely —
      // e.g. a stale OS-level bond stalls the encryption handshake forever.
      // Bound the whole bring-up so the bridge recovers by tearing down and
      // rescanning instead of freezing.
      await this._withTimeout(
        (async () => {
          await peripheral.connectAsync();
          await this._bindCharacteristics(peripheral);
        })(),
        this._cfg.connectTimeoutMs,
        'connect timed out'
      );
      if (typeof peripheral.mtu === 'number' && peripheral.mtu > 3) {
        this._chunk = peripheral.mtu - 3;
      }
      log.info(`Connected to ${name} (chunk=${this._chunk}B).`);
      this._cancelRecovery();
      this.emit('connected', name);
    } catch (err) {
      log.error('Connect failed:', err.message);
      try { await peripheral.disconnectAsync(); } catch { /* noop */ }
      this._onDisconnect();
    }
  }

  // Reject `promise` after `ms` if it hasn't settled, so a hung BLE bring-up
  // can't wedge the bridge. ms<=0 disables the bound.
  _withTimeout(promise, ms, msg) {
    if (!ms || ms <= 0) return promise;
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(msg)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  async _bindCharacteristics(peripheral) {
    const { characteristics } = await peripheral.discoverSomeServicesAndCharacteristicsAsync(
      [this._cfg.serviceUuid],
      [this._cfg.rxCharUuid, this._cfg.txCharUuid]
    );
    for (const c of characteristics) {
      if (c.uuid === this._cfg.rxCharUuid) this._rx = c;
      if (c.uuid === this._cfg.txCharUuid) this._tx = c;
    }
    if (!this._rx || !this._tx) {
      throw new Error('NUS RX/TX characteristics not found on device');
    }
    this._framer.reset();
    this._tx.on('data', (data) => this._framer.push(data));
    await this._tx.subscribeAsync();
  }

  _onDeviceLine(line) {
    try {
      const message = JSON.parse(line);
      if (message && typeof message === 'object' && !Array.isArray(message)) {
        this.emit('line', message);
      }
      return;
    } catch {
      // Non-JSON diagnostics remain observable as raw lines.
    }
    this.emit('line', line);
  }

  _onDisconnect() {
    if (!this._peripheral) return;
    log.warn('Device disconnected.');
    this._teardown();
    this.emit('disconnected');
    if (!this._stopped) setTimeout(() => this._startScanning(), 1000);
  }

  _teardown() {
    if (this._tx) {
      try { this._tx.removeAllListeners('data'); } catch { /* noop */ }
    }
    this._peripheral = null;
    this._rx = null;
    this._tx = null;
  }

  get connected() {
    return !!this._rx;
  }

  // Write a JS object as a single newline-terminated JSON line.
  writeLine(obj) {
    return this.writeRaw(JSON.stringify(obj) + '\n');
  }

  // Snapshot heartbeats describe replaceable state. Commands sent through
  // writeLine() are deliberately never marked coalescible: time/owner/status,
  // OTA, and transfer messages are ordered events whose loss breaks handshakes.
  writeSnapshot(obj) {
    return this._enqueueWrite(JSON.stringify(obj) + '\n', true);
  }

  // Serialize writes so chunked lines never interleave. Each chunk is written
  // with response (NUS RX is a WRITE characteristic on the firmware).
  writeRaw(str) {
    return this._enqueueWrite(str, false);
  }

  _enqueueWrite(str, snapshot) {
    if (!this._rx) return Promise.resolve(false);
    const data = Buffer.from(str, 'utf8');
    return new Promise((resolve) => {
      if (snapshot) {
        const pendingIndex = this._writeQueue.findIndex((item) => item.snapshot);
        if (pendingIndex !== -1) {
          const [pending] = this._writeQueue.splice(pendingIndex, 1);
          /*
           * Replacing a pending snapshot in place silently moves newer state
           * ahead of commands queued after the stale snapshot. That can put a
           * heartbeat before the time/owner handshake it should follow, or
           * ahead of an OTA control message. Remove the stale entry and append
           * its replacement at the tail: coalescing still bounds the backlog,
           * while every intervening command keeps its FIFO position.
           */
          this._writeQueue.push({
            data,
            snapshot,
            rx: this._rx,
            chunk: this._chunk,
            resolvers: [...pending.resolvers, resolve],
          });
          return;
        }
      }
      this._writeQueue.push({
        data,
        snapshot,
        rx: this._rx,
        chunk: this._chunk,
        resolvers: [resolve],
      });
      this._drainWriteQueue();
    });
  }

  async _drainWriteQueue() {
    if (this._writeActive) return;
    this._writeActive = true;
    while (this._writeQueue.length > 0) {
      const item = this._writeQueue.shift();
      let written = false;
      try {
        /*
         * At the 20-byte fallback MTU, one heartbeat can require more than a
         * hundred writes. Queuing every forced update behind it preserves stale
         * whole snapshots and turns state changes into backlog latency. The
         * active item has already left the queue, so replacement can touch only
         * an unsent snapshot; its chunk stream always completes intact. Command
         * items are exempt because dropping one can break clock, status, OTA,
         * or transfer protocols rather than merely skip an obsolete state.
         */
        for (let i = 0; i < item.data.length; i += item.chunk) {
          await item.rx.writeAsync(item.data.subarray(i, i + item.chunk), false);
        }
        written = true;
      } catch (err) {
        log.error('Write failed:', err.message);
      }
      for (const resolve of item.resolvers) resolve(written);
    }
    this._writeActive = false;
  }

  async stop() {
    this._stopped = true;
    this._cancelRecovery();
    try {
      if (this._noble) await this._noble.stopScanningAsync();
      if (this._peripheral) await this._peripheral.disconnectAsync();
    } catch { /* noop */ }
    this._teardown();
  }
}

module.exports = { BleCentral, parseBondedAddress };

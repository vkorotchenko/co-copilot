'use strict';

const EventEmitter = require('events');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { LineFramer } = require('../protocol/lineframer');
const log = require('../util/log');

const execFileP = promisify(execFile);

// Pull the bonded device's address out of `blueutil --paired` output, matching
// the configured name prefix. Lines look like:
//   address: 48-27-e2-e3-c9-25, connected (master, 0 dBm), ..., name: "Copilot-C924"
function parseBondedAddress(stdout, namePrefix) {
  for (const line of String(stdout || '').split('\n')) {
    if (line.indexOf(`name: "${namePrefix}`) === -1) continue;
    const m = /address:\s*([0-9a-f:-]+)/i.exec(line);
    if (m) return m[1];
  }
  return null;
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
    this._writeQueue = Promise.resolve();
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
  }

  async _onScanStall() {
    this._recoverTimer = null;
    if (this._stopped || this.connected || this._peripheral) return; // connected/connecting
    await this._attemptRecovery();
    // Still stuck? keep trying on the same cadence.
    if (!this._stopped && !this.connected && !this._peripheral) this._scheduleRecovery();
  }

  // Best-effort: ask blueutil to drop the OS-held connection so the device
  // re-advertises. No-ops harmlessly if blueutil is absent or the device isn't
  // actually held. The ongoing noble scan then rediscovers + connects.
  async _attemptRecovery() {
    if (this._recovering) return;
    this._recovering = true;
    try {
      const { stdout } = await execFileP('blueutil', ['--paired']);
      const addr = parseBondedAddress(stdout, this._cfg.namePrefix);
      if (!addr) { log.debug('BLE recovery: no bonded device matched.'); return; }
      log.warn(`Scan stalled ~${Math.round(this._recoverStallMs / 1000)}s; ` +
        `releasing OS hold on ${addr} (blueutil --disconnect).`);
      await execFileP('blueutil', ['--disconnect', addr]);
    } catch (err) {
      log.debug('BLE recovery skipped:', err.message);
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
    if (line[0] === '{') {
      try {
        this.emit('line', JSON.parse(line));
        return;
      } catch {
        /* fall through to raw */
      }
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

  // Serialize writes so chunked lines never interleave. Each chunk is written
  // with response (NUS RX is a WRITE characteristic on the firmware).
  writeRaw(str) {
    if (!this._rx) return Promise.resolve(false);
    const rx = this._rx;
    const data = Buffer.from(str, 'utf8');
    const chunk = this._chunk;
    this._writeQueue = this._writeQueue.then(async () => {
      try {
        for (let i = 0; i < data.length; i += chunk) {
          await rx.writeAsync(data.subarray(i, i + chunk), false);
        }
        return true;
      } catch (err) {
        log.error('Write failed:', err.message);
        return false;
      }
    });
    return this._writeQueue;
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

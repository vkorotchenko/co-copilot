'use strict';

const EventEmitter = require('events');
const log = require('../util/log');

// A transport that pretends to be a connected device. It logs outgoing lines
// like ConsoleTransport, but also *auto-answers* any permission prompt it sees
// in an outgoing snapshot by emitting a {"cmd":"permission",...} line back.
// This lets the whole confirm() round-trip (and the MCP companion_confirm tool)
// be exercised end-to-end with no hardware.
//
// Set COMPANION_FAKE_DECISION=deny to make it deny instead of approve, and
// COMPANION_FAKE_DELAY_MS to control how long the "button press" takes. Pass
// { autoAnswer: false } to keep prompts unanswered so a test can drive the
// button presses itself (used to exercise the confirmation queue).
class FakeDeviceTransport extends EventEmitter {
  constructor(opts = {}) {
    super();
    this._connected = false;
    this._decision = process.env.COMPANION_FAKE_DECISION === 'deny' ? 'deny' : 'once';
    this._delay = parseInt(process.env.COMPANION_FAKE_DELAY_MS || '400', 10);
    this._autoAnswer = opts.autoAnswer !== false;
    this._completionLatch = opts.completionLatch === true;
    this._answered = new Set();
    this.sent = []; // every outgoing object, for assertions
  }

  start() {
    setImmediate(() => {
      this._connected = true;
      log.info(`Fake device ready (auto-answers prompts: ${this._autoAnswer ? this._decision : 'no'}).`);
      this.emit('connected', 'fake-device');
    });
  }

  get connected() {
    return this._connected;
  }

  // Simulate the BLE link dropping (device out of range / OS grabbed the bond).
  disconnect() {
    this._connected = false;
    this.emit('disconnected');
  }

  // Simulate a button press for a specific prompt id.
  press(id, decision = 'once') {
    this.emit('line', { cmd: 'permission', id, decision });
  }

  // The prompt currently rendered on screen, per the last snapshot sent.
  get lastPrompt() {
    for (let i = this.sent.length - 1; i >= 0; i--) {
      const obj = this.sent[i];
      if (obj && Object.prototype.hasOwnProperty.call(obj, 'msg')) {
        return obj.prompt || null;
      }
    }
    return null;
  }

  writeLine(obj) {
    this.sent.push(obj);
    return this.writeRaw(JSON.stringify(obj) + '\n');
  }

  writeRaw(str) {
    if (str.indexOf('"ota_chunk"') === -1) {
      const out = log.isStderrOnly() ? process.stderr : process.stdout;
      out.write('  TX> ' + str);
    }
    // Inspect for a permission prompt and schedule an auto-answer.
    try {
      const obj = JSON.parse(str);
      if (
        this._autoAnswer &&
        obj && obj.prompt && obj.prompt.id && !this._answered.has(obj.prompt.id)
      ) {
        this._answered.add(obj.prompt.id);
        const id = obj.prompt.id;
        setTimeout(() => {
          const reply = { cmd: 'permission', id, decision: this._decision };
          log.info(`Fake device pressing ${this._decision === 'deny' ? 'DENY' : 'APPROVE'} for ${id}`);
          this.emit('line', reply);
        }, this._delay);
      }
      if (obj && obj.cmd === 'status') {
        const data = { name: 'fake-device' };
        if (this._completionLatch) data.cl = 1;
        setImmediate(() => this.emit('line', { ack: 'status', ok: true, data }));
      }
      // OTA: ack each ota_* command so the flasher round-trip can be tested.
      if (obj && typeof obj.cmd === 'string' && obj.cmd.startsWith('ota_')) {
        this._handleOta(obj);
      }
    } catch {
      /* not JSON, ignore */
    }
    return Promise.resolve(true);
  }

  _handleOta(obj) {
    let ack;
    if (obj.cmd === 'ota_begin') {
      this._otaWritten = 0;
      this._otaTotal = obj.size || 0;
      ack = { ack: 'ota_begin', ok: true, n: 0 };
    } else if (obj.cmd === 'ota_chunk') {
      const len = obj.d ? Buffer.from(obj.d, 'base64').length : 0;
      this._otaWritten = (this._otaWritten || 0) + len;
      ack = { ack: 'ota_chunk', ok: true, n: this._otaWritten };
    } else if (obj.cmd === 'ota_end') {
      ack = { ack: 'ota_end', ok: true, n: this._otaWritten || 0 };
    } else if (obj.cmd === 'ota_abort') {
      ack = { ack: 'ota_abort', ok: true, n: 0 };
    }
    if (ack) setImmediate(() => this.emit('line', ack));
  }

  async stop() {
    this._connected = false;
  }
}

module.exports = { FakeDeviceTransport };

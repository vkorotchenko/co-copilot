#!/usr/bin/env node
'use strict';

const cfg = require('./config');
const log = require('./util/log');
const { Bridge } = require('./bridge');
const { CopilotSource } = require('./copilot/source');
const { SimulateSource } = require('./simulate');

function parseArgs(argv) {
  const a = { simulate: false, ble: true, fakeDevice: false, mcp: false, mcpStdio: false, flash: null, help: false };
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--simulate' || arg === '-s') a.simulate = true;
    else if (arg === '--no-ble') a.ble = false;
    else if (arg === '--fake-device') { a.fakeDevice = true; a.ble = false; }
    else if (arg === '--mcp') a.mcp = true;
    else if (arg === '--mcp-stdio') { a.mcp = true; a.mcpStdio = true; }
    else if (arg === '--flash') a.flash = rest[++i];
    else if (arg === '--help' || arg === '-h') a.help = true;
    else if (a.flash === undefined) a.flash = arg;   // bare path after --flash
    else log.warn('Unknown argument:', arg);
  }
  return a;
}

const HELP = `co-mpanion bridge — stream GitHub Copilot CLI activity to a BLE desk-buddy.

Usage: co-mpanion [options]

Options:
  -s, --simulate     Stream scripted fake activity instead of reading Copilot.
      --no-ble       Don't use Bluetooth; print outgoing lines to the console.
      --fake-device  Simulate a connected device that auto-answers prompts
                     (implies --no-ble; for testing confirm/MCP/OTA flows).
      --mcp          Also run the MCP server over HTTP (read+write tools).
      --mcp-stdio    Run the MCP server over stdio (implies --mcp). Use this when
                     Copilot CLI launches the bridge as a "local" MCP server;
                     all logs are redirected to stderr.
      --flash <bin>  Push a firmware .bin to the device over BLE (OTA), then exit.
  -h, --help         Show this help.

Env:
  COPILOT_HOME           Copilot state dir (default ~/.copilot)
  COMPANION_LOGS_DIR     Dir holding the live process-*.log (default
                         $COPILOT_HOME/logs; set if a launcher redirects
                         logs via --log-dir; searched recursively)
  COMPANION_NAME_PREFIX  BLE device name prefix to scan for (default "Copilot")
  COMPANION_MCP_PORT     MCP HTTP port (default 4317)
  COMPANION_OTA_CHUNK    OTA chunk size in bytes (default 384)
  COMPANION_LOG          Log level: debug|info|warn|error (default info)
`;

function makeTransport(args) {
  if (args.fakeDevice) {
    const { FakeDeviceTransport } = require('./transport/fakeDevice');
    return new FakeDeviceTransport();
  }
  if (!args.ble) {
    const { ConsoleTransport } = require('./transport/console');
    return new ConsoleTransport();
  }
  const { BleCentral } = require('./ble/central');
  return new BleCentral(cfg);
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    process.stdout.write(HELP);
    return;
  }

  const transport = makeTransport(args);

  // stdio MCP owns stdout for JSON-RPC; route every log line to stderr so we
  // never corrupt the framing. Must happen before anything logs.
  if (args.mcpStdio) log.setStderrOnly(true);

  // --- OTA flash mode: connect, push the firmware, exit --------------------
  if (args.flash) {
    await runFlash(transport, args.flash);
    return;
  }

  const bridge = new Bridge(transport, cfg);
  const source = args.simulate
    ? new SimulateSource(cfg)
    : new CopilotSource(cfg, {
        usageSessionIds: () =>
          bridge.registry
            .list()
            .map((record) => record.conversation_id)
            .filter(Boolean),
      });
  log.info(args.simulate ? 'Source: simulated activity' : 'Source: Copilot CLI');

  source.on('model', (model) => bridge.setModel(model));

  let mcp = null;
  if (args.mcp) {
    const { CompanionMcpServer } = require('./mcp/server');
    mcp = new CompanionMcpServer(bridge, cfg);
    if (args.mcpStdio) await mcp.startStdio();
    else await mcp.start();
  }

  bridge.start();
  source.start();
  transport.start();

  const shutdown = async () => {
    log.info('Shutting down...');
    try { source.stop(); } catch { /* noop */ }
    try { bridge.stop(); } catch { /* noop */ }
    try { if (mcp) await mcp.stop(); } catch { /* noop */ }
    try { await transport.stop(); } catch { /* noop */ }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  log.error('Fatal:', err.stack || err.message);
  process.exit(1);
});

// Connect to the device, stream a firmware image over BLE OTA, then exit.
async function runFlash(transport, binPath) {
  const fs = require('fs');
  if (!fs.existsSync(binPath)) {
    log.error(`Firmware file not found: ${binPath}`);
    process.exit(1);
  }
  const { flashFirmware } = require('./ota/flasher');
  const chunkSize = parseInt(process.env.COMPANION_OTA_CHUNK || '384', 10);

  await new Promise((resolve) => {
    let started = false;
    transport.on('connected', async () => {
      if (started) return;
      started = true;
      try {
        let lastPct = -1;
        const t0 = Date.now();
        await flashFirmware(transport, binPath, {
          chunkSize,
          onProgress: (written, total) => {
            const pct = Math.floor((written / total) * 100);
            if (pct !== lastPct) {
              lastPct = pct;
              process.stdout.write(`\r  flashing ${pct}% (${written}/${total} bytes)   `);
            }
          },
        });
        const secs = ((Date.now() - t0) / 1000).toFixed(1);
        process.stdout.write('\n');
        log.info(`Done in ${secs}s. Device is verifying + rebooting; it will re-advertise shortly.`);
      } catch (err) {
        process.stdout.write('\n');
        log.error('OTA failed:', err.message);
        try { await transport.writeLine({ cmd: 'ota_abort' }); } catch { /* noop */ }
        process.exitCode = 1;
      } finally {
        try { await transport.stop(); } catch { /* noop */ }
        resolve();
      }
    });
    transport.on('scanning', () => log.info('Waiting for a co-mpanion device to flash...'));
    transport.start();
  });
}

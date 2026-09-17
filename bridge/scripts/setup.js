#!/usr/bin/env node
'use strict';

// One-command installer for the co-mpanion bridge.
//
//   node scripts/setup.js              install + start
//   node scripts/setup.js --uninstall  stop + remove
//
// It makes the "clone -> install -> use" path real by doing the two manual
// steps for you, idempotently:
//
//   1. Registers co-mpanion in ~/.copilot/mcp-config.json as a `type:"http"`
//      MCP server (merging, never clobbering, your other servers; backs up
//      first). HTTP is the transport that actually works across concurrent
//      Copilot processes — one long-lived bridge owns the single BLE link,
//      instead of each process spawning its own and fighting over the device.
//
//   2. Installs a per-user background service that runs `index.js --mcp` so the
//      bridge is always up and owns the device across sessions and reboots:
//        macOS -> launchd LaunchAgent (~/Library/LaunchAgents)
//        Linux -> systemd --user unit (~/.config/systemd/user)
//
// Absolute node + repo paths are resolved automatically. Set COMPANION_LOGS_DIR
// / COMPANION_MCP_PORT / COMPANION_MCP_HOST / COMPANION_NAME_PREFIX / COPILOT_HOME
// in the environment at install time to bake them into the service.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const LABEL = 'com.co-mpanion.bridge';        // launchd label / systemd unit base
const UNIT = 'co-mpanion-bridge.service';     // systemd unit filename
const HOME = os.homedir();
const NODE_BIN = process.execPath;                        // absolute node path
const BRIDGE_DIR = path.resolve(__dirname, '..');         // .../bridge
const ENTRY = path.join(BRIDGE_DIR, 'src', 'index.js');
const HOST = process.env.COMPANION_MCP_HOST || '127.0.0.1';
const PORT = process.env.COMPANION_MCP_PORT || '4317';
const MCP_URL = `http://${HOST}:${PORT}/mcp`;
const COPILOT_HOME = process.env.COPILOT_HOME || path.join(HOME, '.copilot');
const MCP_CONFIG = path.join(COPILOT_HOME, 'mcp-config.json');

function log(msg) { process.stdout.write(`[setup] ${msg}\n`); }

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// Only env vars explicitly set at install time are baked into the service, so a
// vanilla install stays clean (defaults apply). COMPANION_LOG defaults to info.
function serviceEnv() {
  const env = {};
  for (const k of [
    'COMPANION_LOGS_DIR', 'COMPANION_MCP_PORT', 'COMPANION_MCP_HOST',
    'COMPANION_NAME_PREFIX', 'COPILOT_HOME',
    // Only an explicit override is carried through. The bridge resolves
    // blueutil itself at runtime (see src/ble/blueutil.js) precisely because
    // this service inherits a bare PATH, so baking a discovered path here would
    // duplicate that logic and could go stale if Homebrew moves or blueutil is
    // installed after setup ran.
    'COMPANION_BLUEUTIL',
  ]) {
    if (process.env[k]) env[k] = process.env[k];
  }
  env.COMPANION_LOG = process.env.COMPANION_LOG || 'info';
  return env;
}

// ---- MCP registration -----------------------------------------------------

function registerMcp() {
  fs.mkdirSync(COPILOT_HOME, { recursive: true });
  let cfg = { mcpServers: {} };
  if (fs.existsSync(MCP_CONFIG)) {
    const raw = fs.readFileSync(MCP_CONFIG, 'utf8');
    try {
      cfg = JSON.parse(raw);
    } catch (e) {
      throw new Error(`Could not parse ${MCP_CONFIG}: ${e.message}`);
    }
    const bak = `${MCP_CONFIG}.bak-${stamp()}`;
    fs.writeFileSync(bak, raw);
    log(`Backed up existing config -> ${bak}`);
  }
  if (!cfg.mcpServers || typeof cfg.mcpServers !== 'object') cfg.mcpServers = {};
  cfg.mcpServers['co-mpanion'] = { type: 'http', url: MCP_URL, tools: ['*'] };
  fs.writeFileSync(MCP_CONFIG, JSON.stringify(cfg, null, 2) + '\n');
  log(`Registered co-mpanion (http ${MCP_URL}) in ${MCP_CONFIG}`);
}

function unregisterMcp() {
  if (!fs.existsSync(MCP_CONFIG)) return;
  const raw = fs.readFileSync(MCP_CONFIG, 'utf8');
  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch {
    return;
  }
  if (cfg.mcpServers && cfg.mcpServers['co-mpanion']) {
    const bak = `${MCP_CONFIG}.bak-${stamp()}`;
    fs.writeFileSync(bak, raw);
    delete cfg.mcpServers['co-mpanion'];
    fs.writeFileSync(MCP_CONFIG, JSON.stringify(cfg, null, 2) + '\n');
    log(`Removed co-mpanion from ${MCP_CONFIG} (backup ${bak})`);
  }
}

// ---- service: macOS launchd ----------------------------------------------

const plistPath = () => path.join(HOME, 'Library', 'LaunchAgents', `${LABEL}.plist`);
const macLogPath = () => path.join(HOME, 'Library', 'Logs', 'co-mpanion-bridge.log');

function xml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function macPlist() {
  const envXml = Object.entries(serviceEnv())
    .map(([k, v]) => `        <key>${xml(k)}</key>\n        <string>${xml(v)}</string>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${xml(NODE_BIN)}</string>
        <string>${xml(ENTRY)}</string>
        <string>--mcp</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${xml(BRIDGE_DIR)}</string>
    <key>EnvironmentVariables</key>
    <dict>
${envXml}
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ProcessType</key>
    <string>Background</string>
    <key>StandardOutPath</key>
    <string>${xml(macLogPath())}</string>
    <key>StandardErrorPath</key>
    <string>${xml(macLogPath())}</string>
</dict>
</plist>
`;
}

function macInstall() {
  const p = plistPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.mkdirSync(path.dirname(macLogPath()), { recursive: true });
  fs.writeFileSync(p, macPlist());
  log(`Wrote ${p}`);
  const dom = `gui/${process.getuid()}`;
  try { execFileSync('launchctl', ['bootout', dom, p], { stdio: 'ignore' }); } catch { /* not loaded */ }
  execFileSync('launchctl', ['bootstrap', dom, p], { stdio: 'inherit' });
  try { execFileSync('launchctl', ['kickstart', '-k', `${dom}/${LABEL}`], { stdio: 'ignore' }); } catch { /* noop */ }
  log(`Loaded launchd service ${LABEL}`);
  log(`Logs: ${macLogPath()}`);
}

function macUninstall() {
  const p = plistPath();
  const dom = `gui/${process.getuid()}`;
  try { execFileSync('launchctl', ['bootout', dom, p], { stdio: 'ignore' }); } catch { /* noop */ }
  if (fs.existsSync(p)) { fs.unlinkSync(p); log(`Removed ${p}`); }
  log(`Stopped launchd service ${LABEL}`);
}

// ---- service: Linux systemd --user ---------------------------------------

const systemdPath = () => path.join(HOME, '.config', 'systemd', 'user', UNIT);

function systemdUnit() {
  const envLines = Object.entries(serviceEnv())
    .map(([k, v]) => `Environment="${k}=${v}"`)
    .join('\n');
  return `[Unit]
Description=co-mpanion bridge (GitHub Copilot CLI -> BLE desk-buddy)
After=network.target

[Service]
Type=simple
WorkingDirectory=${BRIDGE_DIR}
ExecStart=${NODE_BIN} ${ENTRY} --mcp
Restart=always
RestartSec=2
${envLines}

[Install]
WantedBy=default.target
`;
}

function systemdInstall() {
  const p = systemdPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, systemdUnit());
  log(`Wrote ${p}`);
  execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'inherit' });
  execFileSync('systemctl', ['--user', 'enable', '--now', UNIT], { stdio: 'inherit' });
  try { execFileSync('systemctl', ['--user', 'restart', UNIT], { stdio: 'ignore' }); } catch { /* noop */ }
  log(`Enabled + started systemd user service ${UNIT}`);
  log(`Logs: journalctl --user -u ${UNIT} -f`);
}

function systemdUninstall() {
  try { execFileSync('systemctl', ['--user', 'disable', '--now', UNIT], { stdio: 'ignore' }); } catch { /* noop */ }
  const p = systemdPath();
  if (fs.existsSync(p)) { fs.unlinkSync(p); log(`Removed ${p}`); }
  try { execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' }); } catch { /* noop */ }
  log(`Stopped systemd user service ${UNIT}`);
}

// ---- driver ---------------------------------------------------------------

function installService() {
  if (process.platform === 'darwin') return macInstall();
  if (process.platform === 'linux') return systemdInstall();
  throw new Error(
    `Unsupported platform "${process.platform}" for the managed service.\n` +
    `MCP was still registered. Start the bridge yourself with \`npm run mcp\` ` +
    `(it must stay running and serve ${MCP_URL}).`,
  );
}

function uninstallService() {
  if (process.platform === 'darwin') return macUninstall();
  if (process.platform === 'linux') return systemdUninstall();
  log(`No managed service on ${process.platform}; nothing to remove.`);
}

function main() {
  if (process.argv.includes('--uninstall')) {
    uninstallService();
    unregisterMcp();
    log('Uninstall complete.');
    return;
  }
  registerMcp();
  try {
    installService();
  } catch (e) {
    // MCP is registered; surface the service problem but don't hard-crash the
    // whole install — the user can fall back to `npm run mcp`.
    log(`WARNING: ${e.message}`);
    return;
  }
  log('');
  log('Done. One bridge now owns the device for every Copilot session.');
  log('Restart any running Copilot session so it picks up the HTTP MCP config.');
}

main();

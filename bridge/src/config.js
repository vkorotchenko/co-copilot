'use strict';

const os = require('os');
const path = require('path');

const COPILOT_HOME =
  process.env.COPILOT_HOME || path.join(os.homedir(), '.copilot');

module.exports = {
  // --- Copilot CLI local state ---------------------------------------------
  copilotHome: COPILOT_HOME,
  sessionStoreDb: path.join(COPILOT_HOME, 'session-store.db'),
  settingsJson: path.join(COPILOT_HOME, 'settings.json'),
  // Where the live `process-*.log` lives. Defaults to ~/.copilot/logs, but a
  // launcher (e.g. an `agency`/wrapper that passes `--log-dir`) may redirect
  // it elsewhere; point COMPANION_LOGS_DIR at that root. The tail searches it
  // recursively, so a per-session subdirectory layout works too.
  logsDir: process.env.COMPANION_LOGS_DIR || path.join(COPILOT_HOME, 'logs'),
  // Where the CLI writes per-session `events.jsonl` (one JSON event per line).
  // Used to passively detect Copilot's built-in permission prompts so the buddy
  // lights up when a session is waiting on you. Defaults to
  // ~/.copilot/session-state; override with COMPANION_SESSION_STATE_DIR.
  sessionStateDir:
    process.env.COMPANION_SESSION_STATE_DIR ||
    path.join(COPILOT_HOME, 'session-state'),

  // --- Permission-prompt watch ---------------------------------------------
  perm: {
    // Only scan event files modified within this window (plus any still holding
    // an unresolved request, whose mtime freezes while it waits).
    recentWindowMs: parseInt(process.env.COMPANION_PERM_WINDOW_MS || String(30 * 60 * 1000), 10),
    // Suppress requests younger than this so fast auto-approvals don't flash.
    minAgeMs: parseInt(process.env.COMPANION_PERM_MIN_AGE_MS || '1500', 10),
  },

  // --- BLE / Nordic UART Service -------------------------------------------
  // The device advertises NUS; the bridge is the central. UUIDs are written
  // without dashes the way noble expects them.
  ble: {
    serviceUuid: '6e400001b5a3f393e0a9e50e24dcca9e',
    rxCharUuid: '6e400002b5a3f393e0a9e50e24dcca9e', // central -> device (write)
    txCharUuid: '6e400003b5a3f393e0a9e50e24dcca9e', // device -> central (notify)
    namePrefix: process.env.COMPANION_NAME_PREFIX || 'Copilot',
    // Fallback write chunk size when the negotiated MTU is unknown (default
    // ATT MTU 23 -> 20 usable payload bytes).
    fallbackChunk: 20,
    // Abort a connect/characteristic-discovery attempt that hasn't completed
    // in this long and rescan. Guards against a hung BLE bring-up (e.g. a
    // stale OS bond stalling the encryption handshake) wedging the bridge.
    connectTimeoutMs: parseInt(process.env.COMPANION_CONNECT_TIMEOUT_MS || '15000', 10),
    // macOS self-heal: if noble scans this long without ever finding the device,
    // macOS has likely grabbed the bonded link (so it stops advertising); shell
    // out to `blueutil --disconnect` to release it. 0 disables.
    recoverStallMs: parseInt(process.env.COMPANION_BLE_RECOVER_MS || '45000', 10),
  },

  // --- Timing --------------------------------------------------------------
  // How often to recompute the activity model and (if changed) push a snapshot.
  // Drives how quickly state changes (e.g. a finished turn -> celebrate) reach
  // the device, so keep it snappy; the per-tick work (a tail read + a couple of
  // SQLite queries) is cheap.
  tickMs: 1000,
  // Push at least this often even when nothing changed (protocol keepalive;
  // the device treats >30s of silence as a dead link).
  keepaliveMs: 10000,
  // Poll the device's status ack this often (for the on-device stats panel).
  statusPollMs: 15000,

  // --- MCP server (optional bidirectional "write" surface) -----------------
  mcp: {
    host: process.env.COMPANION_MCP_HOST || '127.0.0.1',
    port: parseInt(process.env.COMPANION_MCP_PORT || '4317', 10),
  },

  // --- Activity heuristics -------------------------------------------------
  // A session counts as "active/total" if it produced a turn within this window.
  activeWindowMs: 5 * 60 * 1000,
  // The active log file growing within this window means a session is "running".
  busyWindowMs: 20 * 1000,
  // How long the device shows the "celebrate" animation after a turn finishes.
  // Completion is detected the instant a new turn row appears (a real turn
  // boundary), then held this long so the animation is actually visible; new
  // model activity cancels it early. (Decoupled from busyWindowMs on purpose —
  // the old "not busy AND turn within 5s" check lost the race to the 20s grace,
  // so celebrations fired ~20s late or not at all.)
  completedHoldMs: 6 * 1000,
  // Max recent transcript entries to send (device stores up to 8).
  maxEntries: 6,
};

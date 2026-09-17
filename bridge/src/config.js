'use strict';

const os = require('os');
const path = require('path');
const { normalizeConfirmQueue, normalizeDeviceProjectionMax } = require('./bridge');

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
    // Ceiling on a captured live prompt before it is compared/rendered. The
    // device shows ~150 characters; the extra headroom exists so the
    // de-duplication against the persisted turn row has enough text to be
    // unambiguous.
    maxPromptChars: parseInt(process.env.COMPANION_PROMPT_MAX_CHARS || '600', 10),
    // On first sight of an events file we replay its tail to recover pending /
    // waiting state. A user.message found in that replay only counts as the
    // *current* question if it is this recent — otherwise restarting the bridge
    // would show a long-finished prompt as live work.
    promptPrimeWindowMs: parseInt(
      process.env.COMPANION_PROMPT_PRIME_MS || String(2 * 60 * 1000), 10
    ),
    // Initial event-tail recovery may need to cross a large tool result to find
    // the current user.message. PermissionWatch scans this window in 256 KiB
    // chunks and clamps it to 256 KiB..64 MiB.
    primeMaxBytes: parseInt(
      process.env.COMPANION_PROMPT_PRIME_BYTES || String(32 * 1024 * 1024), 10
    ),
    // Stop treating an interrupted prompt as live after its session has been
    // completely quiet for this long.
    promptMaxQuietMs: parseInt(
      process.env.COMPANION_PROMPT_MAX_QUIET_MS || String(30 * 60 * 1000), 10
    ),
    // Bound synchronous startup recovery fan-out; remaining recent sessions are
    // picked up on later one-second polls.
    maxPrimeFilesPerUpdate: parseInt(
      process.env.COMPANION_PROMPT_PRIME_FILES || '2', 10
    ),
    // A session counts as "active" for transcript-focus ranking when anything
    // happened in it this recently.
    focusActiveWindowMs: parseInt(process.env.COMPANION_FOCUS_ACTIVE_MS || '60000', 10),
  },

  // --- Process-log tail ----------------------------------------------------
  // Every CLI process writes its own process-*.log, so concurrent sessions mean
  // concurrent files. The tail tracks each one independently (its own AI-request
  // group stack) and aggregates, rather than following only the newest-mtime
  // file — which used to discard an in-flight request whenever the other log
  // became newest.
  logs: {
    // Only follow logs touched within this window (plus any still holding an
    // open AI request, which is never dropped mid-flight).
    recentWindowMs: parseInt(process.env.COMPANION_LOG_WINDOW_MS || String(30 * 60 * 1000), 10),
    // Hard cap on simultaneously tracked logs; newest-mtime wins.
    maxFiles: parseInt(process.env.COMPANION_LOG_MAX_FILES || '8', 10),
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

  // --- Explicit session registry (event-driven state) ----------------------
  // A top-level session orchestrator registers one long-lived conversation,
  // reports each task through companion_state / companion_task_complete, and
  // calls companion_session_end only when retiring the conversation. Spawned
  // agents report back to the orchestrator rather than creating records.
  // Active work holds a lease: if the reporter crashes or goes quiet, the pal
  // falls back to idle without losing its conversation identity/configuration.
  sessions: {
    defaultTtlMs: parseInt(process.env.COMPANION_SESSION_TTL_MS || '90000', 10),
    // Bounds applied to caller-supplied ttl_seconds (values outside clamp in).
    minTtlMs: parseInt(process.env.COMPANION_SESSION_MIN_TTL_MS || '5000', 10),
    maxTtlMs: parseInt(process.env.COMPANION_SESSION_MAX_TTL_MS || String(60 * 60 * 1000), 10),
    // Hard cap on tracked sessions; eviction is ended-first, then least-
    // recently-updated, then creation time and id for deterministic ties.
    maxSessions: parseInt(process.env.COMPANION_SESSION_MAX || '64', 10),
    // Firmware MAX_SESSION_PALS is eight. Keeping the bridge projection at or
    // below that ceiling bounds both fixed device RAM and the newline-delimited
    // JSON wire budget; larger values cannot make more rows visible safely.
    deviceProjectionMax: normalizeDeviceProjectionMax(
      process.env.COMPANION_DEVICE_PROJECTION_MAX
    ),
    // How long an ended session stays visible (so status can report the
    // outcome) before it is pruned.
    endedLingerMs: parseInt(process.env.COMPANION_SESSION_ENDED_MS || '10000', 10),
  },

  // --- Device confirmations ------------------------------------------------
  confirm: {
    // Simultaneous companion_confirm calls are served FIFO. Beyond this depth
    // new questions resolve immediately as `unavailable` rather than piling up
    // behind a screen that can only show one prompt at a time.
    //
    // Parsed by the *same* normalizer the Bridge applies to whatever it is
    // handed (see normalizeConfirmQueue in bridge.js), so an env var and a
    // programmatically-supplied cfg cannot disagree about what `0`, a negative,
    // a fraction or a typo means. Values below the floor of 1 clamp up rather
    // than being honoured: the screen shows one prompt at a time, so 1 already
    // means "no queueing", while a literal 0 would make every confirmation
    // resolve `unavailable` and silently disable the hardware approval gate.
    // Unparseable values fall back to the default.
    maxQueue: normalizeConfirmQueue(process.env.COMPANION_CONFIRM_QUEUE),
  },

  // --- Activity heuristics -------------------------------------------------
  // A session counts as "active/total" if it produced a turn within this window.
  activeWindowMs: 5 * 60 * 1000,
  // The active log file growing within this window means a session is "running".
  busyWindowMs: 20 * 1000,
  // How long the device shows the "celebrate" animation after a turn finishes.
  // Current clients provide the boundary immediately through
  // session.task_complete; a new turn row remains the older-client fallback.
  // The legacy pulse is held this long so it is visible, while modern firmware
  // persists the latched completion until dismissal or new work.
  completedHoldMs: 6 * 1000,
  // Max recent transcript entries to send (device stores up to 8).
  maxEntries: 6,
};

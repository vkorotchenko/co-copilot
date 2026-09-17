'use strict';

const fs = require('fs');
const path = require('path');

// Everything the bridge needs to talk to `blueutil`, kept in one place so the
// lookup rules have a single definition.
//
// Why an explicit lookup instead of `execFile('blueutil', ...)`: the supported
// install runs the bridge as a managed background service, and a launchd agent
// inherits a bare `PATH` of `/usr/bin:/bin:/usr/sbin:/sbin` (the plist sets no
// PATH at all). Homebrew installs blueutil outside every one of those
// directories, so a bare-name exec raises ENOENT under the very configuration
// the recovery path exists to serve, while still working when a developer runs
// the bridge from an interactive shell. Resolving an absolute path up front
// makes the service and the shell behave identically.

// Package-manager prefixes, probed before PATH so that a service and a shell
// resolve to the same binary on the same machine.
const WELL_KNOWN = [
  ['/opt/homebrew/bin/blueutil', 'homebrew-arm64'], // Apple Silicon Homebrew
  ['/usr/local/bin/blueutil', 'homebrew-x86_64'],   // Intel Homebrew
  ['/opt/local/bin/blueutil', 'macports'],          // MacPorts
];

// A directory carries the execute bit too (it means "traversable"), so an
// access() check alone would happily accept `/opt/homebrew/bin` itself.
function defaultIsExecutableFile(p) {
  try {
    if (!fs.statSync(p).isFile()) return false;
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// Locate blueutil without trusting the inherited PATH.
//
// Order: COMPANION_BLUEUTIL -> well-known prefixes -> PATH.
//
// Returns `{ path, source }` on success, or `{ path: null, reason, ... }`
// describing why it could not be found. Never throws: a missing or broken
// blueutil only disables auto-recovery, it must not disturb BLE scanning.
//
// `env`, `platform` and `isExecutableFile` are injectable so the rules can be
// tested on any host without blueutil installed.
function resolveBlueutil(opts = {}) {
  const env = opts.env || process.env;
  const platform = opts.platform || process.platform;
  const isExecutableFile = opts.isExecutableFile || defaultIsExecutableFile;

  // blueutil is a macOS tool, and the OS-grabs-the-bonded-link failure it
  // repairs is macOS-specific. Everywhere else this is a no-op.
  if (platform !== 'darwin') return { path: null, reason: 'unsupported-platform', platform };

  const configured = String(env.COMPANION_BLUEUTIL || '').trim();
  if (configured) {
    // An explicit override wins or fails loudly. Falling back to a different
    // binary than the operator named would be a worse outcome than declining
    // to recover: it hides the typo and runs something unexpected as root's
    // Bluetooth agent. Relative paths are rejected because the service's
    // working directory is not the operator's.
    if (!path.isAbsolute(configured)) {
      return { path: null, reason: 'configured-invalid', configured, detail: 'not an absolute path' };
    }
    if (!isExecutableFile(configured)) {
      return {
        path: null,
        reason: 'configured-invalid',
        configured,
        detail: 'not an executable file (missing, a directory, or not +x)',
      };
    }
    return { path: configured, source: 'COMPANION_BLUEUTIL' };
  }

  const tried = [];
  for (const [candidate, source] of WELL_KNOWN) {
    tried.push(candidate);
    if (isExecutableFile(candidate)) return { path: candidate, source };
  }

  // Last resort, for installs that live somewhere else entirely. Scanned
  // in-process rather than shelling out to `which`, which keeps this free of
  // subprocesses and of the same PATH assumption that caused the bug. Relative
  // PATH entries are skipped so the result is always an absolute path.
  for (const dir of String(env.PATH || '').split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir)) continue;
    const candidate = path.join(dir, 'blueutil');
    if (tried.includes(candidate)) continue;
    tried.push(candidate);
    if (isExecutableFile(candidate)) return { path: candidate, source: 'PATH' };
  }

  return { path: null, reason: 'not-found', tried };
}

// Human-readable explanation for a failed resolveBlueutil(), written so a log
// reader can tell a missing executable apart from a misconfigured one.
function describeResolution(res) {
  switch (res && res.reason) {
    case 'configured-invalid':
      return `COMPANION_BLUEUTIL="${res.configured}" is ${res.detail}`;
    case 'not-found':
      return `blueutil not found (tried ${res.tried.join(', ')}). Install it ` +
        '(`brew install blueutil`) or set COMPANION_BLUEUTIL to its absolute path.';
    case 'unsupported-platform':
      return `blueutil is macOS-only (platform=${res.platform})`;
    default:
      return 'blueutil unavailable';
  }
}

// Pull the bonded device's address out of `blueutil --paired` output, matching
// the configured name prefix. Lines look like:
//   address: 48-27-e2-e3-c9-25, connected (master, 0 dBm), ..., name: "Copilot-C924"
//   address: 48-27-e2-e3-c9-25, not connected, ..., name: "Copilot-C924", recent access date: ...
//
// `connected` is reported as a tri-state: true/false when the line states it,
// null when the format is unrecognised. Callers treat null as "attempt anyway",
// because failing to recover is worse than a redundant disconnect.
function parseBondedDevice(stdout, namePrefix) {
  for (const line of String(stdout || '').split('\n')) {
    if (line.indexOf(`name: "${namePrefix}`) === -1) continue;
    const m = /address:\s*([0-9a-f:-]+)/i.exec(line);
    if (!m) continue;
    let connected = null;
    if (/,\s*not connected\b/i.test(line)) connected = false;
    else if (/,\s*connected\b/i.test(line)) connected = true;
    return { address: m[1], connected };
  }
  return null;
}

// Address-only view, kept as the original module API.
function parseBondedAddress(stdout, namePrefix) {
  const found = parseBondedDevice(stdout, namePrefix);
  return found ? found.address : null;
}

module.exports = {
  WELL_KNOWN,
  resolveBlueutil,
  describeResolution,
  parseBondedDevice,
  parseBondedAddress,
  isExecutableFile: defaultIsExecutableFile,
};

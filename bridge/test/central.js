'use strict';

// Tests for the BLE stall-recovery path.
//
// Central concern: the recovery shells out to blueutil, and the supported
// install runs the bridge from a launchd agent whose PATH is
// `/usr/bin:/bin:/usr/sbin:/sbin`. Homebrew installs blueutil outside all of
// those, so a bare-name exec silently ENOENTs there. These tests pin the
// explicit resolution order, the "keep scanning" failure behaviour, and the
// log cadence.
//
// Nothing here requires blueutil to be installed: the resolver's filesystem
// probe and environment are injected, and the end-to-end exec tests use a
// throwaway stub script they create and remove themselves.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.COMPANION_LOG = process.env.COMPANION_LOG || 'error';

const {
  resolveBlueutil,
  describeResolution,
  isExecutableFile,
  parseBondedDevice,
} = require('../src/ble/blueutil');
const { BleCentral, parseBondedAddress } = require('../src/ble/central');
const log = require('../src/util/log');

const ARM = '/opt/homebrew/bin/blueutil';
const INTEL = '/usr/local/bin/blueutil';
const PORTS = '/opt/local/bin/blueutil';

// Injected stand-in for the real stat()+access() probe, so these cases run
// identically on a machine with or without blueutil.
function present(...paths) {
  const set = new Set(paths);
  return (p) => set.has(p);
}

function resolve(env, presentPaths, platform = 'darwin') {
  return resolveBlueutil({
    env,
    platform,
    isExecutableFile: present(...presentPaths),
  });
}

// ---- resolution order -----------------------------------------------------

function configuredPathWins() {
  // An explicit absolute override beats every discovered candidate.
  const res = resolve(
    { COMPANION_BLUEUTIL: '/custom/tools/blueutil', PATH: '/opt/homebrew/bin' },
    ['/custom/tools/blueutil', ARM]
  );
  assert.strictEqual(res.path, '/custom/tools/blueutil');
  assert.strictEqual(res.source, 'COMPANION_BLUEUTIL');
}

function configuredPathIsValidated() {
  // Relative paths are rejected outright: the service's working directory is
  // not the operator's, so a relative override would resolve unpredictably.
  const rel = resolve({ COMPANION_BLUEUTIL: 'bin/blueutil' }, [ARM]);
  assert.strictEqual(rel.path, null);
  assert.strictEqual(rel.reason, 'configured-invalid');
  assert.match(rel.detail, /absolute/);

  // A configured path that isn't an executable file fails rather than silently
  // falling back to a different binary than the operator named.
  const gone = resolve({ COMPANION_BLUEUTIL: '/nope/blueutil' }, [ARM]);
  assert.strictEqual(gone.path, null);
  assert.strictEqual(gone.reason, 'configured-invalid');

  // Whitespace-only is treated as unset, not as a broken override.
  const blank = resolve({ COMPANION_BLUEUTIL: '   ' }, [ARM]);
  assert.strictEqual(blank.path, ARM);
}

function appleSiliconPath() {
  const res = resolve({ PATH: '/usr/bin:/bin' }, [ARM]);
  assert.strictEqual(res.path, ARM);
  assert.strictEqual(res.source, 'homebrew-arm64');
}

function intelPath() {
  // No /opt/homebrew on an Intel Mac; the Intel Homebrew prefix is found next.
  const res = resolve({ PATH: '/usr/bin:/bin' }, [INTEL]);
  assert.strictEqual(res.path, INTEL);
  assert.strictEqual(res.source, 'homebrew-x86_64');
}

function macportsPath() {
  const res = resolve({ PATH: '/usr/bin:/bin' }, [PORTS]);
  assert.strictEqual(res.path, PORTS);
  assert.strictEqual(res.source, 'macports');
}

function wellKnownBeatsPath() {
  // Determinism matters more than PATH order here: a shell and the launchd
  // service must resolve to the same binary on the same machine.
  const res = resolve({ PATH: '/somewhere/else' }, [ARM, '/somewhere/else/blueutil']);
  assert.strictEqual(res.path, ARM);
}

function pathFallback() {
  // Nothing in the package-manager prefixes, but PATH has it (nix, a manual
  // install, a vendored copy).
  const res = resolve({ PATH: '/usr/bin:/opt/custom/bin' }, ['/opt/custom/bin/blueutil']);
  assert.strictEqual(res.path, '/opt/custom/bin/blueutil');
  assert.strictEqual(res.source, 'PATH');
}

function pathEntriesAreSanitised() {
  // Relative and empty PATH entries are skipped so the result is always an
  // absolute path (a relative one would depend on the service's cwd).
  const res = resolve({ PATH: ':relative/bin:' }, ['relative/bin/blueutil']);
  assert.strictEqual(res.path, null);
  assert.strictEqual(res.reason, 'not-found');
}

function absentEverywhere() {
  // The launchd reality: bare PATH, blueutil nowhere on it.
  const res = resolve({ PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }, []);
  assert.strictEqual(res.path, null);
  assert.strictEqual(res.reason, 'not-found');
  for (const candidate of [ARM, INTEL, PORTS]) {
    assert.ok(res.tried.includes(candidate), `should have tried ${candidate}`);
  }
  assert.ok(res.tried.includes('/usr/bin/blueutil'), 'should have tried PATH entries');
}

function nonDarwinIsNoop() {
  // blueutil is macOS-only, and so is the OS-grabs-the-bond failure it fixes.
  for (const platform of ['linux', 'win32']) {
    const res = resolve({ COMPANION_BLUEUTIL: ARM, PATH: '/usr/bin' }, [ARM], platform);
    assert.strictEqual(res.path, null, `${platform} must not resolve blueutil`);
    assert.strictEqual(res.reason, 'unsupported-platform');
  }
}

function diagnosticsDistinguishFailures() {
  // A log reader has to be able to tell "not installed" from "you typo'd the
  // override" — that distinction is the whole point of promoting these to warn.
  const missing = describeResolution(resolve({ PATH: '/usr/bin' }, []));
  assert.match(missing, /not found/);
  assert.match(missing, /brew install blueutil/);
  assert.match(missing, /COMPANION_BLUEUTIL/);

  const misconfigured = describeResolution(resolve({ COMPANION_BLUEUTIL: '/nope/bu' }, []));
  assert.match(misconfigured, /COMPANION_BLUEUTIL="\/nope\/bu"/);
  assert.notStrictEqual(missing, misconfigured);

  const wrongOs = describeResolution(resolve({}, [], 'linux'));
  assert.match(wrongOs, /macOS-only/);
}

function realProbeRejectsDirectories() {
  // A directory carries the execute bit (it means "traversable"), so an
  // access(X_OK) check alone would accept `/opt/homebrew/bin` as the binary.
  assert.strictEqual(isExecutableFile(os.tmpdir()), false, 'a directory is not an executable');
  assert.strictEqual(isExecutableFile('/bin/sh'), true, '/bin/sh is an executable file');
  assert.strictEqual(isExecutableFile('/no/such/path/at/all'), false);
}

// ---- `blueutil --paired` parsing ------------------------------------------

function parserPicksBondedDevice() {
  const sample = [
    'address: 24-05-29-00-02-9c, not connected, not favourite, paired, name: "DG08"',
    'address: 48-27-e2-e3-c9-25, connected (master, 0 dBm), not favourite, paired, name: "Copilot-C924"',
    'address: c0-44-42-d9-66-88, not connected, paired, name: "Magic Mouse"',
  ].join('\n');

  assert.strictEqual(
    parseBondedAddress(sample, 'Copilot'),
    '48-27-e2-e3-c9-25',
    'should pick the Copilot device address'
  );

  // No matching device => null.
  assert.strictEqual(parseBondedAddress(sample, 'Nonexistent'), null);
  assert.strictEqual(parseBondedAddress('', 'Copilot'), null);
  assert.strictEqual(parseBondedAddress(null, 'Copilot'), null);

  // Real blueutil 2.x output carries a trailing `recent access date:` field the
  // original fixture omitted. It must not throw off the address match.
  const live = 'address: 48-27-e2-e3-c9-25, not connected, not favourite, paired, ' +
    'name: "Copilot-C924", recent access date: 2026-09-15 23:06:21 +0000';
  assert.strictEqual(parseBondedAddress(live, 'Copilot'), '48-27-e2-e3-c9-25');
}

function parserReadsConnectedState() {
  // Only a link macOS is *holding* can be released, and `--disconnect` on an
  // idle device blocks until it is killed. The connected flag is what keeps the
  // recovery from burning its timeout on every stall.
  const held = parseBondedDevice(
    'address: 48-27-e2-e3-c9-25, connected (master, 0 dBm), paired, name: "Copilot-C924"',
    'Copilot'
  );
  assert.deepStrictEqual(held, { address: '48-27-e2-e3-c9-25', connected: true });

  // "not connected" must not be read as "connected" by a sloppy substring test.
  const idle = parseBondedDevice(
    'address: 48-27-e2-e3-c9-25, not connected, paired, name: "Copilot-C924"',
    'Copilot'
  );
  assert.deepStrictEqual(idle, { address: '48-27-e2-e3-c9-25', connected: false });

  // Unrecognised shape => unknown, so the caller attempts recovery anyway
  // rather than skipping one that may have been needed.
  const odd = parseBondedDevice(
    'address: 48-27-e2-e3-c9-25, paired, name: "Copilot-C924"',
    'Copilot'
  );
  assert.deepStrictEqual(odd, { address: '48-27-e2-e3-c9-25', connected: null });

  assert.strictEqual(parseBondedDevice('', 'Copilot'), null);
}

// ---- log cadence + attempt behaviour --------------------------------------

function central(overrides = {}) {
  return new BleCentral({
    ble: {
      fallbackChunk: 20,
      namePrefix: 'Copilot',
      recoverStallMs: 45000,
      connectTimeoutMs: 15000,
      ...overrides,
    },
  });
}

// Capture the leveled logger around a block. log is a module singleton whose
// methods are plain properties, so swapping them is enough.
async function captureLogs(fn) {
  const warns = [];
  const debugs = [];
  const realWarn = log.warn;
  const realDebug = log.debug;
  log.warn = (...a) => warns.push(a.join(' '));
  log.debug = (...a) => debugs.push(a.join(' '));
  try {
    await fn();
  } finally {
    log.warn = realWarn;
    log.debug = realDebug;
  }
  return { warns, debugs };
}

async function warnCadenceIsBounded() {
  const c = central();

  const { warns, debugs } = await captureLogs(async () => {
    // Recovery retries every ~45s for as long as the stall lasts. The same
    // condition must be announced once, not 80 times an hour.
    c._reportRecovery('resolve:not-found', 'blueutil missing');
    c._reportRecovery('resolve:not-found', 'blueutil missing');
    c._reportRecovery('resolve:not-found', 'blueutil missing');
    // A *different* condition is news, so it warns again.
    c._reportRecovery('paired:ENOENT', 'paired failed');
    // A link came up: the episode is over and the next stall reports afresh.
    c._cancelRecovery();
    c._reportRecovery('resolve:not-found', 'blueutil missing');
  });

  assert.deepStrictEqual(
    warns,
    ['blueutil missing', 'paired failed', 'blueutil missing'],
    'warn once per condition per stall episode'
  );
  assert.strictEqual(debugs.length, 2, 'repeats are demoted to debug, not dropped');
}

async function unresolvableBlueutilWarnsOnceAndKeepsScanning() {
  // Deterministic on any host: a configured path that cannot exist fails on
  // macOS (configured-invalid), and every non-macOS host short-circuits on
  // platform. Both must produce exactly one warning and no throw.
  const prior = process.env.COMPANION_BLUEUTIL;
  process.env.COMPANION_BLUEUTIL = '/definitely/not/here/blueutil';
  const c = central();
  try {
    const { warns } = await captureLogs(async () => {
      await c._attemptRecovery();
      await c._attemptRecovery();
    });
    assert.strictEqual(warns.length, 1, 'one warning across repeated attempts');
    assert.match(warns[0], /BLE recovery unavailable/);
    assert.match(warns[0], /Scanning continues/);
  } finally {
    if (prior === undefined) delete process.env.COMPANION_BLUEUTIL;
    else process.env.COMPANION_BLUEUTIL = prior;
  }

  // Failure must leave the central reusable, not wedged mid-attempt.
  assert.strictEqual(c._recovering, false, 'the in-flight guard is released');
  assert.strictEqual(c.connected, false);
}

// Write a throwaway stub that stands in for blueutil, so the exec path is
// covered without requiring the real tool. Lives beside the test (never in a
// shared temp dir) and is removed by the caller.
function writeStubBlueutil(tag, opts = {}) {
  const connected = opts.connected === false ? 'not connected' : 'connected (master, 0 dBm)';
  const stub = path.join(__dirname, `.stub-blueutil-${process.pid}-${tag}.sh`);
  const callLog = path.join(__dirname, `.stub-blueutil-${process.pid}-${tag}.calls`);
  fs.writeFileSync(stub, [
    '#!/bin/sh',
    `printf '%s\\n' "$*" >> ${JSON.stringify(callLog)}`,
    'if [ "$1" = "--paired" ]; then',
    `  printf '%s\\n' 'address: 11-22-33-44-55-66, ${connected}, paired, name: "Copilot-C924"'`,
    '  exit 0',
    'fi',
    // Real blueutil returns from --paired immediately but blocks forever on
    // --disconnect when there is nothing to disconnect; `hang` reproduces that
    // asymmetry so the timeout can be exercised.
    opts.hang ? 'sleep 30' : '',
    'exit 0',
    '',
  ].join('\n'));
  fs.chmodSync(stub, 0o755);
  return {
    stub,
    calls: () => (fs.existsSync(callLog)
      ? fs.readFileSync(callLog, 'utf8').trim().split('\n').filter(Boolean)
      : []),
    cleanup: () => {
      fs.rmSync(stub, { force: true });
      fs.rmSync(callLog, { force: true });
    },
  };
}

async function recoveryInvokesResolvedBinary() {
  const fake = writeStubBlueutil('hit');
  const c = central();
  // Seed the resolved-path cache directly so this covers the exec/parse/
  // disconnect orchestration on any platform; resolution itself is pinned by
  // the injected cases above.
  c._blueutilPath = fake.stub;

  try {
    const { warns } = await captureLogs(async () => {
      await c._attemptRecovery();
    });

    assert.deepStrictEqual(
      fake.calls(),
      ['--paired', `--disconnect 11-22-33-44-55-66`],
      'should list bonded devices, then release the matched address'
    );
    assert.strictEqual(warns.length, 1, 'one announcement per stall episode');
    assert.match(warns[0], /releasing OS hold on 11-22-33-44-55-66/);
    assert.ok(warns[0].includes(fake.stub), 'names the binary actually executed');
    assert.strictEqual(c._recovering, false);
  } finally {
    fake.cleanup();
  }
}

async function noBondedMatchIsReportedNotSilent() {
  const fake = writeStubBlueutil('miss');
  // Prefix the stub's output cannot match => there is nothing to release.
  const c = central({ namePrefix: 'Nonexistent' });
  c._blueutilPath = fake.stub;

  try {
    const { warns } = await captureLogs(async () => {
      await c._attemptRecovery();
      await c._attemptRecovery();
    });
    assert.strictEqual(warns.length, 1, 'skipped recovery is visible, but only once');
    assert.match(warns[0], /BLE recovery skipped/);
    assert.match(warns[0], /another cause/);
    assert.ok(
      !fake.calls().some((call) => call.startsWith('--disconnect')),
      'never disconnects an unmatched device'
    );
  } finally {
    fake.cleanup();
  }
}

async function brokenBlueutilFallsBackToScanning() {
  // Present but failing (non-zero exit): distinct from "missing", and the
  // bridge must keep scanning rather than throwing out of the timer callback.
  const stub = path.join(__dirname, `.stub-blueutil-${process.pid}-broken.sh`);
  fs.writeFileSync(stub, '#!/bin/sh\necho "boom" >&2\nexit 3\n');
  fs.chmodSync(stub, 0o755);
  const c = central();
  c._blueutilPath = stub;

  try {
    const { warns } = await captureLogs(async () => {
      await c._attemptRecovery();
      await c._attemptRecovery();
    });
    assert.strictEqual(warns.length, 1, 'a persistent command failure warns once');
    assert.match(warns[0], /BLE recovery failed/);
    assert.match(warns[0], /--paired/);
    assert.strictEqual(c._recovering, false);
    // A failing (but present) binary stays cached; only ENOENT invalidates it.
    assert.strictEqual(c._blueutilPath, stub);
  } finally {
    fs.rmSync(stub, { force: true });
  }
}

async function idleBondedDeviceIsNotDisconnected() {
  // Bonded but not held by macOS. Real blueutil blocks until a disconnect
  // event that will never arrive, so attempting it here would burn the timeout
  // on every stall and bury the real cause (device off / out of range).
  const fake = writeStubBlueutil('idle', { connected: false });
  const c = central();
  c._blueutilPath = fake.stub;

  try {
    const { warns } = await captureLogs(async () => {
      await c._attemptRecovery();
      await c._attemptRecovery();
    });
    assert.ok(
      !fake.calls().some((call) => call.startsWith('--disconnect')),
      'must not disconnect a device macOS is not holding'
    );
    assert.strictEqual(warns.length, 1, 'reported once per stall episode');
    assert.match(warns[0], /bonded but not connected/);
    assert.match(warns[0], /Still scanning/);
  } finally {
    fake.cleanup();
  }
}

async function hangingBlueutilCannotWedgeRecovery() {
  // The failure that bit c015035's own design: `blueutil --disconnect` waits
  // forever on an idle device. Unbounded, that would strand _recovering=true
  // and silently kill every future attempt — the same shape as the bug this
  // whole path exists to repair.
  const fake = writeStubBlueutil('hang', { hang: true });
  const c = central({ blueutilTimeoutMs: 300 });
  c._blueutilPath = fake.stub;

  try {
    const started = Date.now();
    const { warns } = await captureLogs(async () => {
      await c._attemptRecovery();
    });
    const elapsed = Date.now() - started;

    assert.ok(elapsed < 5000, `the hang must be bounded, took ${elapsed}ms`);
    assert.strictEqual(c._recovering, false, 'the in-flight guard must be released');
    // The attempt announcement, then the timeout report.
    assert.strictEqual(warns.length, 2);
    assert.match(warns[1], /BLE recovery failed/);
    assert.match(warns[1], /timed out after 300ms/);

    // Still usable afterwards: a later stall must be able to try again.
    const { warns: again } = await captureLogs(async () => {
      await c._attemptRecovery();
    });
    assert.ok(again.length >= 1, 'recovery is not permanently disabled by a timeout');
  } finally {
    fake.cleanup();
  }
}

async function vanishedBlueutilIsReResolved() {
  // Cached path uninstalled under us (`brew uninstall blueutil`): the cache
  // must be dropped so the next stall re-resolves instead of retrying a dead
  // path forever.
  const c = central();
  c._blueutilPath = path.join(__dirname, `.stub-blueutil-${process.pid}-vanished.sh`);

  await captureLogs(async () => {
    await c._attemptRecovery();
  });
  assert.strictEqual(c._blueutilPath, null, 'ENOENT invalidates the cached path');
}

function schedulingRespectsPlatformAndToggle() {
  // Disabled by config: no timer regardless of platform.
  const off = central({ recoverStallMs: 0 });
  off._scheduleRecovery();
  assert.strictEqual(off._recoverTimer, null, 'recoverStallMs=0 disables recovery');

  const c = central({ recoverStallMs: 60000 });
  c._scheduleRecovery();
  if (process.platform === 'darwin') {
    assert.ok(c._recoverTimer, 'macOS arms the stall timer');
    c._recoverWarnKey = 'stale';
    c._cancelRecovery();
    assert.strictEqual(c._recoverTimer, null, 'cancel clears the timer');
    assert.strictEqual(c._recoverWarnKey, null, 'cancel resets the warn cadence');
  } else {
    // Linux/other: the whole recovery path is a no-op, so nothing is armed and
    // no handle is left behind to keep the event loop alive.
    assert.strictEqual(c._recoverTimer, null, 'non-macOS never arms the stall timer');
  }
}

async function main() {
  configuredPathWins();
  configuredPathIsValidated();
  appleSiliconPath();
  intelPath();
  macportsPath();
  wellKnownBeatsPath();
  pathFallback();
  pathEntriesAreSanitised();
  absentEverywhere();
  nonDarwinIsNoop();
  diagnosticsDistinguishFailures();
  realProbeRejectsDirectories();
  parserPicksBondedDevice();
  parserReadsConnectedState();
  await warnCadenceIsBounded();
  await unresolvableBlueutilWarnsOnceAndKeepsScanning();
  await recoveryInvokesResolvedBinary();
  await noBondedMatchIsReportedNotSilent();
  await brokenBlueutilFallsBackToScanning();
  await idleBondedDeviceIsNotDisconnected();
  await hangingBlueutilCannotWedgeRecovery();
  await vanishedBlueutilIsReResolved();
  schedulingRespectsPlatformAndToggle();

  console.log('PASS: blueutil resolves without PATH, parses bonded devices, and warns once per stall');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

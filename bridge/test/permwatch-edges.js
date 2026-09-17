'use strict';

// Regression for per-session semantic edge delivery.
//
// PermissionWatch used to keep exactly one identity per edge kind
// (`_edgeIds.prompt/user/tool`), so when two session files appended the same
// kind of event between polls the second overwrote the first. Only one
// conversation's edge ever reached the bridge, which meant the other
// conversation's echo guard could not be disarmed by its own new work and its
// next turn row was swallowed as a phantom echo.
//
// The watcher now also queues the newest edge of each kind *per session* and
// hands the whole batch over on `takeEdges()`:
//   * every session that appended a relevant event in a poll is represented,
//   * the batch is edge-triggered — draining it twice yields nothing the
//     second time, so the bridge cannot double-count an interaction,
//   * `edgeIds` keeps its level-triggered newest-per-kind meaning for older
//     callers, and the last batch entry of a kind agrees with it.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

process.env.COMPANION_LOG = process.env.COMPANION_LOG || 'error';

const { PermissionWatch } = require('../src/copilot/permwatch');

const ROOT = path.join(__dirname, '.scratch-permwatch-edges');

function userLine(id, text, tsIso) {
  return JSON.stringify({
    type: 'user.message',
    data: { content: text, promptId: id },
    id: `evt-${id}`,
    timestamp: tsIso,
  }) + '\n';
}

function toolLine(id, tsIso) {
  return JSON.stringify({
    type: 'tool.execution_start',
    data: { toolCallId: id, toolName: 'bash' },
    id: `evt-${id}`,
    timestamp: tsIso,
  }) + '\n';
}

function permLine(id, tsIso) {
  return JSON.stringify({
    type: 'permission.requested',
    data: {
      requestId: id,
      permissionRequest: { kind: 'shell', fullCommandText: 'git push' },
    },
    id: `evt-${id}`,
    timestamp: tsIso,
  }) + '\n';
}

function sessionFile(name) {
  const dir = path.join(ROOT, name);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'events.jsonl');
}

function byKind(edges, kind) {
  return edges.filter((edge) => edge.kind === kind);
}

function sessionsOf(edges, kind) {
  return byKind(edges, kind).map((edge) => edge.session).sort();
}

function run() {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(ROOT, { recursive: true });

  const watch = new PermissionWatch({
    sessionStateDir: ROOT,
    perm: { minAgeMs: 0, recentWindowMs: 60 * 60 * 1000 },
  });

  watch.update();
  assert.deepStrictEqual(watch.takeEdges(), [], 'nothing tracked yet, nothing to deliver');

  // --- two sessions ask a question in the same poll -------------------------
  const fileA = sessionFile('sess-a');
  const fileB = sessionFile('sess-b');
  const askedA = new Date(Date.now() - 4000).toISOString();
  const askedB = new Date(Date.now() - 3000).toISOString();
  fs.writeFileSync(fileA, userLine('prompt-a1', 'build the firmware', askedA));
  fs.writeFileSync(fileB, userLine('prompt-b1', 'review the diff', askedB));

  watch.update();
  const first = watch.takeEdges();
  assert.deepStrictEqual(sessionsOf(first, 'user'), ['sess-a', 'sess-b'],
    'both sessions deliver their user edge, neither overwrites the other');
  const userA = byKind(first, 'user').find((edge) => edge.session === 'sess-a');
  const userB = byKind(first, 'user').find((edge) => edge.session === 'sess-b');
  assert.strictEqual(userA.at, Date.parse(askedA), 'edges carry their event timestamp');
  assert.strictEqual(userB.at, Date.parse(askedB));
  assert.ok(userA.id && userA.id !== userB.id, 'and a distinct, file-scoped identity');

  assert.deepStrictEqual(watch.takeEdges(), [],
    'the batch is edge-triggered: a second drain delivers nothing');

  // --- simultaneous tool and permission edges from both sessions ------------
  const toolAt = new Date(Date.now() - 2000).toISOString();
  const permAt = new Date(Date.now() - 1000).toISOString();
  fs.appendFileSync(fileA, toolLine('tc-a1', toolAt) + permLine('req-a1', permAt));
  fs.appendFileSync(fileB, toolLine('tc-b1', toolAt) + permLine('req-b1', permAt));

  watch.update();
  const second = watch.takeEdges();
  assert.deepStrictEqual(sessionsOf(second, 'tool'), ['sess-a', 'sess-b'],
    'both tool edges survive the poll');
  assert.deepStrictEqual(sessionsOf(second, 'prompt'), ['sess-a', 'sess-b'],
    'both permission-request edges survive the poll');
  assert.strictEqual(byKind(second, 'user').length, 0, 'nothing stale is re-delivered');

  // The level-triggered contract is unchanged, and the batch agrees with it:
  // the last entry of a kind is exactly what `edgeIds` reports.
  const slots = watch.edgeIds;
  for (const kind of ['prompt', 'tool']) {
    const entries = byKind(second, kind);
    assert.ok(slots[kind], `${kind}: the newest-per-kind slot is still published`);
    assert.strictEqual(entries[entries.length - 1].id, slots[kind].id,
      `${kind}: the last batched edge is the one the legacy slot reports`);
  }
  assert.ok(watch.pending(), 'pending-request detection is unaffected');

  // --- the newest edge per session and kind wins inside one poll ------------
  const older = new Date(Date.now() - 900).toISOString();
  const newer = new Date(Date.now() - 800).toISOString();
  fs.appendFileSync(fileA, userLine('prompt-a2', 'first', older) +
    userLine('prompt-a3', 'second', newer));
  fs.appendFileSync(fileB, userLine('prompt-b2', 'only', newer));

  watch.update();
  const third = watch.takeEdges();
  const userEdges = byKind(third, 'user');
  assert.strictEqual(userEdges.length, 2, 'one user edge per session, not per line');
  assert.deepStrictEqual(sessionsOf(third, 'user'), ['sess-a', 'sess-b']);
  assert.strictEqual(userEdges.find((edge) => edge.session === 'sess-a').at,
    Date.parse(newer), "session A's newest question is the one delivered");

  // --- a session that goes away stops producing edges -----------------------
  fs.rmSync(path.dirname(fileB), { recursive: true, force: true });
  fs.appendFileSync(fileA, toolLine('tc-a2', new Date().toISOString()));
  watch.update();
  const fourth = watch.takeEdges();
  assert.deepStrictEqual(sessionsOf(fourth, 'tool'), ['sess-a'],
    'only the surviving session contributes');

  console.log(
    'PASS: permission watch delivers every newly observed semantic edge per session ' +
    '(simultaneous same-kind edges, drain semantics, legacy slot agreement)'
  );
}

try {
  run();
} finally {
  fs.rmSync(ROOT, { recursive: true, force: true });
}

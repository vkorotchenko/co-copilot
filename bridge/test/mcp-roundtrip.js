'use strict';

// End-to-end test of the MCP read+write surface against a fake device.
// Spins up Bridge + FakeDeviceTransport + CompanionMcpServer in-process, then
// drives it with the real MCP client SDK over HTTP:
//   - lists tools
//   - companion_status (read, including the additive session fields)
//   - companion_notify (write)
//   - companion_confirm -> fake device auto-APPROVES
//   - companion_confirm -> fake device auto-DENIES (via env)
//   - companion_session_begin / companion_state / companion_task_complete /
//     companion_session_end
//   - error handling for an unknown session id
//
// Run: node test/mcp-roundtrip.js   (exits non-zero on failure)

const assert = require('assert');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const {
  StreamableHTTPClientTransport,
} = require('@modelcontextprotocol/sdk/client/streamableHttp.js');

const PORT = 4399;
process.env.COMPANION_MCP_PORT = String(PORT);
process.env.COMPANION_FAKE_DELAY_MS = '150';
process.env.COMPANION_LOG = process.env.COMPANION_LOG || 'warn';

const cfg = require('../src/config');
const { Bridge } = require('../src/bridge');
const { FakeDeviceTransport } = require('../src/transport/fakeDevice');
const { CompanionMcpServer } = require('../src/mcp/server');
const { serialize } = require('../src/protocol/snapshot');

function textOf(res) {
  return (res.content || []).map((c) => c.text).join('');
}

async function connectClient() {
  const client = new Client({ name: 'test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`));
  await client.connect(transport);
  return client;
}

async function withRig(fakeDecision, fn) {
  if (fakeDecision) process.env.COMPANION_FAKE_DECISION = fakeDecision;
  else delete process.env.COMPANION_FAKE_DECISION;

  const transport = new FakeDeviceTransport();
  const bridge = new Bridge(transport, cfg);
  const mcp = new CompanionMcpServer(bridge, cfg);
  await mcp.start();
  bridge.start();
  transport.start();
  // Give the fake device a tick to "connect".
  await new Promise((r) => setTimeout(r, 50));
  // Seed a telemetry snapshot so status has content.
  bridge.setModel({ total: 2, running: 1, waiting: 0, msg: 'working...', entries: ['10:00 hello'] });

  try {
    await fn(bridge);
  } finally {
    bridge.stop();
    await mcp.stop();
    await transport.stop();
  }
}

async function main() {
  await withRig('once', async () => {
    const client = await connectClient();

    const listedTools = (await client.listTools()).tools;
    const beginTool = listedTools.find((tool) => tool.name === 'companion_session_begin');
    assert.match(
      beginTool.description,
      /Subagents must not call it/,
      'tool guidance must reserve pal ownership for the top-level orchestrator'
    );
    assert.ok(
      beginTool.inputSchema.properties.conversation_id,
      'begin exposes the stable conversation identity'
    );
    const tools = listedTools.map((t) => t.name).sort();
    assert.deepStrictEqual(
      tools,
      [
        'companion_confirm',
        'companion_notify',
        'companion_session_begin',
        'companion_session_configure',
        'companion_session_end',
        'companion_state',
        'companion_status',
        'companion_task_complete',
      ],
      `unexpected tool list: ${tools}`
    );

    const status = JSON.parse(textOf(await client.callTool({ name: 'companion_status', arguments: {} })));
    assert.strictEqual(status.connected, true, 'status.connected should be true');
    assert.strictEqual(status.running, 1, 'status.running should reflect the model');
    // Additive fields: present, but the pre-existing shape is untouched.
    assert.deepStrictEqual(status.sessions, [], 'no explicit sessions have been reported yet');
    assert.strictEqual(status.pending_confirmations, 0);
    assert.deepStrictEqual(status.usage_tracking, {
      available: false,
      experimental: true,
      source: 'assistant_usage_events',
      tracked_sessions: 0,
    });
    assert.strictEqual(status.total, 2);
    assert.deepStrictEqual(status.entries, ['10:00 hello']);
    assert.strictEqual(status.msg, 'working...');

    const notify = textOf(await client.callTool({
      name: 'companion_notify',
      arguments: { message: 'build passed' },
    }));
    assert.match(notify, /Showed on device: build passed/, `notify result: ${notify}`);

    const approved = textOf(await client.callTool({
      name: 'companion_confirm',
      arguments: { title: 'git push', detail: 'origin main', timeout_seconds: 5 },
    }));
    assert.strictEqual(approved, 'approved', `expected approved, got: ${approved}`);

    await client.close();
  });

  await withRig('deny', async () => {
    const client = await connectClient();
    const denied = textOf(await client.callTool({
      name: 'companion_confirm',
      arguments: { title: 'rm -rf', detail: '/tmp/foo', timeout_seconds: 5 },
    }));
    assert.strictEqual(denied, 'denied', `expected denied, got: ${denied}`);
    await client.close();
  });

  // --- explicit session lifecycle over MCP ---------------------------------
  await withRig(null, async (bridge) => {
    const client = await connectClient();

    const begun = JSON.parse(textOf(await client.callTool({
      name: 'companion_session_begin',
      arguments: {
        label: 'refactor the bridge',
        cwd: '/srv/app',
        conversation_id: 'copilot-conversation-1',
        ttl_seconds: 60,
      },
    })));
    assert.ok(begun.session_id, 'begin should return a session_id');
    assert.strictEqual(begun.state, 'working');
    assert.strictEqual(begun.source, 'mcp');
    assert.strictEqual(begun.conversation_id, 'copilot-conversation-1');
    assert.strictEqual(begun.expires_in_seconds, 60);
    assert.ok(begun.pal_id, 'begin assigns presentation metadata without caller fields');

    const retry = JSON.parse(textOf(await client.callTool({
      name: 'companion_session_begin',
      arguments: {
        label: 'retry must not replace the parent',
        cwd: '/different',
        conversation_id: 'copilot-conversation-1',
        ttl_seconds: 120,
      },
    })));
    assert.strictEqual(retry.session_id, begun.session_id, 'same conversation reuses one MCP pal');
    assert.strictEqual(retry.label, begun.label, 'retry preserves the original record');
    assert.strictEqual(retry.expires_in_seconds, 120, 'retry refreshes the lease');
    assert.strictEqual(bridge.registry.size, 1, 'retry does not add a projected row');

    const configured = JSON.parse(textOf(await client.callTool({
      name: 'companion_session_configure',
      arguments: {
        session_id: begun.session_id,
        pal: 'owl',
        theme: 'cyan',
        colors: { body: 0x45cb, bg: 0, text: 0xffff, text_dim: 0x8410, ink: 0 },
        summary: 'reviewing the API',
      },
    })));
    assert.strictEqual(configured.pal_id, 'owl');
    assert.strictEqual(configured.theme_id, 'cyan');
    assert.strictEqual(configured.palette.body, 0x45cb, 'explicit colors override the theme');
    assert.strictEqual(configured.palette.text_dim, 0x8410);
    assert.strictEqual(configured.summary, 'reviewing the API');
    assert.strictEqual(configured.assignment, 'user');

    const emoji96 = '😀'.repeat(96);
    const emojiConfigured = JSON.parse(textOf(await client.callTool({
      name: 'companion_session_configure',
      arguments: { session_id: begun.session_id, summary: emoji96 },
    })));
    assert.strictEqual(emojiConfigured.summary, emoji96, '96 code points are accepted over MCP');

    const scalarConfigured = JSON.parse(textOf(await client.callTool({
      name: 'companion_session_configure',
      arguments: { session_id: begun.session_id, summary: 'left\ud800right' },
    })));
    assert.strictEqual(scalarConfigured.summary, 'left\ufffdright');
    const wireLine = serialize(bridge.status);
    assert.strictEqual(Buffer.from(wireLine, 'utf8').toString('utf8'), wireLine);

    const emoji97 = await client.callTool({
      name: 'companion_session_configure',
      arguments: { session_id: begun.session_id, summary: '😀'.repeat(97) },
    });
    assert.strictEqual(emoji97.isError, true, '97 code points are rejected over MCP');

    const blankId = await client.callTool({
      name: 'companion_session_configure',
      arguments: { session_id: '   ', summary: 'x' },
    });
    assert.strictEqual(blankId.isError, true);
    assert.strictEqual(JSON.parse(textOf(blankId)).error, 'invalid_argument');

    const configuredStatus = JSON.parse(
      textOf(await client.callTool({ name: 'companion_status', arguments: {} }))
    );
    assert.strictEqual(configuredStatus.sessions[0].pal_id, 'owl');
    assert.strictEqual(configuredStatus.sessions[0].summary, 'left\ufffdright');
    assert.deepStrictEqual(configuredStatus.projection, {
      schema_version: 1,
      max_sessions: 8,
      live: 1,
      species_in_use: ['owl'],
    });

    for (const [what, arguments_] of [
      ['invalid pal', { session_id: begun.session_id, pal: 'horse' }],
      [
        'invalid palette',
        {
          session_id: begun.session_id,
          colors: { body: 0x45cb, bg: 1, text: 0xffff, text_dim: 0x8410, ink: 0 },
        },
      ],
      ['oversized summary', { session_id: begun.session_id, summary: 'x'.repeat(97) }],
      ['unknown session', { session_id: 'cs-not-a-real-session', summary: 'x' }],
    ]) {
      const result = await client.callTool({
        name: 'companion_session_configure',
        arguments: arguments_,
      });
      assert.strictEqual(result.isError, true, `${what} should return a coded tool error`);
    }

    const updated = JSON.parse(textOf(await client.callTool({
      name: 'companion_state',
      arguments: { session_id: begun.session_id, state: 'waiting', message: 'need a decision' },
    })));
    assert.strictEqual(updated.state, 'waiting');

    // Explicit state is visible in status and composed into the snapshot.
    const busy = JSON.parse(textOf(await client.callTool({ name: 'companion_status', arguments: {} })));
    assert.strictEqual(busy.sessions.length, 1, 'the explicit session shows up in status');
    assert.strictEqual(busy.sessions[0].state, 'waiting');
    assert.strictEqual(busy.msg, 'need a decision', 'explicit state wins the display line');
    assert.strictEqual(busy.waiting, 1);
    assert.strictEqual(bridge.status.waiting, 1, 'and reaches the device snapshot');

    const completed = JSON.parse(textOf(await client.callTool({
      name: 'companion_task_complete',
      arguments: { session_id: begun.session_id, outcome: 'success' },
    })));
    assert.strictEqual(completed.state, 'idle');
    assert.strictEqual(completed.task_outcome, 'success');
    assert.strictEqual(bridge.registry.get(begun.session_id).state, 'idle',
      'task completion keeps the conversation registered');
    assert.strictEqual(bridge.status.waiting, 0, 'task completion returns the pal to idle');
    assert.ok(bridge.completionLatch.current, 'task completion latches the animation');
    // No result message exists, so the session's last in-flight text must not
    // be resurrected.
    assert.notStrictEqual(
      bridge.status.msg,
      'need a decision',
      'task completion must not re-flash the stale state message'
    );

    // The next task uses the same pal and clears the previous completion.
    const resumed = JSON.parse(textOf(await client.callTool({
      name: 'companion_state',
      arguments: { session_id: begun.session_id, state: 'working', message: 'next request' },
    })));
    assert.strictEqual(resumed.session_id, begun.session_id);
    assert.strictEqual(bridge.completionLatch.current, null);

    const ended = JSON.parse(textOf(await client.callTool({
      name: 'companion_session_end',
      arguments: { session_id: begun.session_id, outcome: 'success' },
    })));
    assert.strictEqual(ended.outcome, 'success');
    assert.strictEqual(bridge.completionLatch.current, null,
      'retiring the conversation does not create a completion animation');

    // A second session can complete a failed task, then later retire with a
    // distinct closing message.
    const loud = JSON.parse(textOf(await client.callTool({
      name: 'companion_session_begin',
      arguments: { label: 'nightly build' },
    })));
    await client.callTool({
      name: 'companion_state',
      arguments: { session_id: loud.session_id, state: 'working', message: 'compiling' },
    });
    const failedTask = JSON.parse(textOf(await client.callTool({
      name: 'companion_task_complete',
      arguments: { session_id: loud.session_id, outcome: 'failed' },
    })));
    assert.strictEqual(failedTask.state, 'idle');
    assert.strictEqual(failedTask.task_outcome, 'failed');
    const loudEnd = JSON.parse(textOf(await client.callTool({
      name: 'companion_session_end',
      arguments: { session_id: loud.session_id, outcome: 'failed', message: 'build broke' },
    })));
    assert.strictEqual(loudEnd.closing_message, 'build broke');
    assert.strictEqual(bridge.status.msg, 'build broke', 'the closing message is flashed');

    // Unknown / already-ended sessions produce an explicit tool error.
    const missing = await client.callTool({
      name: 'companion_state',
      arguments: { session_id: 'cs-not-a-real-session', state: 'working' },
    });
    assert.strictEqual(missing.isError, true, 'unknown session should be a tool error');
    assert.strictEqual(JSON.parse(textOf(missing)).error, 'unknown_session');

    const reEnd = await client.callTool({
      name: 'companion_session_end',
      arguments: { session_id: begun.session_id },
    });
    assert.strictEqual(reEnd.isError, true, 'ending twice should be a tool error');

    await client.close();
  });

  console.log(
    'PASS: MCP read+write round-trip (status, notify, confirm approve/deny, session lifecycle)'
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('FAIL:', err.stack || err.message);
    process.exit(1);
  });

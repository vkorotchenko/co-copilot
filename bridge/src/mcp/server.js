'use strict';

const http = require('http');
const { z } = require('zod');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const {
  StreamableHTTPServerTransport,
} = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { handleApiRequest } = require('../http/api');
const { checkRequest, allowedHostList, allowedOriginList } = require('../http/guard');
const { STATES, OUTCOMES } = require('../sessions/registry');
const { SPECIES } = require('../sessions/species');
const { THEMES } = require('../sessions/palettes');
const { validateSummary } = require('../sessions/summary');
const log = require('../util/log');

// MCP server hosted by the bridge. Exposes the device as a set of tools the
// agent can call:
//
//   companion_status        (read)  -> activity snapshot + explicit sessions
//   companion_notify        (write) -> flash a message on the device screen
//   companion_confirm       (write) -> ask the user a yes/no on the device and
//                                      BLOCK until they press approve/deny
//                                      (reuses the firmware's prompt UI)
//   companion_session_begin (write) -> register an orchestrator-owned conversation
//   companion_session_configure (write) -> set optional pal presentation
//   companion_state         (write) -> report this session's lifecycle state
//   companion_task_complete (write) -> finish current work, keep the session
//   companion_session_end   (write) -> retire the conversation
//
// The session tools are the event-driven path: instead of inferring what an
// agent is doing from log scraping, the agent says so. Active work carries a
// TTL, so a crashed or silent reporter falls back to idle instead of pinning
// the buddy to a stale state; the conversation and its pal remain registered.
//
// Two transports are supported:
//   - HTTP (start):      registered in mcp-config.json as `type: "http"`; the
//                        bridge must already be running. The same listener also
//                        serves the plain-HTTP mirror in ../http/api.js.
//   - stdio (startStdio): registered as `type: "local"`; Copilot CLI spawns the
//                        whole bridge per session and talks over stdin/stdout.
//
// Runs stateless (no session affinity needed).
class CompanionMcpServer {
  constructor(bridge, cfg) {
    this._bridge = bridge;
    this._port = cfg.mcp.port;
    this._host = cfg.mcp.host;
    // Canonical loopback spellings for this listener, handed to the SDK's own
    // DNS-rebinding protection as a second line of defence behind our gate.
    this._allowedHosts = allowedHostList(this._host, this._port);
    this._allowedOrigins = allowedOriginList(this._host, this._port);
    this._http = null;
    this._stdioServer = null;
    this._stdioTransport = null;
  }

  // stdio transport: one persistent server bound to this process's stdin/stdout.
  // Copilot CLI launches the bridge as a `local` MCP server and speaks JSON-RPC
  // over the pipe, so nothing else may write to stdout (logs go to stderr).
  async startStdio() {
    const {
      StdioServerTransport,
    } = require('@modelcontextprotocol/sdk/server/stdio.js');
    this._stdioServer = this._buildServer();
    this._stdioTransport = new StdioServerTransport();
    await this._stdioServer.connect(this._stdioTransport);
    log.info('MCP server attached to stdio (local transport).');
  }

  async start() {
    // Stateless Streamable HTTP: build a fresh server + transport per request
    // (the documented stateless pattern). Tools close over the shared bridge.
    // The same listener also answers the plain-HTTP mirror (/healthz, /v1/*)
    // so non-MCP callers never need a second daemon or a second BLE owner.
    this._http = http.createServer((req, res) => {
      if (handleApiRequest(req, res, this._bridge, { port: this._port })) return;
      if (req.url && req.url.split('?')[0] !== '/mcp') {
        res.writeHead(404).end();
        return;
      }
      // /mcp gets the same transport gate as the mirror (loopback peer,
      // loopback Host on our port, loopback-or-absent Origin) *before* the body
      // is collected, so a rebound or cross-origin caller never reaches a tool.
      // The SDK enforces `Content-Type: application/json` on POST /mcp itself
      // (415) and also runs its own allowedHosts/allowedOrigins check below;
      // this gate is the authoritative one and is applied first because it
      // understands the whole 127.0.0.0/8 range rather than a fixed list.
      const denied = checkRequest(req, { port: this._port });
      if (denied) {
        log.debug(`MCP /mcp -> ${denied.status} ${denied.code}: ${denied.detail}`);
        sendJsonRpcError(res, denied.status, denied.message);
        return;
      }
      collectBody(req)
        .then(async (body) => {
          const server = this._buildServer();
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
            // Belt and braces: the SDK compares the raw Host/Origin against
            // these exact strings. Narrower than our gate (it only knows the
            // canonical spellings), never wider, so it can only ever reject
            // more — which is the safe direction for a rebinding defence.
            enableDnsRebindingProtection: true,
            allowedHosts: this._allowedHosts,
            allowedOrigins: this._allowedOrigins,
          });
          res.on('close', () => {
            transport.close();
            server.close();
          });
          await server.connect(transport);
          await transport.handleRequest(req, res, body);
        })
        .catch((err) => {
          log.error('MCP request error:', err.message);
          if (!res.headersSent) res.writeHead(500).end();
        });
    });

    await new Promise((resolve, reject) => {
      this._http.once('error', reject);
      this._http.listen(this._port, this._host, resolve);
    });
    log.info(`MCP server listening at http://${this._host}:${this._port}/mcp`);
    log.info(`HTTP mirror: http://${this._host}:${this._port}/healthz and /v1/*`);
    log.info('Add it to Copilot as an http MCP server pointing at the /mcp URL.');
  }

  _buildServer() {
    const server = new McpServer(
      { name: 'co-mpanion', version: '0.1.0' },
      { capabilities: { tools: {} } }
    );

    server.registerTool(
      'companion_status',
      {
        title: 'Companion status',
        description:
          'Read the current GitHub Copilot activity as shown on the co-mpanion ' +
          'device: session counts, busy/idle, recent messages, and whether a ' +
          'device is connected.',
        inputSchema: {},
      },
      async () => ({
        content: [{ type: 'text', text: JSON.stringify(statusPayload(this._bridge), null, 2) }],
      })
    );

    server.registerTool(
      'companion_notify',
      {
        title: 'Notify on device',
        description:
          'Flash a short message on the co-mpanion device screen for a few ' +
          'seconds. Use for status pings ("build passed", "deploying...").',
        inputSchema: {
          message: z.string().max(23).describe('Short message (<=23 chars shown).'),
        },
      },
      async ({ message }) => {
        const delivered = this._bridge.notify(message);
        return {
          content: [
            {
              type: 'text',
              text: delivered
                ? `Showed on device: ${message}`
                : 'No device connected; message not shown.',
            },
          ],
        };
      }
    );

    server.registerTool(
      'companion_confirm',
      {
        title: 'Confirm on device',
        description:
          'Ask the user to physically approve or deny an action on the ' +
          'co-mpanion device, then BLOCK until they press the approve (A) or ' +
          'deny (B) button. Returns "approved" or "denied". Use before risky or ' +
          'irreversible actions when you want a hardware confirmation. ' +
          'Simultaneous confirmations are queued and shown one at a time, in the ' +
          'order they were asked; each caller receives its own answer.',
        inputSchema: {
          title: z.string().max(19).describe('Short action name, e.g. the tool/command.'),
          detail: z.string().max(43).optional().describe('One-line detail/hint.'),
          timeout_seconds: z
            .number()
            .int()
            .min(5)
            .max(600)
            .optional()
            .describe('How long to wait for a button press (default 60).'),
        },
      },
      async ({ title, detail, timeout_seconds }) => {
        const { decision } = await this._bridge.confirm({
          title,
          detail,
          timeoutMs: (timeout_seconds || 60) * 1000,
        });
        const text =
          decision === 'approved'
            ? 'approved'
            : decision === 'denied'
            ? 'denied'
            : decision === 'timeout'
            ? 'timeout: no response from the device'
            : 'unavailable: no co-mpanion device is connected';
        return {
          content: [{ type: 'text', text }],
          isError: decision === 'unavailable',
        };
      }
    );

    // --- explicit session lifecycle ----------------------------------------

    server.registerTool(
      'companion_session_begin',
      {
        title: 'Begin a companion session',
        description:
          'Register one top-level Copilot conversation with the co-mpanion bridge ' +
          'so the device shows what the session orchestrator is doing without ' +
          'waiting for log scraping. Call this once per user conversation. When ' +
          'the host exposes a stable conversation ID, pass it as conversation_id ' +
          'so retries return the existing pal instead of creating another one. ' +
          'Subagents must not call it; they report back to the orchestrator, which ' +
          'updates this same pal. Returns an ' +
          'opaque session_id to pass to companion_state, companion_task_complete, ' +
          'and companion_session_end. The first task starts in the "working" state. ' +
          'If active reporting stops, its lease falls back to idle (default 90s) ' +
          'without discarding the conversation or its configured pal.',
        inputSchema: {
          label: z
            .string()
            .min(1)
            .max(64)
            .describe('Short human-readable name for this session, e.g. the task or repo.'),
          cwd: z.string().max(256).optional().describe('Working directory this session runs in.'),
          conversation_id: z
            .string()
            .trim()
            .min(1)
            .max(128)
            .optional()
            .describe(
              'Stable top-level Copilot conversation ID, when available. Reusing it makes begin idempotent. Never use cwd or label as this identity.'
            ),
          ttl_seconds: z
            .number()
            .int()
            .min(5)
            .max(3600)
            .optional()
            .describe('Active-task lease before stale work falls back to idle (default 90). Renewed by companion_state.'),
        },
      },
      async ({ label, cwd, conversation_id, ttl_seconds }) =>
        this._sessionCall(() =>
          this._bridge.beginSession({
            label,
            cwd,
            conversationId: conversation_id,
            source: 'mcp',
            ttlSeconds: ttl_seconds,
          })
        )
    );

    server.registerTool(
      'companion_session_configure',
      {
        title: 'Configure a companion session',
        description:
          'Optionally change the pal, palette, or brief summary for a session. ' +
          'companion_session_begin already assigns a deterministic pal and ' +
          'classic palette, so configuration is cosmetic and never required. ' +
          'This call does not renew the session lease; companion_state is what ' +
          'keeps it alive. Omitted fields stay unchanged, while explicit null ' +
          'resets a field to its default. An explicit pal is authoritative and ' +
          'may intentionally match another live session.',
        inputSchema: {
          session_id: z.string(),
          pal: z.enum(SPECIES).nullable().optional(),
          theme: z.enum(THEMES).nullable().optional(),
          colors: z
            .object({
              body: z.number().int().min(0).max(65535),
              bg: z.number().int().min(0).max(65535),
              text: z.number().int().min(0).max(65535),
              text_dim: z.number().int().min(0).max(65535),
              ink: z.number().int().min(0).max(65535),
            })
            .strict()
            .nullable()
            .optional(),
          summary: z
            .string()
            .refine((value) => validateSummary(value).ok, {
              message: 'summary must contain at most 96 Unicode code points.',
            })
            .nullable()
            .optional(),
        },
      },
      async ({ session_id, pal, theme, colors, summary }) =>
        this._sessionCall(() =>
          this._bridge.configureSession({
            id: session_id,
            palId: pal,
            themeId: theme,
            colors:
              colors === undefined || colors === null
                ? colors
                : {
                    body: colors.body,
                    bg: colors.bg,
                    text: colors.text,
                    textDim: colors.text_dim,
                    ink: colors.ink,
                  },
            summary,
          })
        )
    );

    server.registerTool(
      'companion_state',
      {
        title: 'Report session state',
        description:
          'Update the lifecycle state of a session started with ' +
          'companion_session_begin. Only the top-level session orchestrator calls ' +
          'this; it summarizes subagent work into the same session rather than ' +
          'creating a pal per agent. The device shows the highest-priority live ' +
          'state (blocked/waiting beats working/thinking). Each call renews the ' +
          "session's lease. Call this whenever you switch phase — before a long " +
          'tool run ("working"), while reasoning ("thinking"), or when you need ' +
          'the human ("waiting"/"blocked"). Starting an active state from idle ' +
          'begins the next task cycle; use companion_task_complete when all work ' +
          'for that cycle is finished.',
        inputSchema: {
          session_id: z.string().describe('The session_id from companion_session_begin.'),
          state: z
            .enum(STATES)
            .describe('Lifecycle state: thinking, working, waiting, blocked, or idle.'),
          message: z
            .string()
            .max(120)
            .optional()
            .describe('Optional one-line detail shown on the device (<=23 chars visible).'),
          ttl_seconds: z
            .number()
            .int()
            .min(5)
            .max(3600)
            .optional()
            .describe('Override the lease length for this and subsequent updates.'),
        },
      },
      async ({ session_id, state, message, ttl_seconds }) =>
        this._sessionCall(() =>
          this._bridge.updateSession({ id: session_id, state, message, ttlSeconds: ttl_seconds })
        )
    );

    server.registerTool(
      'companion_task_complete',
      {
        title: 'Complete current companion task',
        description:
          'Mark all work for the current user request complete and return the ' +
          'long-lived conversation session to idle without removing its pal or ' +
          'configuration. Only the top-level orchestrator calls this, after all ' +
          'subtasks and delegated agents have finished. This is the event that ' +
          'shows the success/failed/aborted completion animation. Repeating it ' +
          'after the same task is idempotent and does not replay the animation.',
        inputSchema: {
          session_id: z.string().describe('The session_id from companion_session_begin.'),
          outcome: z
            .enum(OUTCOMES)
            .optional()
            .describe('How the current task finished (default "success").'),
        },
      },
      async ({ session_id, outcome }) =>
        this._sessionCall(() => this._bridge.completeTask({ id: session_id, outcome }))
    );

    server.registerTool(
      'companion_session_end',
      {
        title: 'End a companion session',
        description:
          'Permanently retire the orchestrator-owned conversation started with ' +
          'companion_session_begin. This does not trigger a completion animation; ' +
          'use companion_task_complete when the current request finishes, because ' +
          'a conversation may continue through many tasks. The device stops counting ' +
          'an ended session immediately. Subagents must not end the parent session. ' +
          'Pass a message only if you want a closing ' +
          'line flashed on screen (e.g. "build broke"); omit it and the device ' +
          'falls straight back to your other sessions. Call this only when the ' +
          'conversation itself is being discarded, not at the end of each task.',
        inputSchema: {
          session_id: z.string().describe('The session_id from companion_session_begin.'),
          outcome: z
            .enum(OUTCOMES)
            .optional()
            .describe('How the session finished (default "success").'),
          message: z
            .string()
            .max(120)
            .optional()
            .describe(
              'Optional closing message to flash on the device. Only a message ' +
                'given here is flashed — the last companion_state message is not ' +
                'reused as a result.'
            ),
        },
      },
      async ({ session_id, outcome, message }) =>
        this._sessionCall(() => this._bridge.endSession({ id: session_id, outcome, message }))
    );

    return server;
  }

  // Shared wrapper for the session tools: JSON-encode the record, or turn a
  // registry error into an explicit, machine-readable tool error so the agent
  // knows to start a fresh session rather than silently losing state.
  _sessionCall(fn) {
    try {
      const record = fn();
      return { content: [{ type: 'text', text: JSON.stringify(record, null, 2) }] };
    } catch (err) {
      const payload = {
        error: err.code || 'internal_error',
        message: err.message || 'Session call failed.',
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
        isError: true,
      };
    }
  }

  async stop() {
    if (this._http) {
      await new Promise((r) => this._http.close(r));
      this._http = null;
    }
    if (this._stdioServer) {
      try { await this._stdioServer.close(); } catch { /* noop */ }
      this._stdioServer = null;
      this._stdioTransport = null;
    }
  }
}

function statusPayload(bridge) {
  const status = bridge.status;
  const sessions = bridge.registry.list();
  const liveSessions = sessions.filter((record) => record.state !== 'ended');
  return {
    connected: bridge.connected,
    total: status.total,
    running: status.running,
    waiting: status.waiting,
    msg: status.msg,
    entries: status.entries || [],
    // Additive: explicitly-reported sessions (companion_session_begin).
    // Existing callers can ignore these fields safely.
    sessions,
    pending_confirmations: bridge.pendingConfirmations,
    // Additive: which Copilot conversation the passive entries/state describe.
    // Null on an older CLI with no session-state events, or before the first
    // source tick. Existing callers can ignore this safely.
    focus: bridge.passiveFocus || null,
    usage_tracking: bridge.usageStatus,
    projection: {
      schema_version: 1,
      max_sessions: bridge.deviceProjectionMax,
      live: liveSessions.length,
      species_in_use: [...new Set(liveSessions.map((record) => record.pal_id))].sort(),
    },
  };
}

// Refuse a /mcp request in the shape the SDK itself uses for transport-level
// rejections, so an MCP client reports a protocol error rather than choking on
// an unexpected body.
function sendJsonRpcError(res, status, message) {
  const body = JSON.stringify({
    jsonrpc: '2.0',
    error: { code: -32000, message },
    id: null,
  });
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function collectBody(req) {
  if (req.method !== 'POST') return Promise.resolve(undefined);
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 4 * 1024 * 1024) reject(new Error('body too large'));
    });
    req.on('end', () => {
      if (!data) return resolve(undefined);
      try {
        resolve(JSON.parse(data));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

module.exports = { CompanionMcpServer, statusPayload };

# co-mpanion bridge

The Copilot-side host app. It is the BLE **central**: it scans for a co-mpanion
device, connects, and streams your **GitHub Copilot CLI** activity to it as
newline-delimited JSON "heartbeat" snapshots (see `../REFERENCE.md`).

This is the piece the Claude desktop app provides natively for
`claude-desktop-buddy` — Copilot has no equivalent, so the bridge supplies it.

## Install

```bash
cd bridge
npm install
```

Native dependencies:

- `@abandonware/noble` — BLE central (CoreBluetooth on macOS).
- `better-sqlite3` — read-only access to the Copilot session store.

On macOS, the first run triggers a Bluetooth permission prompt; grant it. If
Bluetooth is off the bridge logs `BLE adapter state: poweredOff` and waits.

## Run

```bash
npm start            # read Copilot CLI activity, stream to a "Copilot-XXXX" device
npm run simulate     # stream scripted fake activity to a real device
npm run dry-run      # simulate + print lines to the console (no Bluetooth/device)
npm run mcp          # also run the MCP server (read + write tools for Copilot)
npm run setup        # install: register MCP (http) + background service (see below)
npm run uninstall    # stop + remove the background service and MCP registration
npm test             # bridge test suite (MCP, sessions, projection/budget/backcompat, confirm queue, HTTP, OTA, parsers)
```

Or directly:

```bash
node src/index.js [--simulate] [--no-ble] [--fake-device] [--mcp]
```

| Flag | Effect |
| --- | --- |
| `--simulate`, `-s` | Use scripted fake activity instead of reading Copilot. |
| `--no-ble` | Print outgoing JSON lines to the console instead of using BLE. |
| `--fake-device` | Simulate a connected device that auto-answers prompts (implies `--no-ble`). |
| `--mcp` | Also run the MCP server over HTTP (read + write tools for Copilot). |
| `--mcp-stdio` | Run the MCP server over stdio (implies `--mcp`); for `type: "local"` registration. Logs go to stderr. |
| `--help`, `-h` | Usage. |

### Environment

| Var | Default | Meaning |
| --- | --- | --- |
| `COPILOT_HOME` | `~/.copilot` | Copilot CLI state directory. |
| `COMPANION_LOGS_DIR` | `$COPILOT_HOME/logs` | Where the live `process-*.log` files live. Set this if a launcher redirects logs via `--log-dir` (e.g. a wrapper using `~/.local/agency/logs/session_*/`); the tail searches it recursively. Every recently-written log is tracked independently, not just the newest one. |
| `COMPANION_LOG_WINDOW_MS` | `1800000` | Only follow logs written within this window. The newest log overall is always followed regardless of age, and a log holding an open model request is never dropped mid-flight. |
| `COMPANION_LOG_MAX_FILES` | `8` | Cap on simultaneously tracked `process-*.log` files (newest-mtime wins). |
| `COMPANION_PROMPT_MAX_CHARS` | `600` | Ceiling on a captured in-flight question before it is matched against the persisted turn and rendered (the device shows ~150 characters). |
| `COMPANION_PROMPT_PRIME_MS` | `120000` | On first sight of a session's event file the bridge replays its tail to recover state. A question found in that replay only counts as *current* work if it is this recent — otherwise restarting would parade a long-finished prompt as live. |
| `COMPANION_PROMPT_PRIME_BYTES` | `33554432` | Maximum event-file window searched once when recovering a session after bridge startup. Scanned in 256 KiB chunks and clamped to 256 KiB–64 MiB so large tool results do not hide the current question while memory and I/O remain bounded. |
| `COMPANION_PROMPT_PRIME_FILES` | `2` | Maximum newly discovered session event files synchronously recovered per one-second poll. Additional recent sessions are deferred to later polls. |
| `COMPANION_PROMPT_MAX_QUIET_MS` | `1800000` | Retire an in-flight prompt if its session has no later events for this long, preventing a crashed CLI from leaving a ghost question indefinitely. |
| `COMPANION_FOCUS_ACTIVE_MS` | `60000` | How recently a session must have done something to rank as "active" when choosing which conversation the screen shows. |
| `COMPANION_NAME_PREFIX` | `Copilot` | BLE device-name prefix to scan for. |
| `COMPANION_MCP_PORT` | `4317` | Port for the MCP HTTP server + HTTP mirror (`--mcp`). |
| `COMPANION_SESSION_TTL_MS` | `90000` | Default lease for active work in an explicitly reported conversation. When it expires, the pal returns to idle instead of being deleted. |
| `COMPANION_SESSION_MIN_TTL_MS` / `_MAX_TTL_MS` | `5000` / `3600000` | Bounds that caller-supplied `ttl_seconds` values clamp into. |
| `COMPANION_SESSION_MAX` | `64` | Cap on tracked sessions. At the cap, ended records are shed first, then the least-recently-*updated* one. |
| `COMPANION_DEVICE_PROJECTION_MAX` | `8` | Maximum live session-pal rows sent to the device. Values clamp to `1..8`; status still reports the complete registry. |
| `COMPANION_SESSION_ENDED_MS` | `10000` | How long an ended session stays visible in `companion_status`. |
| `COMPANION_CONFIRM_QUEUE` | `8` | Max queued `companion_confirm` calls before new ones return `unavailable`. Minimum 1 (the screen shows one prompt at a time); lower values clamp up rather than disabling confirmations. |
| `COMPANION_BLE_RECOVER_MS` | `45000` | macOS only. After scanning this long without ever finding the device, macOS has usually auto-reconnected to the bonded peripheral and is holding the link (so it stops advertising and can't be rediscovered). The bridge runs `blueutil --disconnect` to release the hold. `0` disables. |
| `COMPANION_BLUEUTIL` | auto | Absolute path to `blueutil` for the recovery above. Normally unnecessary — the bridge checks `/opt/homebrew/bin` (Apple Silicon), `/usr/local/bin` (Intel), `/opt/local/bin` (MacPorts), then `PATH`. Set this only for a non-standard install. Must be absolute; a relative or non-executable value is refused with a warning rather than silently running something else. |
| `COMPANION_LOG` | `info` | `debug` \| `info` \| `warn` \| `error`. |

## Bidirectional mode (MCP): the device can answer the agent

By default the bridge streams **passive** telemetry it scrapes from the Copilot
CLI's local state. With `--mcp` it also hosts an **MCP server** so the top-level
session orchestrator can *talk back to the device* — asking for a hardware
approve/deny and reporting the conversation lifecycle instead of waiting for it
to be inferred from a log (see the project notes on why a raw approve/deny hook
isn't possible). Spawned agents defer to the orchestrator and do not create
their own pals. The MCP server reuses the device's existing permission-prompt
UI, so **no firmware change is needed**.

```bash
npm run mcp     # bridge + MCP server on http://127.0.0.1:4317/mcp
```

### Recommended — `make install` (HTTP + managed background service)

From the repo root, `make install` does everything: installs deps, registers
co-mpanion as a **`type:"http"`** MCP server in `~/.copilot/mcp-config.json`, and
installs a per-user background service (launchd on macOS, systemd `--user` on
Linux) that keeps **one** bridge running and owning the device. That single
shared bridge is the key: a Copilot session can spawn several processes
(interactive shell, agent subprocess, sub-agents) and the device accepts only
one BLE connection, so one long-lived owner — instead of a bridge-per-process
scramble — is what makes prompts reliably reach the device.

The MCP entry it writes is simply:

```json
{
  "mcpServers": {
    "co-mpanion": { "type": "http", "url": "http://127.0.0.1:4317/mcp", "tools": ["*"] }
  }
}
```

Manage it with `make service-restart`, `make service-logs`, `make uninstall`.
Restart any running Copilot session afterward so it loads the new config.

> **macOS:** install `blueutil` (`brew install blueutil`) to enable BLE
> auto-recovery. When the device drops, macOS re-grabs the Just Works-bonded
> peripheral and holds the link, so it stops advertising and the bridge can
> never rediscover it. `blueutil --disconnect` releases that hold. The bridge
> finds it by absolute path — a launchd agent inherits only
> `/usr/bin:/bin:/usr/sbin:/sbin`, which contains no Homebrew prefix — so no
> PATH setup is needed. Without it the bridge still scans normally, and says so
> once per stall in `make service-logs`.

### Manual HTTP (no service)

Prefer to manage the process yourself? Start the bridge with `npm run mcp` (keep
it running) and add the same `type:"http"` entry above to
`~/.copilot/mcp-config.json` by hand.

### Advanced — stdio (`type: "local"`, single-process only)

Copilot can instead *launch the bridge itself* over stdio. Only use this if you
run a **single** Copilot process at a time: each process spawns its own bridge,
and only one can hold the BLE device — so with concurrent processes (agent
subprocesses, sub-agents, a separate interactive shell) the others get a
disconnected bridge and questions won't appear. Prefer HTTP above unless you
know you need this.

```json
{
  "mcpServers": {
    "co-mpanion": {
      "type": "local",
      "command": "node",
      "args": ["/abs/path/to/co-mpanion/bridge/src/index.js", "--mcp-stdio"],
      "tools": ["*"]
    }
  }
}
```

`--mcp-stdio` speaks JSON-RPC over stdout, so all logs are redirected to stderr.

Tools exposed to the agent:

| Tool | Direction | What it does |
| --- | --- | --- |
| `companion_status` | read | Returns current activity (sessions, busy/idle, recent messages, whether a device is connected) plus the explicitly-reported sessions. |
| `companion_notify` | write | Flashes a short message on the device screen. |
| `companion_confirm` | write | Shows an approve/deny prompt on the device and **blocks until the user presses a button**, returning `approved` / `denied`. Simultaneous calls queue FIFO. |
| `companion_session_begin` | write | Registers one top-level user conversation (`label`, optional stable `conversation_id`, `cwd`, `ttl_seconds`) and returns an opaque `session_id`. Reusing `conversation_id` refreshes the existing pal; subagents do not create pals. |
| `companion_session_configure` | write | Optionally changes a session's pal, theme, complete palette, or one-line summary without renewing its lease. |
| `companion_state` | write | Reports that conversation's state: `thinking`, `working`, `waiting`, `blocked`, `idle` (+ optional `message`). Active states renew the task lease; an idle-to-active transition starts the next task cycle. |
| `companion_task_complete` | write | Marks all work for the current user request complete with `success`, `failed`, or `aborted`. It triggers the completion animation, returns the same pal to idle, and keeps its configuration for the next request. Repeated calls for the same task are idempotent. |
| `companion_session_end` | write | Permanently retires the conversation without triggering a completion animation. An optional `message` is a **closing** message and is the only thing flashed on screen; omit it and the device falls straight back to the other live sessions (or passive state). |

Nudge the agent to route risky actions through it, e.g. in `AGENTS.md`:
*"Before any irreversible action, call `companion_confirm` and respect the
result."* The agent then gets a physical button press back as the tool result.

> This covers actions the agent *chooses* to route through the tool — it does
> not intercept Copilot's own built-in permission prompts (that isn't externally
> hookable today). See the project notes / `permission-spike`.

### Concurrent confirmations

The screen shows one question at a time, so concurrent `companion_confirm` calls
are queued and asked in the order they arrived. Each caller's promise resolves
with the answer to *its own* question — answers are correlated by prompt id, so
a late or duplicate button press can't leak into the question now on screen.

`timeout_seconds` bounds the **total** wait (queueing included): a caller that
gives up while still in line leaves the queue without disturbing the question on
screen, and a head that times out promotes the next one immediately. If the link
drops, every waiting caller — queued ones included — is released as
`unavailable`. Beyond `COMPANION_CONFIRM_QUEUE` (default 8, minimum 1) pending
questions, new calls return `unavailable` immediately rather than piling up.

## Event-driven state: orchestrators report conversation state

Passive log scraping is accurate but laggy, and it can't tell *why* a session is
quiet. The top-level session orchestrator can call MCP (or a coordinating script
can use `curl`) to announce the conversation lifecycle, which the bridge shows
immediately:

```
companion_session_begin({
  label: "refactor the bridge",
  conversation_id: "copilot-conversation-uuid"
}) -> { session_id }
companion_state({ session_id, state: "working",  message: "running tests" })
companion_state({ session_id, state: "blocked",  message: "need a decision" })
companion_task_complete({ session_id, outcome: "success" })
```

The returned handle belongs to the whole user conversation. Spawned agents
report results to the orchestrator instead of calling the lifecycle tools
themselves; the orchestrator updates the same summary and state. Passive log
telemetry may still observe several simultaneous model requests, but those
requests do not become separate pals.

`conversation_id` is optional for backward compatibility. When the caller has a
stable top-level Copilot conversation ID, it should pass it: another begin with
the same live key returns the same `session_id`, preserves lifecycle and pal
configuration, and refreshes the lease only while a task is active. Task
completion and active-lease expiry keep the key and pal registered in idle.
Explicit session end and capacity eviction release the key so a later
conversation can start cleanly. Do not derive this key from `cwd` or `label`;
independent conversations can share both. Without a stable key, every begin
remains a new explicit record, so the orchestrator must call it only once and
retain the returned handle.

`companion_task_complete` is the task boundary. The top-level orchestrator calls
it only after the current user request and all delegated work finish. It latches
the completion card once, records the task outcome, and returns the conversation
to idle. The next idle-to-active `companion_state` starts a fresh task cycle and
clears the previous card.

`message` means different things on state updates and conversation retirement.
On `companion_state` it is *ambient* text describing current work ("running
tests"). On `companion_session_end` it is a *closing* message — a result worth
flashing ("conversation closed") — and it is the only text an end can put on
screen. Ending without one does **not** re-show the last state line. Session end
does not create a completion card; use it only when the conversation itself is
being discarded.

Ambient text is **task-cycle local**. It is cleared when the task cycle ends —
by `companion_task_complete` or by a direct active-to-idle abandonment — and
again when the next idle-to-active transition opens a new cycle. A caller that
supplies a `message` on that transition still gets it; one that does not gets
silence rather than the previous task's "running tests".

Active work holds a **lease** (default 90s, `ttl_seconds` to override, bounded
5s–1h). Each active `companion_state` call renews it. If a reporter crashes,
hangs, or simply stops reporting, the lease lapses and the conversation returns
to idle — the device is never pinned to stale work, and the pal remains
available for the next request. Idle conversations persist until explicit
session end, capacity eviction, or bridge restart.

The registry is **in-memory only**: after a bridge restart the passive observers
reconstruct activity within a tick or two, which is better than resurrecting
session rows that may no longer be true.

### Session pals and presentation

Every orchestrator-owned conversation receives resolved presentation metadata at
`companion_session_begin`, whether or not the caller ever configures it:

| Status field | Default and meaning |
| --- | --- |
| `pal_id` | Deterministic species from the 18-entry catalog. |
| `theme_id` | `classic`. |
| `palette` | Complete `{ body, bg, text, text_dim, ink }` RGB565 palette resolved from the theme. |
| `summary` | Whitespace-normalized session `label`; configured summaries accept at most 96 Unicode code points and replace invalid UTF-16 surrogates with U+FFFD. |
| `assignment` | `derived` until the first successful configure call, then `user`. |
| `configured_at` | `null` until configured, then the successful configuration time. |

The default pal is stable for the record's lifetime. The bridge hashes the
normalized `label`, a NUL separator, and `cwd` with UTF-8 FNV-1a, then probes
the catalog in order to avoid animals already used by automatic assignments.
Explicit choices are a softer constraint: the bridge avoids them while another
automatic slot is free, but the 18th automatic session may collide with an
explicit choice rather than duplicate an automatic assignment. Above 18, the
bridge deterministically reuses the least-used automatic assignment, using
explicit occupancy and hash order as tie-breaks. An explicit pal remains
authoritative and may intentionally collide with another session.

The six themes all use black background, white text, `0x8410` dim text, and
black ink. Their body colors are:

| Theme | RGB565 body |
| --- | --- |
| `classic` | `0xBD51` |
| `cyan` | `0x05D9` |
| `green` | `0x45CB` |
| `amber` | `0xD4A0` |
| `magenta` | `0xC254` |
| `white` | `0xBDF7` |

Configure a session through MCP:

```text
companion_session_configure({
  session_id,
  pal: "owl",
  theme: "cyan",
  colors: { body: 17867, bg: 0, text: 65535, text_dim: 33808, ink: 0 },
  summary: "reviewing the API"
})
```

The MCP tool and `POST /v1/session/configure` share the following request
contract:

- `session_id` is required and must identify a live, non-ended session. Both
  HTTP and MCP reject a whitespace-only value as `invalid_argument`.
- At least one of `pal`, `theme`, `colors`, or `summary` must be present.
- `pal` is `null` or one of `capybara`, `duck`, `goose`, `blob`, `cat`,
  `dragon`, `octopus`, `owl`, `penguin`, `turtle`, `snail`, `ghost`,
  `axolotl`, `cactus`, `robot`, `rabbit`, `mushroom`, and `chonk`.
- `theme` is `null` or one of the six theme names above.
- `colors` is `null` or a strict, complete object containing exactly `body`,
  `bg`, `text`, `text_dim`, and `ink`. Every value must be an integer from
  `0` through `65535`; partial palettes and unknown keys are rejected. V1
  requires `bg == 0`, text/background contrast of at least 4.5:1,
  dim-text/background contrast of at least 3:1, body contrast of at least 3:1
  against black and 1.4:1 against white, and ink/body contrast of at least 2:1.
- `summary` is `null` or a string of at most 96 Unicode code points after
  whitespace normalization. Isolated UTF-16 surrogates become U+FFFD before
  storage. The device projection applies a second UTF-8 limit of 48 bytes
  without splitting a code point.

**Omitted and `null` are different.** An omitted field stays unchanged.
Explicit `null` resets `pal` to its deterministic collision-aware default,
`theme` to `classic`, `colors` to the resulting theme palette, or `summary` to
the session label. Theme resolution happens before explicit colors, so a
request may select a theme and then replace it with a complete custom palette
atomically. Any successful call sets `assignment: "user"`, `configured_at`,
and `updated_at`.

Configuration is cosmetic and deliberately does **not** change `expires_at`.
Only `companion_state` renews the lease because a lifecycle report proves the
agent is still alive; repeated color or summary writes must not pin a stale
session on the device.

At most `COMPANION_SESSION_MAX` (default 64) records are tracked at once. When
that cap is reached a new `begin` sheds an existing record rather than failing:
ended records go first (they are terminal and only linger so a status reader can
see the outcome), then the **least-recently-updated** one. Notably *not* the one
closest to expiry — expiry distance is set by the caller's own `ttl_seconds`, so
that rule would let anything holding the maximum 1h lease outlive every
legitimate reporter on the 90s default. A lease says nothing about whether
anyone is still behind it; only a fresh `companion_state` does, so the sessions
that keep reporting are the sessions that keep their place.

### How explicit and passive state are combined

Passive telemetry reports bare counts with no per-session identity, so explicit
and passive records can't be correlated 1:1 — summing them would double-count
the common case (an agent that reports explicitly *and* shows up in the log).
Each count is therefore a union-by-maximum, so neither source can double-count
and neither can suppress the other's evidence:

| Wire field | Composed as |
| --- | --- |
| `total` | `max(passive total, live explicit sessions)` |
| `running` | `max(passive running, explicit thinking+working)` |
| `waiting` | `max(passive waiting, explicit waiting+blocked)` |

`msg` picks the highest-priority line available:

1. an active confirmation (`confirm on device`)
2. a transient `companion_notify` flash, while its few seconds hold
3. explicit `blocked` / `waiting` (its `message`, else `blocked` / `your turn`)
4. explicit `working` / `thinking` (its `message`, else `working...` / `thinking...`)
5. the passive line (`working...` / `idle` / `approval waiting`)

Within a tier the most recently updated session wins, then the lowest session
id. Selection is a pure function of the inputs, so the same state always renders
the same line (no flapping). Composition runs at send time, once a second, which
is also what makes lease expiry take effect without any extra timers.

Ended sessions stop counting immediately and linger ~10s in `companion_status`
so the outcome is observable, then vanish.

## HTTP mirror (for callers that don't speak MCP)

The `--mcp` listener also serves a small plain-HTTP API on the **same** port, so
a shell script, git hook, or CI step can drive the buddy without an MCP client —
and without a second daemon fighting over the BLE link. Loopback only, JSON
only; request bodies are capped at 64 KB. See *Who can reach this* below.

| Endpoint | Body | Returns |
| --- | --- | --- |
| `GET /healthz` | — | `{ ok, device_connected, sessions, pending_confirmations, default_ttl_seconds, usage_tracking }` |
| `POST /v1/session/begin` | `{ label, conversation_id?, cwd?, ttl_seconds? }` | the session record (incl. `session_id`; same live `conversation_id` is idempotent) |
| `POST /v1/session/configure` | `{ session_id, pal?, theme?, colors?, summary? }` | the updated session record |
| `POST /v1/state` | `{ session_id, state, message?, ttl_seconds? }` | the updated record |
| `POST /v1/task/complete` | `{ session_id, outcome? }` | the idle conversation record with the completed task outcome |
| `POST /v1/session/end` | `{ session_id, outcome?, message? }` | the ended record |
| `POST /v1/notify` | `{ message }` | `{ delivered, message }` |

```bash
SID=$(curl -s localhost:4317/v1/session/begin \
  -H 'content-type: application/json' \
  -d '{"label":"nightly build","conversation_id":"build-2026-09-16"}' | jq -r .session_id)
curl -s localhost:4317/v1/state -H 'content-type: application/json' \
  -d "{\"session_id\":\"$SID\",\"state\":\"working\"}"
curl -s localhost:4317/v1/session/configure \
  -H 'content-type: application/json' \
  -d "{\"session_id\":\"$SID\",\"pal\":\"owl\",\"theme\":\"cyan\",\"summary\":\"reviewing the API\"}"
curl -s localhost:4317/v1/session/configure \
  -H 'content-type: application/json' \
  -d "{\"session_id\":\"$SID\",\"pal\":null,\"theme\":null,\"colors\":null,\"summary\":null}"
curl -s localhost:4317/v1/task/complete -H 'content-type: application/json' \
  -d "{\"session_id\":\"$SID\",\"outcome\":\"success\"}"
```

The first configure call customizes selected fields. The second demonstrates
explicit reset semantics; omitting those fields instead would preserve the
custom values. Task completion leaves the conversation registered in idle. Use
`POST /v1/session/end` only when you intend to retire that conversation
permanently.

`content-type: application/json` is **required** on every POST — `curl -d`
defaults to form-urlencoded, which is refused with `415`. See
*Who can reach this* below for why.

Errors are JSON `{ error, message }`: `400 invalid_argument` / `invalid_body`,
`403 forbidden`, `404 unknown_session` (unknown, ended, or evicted) / `not_found`,
`405 method_not_allowed`, `413 payload_too_large`, `415
unsupported_media_type`. Bodies are capped at 64 KiB; an oversized one is
answered with a real `413` (the rest of the upload is drained and the
connection closed) rather than the socket being reset out from under you.
For configure specifically, invalid fields return `400 invalid_argument`, and
an unknown, ended, or capacity-evicted `session_id` returns
`404 unknown_session`. MCP
returns the same `error` values in a tool-error JSON payload.

`GET /healthz` also adds `projection_schema_version`,
`projection_max_sessions`, `live_sessions`, sorted `species_in_use`, and
`usage_tracking`.
`companion_status` adds the full `sessions` records plus `projection` with
`schema_version`, `max_sessions`, `live`, and sorted `species_in_use`; it also
adds `usage_tracking`. These fields are additive; existing health and status
consumers can ignore them.

### Who can reach this

A POST here mutates bridge state, and "loopback-only" is a weaker fence than it
sounds: a browser running on this machine is *also* a loopback peer, so a page
on any website can make it POST to `127.0.0.1:4317`, and a hostname rebound to
`127.0.0.1` reaches us the same way. Four checks close that off, and every one
of them lands before a single body byte is read — a refused request can never
create or touch a session:

| Check | Rule | On failure |
| --- | --- | --- |
| Peer address | Must be loopback (`127.0.0.0/8`, `::1`, `::ffff:127.x`). | `403 forbidden` |
| `Host` | Must be a loopback host (`localhost`, `127.x.y.z`, `[::1]`) **and** carry the port the bridge is listening on. Malformed values are rejected, not guessed at. | `403 forbidden` |
| `Origin` | Absent is fine (that's every CLI caller). If present it must be a loopback origin — any port, `http` or `https`. | `403 forbidden` |
| `Content-Type` | `application/json` on every POST; parameters such as `; charset=utf-8` are fine. | `415 unsupported_media_type` |

The `Host` check is what actually defeats DNS rebinding: a rebound `evil.com`
resolves to `127.0.0.1`, so the socket looks local, but the browser still sends
`Host: evil.com`.

The `Content-Type` check is what actually defeats cross-site POSTs: the only
types a browser may send cross-origin *without* a preflight are
form-urlencoded, multipart and `text/plain`, and the bridge answers no
preflight — so requiring JSON puts every mutating route out of a web page's
reach entirely.

**No CORS headers are ever emitted**, for any origin. That is deliberate: there
is no legitimate browser client for this API, so nothing should be granted read
access to a response. A `fetch()` from a page will therefore fail at the
browser even in the cases the bridge would have answered.

`/mcp` is gated identically (`Host`/`Origin`, plus the MCP SDK's own
`application/json` requirement and its `allowedHosts`/`allowedOrigins` DNS
rebinding protection as a second layer). Refusals there are returned as
JSON-RPC errors so an MCP client reports a protocol failure rather than
choking on an unexpected body.

`source` on `/v1/session/begin` is **stamped by the transport**, not read from
the body: an HTTP caller is always recorded as `http` and cannot pass itself
off as an MCP reporter.

`conversation_id` is caller-supplied identity, not provenance. It must be a
non-empty string of at most 128 characters. The bridge trims surrounding
whitespace and returns it on the session record for diagnostics.

There is deliberately **no plain-HTTP confirm endpoint**: a confirmation blocks
for up to ten minutes waiting on a physical button, and holding a bare HTTP
socket open that long invites proxy/keepalive truncation and silent double-asks.
Use MCP `companion_confirm`, which carries those semantics properly.

## Where the data comes from

Each wire field is composed from passive telemetry and (when present) explicitly
reported sessions — see *How explicit and passive state are combined* above.
The passive side is sourced as follows:

| Wire field | Source | Notes |
| --- | --- | --- |
| `total` | `session-store.db` — sessions with a turn in the last 5 min | "active" sessions; raised by live explicit sessions |
| `running` | open `--- ... Sending request to the AI model ---` groups in `logs/process-*.log` | counts in-flight model requests (stack-tracked **per log file**, summed across every tracked log, so two concurrent sessions read as two); short grace window; falls back to file-growth on older log formats; raised by explicit `thinking`/`working` |
| `waiting` | passively-detected permission prompts (`session-state/*/events.jsonl`) | also raised by explicit `waiting`/`blocked` and by a live `companion_confirm` |
| `completed` | newest turn finished within ~5s and not busy | drives the legacy task-completion presentation |
| `msg` | derived | see the msg priority list above |
| `entries` | the focused session's recent `turns`, plus its in-flight question from `session-state/*/events.jsonl` | `HH:MM <your message>`; always passive — see *Which conversation the screen shows* below |
| `tokens` | deltas from `assistant_usage_events`; process-log estimate on older CLIs | one bridge-lifetime cumulative counter for pet progression; source baselines and resets are not replayed |
| `tokens_used` / `tokens_max` | `CompactionProcessor: Utilization X% (used/total tokens)` log line | current context-window usage; may be absent |
| `model` | `Using default model: <m>` (and override lines) in the log | e.g. `claude-opus-4.8` |
| `effort` | `defaultReasoningEffort` / `reasoning_effort` log lines | **debug-level only**, so usually absent at the default INFO log level |
| `prompt` | `companion_confirm` (answerable) or a passively-detected Copilot prompt (acknowledge-only) | a confirmation outranks a passive prompt |
| `time` / owner | OS clock / `gh api user` → git config → OS user | sent once on connect |

Explicitly reported conversations also add the optional `sv` and `ss` device
projection. They are absent when no live sessions project, so the zero-session
heartbeat remains byte-identical to the legacy shape. Old firmware ignores the
unknown keys; see `../REFERENCE.md` for the row schema, ranking, and byte budget.

### Per-pal usage tracking

> ⚠️ **Experimental:** Current Copilot CLI builds persist privacy-minimal
> `assistant.usage` rows in the `assistant_usage_events` table inside
> `session-store.db`. The bridge reads this table without modifying it. The
> local schema can change, and the official accumulated
> `session.usage.getMetrics` API is still experimental.

The bridge aggregates every usage row by `session_id` and model. Root and
subagent calls already carry the top-level Copilot session ID, so they roll up
to one pal without creating child pals. Each `companion_status` session can
include:

- `api_calls`
- `input_tokens`
- `output_tokens`
- `cache_read_tokens`
- `cache_write_tokens`
- `reasoning_tokens`
- `total_nano_aiu`
- `updated_at`
- `latest_model`
- the same counters grouped under `models`

The device receives cumulative output tokens (`ss[].u`), cumulative input
tokens (`ss[].q`), the latest model (`ss[].d`), and model count (`ss[].v`).
Firmware uses output-token deltas to queue one heart animation per 100 new
tokens. First sight is a baseline, so reconnecting or restarting does not replay
historical hearts.

The optional context pair (`ss[].x`) is reserved for a positively
session-correlated source. Process logs carry no Copilot session ID, so the
current bridge omits `x` even when only one log is tracked; a sole stale or
unrelated log is still not proof of ownership. Firmware shows
`context unavailable` instead of attaching another conversation's context.

Per-pal attribution is an exact identity join:
`companion_session_begin.conversation_id` must be the real Copilot session UUID.
Do not derive it from `cwd`, repository, or label because several conversations
can share those values. If the ID does not match, the pal remains usable but its
`usage` field stays `null`.

`usage_tracking.available` reports whether the expected table and columns are
present. When they are unavailable, global output-token progression falls back
to process-log parsing and detailed per-pal usage remains unavailable. The
adapter probes again periodically so upgrading the CLI does not require
restarting the bridge.

**Stability checkpoint:** Pin and test the supported Copilot CLI version while
this adapter is in use. Reevaluate the integration when
`session.usage.getMetrics` becomes stable and externally consumable from the
normal interactive workflow. Remove or replace the table adapter only after
verifying parity for root calls, subagent calls, per-model totals, and restart
reconciliation.

### Which conversation the screen shows

The device shows a pal state *and* a block of transcript text. Both come from a
single **focused session** so they can never describe different conversations.

The focus is chosen from the session-state event stream — the only place a
Copilot session id is available at all (`process-*.log` carries no session id
and no cwd). Ranking, highest first:

| Rank | Condition | Reason reported |
| --- | --- | --- |
| 3 | blocked on a permission request | `requesting` |
| 2 | finished its response, waiting on you | `waiting` |
| 1 | a live question in flight, or activity in the last 60s | `prompt` / `active` |
| 0 | merely tracked | `tracked` |

Ties break on the newest semantic edge, then on session id, so the same inputs
always pick the same session.

**The live question.** `turns` rows are written when a turn *ends*, so a
transcript built only from completed turns is structurally one question behind —
while you wait on question N the screen still shows N-1. The bridge therefore
also reads the focused session's newest `user.message` event and splices it in
as the newest entry. When the completed row catches up, the two are matched
(same sanitized text, row timestamp at or after the prompt) and the provisional
copy is dropped, so nothing ever appears twice. Asking the same thing twice
still shows both — the older row predates the newer question.

Both sources are sanitized identically: injected `<system_reminder>` and
`<current_datetime>` wrappers are stripped and whitespace is collapsed before
anything is compared or displayed. Reads are bounded (256 KB per poll), so on a
very long-running session a restart may not recover a question already buried
under megabytes of tool output; everything appended from then on is captured
immediately.

**Timestamps.** The session store has shipped two formats — SQLite's
`datetime('now')` text (`2026-09-16 21:08:56`, implicitly UTC) and JavaScript
ISO-8601 (`2026-09-16T21:08:56.212Z`). Both are accepted, along with explicit
`±HH:MM` offsets. Window comparisons are done on integer epoch seconds computed
by SQLite, never lexically: `'T'` sorts after `' '`, so a text comparison reads
an ISO row from earlier the same day as "within the last five minutes".

`companion_status` reports the decision additively as `focus`
(`{session_id, source, turn_session, provisional, log_file, tracked_logs}`), or
`null` on a CLI with no session-state events. It is diagnostics only and is not
part of the wire snapshot.

## How it's wired

```
copilot/store.js   ┐
copilot/logtail.js ┼→ copilot/source.js ─model──┐
copilot/permwatch.js ┘                          ├→ bridge.js ─snapshot→ ble/central.js → device
simulate.js ───────────────────model────────────┘   ▲              (or transport/console.js)
                                                    │
mcp/server.js  (tools)  ┐                           │
http/api.js    (/v1/*)  ┴→ sessions/registry.js ────┘
http/guard.js  (gate)      sessions/compose.js
```

- `http/guard.js` is the single transport gate in front of *both* `/v1/*` and
  `/mcp`: loopback peer, loopback `Host` on the listening port, loopback-or-
  absent `Origin`, and the `application/json` requirement. It runs before any
  body is read, so nothing it refuses can reach the registry.
- `sessions/registry.js` holds the explicit conversation records and active-task
  leases; the bridge owns the single instance, and both the MCP tools and the
  HTTP mirror mutate it through `bridge.beginSession/updateSession/`
  `configureSession/completeTask/endSession`.
- `sessions/compose.js` merges the registry with the passive model into the
  model handed to `protocol/snapshot.js` (counts, `msg` priority, `prompt`).
- `protocol/snapshot.js` shapes a model into the exact wire object + size limits
  the firmware parses (`firmware/src/data.h`), and diffs snapshots so we only
  send on change (plus a ≤10s keepalive).
- `protocol/commands.js` builds the one-shot `time`/`owner` messages and the
  `status`/`name`/`unpair` commands; `bridge.js` handles the device's acks.
- `protocol/lineframer.js` reassembles MTU-fragmented notifications from the
  device into whole JSON lines.
- `ble/central.js` serializes chunked writes. It keeps command lines FIFO and
  intact, while replacing an unsent pending snapshot with the newest snapshot
  so fallback-MTU bursts cannot grow a backlog of stale device state.

## Caveats

- **Tokens are best-effort.** Parsed from the CLI's context-utilization log
  lines; absent until the first one is seen.
- **Live state is heuristic.** "Running" tracks open *"Sending request to the AI
  model"* log groups (accurate, and counts concurrent sub-agent requests), with
  a short grace window for tool-execution gaps; it falls back to file-growth only
  if a log predates those markers. It still can't attribute work to a *specific*
  session when several run at once.
- **`effort` needs debug logging.** Reasoning effort is only written at the CLI's
  debug log level, so on a normal INFO session the `effort` field is omitted.
- **Copilot's own approval prompts aren't answerable from the device.** They
  aren't hookable from outside the CLI, so the bridge only *detects* them
  passively (from `session-state/*/events.jsonl`) and lights the buddy up; the
  buttons just acknowledge on-device and the real answer happens in the
  terminal. To get questions the device can actually answer, run with `--mcp`
  and have the agent call `companion_confirm` (see the bidirectional section
  above and the repo `AGENTS.md`). Device decisions flow back as the tool result.
- **Explicit sessions are in-memory.** Restarting the bridge empties the
  registry; passive observation reconstructs activity within a tick or two.
- **Explicit and passive sessions can't be correlated.** The passive side has no
  per-session identity to match against, so counts are unioned by maximum (see
  above). If three conversation orchestrators report explicitly but the log
  only shows one busy session, `total` is 3 — not 4, and not 1.

## Smoke test (no hardware)

```bash
npm run dry-run        # see scripted snapshots on the console
COMPANION_LOG=debug node src/index.js --no-ble   # see snapshots from your real Copilot activity
```

The suite includes dedicated `session-projection`, `snapshot-budget`, and
`snapshot-backcompat` coverage for the additive roster and old-firmware path.


## Latched completion (bridge half implemented)

The bridge owns one volatile completion slot in
`src/sessions/completionLatch.js`, separate from `SessionRegistry`. Explicit
end captures the resolved pal metadata and duration before composing the
terminal update; passive turn completion can create an ownerless success slot
only on a newly observed completion edge. A random nonzero uint32 epoch is
created per bridge process, generation starts at 1, replacements increment it,
and uint32 overflow rotates the epoch and restarts generation. Nothing is
persisted.

For current Copilot CLI builds, `PermissionWatch` takes the completion edge
directly from the live `session.task_complete` event, so the celebration starts
when the task ends rather than when SQLite eventually publishes the turn row.
Startup-replayed events are ignored, and a session must first contain a
nondelegated human `user.message`, so a spawned agent cannot create a
user-facing completion card. `success:false` maps to the failed outcome.
The SQLite marker remains the fallback for older or incomplete event streams.

Every live event completion arms one bounded, per-session store-echo guard
(maximum 8 sessions). The next turn row observed for that Copilot session is
consumed as the delayed copy of the same completion instead of relatching the
card after the next prompt. Once consumed, a genuinely later row in that session
uses the normal fallback path.

The existing status poll is the negotiation point. A device status ack with
`data.cl:1` enables `sg` on every snapshot and optional `sc` for the live
slot. Before that ack, and again after disconnect, snapshots contain neither
field and retain the timed legacy `completed` behavior. The bridge therefore
also sends one `status` request inside the connect handshake, so the
legacy-shaped window after a reconnect is a round trip rather than a whole
`statusPollMs` interval; the periodic poll continues unchanged. The fake device
stays legacy by default; tests opt in with `{ completionLatch: true }`.

`sc` is `{g,o,i?,p?,c?,m?,d?}`: `g` is uint32 generation, `o` is
0/1/2 for success/failed/aborted, `i/p/c/m` are strictly all-or-none completed
pal metadata, and `d` is optional duration seconds. A device clears with
`{"cmd":"completion","sg":<epoch>,"g":<generation>,"action":"dismiss"}`;
only an exact live match succeeds. Absence of `sc` on a capable snapshot is
the authoritative clear.

Clear edges are successful new session begin, idle-to-active explicit lifecycle,
waiting/blocked-to-working/thinking resume, a new passive prompt/user/tool/AI
request identity that is undated or newer than the protected completion, or
exact dismissal. Configure, lease renewal, repeated state, model/token changes,
log growth, transcript reread, work already active at capture, and a newly
observed identity timestamped at or before the protected completion (replayed
history) do not clear. Closing notify text retains its existing priority and may
coexist with the latch in the same snapshot.

An explicit task completion also arms an echo guard, because the CLI writes the
turn row for the same task *after* `companion_task_complete` returns. The
following passive completion edge is that latch's own echo and is swallowed
instead of downgrading an owned failed/aborted card to an anonymous success one.
Guards are kept in a bounded FIFO (at most `MAX_EXPLICIT_ECHO_GUARDS`, 8) keyed
by the completing session — owner, latched generation, working directory, the
completion's own timestamp, and an `EXPLICIT_ECHO_WINDOW_MS` (30 s) expiry — so
concurrent task completions suppress one echo each and a later completion never
disarms an earlier session's guard.

Each edge consumes at most one guard, and only on **positive** correlation: an
exact Copilot session identity match (rank 2) or, when identity is unavailable
on one side, an exact working-directory match between two known directories
(rank 1). Known session-ID or cwd disagreements are not candidates, and neither
is an edge that shares no identifying information with a guard — an uncorrelated
guard can no longer swallow a completion that names a different conversation.
The oldest guard of the best tier wins, so A/B and B/A echo order give the same
result, and an unmatched edge consumes nothing and latches normally. Completion
edges taken from the event stream are enriched with the session's `cwd` from the
session store (never guessed), which is what makes the cwd tier usable at all.

An idle-to-active explicit cycle disarms only the prior guard owned by that
conversation. A passive prompt, user, or tool identity disarms only older guards
whose `conversation_id` matches its Copilot session ID. Timestamp alone is not
enough to remove another conversation's protection. An AI-request edge or other
identity without a session ID still clears the displayed card, but leaves guards
to their bounded expiry.

**Disarming and display are separate decisions.** Correlated disarming compares
an edge against each matching guard's own `completedAt`, so session A's
interaction at t=1500 still disarms A's guard from t=1000 even though session B
completed at t=2000. Consuming a correlated completion echo likewise happens
whether or not that completion ends up displayed. Only the "does this edge count
as an interaction and clear the card" question uses `_protectedCompletionAt()` —
the newest of the displayed card and every armed guard — so the bar does not
move when the device dismisses the card. The dismissed turn's late echo still
cannot reappear as a new anonymous card, and an old event replayed from a
session file the permission watch only just found remains history, not new work.
An identity with no timestamp also clears the displayed card but disarms no
guard. Individual guards lapse on expiry, and the oldest is evicted past the
cap, so protection remains bounded and a genuinely different completion still
latches normally.

Passive semantic edges are delivered **per session**. `PermissionWatch` queues
every newly observed prompt/user/tool identity in a bounded map keyed by session
and kind (`MAX_PENDING_EDGES`, 64) and `takeEdges()` drains it once per poll into
`model.edges` as `{kind, id, at, session}`. Two conversations that each ask a
question between polls therefore both reach the guards, instead of one
overwriting the other in a single global slot. `model.edgeIds` remains the older
level-triggered newest-per-kind map (it still carries the log tail's
`aiRequest`); the bridge processes the batch first and then the map, deduping by
identity, so an older source or test double keeps working unchanged.

Budgeting treats `sg/sc.g/sc.o` as required core. It first sheds `ss` tails
and entries, then optional duration and the all-or-none completed-pal tuple, then
legacy telemetry. Every step reserializes and remeasures; inability to retain
the required latch core below 4,095 non-newline bytes throws.

> **Firmware half shipped.** Current firmware advertises `cl:1` after implementing strict `sg`/`sc` parsing, the volatile mirror, outcome cards, exact dismissal with reconnect retry, priority arbitration, legacy fallback, and the rollover-safe 24-hour watchdog. Devices without that capability remain safely on the timed legacy path.

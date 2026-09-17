# Agent instructions for co-mpanion

co-mpanion is a desk-buddy (an M5Dial running the firmware in `firmware/`) plus a
Node bridge (`bridge/`) that streams GitHub Copilot CLI activity to it over BLE.
When the bridge runs with `--mcp`, it exposes tools you should use so the
physical buddy can show what's happening and ask the user real questions.

## Use the companion device

- **Before any risky or irreversible action, call `companion_confirm`** and respect
  the result. If it returns `denied`, do not perform the action. If it returns
  `unavailable` (no device connected) or `timeout`, fall back to your normal
  approval flow. Treat these as needing a hardware yes/no:
  - destructive git (`git push --force`, `git reset --hard`, branch/tag deletion,
    history rewrites), `rm -rf`, dropping/migrating databases, deploys/releases,
    OTA-flashing the device, or anything that's hard to undo.
  - Pass a short `title` (≤19 chars, e.g. the command) and a one-line `detail`.
- **The top-level session orchestrator owns exactly one pal per user
  conversation.** At the start of a non-trivial conversation, the orchestrator
  calls `companion_session_begin` once with a short `label`. If the host exposes a
  stable conversation ID, pass it as `conversation_id`; retries with that key
  refresh the existing pal instead of creating another. Never substitute `cwd`
  or `label` for a real conversation ID. The orchestrator then calls
  `companion_session_configure` with a brief
  `summary` (one short phrase describing the work). Keep that summary current at
  meaningful phase changes only — starting a real sub-task, switching files or
  areas, or entering review — not on every tool call or every few seconds. A
  natural cadence is roughly the same as a `companion_state` transition. The pal
  (animal) and color are assigned automatically; choosing either is optional and
  purely cosmetic. Configure does **not** renew the active-task lease, so
  continue to call `companion_state` whenever you change phase (`thinking`,
  `working`, `waiting`, `blocked`, `idle`) with an optional one-line `message`.
  An idle-to-active state starts the next task cycle. After **all** work for the
  current user request finishes, including delegated work, call
  `companion_task_complete` with its outcome (`success`, `failed`, `aborted`).
  That call shows the completion animation and returns the same conversation pal
  to idle for the next request. Call `companion_session_end` only when the
  conversation itself is permanently discarded; it retires the pal and does
  not celebrate. If active reports stop for about 90 seconds, the task lease
  expires to idle without deleting the conversation.
- **Subagents do not call the session lifecycle tools.** They report their
  findings and progress to the orchestrator; the orchestrator folds that work
  into the existing pal's summary and state. A subagent must not call
  `companion_session_begin`, configure a separate pal, complete the parent task,
  or end the parent session. Concurrent subagent model requests may raise
  passive activity counts, but they still belong to the same displayed session
  pal.
- **Use `companion_notify` for milestone pings** (≤23 chars) so the buddy reflects
  progress: "build passed", "tests green", "deploying…", "release cut".
- `companion_status` reports current session activity (running/idle, recent
  messages, explicitly-reported sessions, whether a device is connected) if you
  need to check state.

These tools are best-effort: if no device is connected they no-op gracefully, so
it is always safe to call them.

> This nudge only applies while working in this repo. To get device confirmations
> across all your sessions, copy the "Use the companion device" section into your
> global `~/.copilot/copilot-instructions.md`.

## Building & testing

- Firmware: `cd firmware && pio run` (build), `pio run -t upload` (USB flash),
  `./firmware/test/run-host-tests.sh` (host tests for the session-pal parser,
  UTF-8 clamps, text wrapper, selection tracker, and palette rules — no
  hardware needed). Regenerate the wire fixtures with
  `node firmware/test/fixtures/generate.js` after any protocol change.
- Bridge: `cd bridge && npm test` (MCP tools, session registry, confirmation
  queue, HTTP mirror, OTA round-trip, log/BLE parsers), `npm run dry-run`
  (print simulated wire snapshots, no hardware).
- See `README.md`, `bridge/README.md`, and `REFERENCE.md` for the wire protocol.

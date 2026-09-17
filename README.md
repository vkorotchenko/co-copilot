# co-mpanion

A tiny desk-buddy for **GitHub Copilot CLI** users. It mirrors the experience of
[`claude-desktop-buddy`](../claude-desktop-buddy): a small ESP32 pet (an
**M5Dial**) that wakes up when you're working, looks busy while sessions run, and
shows recent activity on its round screen.

The original buddy relies on the **Claude desktop app**, which natively scans
for the device over Bluetooth and streams session data to it. Copilot has no
such built-in bridge — so co-mpanion ships that piece itself.

```
┌────────────────────┐   reads    ┌──────────────────────┐   BLE / NUS   ┌────────────┐
│ GitHub Copilot CLI │ ─────────▶ │  co-mpanion bridge   │ ────JSON────▶ │  firmware  │
│  (~/.copilot/…)     │  store +   │  (Node.js, BLE       │  heartbeat    │ (M5Dial)   │
│                     │  logs      │   central)           │  snapshots    │            │
└────────────────────┘            └──────────────────────┘               └────────────┘
```

## Layout

| Path | What it is |
| --- | --- |
| `firmware/` | The ESP32 device firmware (forked from `claude-desktop-buddy`, rebranded for Copilot). Build with PlatformIO. |
| `bridge/` | **New.** A Node.js host app that acts as the BLE central, reads Copilot CLI state from `~/.copilot`, and streams it to the device. |
| `REFERENCE.md` | The BLE Nordic-UART wire protocol both sides speak, including co-mpanion extensions. |
| `Makefile` | Build / USB-upload / OTA-flash / cut a release. Run `make help`. |

## How it works

The device is a BLE **peripheral** advertising the Nordic UART Service. The
bridge is the BLE **central** — it scans for a device whose name starts with
`Copilot`, connects, and then streams newline-delimited JSON "heartbeat"
snapshots describing your Copilot activity (sessions running, recent messages,
busy/idle state). See `REFERENCE.md` for the full protocol.

The bridge sources data from the Copilot CLI's local state:

- `~/.copilot/session-store.db` — session history (counts, completed transcript).
  Current CLI builds also materialize official model-usage events here, which
  provide per-session input, output, cache, reasoning, API-call, and AI-unit
  totals.
- `~/.copilot/logs/process-*.log` — the live event stream (busy/turn signals).
  Every recently-written log is followed, so concurrent sessions each keep their
  own in-flight request state.
- `~/.copilot/session-state/<id>/events.jsonl` — permission prompts and the
  question currently being worked on. Completed turns are only written when a
  turn *ends*, so this is what lets the screen show the question you just asked
  instead of the previous one — and it supplies the session id that keeps the
  pal state and the transcript text on the same conversation.

When several Copilot sessions report explicitly, the bridge gives each one its
own pal, color theme, and one-line summary. Assignment is automatic, so no
configuration is required; their orchestrators can optionally customize the
presentation. A stable `conversation_id`, when available, makes repeated begin
calls idempotent. See `bridge/README.md` for configuration and `REFERENCE.md`
for the additive wire format.

### Current scope

- **Passive telemetry**: session counts, recent messages, busy/idle states,
  and cumulative token usage from the Copilot CLI's local state. Current CLI
  builds provide authoritative per-call usage; older builds fall back to
  best-effort log estimates.
- **Event-driven state**: each top-level session orchestrator (or a coordinating
  script using `curl`) reports one conversation lifecycle — `thinking` /
  `working` / `waiting` / `blocked` / `idle` — to the bridge, which shows it
  immediately instead of waiting for log scraping. Spawned agents report back
  to the orchestrator and do not create additional pals. Each report holds a
  short active-task lease, so a crashed reporter returns its conversation pal
  to idle rather than freezing the buddy on stale work. The orchestrator marks
  the current request complete only after all delegated work finishes; that
  completion celebrates without ending the long-lived conversation.
- **Approve/deny from the device**: working, via the MCP `companion_confirm`
  tool. The agent asks, the device shows the question, and the physical A/B
  button press comes back as the tool result. Simultaneous questions queue and
  are asked one at a time. (What is *not* possible is intercepting Copilot's
  own built-in permission prompts — those aren't externally hookable, so the
  bridge only detects them passively and lights up the buddy.)
- **`--simulate` mode**: stream fake snapshots to bring up / test a device
  without any real Copilot activity.

## Quick start

### 1. Flash the firmware

```bash
cd firmware
pio run -t upload
```

The firmware targets the **M5Dial** (`board = m5stack-stamps3`, ESP32-S3). The
platform is pinned to `espressif32@6.9.0` and the libraries are M5Dial /
M5Unified / M5GFX. It builds with the bundled **dual-bank** `partitions_ota_8mb.csv`
(two ~1.94MB app slots for OTA + ~4MB LittleFS for GIF character packs).

#### Updating over the air (OTA)

Once the dual-bank firmware is on the device, you can update it over BLE instead
of USB. The simplest path is the Makefile:

```bash
make flash                      # build + OTA-flash the local firmware over BLE
# or push a published release to the device:
make flash-release VERSION=0.2.0
```

Under the hood that builds `firmware.bin` and runs
`bridge → npm run flash -- <bin>`; the bridge scans for the device, streams the
image into the *other* app slot, and the device verifies an MD5 and reboots into
it. A full image is ~1.2MB and takes a few minutes over BLE.

- **One-time USB step:** the dual-bank partition table is a flash-layout change,
  so the *first* time you must flash over USB (`make upload`). Every update after
  that can be OTA.
- **Integrity:** the MD5 is checked before the boot partition is switched, so a
  corrupted transfer is never booted; the link is already encrypted. Signed
  firmware / bootloader rollback are out of scope — see `REFERENCE.md`.
- The running version is reported in the `status` ack (`data.fw`).

#### Cutting a release

Releases are tag-driven. The Makefile bumps the version, tags, and pushes; a
GitHub Actions workflow then builds the firmware and publishes the `.bin` +
SHA256 to a GitHub Release (with the tag version baked into `FW_VERSION`).

```bash
make release-firmware-patch     # firmware-vX.Y.(Z+1)
make release-firmware-minor     # firmware-vX.(Y+1).0
make release-firmware-major     # firmware-v(X+1).0.0
```

(`make help` lists every target. Local dev builds report `FW_VERSION=dev`; only
release builds carry a real version.)

#### Controls (M5Dial)

The M5Dial has a round touchscreen, a rotary dial, and one button (on the
bezel). There is **no IMU**, so the Stick's shake/face-down gestures are gone.

| Input | Action |
| --- | --- |
| **Rotate dial** | browse session pals on the home card; scroll or navigate a secondary screen; on a prompt, pick approve versus deny |
| **Spin fast** | jump three pals along the carousel; on secondary screens, the buddy gets dizzy (replaces "shake") |
| **Press button** | open or close the selected pal's stats; return from a secondary screen; confirm a menu item; answer a prompt; or dismiss a visible completion card |
| **Hold button** | open or close the menu for activity, pet care, info, settings, demo, and power |
| **Touch** | tap the visible completion outcome pill to dismiss; tap **approve**/**deny** on a prompt; tap anywhere to wake |

The pal carousel is the primary surface. Short presses no longer cycle through
unrelated pages: press a pal to see its stats, then press again to return. Hold
the button to open the menu when you want the transcript, pet-care page,
device information, or settings.

Under **settings → attitude**, choose how successful task completion is
presented. **Kind** is the default and keeps the celebration animation.
**Assertive** skips the celebration and has the completed pal display
`GET BACK TO WORK!!`. Failed and aborted completion cards are unchanged.

#### Session pals

When top-level session orchestrators report their conversations (via
`companion_session_begin` and friends), the bridge sends up to eight of them and
home becomes a **pal card**: one animal per user conversation, each with its own
colour, one-line summary, and lifecycle state. Spawned agents do not create
their own pals; their work is summarized by the parent orchestrator.

- **One session** — just that pal and its summary, no carousel chrome.
- **Two to eight** — rotate to browse. A `2/5` counter and a row of body-colour
  dots show where you are; the selected dot is ringed in white, and any pal
  waiting on you is ringed in red so you can see it while looking at another.
- A red circled number at the top right shows how many projected pals are
  currently `waiting` or `blocked`, including while you browse another pal or
  its stats.
- Each pal animates its **own** state (thinking/working → busy, waiting/blocked
  → attention), not a blended average.
- Press the selected pal to open its stats: cumulative input and output tokens,
  the most recently used model, how many models contributed, and a reserved
  context progress area.
- **Demo** opens a stable five-pal roster and returns directly to the home card.
  Rotate the encoder to browse those pals and press to inspect their fake stats,
  using the same carousel path as live sessions. Every five seconds all five
  pals switch together through idle, thinking, working, waiting, blocked, Kind
  celebration, and Assertive `GET BACK TO WORK!!` phases. The bottom state
  label and animation are driven by that same global demo state.
- Every 100 new output tokens queues one heart animation for that pal. The first
  reading after a device or bridge restart establishes a baseline, so historical
  tokens do not replay as a burst of hearts.
- Root and subagent calls count toward the same top-level pal.
- A session that newly starts waiting or blocking pulls focus — unless you
  turned the dial in the last 15 seconds, in which case browsing wins.
- Approval prompts, pairing passkeys, and OTA updates still take over the whole
  screen and override the carousel.
- The pal is drawn in ASCII while the card is up, even if you have a GIF
  character installed; a GIF cannot be the species the bridge assigned. Your own
  pet choice is untouched and comes back on the other screens.

The screen powers off after 30s idle on battery (kept on while charging or when
a prompt is up); any input wakes it. "Attention" pulses a red ring at the
screen edge (there's no separate LED) plus a periodic chirp. The chirp fires for
*any* waiting session, so a pal you are not currently looking at still gets your
attention.

> Completed tasks remain visible until acknowledged. In the default Kind attitude, success runs one 5.6-second celebrate/confetti cycle and then freezes in its final pose. In Assertive attitude, success instead shows the completed pal with `GET BACK TO WORK!!`. Failed and aborted outcomes use short quiet transitions and still terminal cards. Approval prompts, blocked/waiting attention, pairing, and OTA always hide (but do not dismiss) the completion card. A short button click or a tap on the visible outcome pill clears it; rotation and long-press never do. The first gesture from a dark screen only wakes it.

> Migrating from the M5StickC Plus version? It lives in git history before the
> M5Dial migration commit.

### 2. Install the bridge + MCP (one command)

```bash
make install
```

This is the whole "clone → install → use" path. It:

1. installs the bridge's Node dependencies (`npm install`),
2. registers co-mpanion in `~/.copilot/mcp-config.json` as an **HTTP** MCP server
   (merging with any servers you already have), and
3. installs a small **background service** that keeps one bridge running and
   owns the device across every Copilot session and reboots — **launchd** on
   macOS, **systemd `--user`** on Linux.

Then **restart any running Copilot session** so it picks up the new MCP config,
and you're done — the buddy wakes up when you work, the session orchestrator can
report the conversation via `companion_session_begin` / `companion_state`, and
it can push questions to the device via `companion_confirm`.

On macOS the first run prompts for Bluetooth permission; grant it.

```bash
make service-restart   # restart the background bridge
make service-logs      # tail its logs
make uninstall         # stop + remove the service and MCP entry
```

> **Why a background service?** A single Copilot session can run several
> processes (the interactive shell, agent subprocesses, sub-agents), and the
> device accepts only one BLE connection. One long-lived bridge owning the link
> — rather than each process spawning its own and fighting over it — is what
> makes prompts reliably reach the device. See `bridge/README.md` for the
> transport details and a manual/advanced setup.

#### Reporting state from a script

The same bridge process also serves a small localhost HTTP mirror, so anything
that can `curl` — a git hook, a CI step, a non-Copilot agent — can drive the
buddy without speaking MCP:

The `POST` bodies below all need `-H 'content-type: application/json'` (and the
listener refuses anything that isn't a loopback caller on the expected port —
see `bridge/README.md` for the full rules):

```bash
SID=$(curl -s localhost:4317/v1/session/begin \
  -H 'content-type: application/json' \
  -d '{"label":"nightly build","conversation_id":"build-2026-09-16"}' | jq -r .session_id)
curl -s localhost:4317/v1/state -H 'content-type: application/json' \
  -d "{\"session_id\":\"$SID\",\"state\":\"working\"}"
curl -s localhost:4317/v1/task/complete -H 'content-type: application/json' \
  -d "{\"session_id\":\"$SID\",\"outcome\":\"success\"}"
```

See `bridge/README.md` for the full endpoint list.

#### Test without the full setup

```bash
cd bridge
npm install
npm run dry-run    # print scripted snapshots to the console (no Bluetooth)
npm run simulate   # stream scripted activity to a real device
npm start          # stream your live Copilot activity (passive telemetry only)
```

## Status & caveats

co-mpanion is a maker/hobby tool, not an official GitHub product.

> ⚠️ **Experimental usage integration:** The bridge currently reads the
> Copilot CLI's `assistant_usage_events` materialization in
> `session-store.db`. The rows originate from official `assistant.usage`
> telemetry, but the local table is not a stable public storage contract and
> `session.usage.getMetrics` remains experimental. Pin and verify compatible
> Copilot CLI behavior. Revisit this adapter when `session.usage.getMetrics`
> becomes stable and can be consumed from the normal interactive workflow;
> replace the table reader only after root and subagent totals match.

- Per-pal usage requires `companion_session_begin.conversation_id` to be the
  real Copilot session UUID. Labels and working directories are not identity
  substitutes.
- Older CLIs without the structured usage table continue to use best-effort
  output-token estimates from process logs. Detailed per-pal usage is
  unavailable in that fallback mode.
- The context progress bar currently shows `context unavailable`. Process logs
  do not contain a Copilot session ID, so the bridge cannot attach their
  used/max value to a pal safely. The wire and firmware accept an exact-session
  context pair for a future positively correlated source; they do not guess
  from one convenient or recently modified log.
- Passive "busy/idle" state is parsed from a **human-readable log**, not a stable
  API — it may need tweaks across Copilot CLI versions. Session orchestrators
  that report state explicitly don't depend on that parsing, but the passive
  path stays on as coverage for everything that doesn't.
- Explicit conversations live **in memory only**. Task completion keeps their
  pals idle and reusable, but restarting the bridge clears the registry;
  passive observation reconstructs activity within a tick or two.
- Latched completion is implemented end to end. Firmware advertises `cl:1`, strictly mirrors the bridge `sg`/`sc` slot, preserves completed-pal metadata after the live row disappears, retries an undelivered dismissal after reconnect, and clears defensively after 24 hours. Legacy bridges still use a rising-edge `completed` fallback.

## License

See `LICENSE`. Firmware is derived from `claude-desktop-buddy`.

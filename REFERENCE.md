# Hardware Buddy BLE Protocol

This is the wire protocol the Claude desktop apps speak over Bluetooth LE.
You don't need anything from this repository to implement it. Any device
that can advertise the Nordic UART Service and parse newline-delimited JSON
will work: Arduino, ESP32, nRF52, a Raspberry Pi with a BLE dongle.

## Enabling the bridge

The BLE bridge is off by default. In Claude for macOS or Windows:

1. **Help → Troubleshooting → Enable Developer Mode** — adds a **Developer**
   menu to the menu bar.
2. **Developer → Open Hardware Buddy…** — opens the pairing window.
3. Click **Connect** and pick your device from the scan list. The OS will
   prompt for Bluetooth permission on first use.

Once paired the bridge auto-reconnects in the background; you only need the
window open for initial pairing, the stats panel, or the folder drop target.

## Transport

**BLE Nordic UART Service** (the de-facto serial-over-BLE standard):

|                               | UUID                                   |
| ----------------------------- | -------------------------------------- |
| Service                       | `6e400001-b5a3-f393-e0a9-e50e24dcca9e` |
| RX (desktop → device, write)  | `6e400002-b5a3-f393-e0a9-e50e24dcca9e` |
| TX (device → desktop, notify) | `6e400003-b5a3-f393-e0a9-e50e24dcca9e` |

Advertise a name starting with `Claude` over the Nordic UART Service so the
device picker can filter to you. Appending a few bytes of your BT MAC keeps
multiple devices distinguishable in the picker.

Everything on the wire is UTF-8 JSON—one object per line, terminated with
`\n`. The desktop reassembles multi-packet lines on its end (notifications
fragment at the MTU boundary, just send the bytes). Your device needs to do
the same: accumulate bytes until you see `\n`, then parse.

## Heartbeat snapshot

The desktop apps send a heartbeat snapshot whenever something changes, plus
a keepalive every 10 seconds:

```json
{
  "total": 3,
  "running": 1,
  "waiting": 1,
  "msg": "approve: Bash",
  "entries": ["10:39 reading file...", "10:41 yarn test", "10:42 git push"],
  "tokens": 184502,
  "tokens_today": 31200,
  "prompt": {
    "id": "req_abc123",
    "tool": "Bash",
    "hint": "rm -rf /tmp/foo"
  }
}
```

| Field          | Meaning                                                                           |
| -------------- | --------------------------------------------------------------------------------- |
| `total`        | Count of all sessions                                                             |
| `running`      | Sessions actively generating                                                      |
| `waiting`      | Sessions blocked on a permission prompt                                           |
| `msg`          | One-line summary suitable for a small display                                     |
| `entries`      | Recent transcript lines, oldest first; the last element is newest (capped to a few) |
| `tokens`       | Cumulative output-token progress since the bridge started                         |
| `tokens_today` | Output tokens since local midnight (persisted, survives restart)                  |
| `prompt`       | Only present when a permission decision is needed. The `id` is what you echo back |

A few useful derived signals: `running > 0` means at least one session is
actively generating, `waiting > 0` means a permission prompt is blocking,
and `total == 0` means nothing is open. `tokens_today` resets at local
midnight if you want a daily counter.

If you don't receive a snapshot for ~30 seconds, treat the connection as
dead.

### Session-detail fields (co-copilot addition)

> These optional fields are **not** part of the base Claude protocol — the
> co-copilot bridge adds them so the device can show what the live session is
> using. Treat them as optional and tolerate their absence.

| Field         | Meaning                                                              |
| ------------- | ------------------------------------------------------------------- |
| `model`       | Active AI model name, e.g. `"claude-opus-4.8"` (≤23 chars shown)     |
| `effort`      | Reasoning effort, e.g. `"medium"` (best-effort; may be absent)       |
| `tokens_used` | Context-window tokens currently in use for the live session         |
| `tokens_max`  | Context-window size, so a device can show `used/max`                 |

`effort` is only emitted when the CLI logs it (debug-level), so it is often
absent; render the model/tokens without it in that case.

### Session projection (co-copilot addition)

The co-copilot bridge can add `sv` and `ss` to the heartbeat. Both fields are
optional and additive. When there are no live projected sessions, **both keys
are absent**, not an empty `ss` array, so the serialized legacy heartbeat is
byte-identical.

| Field | Type | Meaning |
| --- | --- | --- |
| `sv` | integer | Session-projection schema version. The current value is `1`. |
| `ss` | array | Ranked live session rows, bounded by `COMPANION_DEVICE_PROJECTION_MAX` and never more than eight. Ended sessions never appear. |

Each `ss` row contains exactly these compact keys:

| Key | Type, range, and limit | Meaning |
| --- | --- | --- |
| `i` | string, exactly 12 lowercase hexadecimal characters | SHA-256-derived 48-bit display identity. The bridge detects collisions within the selected set and deterministically derives a replacement. |
| `p` | uint8, `0..17` | Index in the canonical species catalog: `capybara`, `duck`, `goose`, `blob`, `cat`, `dragon`, `octopus`, `owl`, `penguin`, `turtle`, `snail`, `ghost`, `axolotl`, `cactus`, `robot`, `rabbit`, `mushroom`, `chonk`. |
| `c` | array of exactly five uint16 values, each `0..65535` | RGB565 colors in `[body, bg, text, textDim, ink]` order. This is the exact field order of the firmware `Palette` struct. |
| `s` | uint8, `0..4` | Lifecycle state code from the table below. |
| `m` | valid UTF-8 string, at most 48 encoded bytes | One-line session summary, truncated without splitting a Unicode code point. |
| `u` | optional uint32, `0..4294967294` | Cumulative output tokens for the Copilot session. `4294967295` is reserved as the firmware's unknown sentinel and is never emitted. |
| `q` | optional uint32, `0..4294967294` | Cumulative input tokens for the Copilot session. |
| `d` | optional string, at most 23 characters | Most recently used model from official per-session usage. |
| `v` | optional uint8 | Number of models represented in the per-session usage totals. |
| `x` | optional array of two uint32 values | Reserved context-window `[used,max]` from a positively session-correlated source. The current bridge does not emit it because process logs carry no session ID. |

`u`, `q`, `d`, and `v` are sourced from the CLI's experimental
`assistant_usage_events` materialization. They include root and subagent model
calls that share the same top-level Copilot session ID. The bridge joins usage
to a pal only when `conversation_id` is that exact session UUID; it never
guesses from a label or working directory. The current bridge omits `x` rather
than attaching an independently selected process log to the focused session.
Old firmware ignores these keys, and new firmware treats missing values as
unknown.

The wire state codes increase from idle to blocked:

| `s` | State |
| --- | --- |
| `0` | `idle` |
| `1` | `thinking` |
| `2` | `working` |
| `3` | `waiting` |
| `4` | `blocked` |

**Do not sort by the numeric codes in ascending order.** Projection ranking is
the deliberate inverse: `blocked`, `waiting`, `working`, `thinking`, `idle`.
Within the same state, the newest `updated_at` sorts first, then the oldest
`created_at`, then ascending full `session_id`. This inverse relationship is
easy to implement backwards in firmware: code `4` is the first-ranked state,
not the last.

A realistic compact heartbeat line is:

```json
{"total":3,"running":1,"waiting":1,"completed":false,"msg":"need review","entries":["13:34 run bridge tests"],"model":"gpt-5.6-sol","sv":1,"ss":[{"i":"4a095d98cbba","p":7,"c":[1497,0,65535,33808,0],"s":4,"m":"Reviewing the BLE protocol","u":184502,"q":921400,"d":"gpt-5.6-sol","v":2,"x":[58817,168000]},{"i":"40f80aa49ba7","p":14,"c":[17867,0,65535,33808,0],"s":2,"m":"Running bridge tests","u":9217,"q":48120,"d":"gpt-5.4-mini","v":1}]}
```

### Latched completion extension

The bridge keeps one volatile completion record outside the session registry. It
does not consume registry capacity, participate in TTL/eviction, enter `ss`, or
keep a task active. `companion_task_complete` captures the completed pal in this
slot and returns its long-lived conversation record to idle; permanently ending
the conversation does not create a completion. The device must first advertise
support by returning `data.cl:1` in the existing `status` ack. Until that exact
capability is observed on the current connection, the bridge sends the legacy
timed `completed` pulse and never sends `sg` or `sc`. Capability knowledge
resets on disconnect or when a new peripheral connects, so the bridge asks for
`status` once inside the connect handshake — not only on the periodic poll —
and the legacy-shaped window after a reconnect is one round trip rather than a
whole poll interval.

Once `cl:1` is known, every heartbeat includes `sg`, a random nonzero uint32
process epoch. If a completion is latched it also includes `sc`:

```json
{"sg":305419896,"sc":{"g":7,"o":0,"i":"4a095d98cbba","p":7,"c":[1497,0,65535,33808,0],"m":"Bridge tests passed","d":42}}
```

| Key | Type | Meaning |
| --- | --- | --- |
| `sg` | nonzero uint32 | Bridge-process epoch. Stable for the process; regenerated only if generation overflows. |
| `sc.g` | uint32 | Monotonic completion generation, starting at 1. A new completion replaces the previous slot and increments it. |
| `sc.o` | uint8 | Outcome: `0` success, `1` failed, `2` aborted. |
| `sc.i/p/c/m` | optional all-or-none tuple | Completed display identity, species index, five-color palette, and UTF-8 summary (48 bytes maximum). |
| `sc.d` | optional uint32 | Completed duration in whole seconds. |

An ownerless passive completion carries only `g/o`. Current clients source the
edge from the live `session.task_complete` event, which arrives at the actual
task boundary; `success:false` maps to failed. The watcher ignores startup
history and sessions that have never seen a nondelegated human `user.message`,
so child-agent completion events do not reach the display. SQLite turn rows
remain the fallback for older or incomplete event streams.

A live event completion also arms one bounded, per-session store-echo guard
(maximum 8). The next row observed for that session is the delayed persistence
of the same turn and is consumed without creating another card; a later
different row completes normally. Historical events and rows never create a
startup latch. Absence of `sc` while `sg` is present is the authoritative clear.
The latch and echo guards are memory-only and disappear on bridge restart.

A capable device dismisses the current slot with an exact command:

```json
{"cmd":"completion","sg":305419896,"g":7,"action":"dismiss"}
```

Both numbers must exactly match the live latch. Malformed, stale, duplicate, or
wrong-action commands are ignored without error.

| Clears before the next snapshot | Does not clear |
| --- | --- |
| Genuinely new explicit `session_begin` | Idempotent `session_begin` retry for the same live `conversation_id`; `session_configure` |
| Explicit idle-to-thinking/working/waiting/blocked | Repeated report of the same explicit state |
| Explicit waiting/blocked-to-thinking/working resume | Working/thinking phase changes within an already-active cycle |
| New passive prompt ID or user-message ID | Lease renewal / keepalive |
| New passive tool-execution-start ID | Token, model, or effort changes |
| New AI-request opening identity | Log growth or transcript reread alone |
| Exact epoch+generation dismiss | Unrelated work already active when completion was captured |
| (each of the passive identities above only when undated or newer than the protected completion) | A newly observed identity timestamped at or before the protected completion (replayed history) |

An explicit `companion_task_complete` latches its completion before the CLI
writes the turn row for the same task, so that row's completion edge always
arrives afterwards and with a newer timestamp. Every explicit task completion
therefore arms an echo guard, and each guard swallows exactly one later passive
completion. The guards live in a bounded FIFO (at most 8) keyed by the
completing session — owner, the generation it latched, its working directory,
and a 30-second expiry — so concurrent completions each protect their own echo:
two task completions swallow two echoes, one apiece, and a later completion
never disarms an earlier session's pending guard.

An incoming passive completion edge consumes at most one guard, and only on
**positive** correlation: an exact Copilot session identity match, or — when
identity is unavailable on one side — an exact working-directory match between
two *known* directories. Known session-ID or cwd disagreements are not
candidates, and an edge and guard that share no identifying information are not
correlated at all, so an uncorrelated guard can never swallow a completion that
names a different conversation. Within a tier the oldest armed guard wins. Echo
order therefore does not matter: A/B and B/A consume one guard each and leave
the newest explicit card — outcome, pal, duration and generation — untouched. An
unmatched edge consumes nothing and latches normally. Completion edges read from
the event stream are enriched with that session's `cwd` from the session store
(looked up, never guessed) so the directory tier has something real to match.

An idle-to-active explicit cycle disarms only the prior guard owned by that
conversation. A passive prompt, user, or tool identity disarms only older guards
whose `conversation_id` matches its Copilot session ID. Timestamp alone cannot
remove another conversation's protection. An AI-request edge or other identity
without a session ID still clears the displayed card, but leaves guards to
their bounded expiry.

Disarming is judged per guard, not against a global watermark: a correlated
interaction is compared with each matching guard's own completion timestamp, so
session A's interaction at t=1500 disarms A's guard armed at t=1000 even when
session B completed at t=2000. For the same reason a correlated completion echo
is consumed whether or not that completion is ultimately displayed — an
unrelated newer interaction may suppress the card, but the guard is still spent.

Semantic edges are carried **per session**. The permission watch queues every
newly observed prompt/user/tool identity per session and kind in a bounded map
(64 entries) and drains it once per poll into the activity model's `edges` array
of `{kind, id, at, session}`; the older newest-per-kind `edgeIds` map is still
published (and still carries the log tail's `aiRequest`) for backward
compatibility. Concurrent conversations that each produce the same kind of edge
between polls both reach the guards instead of overwriting one another.

"Still being protected" — used only to decide whether an edge counts as an
interaction and clears the *displayed* card — is the newest of the displayed
card *and* every armed guard, each guard carrying the timestamp of the
completion it is holding an echo for, so a device dismissal cannot lower that
floor. A dismissal clears the displayed card only:
the dismissed turn is still finished, so its still-pending echo is still
swallowed instead of reappearing a second later as an anonymous success card
with a new generation, and a stale identity replayed out of a session file that
the permission watch only just discovered is recognised as history rather than
new work. An edge with no timestamp orders against nothing: it still clears the
displayed card but disarms no guard. Individually guards lapse when the 30-second window expires,
and the FIFO evicts its oldest entry once more than 8 task completions are
outstanding, so the protection floor decays with them and no session is retained
indefinitely. A second turn row with no interaction in between, a row past the
window, and a row from an unmatched directory are all treated as genuinely new
work and latch normally.

the dismissed turn is still finished, so its still-pending echo is still
swallowed instead of reappearing a second later as an anonymous success card
with a new generation, and a stale identity replayed out of a session file that
the permission watch only just discovered is recognised as history rather than
new work. An edge with no timestamp orders against nothing: it still clears the
displayed card but disarms no guard. Individually guards lapse when the 30-second window expires,
and the FIFO evicts its oldest entry once more than 8 task completions are
outstanding, so the protection floor decays with them and no session is retained
indefinitely. A second turn row with no interaction in between, a row past the
window, and a row from an unmatched directory are all treated as genuinely new
work and latch normally.

Waiting, blocked, and live prompt presentation retain their existing priority
above completion. If a later `companion_session_end` supplies a closing message,
that transient `msg` can coexist with an already latched task-completion slot;
the message wins the text line while the completion remains latched underneath.
Session end never creates a new latch.

Firmware advertises `cl:1` only because the full path is implemented. The parser validates `sg` and the complete `sc` object before committing; `i/p/c/m` are all-or-none, malformed same-epoch slots leave the current card untouched, an epoch change clears first, missing `sc` clears authoritatively, and older or locally dismissed generations cannot reappear. The fixed completion slot is 88 bytes or less and is volatile only.

On disconnect the visible mirror clears, while the epoch/generation floor and any unsent dismissal remain in RAM. Reconnect with the same live slot restores the card without replaying an already consumed introduction; a locally dismissed generation stays suppressed and its exact command is retried if the prior BLE write could not be delivered. Unsigned elapsed arithmetic enforces a 24-hour defensive clear across `millis()` rollover.

Legacy snapshots without `sg` are primed on first observation so historical `completed:true` does not celebrate at connect. A later rising edge latches an ownerless neutral `FINISHED` card. A new prompt, a running edge, or a newly thinking/working projected row clears that fallback; keepalives and row reorder do not.

The legacy path is authoritative only while the device has never seen a modern epoch on this boot. Once `sg` has been observed, a snapshot without `sg` is read as a capability gap (a reconnect before the `cl:1` ack lands), not as a downgrade: the pulse is shadowed so its rising edge cannot be replayed later, and the latch, epoch, generation floor, suppression floor, and pending dismissal are left untouched. The same epoch and generation returning after the gap restores the original owner and outcome without replaying the introduction; a bridge that no longer holds a completion clears it authoritatively by omitting `sc`. A card that the bridge cannot acknowledge — a generation-0 legacy card under a known-modern epoch — is dismissed by raising the local suppression floor instead of queueing an unanswerable `dismiss`, so it can never reappear on the next snapshot. A genuinely old bridge (no modern epoch seen since boot) keeps the full legacy behaviour, including local dismissal and new-work clears.

### How the co-copilot bridge fills these fields

The bridge preserves the aggregate heartbeat fields and may add the optional
session projection above. It composes each snapshot from two evidence sources
and sends the result on the normal change/keepalive schedule:

- **Passive observation** — Copilot CLI session store, live process logs, and
  session-state events. Always on; the only source for `entries`, `tokens*`,
  `model`, `effort`, and `completed`. `entries` and the passive state are scoped
  to one **focused session** (chosen from the session-state events) so the pal
  and the text always describe the same conversation, and the focused session's
  in-flight `user.message` is spliced in as the newest entry until its completed
  `turns` row catches up — otherwise the transcript is always one question
  behind. See `bridge/README.md` → *Which conversation the screen shows*.
- **Explicit session events** — top-level orchestrators reporting one lifecycle
  per user conversation (`thinking`, `working`, `waiting`, `blocked`, `idle`)
  through the bridge's MCP tools or its localhost HTTP mirror. Spawned agents
  defer to the orchestrator instead of creating their own pals. Each report
  holds an active-task lease (default 90s); when the lease lapses, the
  conversation returns to idle without losing its pal or configuration. The
  orchestrator calls `companion_task_complete` only after the current request
  and all delegated work finish. An optional stable `conversation_id` makes
  repeated begin calls for the same live conversation idempotent; it is
  bridge-local metadata and is not sent to the device. A state report's
  `message` is ambient text for the current task cycle only: it is cleared when
  the cycle ends (completion or a direct active-to-idle abandonment) and when
  the next idle-to-active transition opens a new cycle, unless that transition
  supplies its own message.

`total`, `running`, and `waiting` are the union-by-maximum of the two sources
(they can't be correlated 1:1, and summing would double-count), with `total`
floored at `max(running, waiting)` so a count is never smaller than the sessions
it is meant to contain. `msg` follows a fixed priority: active confirmation →
transient notify flash → explicit `blocked`/`waiting` → explicit
`working`/`thinking` → passive line. `prompt`
carries an answerable `companion_confirm` question if one is on screen,
otherwise a passively-detected Copilot prompt.

An old device implementation needs to know none of this: it ignores unknown
top-level keys and keeps using the aggregate fields. See `bridge/README.md` for
the registry, assignment, and configuration rules.

### Field caps and byte budget

The bridge clamps legacy strings to the firmware's fixed-width storage before
serialization:

| Field | Bridge cap | Firmware storage |
| --- | --- | --- |
| `msg` | 23 characters | `char[24]` |
| each `entries` row | 159 characters; at most 8 rows | `char[8][160]` |
| `model` | 23 characters | `char[24]` |
| `effort` | 9 characters | `char[10]` |
| `prompt.id` | **39 characters** | `char[40]` |
| `prompt.tool` | 19 characters | `char[20]` |
| `prompt.hint` | 43 characters | `char[44]` |
| `total`, `running`, `waiting` | `0..255` | `uint8_t` |

The explicit `prompt.id` cap is part of the compatibility contract: the bridge
never sends more than the firmware's 39 usable characters.

Firmware keeps each USB and BLE line in a separate 4,096-byte buffer, leaving a
hard ceiling of **4,095 non-newline bytes**. The bridge uses a stricter internal
target of **3,000 non-newline bytes**. Both measurements use encoded UTF-8 bytes
from the complete, compact, fully serialized JSON line; JavaScript character
counts are not wire-size measurements because multibyte text and JSON escaping
change the byte count. The terminating newline is not included.

BLE writes remain serialized so chunks from different lines never interleave.
Snapshot heartbeats are replaceable state: if a newer snapshot arrives while
one unsent snapshot is queued, the stale entry is removed and its replacement
is appended at the queue tail. The active chunked line always completes intact.
Command lines such as time, owner, status, OTA, and transfer messages are never
coalesced or dropped and retain FIFO order.

When a complete candidate exceeds 3,000 bytes, the bridge remeasures the whole
serialized snapshot after every deterministic degradation step:

1. Drop the lowest-ranked `ss` rows from the tail. Remove `sv` and `ss` together when the array becomes empty.
2. Byte-truncate `entries`, starting with the lowest-priority tail entry.
3. Omit `entries`.
4. Omit optional `sc.d`, then omit the complete optional `sc.i/p/c/m` tuple.
5. Omit all token counters: `tokens`, `tokens_today`, `tokens_used`, and `tokens_max`.
6. Omit `model`.
7. Omit `effort`.
8. Omit legacy `completed`.
9. Byte-clamp surviving core strings.

When capability is active, `sg`, `sc.g`, and `sc.o` are lifecycle core and
are never degraded. If a fully serialized line cannot fit under the 4,095-byte
ceiling with those required fields intact, snapshot construction throws rather
than sending an oversized or ambiguously cleared frame.

`total`, `running`, `waiting`, `msg`, and an existing `prompt` always survive.
The bridge never raw-truncates JSON. The measured ordinary maximum with eight
rows is **2,670 non-newline bytes**; the escaped worst-case fixture degrades to
**2,999 non-newline bytes**.

### Backward compatibility

Old firmware reads only recognized keys, ignores unknown `sv` and `ss` fields,
and continues to render the aggregate heartbeat. The aggregate core fields
`total`, `running`, `waiting`, and `msg` remain mandatory; `prompt` also remains
mandatory when a prompt exists. Removing or redefining those fields would
require a new protocol version rather than an additive session-projection
change.

### Completion presentation and input priority

Firmware presentation order is:

1. OTA update
2. Bluetooth pairing passkey
3. Permission or confirmation prompt
4. Blocked or waiting attention state
5. Completion card
6. Selected live session pal
7. Aggregate HUD or transcript
8. Idle or sleep clock

The completion card is visible only on the normal display page while the screen
is on and no OTA, passkey, prompt, blocked or waiting session, menu, settings,
or reset overlay is present. A higher-priority surface hides the completion
without clearing it. If the success introduction is interrupted or arrives
behind another surface, firmware marks the introduction consumed and restores
the still final card when it becomes visible.

The saved attitude setting controls successful completion. `kind` is the
default: success plays exactly one 5.6-second pass through the existing
celebrate poses and confetti, then freezes the final pose without particles,
bobbing, pulsing, or chirps. `assertive` skips that introduction, freezes the
completed pal in its attention pose, and replaces the summary with
`GET BACK TO WORK!!`. Failed uses a restrained 0.8-second transition and
`X FAILED`; aborted uses a 0.4-second transition and `- ABORTED`; both then
remain still. The card retains the completed identity, palette, summary, and
optional duration even after its `ss` row disappears. Ownerless legacy/passive
completion uses the saved pet and a neutral `= FINISHED` badge. Text and glyphs
accompany every outcome color.

Only a short button click or touch inside the visible outcome pill dismisses, and only on unobscured `DISP_NORMAL`. Encoder movement and long-press never dismiss. When the display is dark, the waking button gesture is consumed through release and encoder/touch input must remain quiet for 150 ms before normal dispatch resumes.

### Animation conditions

| Animation | When firmware shows it |
| --- | --- |
| `sleep` | The bridge or data connection is absent. After reconnecting to an otherwise idle bridge, sleep also covers the 12-second wake transition. The idle clock uses sleep decoratively from 01:00 through 06:59, on most weekend frames, and on most frames at or after 22:00 or during the midnight hour. |
| `idle` | The device is connected with no running or waiting work and no active completion. A selected session in `idle` also maps to this animation. During ordinary daytime clock display, idle is the default with occasional sleep frames. |
| `busy` | Aggregate `running` is at least one, or the selected session is `thinking` or `working`. An aborted completion uses busy only for its 0.4-second introduction, then freezes in the idle pose on its persistent card. |
| `attention` | Aggregate `waiting` is at least one, or the selected session is `waiting` or `blocked`. A live permission or confirmation prompt raises the effective persona to attention even when the selected pal is otherwise idle or busy. Failed completion uses attention for its 0.8-second introduction, then freezes in the idle pose. A successful completion in Assertive attitude immediately freezes the completed pal in its attention pose behind `GET BACK TO WORK!!`. Waiting, blocked, and prompt states also drive the attention ring and periodic chirp. |
| `celebrate` | A successful modern task completion in Kind attitude uses celebrate for its 5.6-second introduction and then keeps a fixed final celebrate pose until dismissal or new work. A legacy `completed:false` to `completed:true` edge follows the selected attitude. Separately, a token level-up triggers a three-second one-shot celebration. |
| `dizzy` | A fast encoder spin outside the session carousel, menu, settings, reset flow, or prompt triggers a two-second one-shot, provided another one-shot is not active. The late-night clock also uses dizzy decoratively on some frames. |
| `heart` | Approving a hardware prompt in under five seconds triggers a two-second one-shot. The weekend clock also uses heart decoratively on occasional frames. |

Task-completion cards persist after their introductions. They clear on an exact
hardware dismissal, genuine new work, an authoritative bridge clear,
disconnect or OTA safety handling, or the 24-hour firmware watchdog. Beginning
or refreshing a conversation does not itself celebrate, and
`companion_session_end` retires a conversation without an animation.

### How the firmware consumes the projection

The device parser (`firmware/src/session_pals.h`) is deliberately strict and
bounded. Everything it stores is fixed-size; there is no heap allocation in the
steady state and no per-session canvas — the single shared 240×240×16-bit
sprite is reused for whichever pal is selected.

| Concern | Device behaviour |
| --- | --- |
| Storage | `SessionPal[8]`, measured at 80 bytes per record and 644 bytes for the set with usage enabled. |
| Missing `sv` | Treated as zero sessions; the UI is byte-for-byte the legacy aggregate view. |
| `sv` other than `1` | Ignored, not guessed. Falls back to the legacy view. |
| `sv:1` with absent or empty `ss` | Zero sessions. |
| More than 8 rows | Rows past the eighth are ignored. |
| Malformed row | Dropped individually. Valid neighbours in the same array still render. |
| Duplicate `i` | The later row is dropped so the selection key stays unambiguous. |
| Invalid `m` | Truncated at the last valid code-point boundary; a partial sequence is never stored. |
| Truncated line | `deserializeJson()` fails and `_applyJson()` returns before touching any field, so the previous state survives intact. |

A row is accepted only when `i` is exactly 12 lowercase hex characters, `p` is
`0..17`, `s` is `0..4`, `c` is exactly five integers in `0..65535`, and optional
`u` is an integer in `0..4294967294`. Anything else drops the row.

Firmware never re-ranks. `ss[0]` is the pal shown when nothing else is selected,
which is why the bridge's inverse-of-the-state-codes ordering matters.

**Selection** is tracked by the 12-hex display ID, not by index, so a re-rank
between heartbeats cannot slide a different pal under the user. If the tracked
ID disappears — ended, evicted, or pushed past the projection cap — the device falls back
to the highest-ranked row. A row that *transitions* into `waiting` or `blocked`
pulls focus once, unless the dial moved in the previous 15 seconds.

The top-right red circled count is the number of currently projected rows in
`waiting` or `blocked`. It remains visible across the carousel, pal stats,
transcript, pet, info, and approval surfaces, but yields to pairing and local
menu/settings overlays. Idle, thinking, and working pals are not included.

Demo mode keeps one global state for its five fake pals. On a five-second
cadence, the whole roster moves through `idle`, `thinking`, `working`,
`waiting`, `blocked`, Kind celebration, and Assertive completion together. The
state pill and rendered animation consume the same phase; Demo also bypasses
leftover live one-shot animations so a prior heart or celebration cannot make
the label and pose disagree.

**Palettes** are applied through the species catalog rather than through
per-session art. Each species declares a `bodyColor` and paints its body with
that exact RGB565 literal, so the shared renderer can substitute `c[0]` for it.
`c[1]` becomes the clear colour and `c[3]` recolours dim particles. Reserved
semantic colours — warning red, heart red, yellow, cyan, white highlights — pass
through unchanged so a palette can never repaint a warning. `c[2]` and `c[4]`
drive the card's text and the ink on filled surfaces (the state pill and the
selected roster dot).

Summaries are flattened to one display column per code point before wrapping
(the built-in font is single-byte, so a non-ASCII code point renders as `?`) and
wrapped to two rows of 22 columns with a `..` marker when they overflow.

`firmware/test/run-host-tests.sh` compiles this parser on the host and asserts
it against wire lines generated by the real bridge pipeline
(`firmware/test/fixtures/generate.js`), including a guard that the firmware
species table and the bridge catalog remain in the same order.

## Turn events

Each completed turn also fires a one-shot event containing the raw SDK
content array—text blocks, tool calls, and any other content from the
message. Events that serialize larger than 4KB are dropped (measured in
UTF-8 bytes, not character count).

```json
{
  "evt": "turn",
  "role": "assistant",
  "content": [{ "type": "text", "text": "..." }]
}
```

## Permission decisions

When `prompt` is present, your device can return a response. Send one of:

```json
{"cmd":"permission","id":"req_abc123","decision":"once"}
{"cmd":"permission","id":"req_abc123","decision":"deny"}
```

The `id` must match `prompt.id` exactly. The desktop forwards this to the
session manager: `"once"` approves the tool call, `"deny"` rejects it.

In the co-copilot bridge the `id` prefix tells you where the question came from
and what a button press achieves:

| `prompt.id` | Origin | Effect of a press |
| ----------- | ------ | ----------------- |
| `mcp-…` | An agent's `companion_confirm` call | Authoritative: the decision is returned to the agent as the tool result |
| `perm-…` | A passively-detected Copilot CLI prompt | Acknowledge-only: the real prompt is answered in the terminal, and clears when the CLI resolves it |

Only one question is on screen at a time. Concurrent `companion_confirm` calls
are queued and shown in arrival order; the bridge correlates each answer by
`id`, so a late or duplicate reply for an already-answered prompt is ignored
rather than applied to whatever is on screen now.

## One-shot on connect

Time sync (epoch seconds + timezone offset in seconds):

```json
{ "time": [1775731234, -25200] }
```

Owner name (the user's first name from their account):

```json
{ "cmd": "owner", "name": "Felix" }
```

## Commands and acks

Any command the desktop sends with a `cmd` field expects a matching ack:

```json
{ "ack": "<same as cmd>", "ok": true, "n": 0 }
```

Set `ok:false` and optionally `error:"..."` if you couldn't do it. `n` is a
generic counter (e.g. bytes written for chunk acks, otherwise 0).

| Command                          | Payload                  | Ack you send back            |
| -------------------------------- | ------------------------ | ---------------------------- |
| `{"cmd":"status"}`               | —                        | see Status response below    |
| `{"cmd":"name","name":"Clawd"}`  | sets device display name | `{"ack":"name","ok":true}`   |
| `{"cmd":"owner","name":"Felix"}` | sets owner name          | `{"ack":"owner","ok":true}`  |
| `{"cmd":"unpair"}`               | erase stored BLE bonds   | `{"ack":"unpair","ok":true}` |

**Status response.** The desktop polls this every couple of seconds to
populate the Hardware Buddy window's stats panel:

```json
{
  "ack": "status",
  "ok": true,
  "data": {
    "name": "Clawd",
    "sec": true,
    "cl": 1,
    "bat": { "pct": 87, "mV": 4012, "mA": -120, "usb": true },
    "sys": { "up": 8412, "heap": 84200 },
    "stats": { "appr": 42, "deny": 3, "vel": 8, "nap": 12, "lvl": 5 }
  }
}
```

You can omit fields you don't have. `bat.mA` negative means charging. Set
`data.cl` to integer `1` only when the firmware implements the latched
completion contract above. `bat.mA` negative means charging.

## Folder push

The Hardware Buddy window has a drop target. Dropping a folder there streams
its flat contents to your device. The transport is content-agnostic: GIFs,
config blobs, firmware images, whatever you want under 1.8MB total.

```
desktop:  {"cmd":"char_begin","name":"bufo","total":184320}
device:   {"ack":"char_begin","ok":true}

desktop:  {"cmd":"file","path":"manifest.json","size":412}
device:   {"ack":"file","ok":true}
desktop:  {"cmd":"chunk","d":"<base64>"}
device:   {"ack":"chunk","ok":true,"n":<bytes_written_so_far>}
          ...repeat chunk until file is done...
desktop:  {"cmd":"file_end"}
device:   {"ack":"file_end","ok":true,"n":<final_size>}

          ...repeat file/chunk/file_end for each file...

desktop:  {"cmd":"char_end"}
device:   {"ack":"char_end","ok":true}
```

The desktop sends every regular file in the folder (no recursion, dotfiles
skipped), base64-encodes each chunk, and waits for each ack before sending
the next. You decode and append; the protocol is sequential so you don't
need to buffer whole files.

`char_begin.name` is whatever the folder is called, unless the folder
contains a `manifest.json` with a `"name"` field, in which case that wins.

If your device doesn't want pushed files, don't ack `char_begin`. The
desktop times out after a few seconds and tells the user it failed.

## Firmware OTA (co-copilot extension)

> This section is **not** part of the base Claude protocol — it's a co-copilot
> addition between *its* bridge and *its* firmware, carried over the same
> encrypted NUS link.

The co-copilot bridge can update the device firmware over the air, streaming a
`.bin` straight into the inactive OTA partition. The device must have a
**dual-bank** partition table (`app0` + `app1` + `otadata`); adopting that table
is a flash-layout change, so it has to be flashed **once over USB**, after which
every later update can go over the air.

The flow mirrors the folder push — one JSON object per line, each acked before
the next is sent:

```
bridge:  {"cmd":"ota_begin","size":1268560,"md5":"df90…","version":"0.2.0"}
device:  {"ack":"ota_begin","ok":true}

bridge:  {"cmd":"ota_chunk","d":"<base64>"}
device:  {"ack":"ota_chunk","ok":true,"n":<bytes_written_so_far>}
         ...repeat until size bytes sent...

bridge:  {"cmd":"ota_end"}
device:  {"ack":"ota_end","ok":true,"n":<final_size>}   // then the device reboots
```

| Field | Meaning |
| --- | --- |
| `ota_begin.size` | Total image size in bytes. The device calls `Update.begin(size)` on the next OTA slot. |
| `ota_begin.md5` | 32-hex MD5 of the whole image. The device verifies it in `Update.end()` **before** switching the boot partition, so a corrupted transfer is never booted. |
| `ota_begin.version` | Informational; the device may refuse same/older versions. |
| `ota_chunk.d` | Base64 of the next raw bytes (keep a chunk's whole line under the device's line buffer, ~1KB; co-copilot uses 384-byte chunks). |
| `ota_end` | Finalize, verify MD5, set the boot partition, reboot. |
| `ota_abort` | Cancel an in-progress update; the device discards the partial image. |

On any failure the ack carries `"ok":false` and an `"error"` string and the
device aborts. Send `{"cmd":"status"}` after the device re-advertises to read
the new `data.fw` version and confirm the update took.

**Integrity vs. authenticity.** MD5 + the encrypted bonded link protect against
corruption and eavesdropping. They do **not** authenticate the image — signed
firmware / Secure Boot v2 and bootloader-level rollback are out of scope for the
reference firmware (a logically-broken-but-valid image can still brick into a
crash loop until reflashed over USB).

## Security and pairing

The desktop app connects whether or not your device requests link
encryption, but transcript snippets and tool-call hints flow over this
link, so an unencrypted device is sniffable by anyone in radio range
with a cheap nRF dongle. You should require **LE Secure Connections
bonding**: mark your NUS characteristics (and the TX CCCD) as
encrypted-only and advertise DisplayOnly IO capability. The first GATT
access then triggers OS pairing — the desktop prompts the user for the
6-digit passkey your device displays — and the link is AES-CCM-encrypted
from then on. Reconnects reuse the stored LTK without re-prompting.

The desktop app supports both encrypted and unencrypted devices. Two
protocol hooks tie into pairing:

- Include `"sec": true` in your status ack's `data` once the link is
  encrypted (or `false`/omit it if you don't bond).
- Handle `{"cmd":"unpair"}` by erasing your stored bonds. The desktop
  sends this when the user clicks **Forget**, so the next pairing shows
  a fresh passkey. Ack it like any other command.

If you accept the folder-push protocol, validate `file.path` before
writing — the desktop sends whatever filenames are in the dropped
folder, so reject `..` and absolute paths unless your filesystem holds
nothing you'd mind overwritten.

### Reconnecting after reflashing

If the device won't reconnect after a firmware flash — it appears to
connect for a moment then immediately drops, looping forever — you have a
**stale bond**. A full chip-erase (and sometimes OTA) wipes the bond keys
stored in the ESP32's NVS, but the host still has the old pairing and
tries to encrypt the link with a key the device no longer holds. The
device fails authentication, force-disconnects, the host instantly
reconnects with the same stale key, and the loop repeats. The host's
cached GATT table can also go stale across a flash that changes the
attribute layout.

To recover, clear the bond on **both** sides and re-pair:

1. **Host:** *Forget* the `Copilot-*` device in the OS Bluetooth settings.
   BLE-only peripherals sometimes don't appear there — if so, reset the
   Bluetooth stack (toggle Bluetooth off/on; on macOS `sudo pkill
   bluetoothd`, which auto-restarts). This drops the stale LTK and the
   cached GATT table.
2. **Device:** erase its bonds too, via the factory-reset flow or a
   `{"cmd":"unpair"}` command, so nothing lingers.
3. Reconnect. The device should show a **fresh 6-digit passkey** and the
   host should prompt you to enter it. A passkey prompt means the desync
   is cleared.

A serial monitor on the device is the fastest diagnostic: `[ble] auth
FAIL` means the host is still using the stale key (forget it again),
`[ble] auth ok` means the link re-paired cleanly.

To avoid the desync, *Forget* the device on the host before reflashing,
or avoid a full chip-erase — a plain app upload and OTA normally preserve
NVS bonds; only an `erase` wipes them.

## Availability

The BLE API is only available when the desktop apps are in developer mode
(**Help → Troubleshooting → Enable Developer Mode**). It's intended for
makers and developers and isn't an officially supported product feature.

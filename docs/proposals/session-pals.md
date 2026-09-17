# Session pals architecture proposal

**Status:** Waves 1, 2, and 3 implemented
**Directive:** `/Users/vkorotchenko/workspace/.squad/decisions/inbox/copilot-directive-co-mpanion-session-pals.md`

**Ownership clarification:** A projected session is one top-level Copilot user
conversation, owned by its main agent/orchestrator. Spawned agents never create
additional pals; they defer user interaction and lifecycle reporting to the
orchestrator, which updates the existing session summary and state.

## Problem Statement

The accepted bridge tracks concurrent explicit sessions, but it flattens them before transmission. `bridge/src/sessions/compose.js:64-87` reduces registry rows to counts and one winning message; `composeModel()` emits only aggregate `total`, `running`, `waiting`, and `msg` presentation (`bridge/src/sessions/compose.js:100-150`). The bridge therefore cannot send a distinct animal, palette, and work summary for each session.

Firmware also assumes one buddy. `firmware/src/buddy.cpp:92-100` defines 18 ASCII species but stores one global `currentSpeciesIdx`, and all render paths read that global (`firmware/src/buddy.cpp:116-139,174-207`). `firmware/src/main.cpp:38-58` holds one `PersonaState`, one `DisplayMode`, and one transcript scroll position. Concurrent sessions become one animal in one state.

The legacy wire format provides one 23-character message for all sessions. `bridge/src/protocol/snapshot.js:10-16,27-38` clamps `msg` to 23 characters and `entries` to 8 lines of 159 characters; `firmware/src/data.h:9-27,96-129` stores one copy of those fields. For N sessions, the device receives N counts but only one selected line, so it cannot show which pal is doing what.

The transport is hard-bounded. USB and BLE have separate `_LineBuf<4096>` instances, and each retains at most 4,095 non-newline bytes (`firmware/src/data.h:137-153,173-181`). Once one buffer is full, it ignores remaining bytes until newline. Only lines starting with `{` are parsed, and malformed or truncated JSON returns without changing state or surfacing an error (`firmware/src/data.h:76-78,137-153,173-181`). Session detail must be a bounded projection, not the full 64-row registry.

## Proposed Architecture

### Registry schema

Extend each internal record in `bridge/src/sessions/registry.js` with resolved presentation metadata. Existing identity, lifecycle, provenance, and TTL fields remain authoritative.

| Internal field | Type and limit | `snapshotOf()` output | Meaning |
| --- | --- | --- | --- |
| `conversationId` | optional non-empty string, at most 128 characters | `conversation_id` | Stable top-level Copilot conversation identity. Repeated `begin()` calls reuse the live record and refresh its active-task lease. Task completion and lease expiry preserve it in idle; explicit end, capacity eviction, or bridge restart releases it. |
| `palId` | canonical ASCII string, 1-16 lowercase characters | `pal_id` | One of the 18 names in the shared species catalog; always resolved at `begin()`. |
| `themeId` | ASCII string, 1-24 lowercase/digit/`_`/`-` characters | `theme_id` | Named palette preset; default `classic`. |
| `palette` | `{ body, bg, text, textDim, ink }`, each integer `0..65535` | `palette: { body, bg, text, text_dim, ink }` | Complete resolved RGB565 palette. Explicit colors override a preset. |
| `summary` | normalized UTF-8 string, 0-96 characters | `summary` | Brief work description; defaults to `label`. |
| `assignment` | `derived` or `user` | `assignment` | Whether pal/theme came from defaults or caller configuration. |
| `configuredAt` | epoch milliseconds or `null` | `configured_at` ISO timestamp or `null` | Last successful presentation change. |

Keep the existing bridge-minted `id`, 64-character `label`, 256-character `cwd`, transport-stamped `source`, state, 120-character state message, closing message, outcome, timestamps, TTL, and expiry (`bridge/src/sessions/registry.js:31-47,96-180,269-289`). `source` remains provenance stamped as `mcp` or `http`, never caller input (`bridge/src/http/api.js:156-171`). `conversationId` is optional for compatibility; it must never be inferred from `cwd`, `label`, or the bridge's global passive focus because independent conversations can share those values.

Add `SessionRegistry.configure({ id, palId, themeId, colors, summary })`. It prunes expired rows; rejects unknown or ended IDs; requires at least one configurable field; treats omitted fields as unchanged; and treats explicit `null` as reset to deterministic defaults. It updates `updatedAt` and `configuredAt` but does **not** renew `expiresAt`; only lifecycle state reports renew the lease.

Add `bridge/src/sessions/species.js` as the canonical JavaScript catalog. Its order must match `SPECIES_TABLE` in `firmware/src/buddy.cpp:92-99`:

`capybara, duck, goose, blob, cat, dragon, octopus, owl, penguin, turtle, snail, ghost, axolotl, cactus, robot, rabbit, mushroom, chonk`.

### MCP and HTTP evolution

Add a dedicated operation rather than expanding begin or state:

- MCP: `companion_session_configure`
- HTTP: `POST /v1/session/configure`

Request shape:

```json
{
  "session_id": "cs-0123456789abcdef",
  "pal": "owl",
  "theme": "cyan",
  "colors": {
    "body": 2047,
    "bg": 0,
    "text": 65535,
    "text_dim": 33808,
    "ink": 0
  },
  "summary": "Reviewing the BLE protocol"
}
```

Validation must be identical across Zod and HTTP:

- `session_id`: required non-empty string.
- `pal`: optional nullable enum from the 18-species catalog.
- `theme`: optional nullable enum. V1 presets: `classic`, `cyan`, `green`, `amber`, `magenta`, `white`.
- `colors`: optional nullable complete object. All five RGB565 integers are required when present; reject partial palettes.
- `summary`: optional nullable string, normalized and clamped to 96 characters. The device projection applies a second 48-byte UTF-8 clamp.
- At least one configurable field must be present.

`companion_session_begin` accepts the additive optional `conversation_id`.
`companion_task_complete` marks a request and all delegated work complete while
keeping the conversation pal idle and reusable. `companion_session_end` is
reserved for permanent conversation retirement and does not celebrate. Callers
that never configure presentation receive a deterministic pal, `classic`
palette, and label-derived summary.

### Assignment rules

At `begin()`, normalize `label` and `cwd`, calculate 32-bit FNV-1a over `label + "\\0" + (cwd || "")`, and use `hash % 18` as the first species candidate. Resolve automatic collisions by linear probing through the catalog against live, non-ended rows. The first 18 automatically assigned concurrent sessions therefore get different species.

Explicit user choices are authoritative and may collide; the bridge must not silently replace them. Automatic occupancy is the hard uniqueness constraint and explicit occupancy is a softer preference: avoid an explicitly held species while another automatic slot is free, but collide with explicit occupancy before duplicating an automatic assignment. Above 18 automatic sessions, choose the least-used automatic species, then the least explicitly used, breaking remaining ties by the same hash order. A row's mapping remains stable through state changes, TTL renewals, ranking changes, reconnects, and device navigation.

Preferences do not persist across bridge restarts in V1. The registry is deliberately in memory (`bridge/src/sessions/registry.js:23-29`; `bridge/README.md:224-229`), so restart loses rows and falls back to passive observation. Repeating the same label and cwd gives the same initial candidate, though collision probing can differ with a different concurrent set. Durable preference identity is deferred until it can avoid resurrecting stale sessions.

### Additive wire protocol

Preserve every current heartbeat field and add two optional top-level fields:

```json
{
  "total": 3,
  "running": 1,
  "waiting": 1,
  "msg": "confirm on device",
  "entries": ["10:42 git push"],
  "prompt": { "id": "mcp-abc", "tool": "Bash", "hint": "git push" },
  "sv": 1,
  "ss": [
    {
      "i": "0123456789ab",
      "p": 7,
      "c": [2047, 0, 65535, 33808, 0],
      "s": 4,
      "m": "Waiting for review"
    }
  ]
}
```

`sv` is the session-projection schema version. `ss` is a ranked array of at most eight live sessions. Short keys are intentional.

| Key | Type and limit | Meaning |
| --- | --- | --- |
| `i` | 12 lowercase hex characters | 48-bit display identity derived from the session ID. Detect duplicates in the selected set and deterministically derive a replacement. |
| `p` | uint8 `0..17` | Species catalog index. |
| `c` | five uint16 values | `[body, bg, text, textDim, ink]`, matching `Palette` (`firmware/src/character.h:5-7`). |
| `s` | uint8 | `0=idle`, `1=thinking`, `2=working`, `3=waiting`, `4=blocked`. |
| `m` | valid UTF-8, maximum 48 bytes | Brief summary, clamped without splitting a code point. |

Do not transmit labels, cwd, timestamps, TTLs, source, outcomes, or full IDs; they remain in `companion_status`. Rank live rows `blocked`, `waiting`, `working`, `thinking`, `idle`; within a state, newest `updated_at`, then oldest `created_at`, then session ID. Ended rows never enter `ss`.

`buildSnapshot()` owns field clamps and projection ranking, but the transport guard must measure the fully serialized line. The existing clamps count JavaScript characters before `JSON.stringify()` (`bridge/src/protocol/snapshot.js:17-20,32-60,72-80`); quotes, backslashes, control characters, and multibyte UTF-8 can consume more bytes after serialization. Entry normalization collapses whitespace but does not remove quotes or backslashes (`bridge/src/copilot/source.js:166-179`). The final guard therefore evaluates `Buffer.byteLength(serialize(snapshot))` over the entire snapshot, including legacy fields, after every degradation step. `equal()` retains existing change detection, and unchanged snapshots retain the 10-second keepalive (`bridge/src/protocol/snapshot.js:72-80`; `bridge/src/config.js:58-68`).

### Device representation and UX

Add a fixed record to `firmware/src/data.h`:

```cpp
struct SessionPal {
  char id[13];
  uint8_t species;
  uint8_t state;
  uint16_t colors[5];
  char summary[49];
};

static const uint8_t MAX_SESSION_PALS = 8;
```

Add `sessionSchemaVersion`, `sessionPalCount`, and `SessionPal sessionPals[8]` to `TamaState`. Alignment and trailing padding make `SessionPal` approximately 76 bytes, so eight records cost approximately 608 bytes. With the version, count, and enclosing alignment, `TamaState` grows by approximately 612 bytes, from approximately 1,468 to approximately 2,080 bytes. This remains safe without PSRAM (`firmware/platformio.ini:11`).

The firmware must not allocate a canvas per session. It reuses the single shared 240x240x16-bit `M5Canvas spr`, allocated once before BLE initialization (`firmware/src/main.cpp:9-11,715-722`); that canvas consumes 115,200 bytes, or 112.5 KiB.

Per-session palettes require a renderer refactor, not activation of existing flexibility. The catalog contains exactly 18 species in the stated order, and `Species { name, bodyColor, states[7] }` has the expected shape (`firmware/src/buddy.cpp:72-103`; `firmware/src/buddy.h:23-30`), but `bodyColor` is currently dead. Each species hard-codes RGB565 values in `buddyPrintSprite()` calls, including dragon and robot (`firmware/src/buddies/dragon.cpp:29,71,97,128`; `firmware/src/buddies/robot.cpp:28,68,92,117`). The ASCII renderer also uses fixed `BUDDY_BG` and semantic constants through `buddySetColor()` (`firmware/src/buddy.cpp:19-28,45-69`), while UI text and backgrounds come from the single global `characterPalette()` (`firmware/src/character.cpp:27,248` and `firmware/src/main.cpp`). V1 therefore keeps the five-color wire contract and recommends threading the selected session's body, background, text, textDim, and ink colors through the ASCII renderer, UI card, and all 18 species files. Warning red, heart red, and white highlights remain reserved semantic colors. Animation uses the existing 200 ms global tick (`firmware/src/buddy.cpp:102-108`) plus a deterministic phase offset from `SessionPal.id`; no per-session frame buffer is needed.

When `sv == 1` and sessions exist, `DISP_NORMAL` becomes the session-pal card. Add `DISP_ACTIVITY` to preserve the existing HUD and transcript reader. Button order becomes `DISP_NORMAL -> DISP_ACTIVITY -> DISP_PET -> DISP_INFO`; menus, settings, passkey, OTA, and prompt branches retain higher priority.

Show one full 2x pal at a time on the 240-pixel round screen, plus:

- Species name and `current/total`, such as `owl 2/5`.
- Summary wrapped to at most two lines of 22 display columns.
- Up to eight body-color roster dots on the lower arc; selected dot has a white outline.

On the pal card, rotary detents move left/right through the ranked array. Preserve selection by `i` when snapshots reorder. If the selected ID disappears, select the highest-ranked row. A `fastSpin` advances three positions and does not trigger dizzy while the carousel owns the encoder; dizzy remains unchanged on other displays (`firmware/src/main.cpp:663-680,832-892`).

When a row newly enters `blocked` or `waiting`, auto-focus it unless the user rotated within the previous 15 seconds. A real prompt always overrides the roster: `drawApproval()` remains modal before display-mode overlays (`firmware/src/main.cpp:1004-1014`), and the encoder continues selecting approve/deny.

Map state to existing persona states; the existing aggregate mapping already sends idle to `P_IDLE`, thinking/working to `P_BUSY`, and waiting/blocked to `P_ATTENTION` (`firmware/src/main.cpp:38-39,310-319`):

| Session state | Persona state |
| --- | --- |
| `idle` | `P_IDLE` |
| `thinking`, `working` | `P_BUSY` |
| `waiting` | `P_ATTENTION` |
| `blocked` | `P_ATTENTION` plus attention ring |

Existing passive `completed` may trigger `P_CELEBRATE` on the selected pal; approval may trigger `P_HEART`.

V1 palettes target black: require `bg == 0x0000`, text contrast at least 4.5:1, dim-text contrast at least 3:1, and body color distinguishable from black and white after RGB565 expansion. Reject nonconforming explicit palettes. Color is not the only state signal; animation, text, ring, and position remain. The full renderer sweep is recommended over narrowing the contract to ASCII-only body/background colors because the card's text hierarchy and ink details must remain session-consistent.

Behavior is explicit:

- Zero projected sessions: retain current passive/aggregate home, idle clock, and “No Copilot connected.”
- One: show one pal without carousel affordances.
- Two to eight: enable carousel and dots.
- More than eight bridge sessions: show the highest-ranked eight while legacy counts and `companion_status` still represent the full state.

### Resource budget

A maximum legacy heartbeat using all current clamps, maximum 32-bit token values, and prompt fields is a 1,688-byte payload, or 1,689 bytes with newline, for ordinary unescaped ASCII. A maximum proposed session row serializes to 124 bytes. Full unescaped legacy data plus eight rows is approximately a 2,702-byte payload, or 2,703 bytes with newline, leaving 1,393 bytes below the 4,095-byte non-newline ceiling.

That arithmetic is not an escape-safe upper bound. Eight fully escaped entries plus eight fully escaped summaries can produce approximately 4,515 bytes including newline because the current JavaScript character clamps run before JSON serialization. The bridge must treat 3,000 non-newline bytes as an internal target and 4,095 non-newline bytes as the absolute transport ceiling, both measured with `Buffer.byteLength(serialize(snapshot))` on the complete candidate snapshot.

The existing firmware caps remain part of the compatibility contract: `msg` is `char[24]` (23 usable), `entries` is `char[8][160]` (8 by 159 usable), `model` is `char[24]` (23 usable), `effort` is `char[10]` (9 usable), `promptId` is `char[40]` (39 usable plus terminator), `promptTool` is `char[20]` (19 usable), `promptHint` is `char[44]` (43 usable), and session counts are `uint8_t` clamped to `0..255` (`bridge/src/protocol/snapshot.js:10-16,32-60`; `firmware/src/data.h:9-27`). Add an explicit 39-character clamp for `prompt.id`, which is currently copied without a limit (`bridge/src/protocol/snapshot.js:55-60`). All string clamps must preserve valid UTF-8 and the final serialized-byte guard remains authoritative.

The device maximum is eight. The corrected unescaped case leaves 1,393 bytes of headroom, but escaped content can consume all of it; eight remains the visible and RAM bound, not proof that every candidate fits.

Degradation is deterministic and remeasures the complete serialized snapshot after each step: remove lowest-ranked `ss` rows; byte-truncate `entries` from the lowest-priority tail; then omit optional telemetry in the order `entries`, token counters, `model`, `effort`, and `completed`. If legacy fields alone exceed the 3,000-byte internal target, the bridge keeps the legacy core and continues degradation rather than pretending that dropping `ss` is sufficient. The core fields `total`, `running`, `waiting`, `msg`, and `prompt` always survive; their bounded string values are byte-clamped as needed so the final payload never exceeds 4,095 non-newline bytes. The bridge must never raw-truncate serialized JSON.

No new timer is needed. Passive composition and the bridge check run each second, unchanged snapshots wait for the 10-second keepalive, and lifecycle mutations force a push (`bridge/src/config.js:58-68`; `bridge/src/bridge.js:97-100,144-167,276-287`). BLE serializes writes and chunks them to the negotiated MTU (`bridge/src/ble/central.js:231-252`): a 2,703-byte line is approximately 15 writes with a 182-byte payload but approximately 136 writes at the 20-byte fallback. Rapid forced updates coalesce pending unsent snapshots so the newest state replaces stale queued state; the active chunked line completes intact and command lines remain FIFO. Visible-within-one-tick is expected only at the normal macOS MTU and is not guaranteed at fallback MTU or during mutation bursts. Animation remains local at 200 ms and adds no BLE traffic.

## What Changes

| Module | Impact |
| --- | --- |
| `bridge/src/sessions/registry.js` | Add metadata, deterministic defaults, and `configure()` without changing TTL or eviction semantics. |
| `bridge/src/sessions/species.js` | New catalog, FNV-1a assignment, palette presets, RGB565 validation, and collision handling. |
| `bridge/src/sessions/compose.js` | Preserve aggregate composition; additionally produce ranked live rows. |
| `bridge/src/protocol/snapshot.js` | Add `sv`/`ss`, explicit `prompt.id` clamp, escape-safe UTF-8 clamps, deterministic degradation, and a final whole-snapshot serialized-byte guard. |
| `bridge/src/mcp/server.js` | Add `companion_session_configure`; include metadata in status. |
| `bridge/src/http/api.js` | Add `POST /v1/session/configure` behind existing guards. |
| `bridge/src/bridge.js` | Add `configureSession()` wrapper that forces refresh. |
| `bridge/src/ble/central.js` | Coalesce a pending unsent snapshot in favor of the newest state while preserving serialized chunk writes for the active snapshot. |
| `bridge/src/config.js` | Add `deviceProjectionMax` clamped to `1..8`; correct the stale max-session comment to least-recently-updated. |
| `REFERENCE.md`, `bridge/README.md` | Document schema, APIs, ranking, budget, and compatibility. |
| `firmware/src/data.h` | Parse optional fixed-capacity versioned rows. |
| `firmware/src/buddy.h`, `buddy.cpp`, `buddies/*.cpp` | Thread the selected five-color palette through the ASCII renderer and all 18 species while retaining one table and shared canvas. |
| `firmware/src/main.cpp` | Add pal/activity displays, carousel, state mapping, wrapping, dots, and prompt precedence. |

## What Stays the Same

- Old firmware continues to receive and render the complete legacy snapshot when it fits the internal target. Under escape-driven pressure, deterministic degradation may shed optional telemetry, but `total`, `running`, `waiting`, `msg`, and `prompt` remain mandatory.
- Counts remain union-by-maximum, never sums, with `total >= max(running, waiting)` (`bridge/src/sessions/compose.js:109-150`).
- Message priority remains confirm, notify, explicit blocked/waiting, explicit working/thinking, passive (`bridge/src/sessions/compose.js:27-43,126-136`).
- Prompt behavior and FIFO confirmation correlation remain unchanged.
- Registry defaults remain 90-second TTL, 5-second minimum, 1-hour maximum, 64 rows, 10-second ended linger.
- Eviction remains ended-first, then least-recently-**updated**, then creation time/ID. It must not become nearest-expiry because caller-controlled one-hour leases would displace active default-TTL reporters (`bridge/src/sessions/registry.js:182-229`).
- Registry remains in memory; passive telemetry remains available after restart
  or active-task lease expiry.
- `source` remains transport-stamped and non-spoofable.
- HTTP remains loopback-only, JSON-only, 64 KB body-limited, without CORS, and without a confirm route.
- USB and BLE continue newline-delimited compact JSON through separate `_LineBuf<4096>` instances. `_applyJson()` reads only recognized keys, so ArduinoJson ignores unknown top-level `sv` and `ss` fields (`firmware/src/data.h:76-133`).
- The existing catalog remains exactly 18 species in its current order, with seven persona states, RGB565 representation, one shared canvas, 1x/2x rendering, clock, stats, info, settings, and prompts. The 30-second screen-idle timeout remains, but BLE keepalive keeps `dataBtActive()` true for 15 seconds, so a continuously connected bridge normally prevents screen-off (`firmware/src/data.h:58-61`; `firmware/src/main.cpp:1023-1029`).
- Installed GIF characters remain a global pet option; per-session GIFs are deferred.

## Key Decisions

### 1. Recommendation: resolved metadata in `SessionRegistry` (recommended) or transport-only metadata?

**Recommendation:** Store `palId`, `themeId`, resolved `palette`, `summary`, `assignment`, and `configuredAt` on the record and expose them through `snapshotOf()`.

**Alternatives:** Handler-only metadata; resolve defaults on every snapshot; separate presentation registry.

**Rationale:** The registry already owns identity, state, TTL, and provenance. Co-location gives MCP, HTTP, status, composition, and eviction one atomic record and prevents palette/collision changes between heartbeats.

**Needs sign-off from:** Trogdor and Strong Bad.

### 2. Recommendation: dedicated configure operation (recommended) or fields on begin/state?

**Recommendation:** Add `companion_session_configure` and `/v1/session/configure`; keep lifecycle schemas unchanged.

**Alternatives:** Put metadata on begin; put it on high-frequency state; support both.

**Rationale:** Configuration has different validation and lease semantics. A dedicated idempotent update avoids resending palettes with state, preserves existing callers, and still needs no mandatory second call because begin assigns defaults.

**Needs sign-off from:** Strong Bad and Strong Sad.

### 3. Recommendation: deterministic in-memory assignment with collision probing (recommended) or persistence?

**Recommendation:** FNV-1a label+cwd, linear-probe unused species, honor explicit duplicates, stable for row lifetime, no V1 persistence.

**Alternatives:** Random assignment; plain modulo without probing; persisted cwd/label preferences; device assignment.

**Rationale:** Determinism provides repeatability without stale disk state. Probing gives distinct defaults through 18 sessions. Bridge ownership keeps status and devices consistent.

**Needs sign-off from:** Trogdor and Vadim.

### 4. Recommendation: additive `sv`/`ss` fields (recommended) or aggregate replacement?

**Recommendation:** Add optional versioned short-form rows and preserve every aggregate field.

**Alternatives:** Replace aggregate fields; send a second event; use unversioned long-form objects.

**Rationale:** Old firmware ignores unknown JSON fields but would break if aggregate fields disappeared. One heartbeat preserves ordering, diffing, and liveness; short keys preserve bytes.

**Needs sign-off from:** Strong Bad and The Cheat.

### 5. Recommendation: one-pal carousel plus activity screen (recommended) or multi-pal grid?

**Recommendation:** Render one 2x pal with rotary navigation and preserve the transcript on `DISP_ACTIVITY`.

**Alternatives:** Multi-pal grid; remove HUD; automatic cycling only.

**Rationale:** The round 240-pixel screen cannot fit multiple readable ASCII animals and summaries. A carousel keeps each pal distinct and preserves existing information on a dedicated screen.

**Needs sign-off from:** Pom Pom, The Cheat, and Trogdor.

### 6. Recommendation: eight projected sessions and a 3,000-byte budget (recommended) or larger roster?

**Recommendation:** Keep 64 bridge rows, project eight, and rank-drop before serialization.

**Alternatives:** Send 64; send 16 because it narrowly fits now; vary the limit only by runtime size.

**Rationale:** Eight maximum unescaped rows yield an approximately 2,702-byte payload, or 2,703 bytes with newline, bound RAM, and fit the visible roster while retaining 1,393 bytes below the transport ceiling. Escaping can exceed that headroom, so the whole-snapshot serialized-byte guard and degradation policy are load-bearing.

**Needs sign-off from:** Strong Bad, The Cheat, and Strong Sad.

### 7. Recommendation: bridge-owned ranking and bounded device projection (recommended) or firmware ranking?

**Recommendation:** Bridge resolves metadata, ranking, and truncation; firmware receives display-ready rows.

**Alternatives:** Send all rows; device subscriptions; firmware-owned registry.

**Rationale:** The bridge owns TTL and timestamps and can expose all rows through status. Firmware ranking duplicates business rules and cannot overcome the line limit.

**Needs sign-off from:** Trogdor, Strong Bad, and The Cheat.

### 8. Recommendation: bridge-first migration (recommended) or one cross-stack release?

**Recommendation:** Ship foundation/API, then additive projection, then firmware UI; evaluate persistence afterward.

**Alternatives:** Require simultaneous upgrade; parser first; include persistence in V1.

**Rationale:** New bridge plus old firmware is directly compatible and gives firmware a stable checked-in fixture. Persistence does not block runtime session distinction.

**Needs sign-off from:** Trogdor and Strong Sad.

### 9. Recommendation: layered compatibility tests (recommended) or physical E2E only?

**Recommendation:** Extend registry/MCP/HTTP suites, add projection/budget/backcompat suites, and add PlatformIO parser/UI fixtures.

**Alternatives:** Manual device testing; JSON-only tests; firmware-only tests.

**Rationale:** The critical failures cross validation, protocol size, old/new combinations, and input priority. Layered tests locate failures without requiring hardware in every run.

**Needs sign-off from:** Strong Sad, Strong Bad, and The Cheat.

## Risks and Mitigations

### Snapshot overflow

**Risk:** Metadata exceeds 4,095 bytes and drops the heartbeat.
**Likelihood:** Medium.
**Impact:** High.
**Mitigation:** Eight-row cap, 48-byte summaries, explicit prompt-ID clamp, whole-snapshot `Buffer.byteLength()` checks, deterministic legacy-aware degradation, and escaped-worst-case tests that enforce the 4,095-byte non-newline ceiling.

### Catalog drift

**Risk:** JavaScript and C++ index orders diverge.
**Likelihood:** Medium.
**Impact:** Medium.
**Mitigation:** Canonical documented order, append-only V1 catalog, and an 18-index cross-fixture test.

### Inaccessible colors

**Risk:** RGB565 quantization makes text or body colors unreadable.
**Likelihood:** Medium.
**Impact:** Medium.
**Mitigation:** Black V1 background, measured contrast thresholds, complete-palette validation, and physical screenshots approved by Pom Pom.

### Selection flapping

**Risk:** State updates reorder rows and change the visible pal.
**Likelihood:** High.
**Impact:** Medium.
**Mitigation:** Preserve selection by ID, focus only on transitions into waiting/blocked, and honor a 15-second manual-selection hold.

### Configuration extends stale lifetime

**Risk:** Cosmetic writes keep dead sessions alive.
**Likelihood:** Low.
**Impact:** Medium.
**Mitigation:** `configure()` never changes `expiresAt`; add injected-clock coverage.

### More sessions than species

**Risk:** Distinct automatic animals are impossible above 18.
**Likelihood:** Low.
**Impact:** Low.
**Mitigation:** Guarantee uniqueness while unused species exist, then deterministic least-used reuse. The device projects only eight.

### Palette refactor changes art

**Risk:** Runtime color override alters semantic overlays across 18 species.
**Likelihood:** Medium.
**Impact:** Medium.
**Mitigation:** Treat palette support as an all-18-species renderer sweep; thread body/background/text/textDim/ink through the selected session palette, preserve warning/heart/highlight constants, and add golden renders for idle/busy/attention at 1x/2x.

### Carousel steals prompt or transcript input

**Risk:** New encoder handling regresses safety or navigation.
**Likelihood:** Medium.
**Impact:** High.
**Mitigation:** Move transcript scrolling to `DISP_ACTIVITY`. Suppress carousel fast-spin before the global dizzy branch (`firmware/src/main.cpp:855-859`), preserve encoder priority (`firmware/src/main.cpp:872-891`), and retain the rule that the first movement while asleep is consumed only to wake the display (`firmware/src/main.cpp:844-853`). Prompt arrival still wakes the display, selects `DISP_NORMAL`, and closes menus/settings; approve/deny handling precedes display navigation, and `drawApproval()` wins over display overlays (`firmware/src/main.cpp:811-829,872-909,1006-1013`).

## Scope

### V1

- Per-explicit-session ASCII pal, RGB565 palette, summary, and lifecycle state.
- Deterministic defaults and caller configuration over MCP/HTTP.
- Full metadata in `companion_status`.
- Additive version 1 projection of at most eight ranked rows.
- Old-firmware compatibility.
- M5Dial carousel, summaries, roster dots, state animation, accessible presets, and prompt override.
- Fixed memory with no new canvas.
- Protocol, API, parser, UI, byte-budget, and compatibility tests and docs.

### Deferred

- Preference persistence and durable restart identity.
- More than eight device rows or device-to-bridge paging/filtering.
- Per-session GIF characters and LittleFS asset management.
- Editing pal/colors on the M5Dial.
- Passive-session identity; passive evidence remains aggregate.
- Remote/browser configuration surfaces.

## Implementation Plan

### Wave 0: Architecture and visual contract

**Owners:** Trogdor (lead), Pom Pom (RGB565 palettes and layout), Marzipan (documentation).
**Work:** Sign off schema, append-only species order, six palettes, carousel wireframes, summary wrap, and prompt precedence.
**Blocks:** Waves 1-3.

### Wave 1: Registry and API foundation

**Owner:** Strong Bad. **Reviewer:** Trogdor. **Tester:** Strong Sad.
**Status:** Complete.
**Work:** Catalog, hashing/collisions, record fields, `configure()`, status metadata, MCP tool, HTTP route, and API tests.
**Depends on:** Wave 0. **Blocks:** Wave 2.

### Wave 2: Bridge protocol projection

**Owner:** Strong Bad. **Reviewer:** Trogdor. **Tester:** Strong Sad.
**Status:** Complete.
**Work:** Ranked projection, `sv`/`ss`, UTF-8 byte clamps including `prompt.id`, whole-snapshot serialized-byte guard, deterministic degradation, BLE pending-snapshot coalescing, old-firmware fixture, and protocol docs.
**Depends on:** Wave 1. **Blocks:** Wave 3.
**Independent release:** Yes; new bridge with old firmware remains functional.

### Wave 3: Firmware parser and carousel

**Owner:** The Cheat. **Visual partner:** Pom Pom. **Reviewer:** Trogdor. **Tester:** Strong Sad.
**Work:** Fixed parser; five-color palette plumbing across the ASCII renderer, UI, and all 18 species files; pal/activity modes; carousel input; state mapping; stable selection; summaries; dots; and prompt precedence. Fast-spin suppression must occur before the global dizzy branch, with asleep-wake consumption and prompt-first encoder priority preserved.
**Status:** Complete.
**Depends on:** Wave 2 fixtures and Wave 0 visual contract. **Blocks:** V1 acceptance.

### Wave 4: Persistence evaluation

**Owner:** Strong Bad. **Decision owner:** Trogdor with Vadim sign-off.
**Work:** Define durable preference key and stale-data policy.
**Status:** Deferred until after V1 evidence.

## Success Criteria

1. Eight simultaneous top-level conversations hold independent pal, palette, summary, and state in status without changing aggregate counts.
2. The first 18 automatic concurrent conversations receive distinct species; each mapping is stable until explicit end, capacity eviction, or bridge restart.
3. MCP and HTTP enforce identical limits, reject invalid colors/species, cannot spoof `source`, and do not renew TTL through configuration.
4. With no projected rows, legacy snapshot output remains equivalent to current `buildSnapshot()` behavior.
5. Every fully serialized snapshot is measured as encoded bytes; normal candidates target at most 3,000 non-newline bytes, and escaped worst cases degrade deterministically to at most 4,095 non-newline bytes while preserving the legacy core.
6. Old firmware ignores `sv`/`ss` and retains legacy behavior; malformed or truncated frames leave the previous state unchanged and remain silent.
7. New firmware handles zero, one, and two-to-eight sessions as specified.
8. At the normal macOS BLE MTU, new waiting/blocked state normally becomes visible within one bridge tick unless the 15-second manual hold applies. The guarantee is weaker at the 20-byte fallback MTU or during mutation bursts, pending-snapshot coalescing prevents stale queue growth, and prompts remain modal.
9. No per-session canvas is allocated; eight fixed records consume approximately 608 bytes and `TamaState` grows by approximately 612 bytes, while the single 112.5 KiB canvas is reused.
10. All 18 species render under all approved palettes at 1x/2x without clipping, unreadable text, or semantic color loss.

## Tests and Backward Compatibility

Extend `bridge/test/sessions.js` with named coverage for resolved metadata, reset-to-default, configure-without-TTL-renewal, 18-session collision avoidance, explicit duplicate pal, unchanged ended-first/LRU eviction, and deterministic projection excluding ended rows.

Extend `bridge/test/mcp-roundtrip.js` to assert the new tool list, configure/status round-trip, invalid pal/palette/summary errors, unknown-session errors, and unchanged begin/state/end calls without pal fields.

Extend `bridge/test/http-api.js` for `/v1/session/configure` parity, source stamping, no TTL renewal, and the existing Host/Origin/content-type/body-limit/no-CORS gate before mutation.

Add:

- `bridge/test/session-projection.js`: exact `sv:1` fixture; state codes; blocked-first ranking; unique display IDs; 48-byte UTF-8 clamp; deterministic truncation above eight while registry/status retain all rows.
- `bridge/test/snapshot-budget.js`: ordinary unescaped maximum legacy fields plus eight maximum rows match the corrected approximately 2,702-byte payload; an escaped-worst-case fixture uses quotes, backslashes, and control characters in all entries and summaries, exercises legacy-aware degradation, preserves the core fields, and asserts the fully serialized payload stays at or below 4,095 non-newline bytes.
- `bridge/test/snapshot-backcompat.js`: **old firmware + new bridge** fixture parses only legacy keys and produces identical aggregate `TamaState`; new firmware fixture accepts a legacy heartbeat with no `sv`/`ss`.
- `firmware/test/test_session_protocol/test_main.cpp`: absent fields, one/eight rows, unknown future version, malformed rows, exact RGB565 values, all 18 index/name mappings, 4,095-byte accepted line, and 4,096-byte oversized handling for USB and BLE framing.
- `firmware/test/test_session_ui/test_main.cpp`: zero/one/many modes, rotary wrap, fast-spin three-step navigation, selection preservation, 15-second hold, state mapping, prompt precedence, and two-line 22-column wrapping.
- A slow-MTU BLE throughput test at a 20-byte payload that sends mutation bursts, verifies pending snapshots coalesce instead of queuing stale whole snapshots, and records the weaker delivery latency bound.
- Golden framebuffer fixtures for all 18 species in idle, busy, and attention under all approved V1 palettes at 1x and 2x.

Backward compatibility is a release gate. Wave 2 cannot ship until the old-firmware fixture passes. `_applyJson()` reads recognized keys only, so unknown top-level `sv` and `ss` fields are ignored (`firmware/src/data.h:76-133`). Wave 3 cannot ship until new firmware accepts both legacy heartbeats and `sv:1`. Aggregate core fields remain mandatory even after supported devices understand `ss`; removing them requires a separate protocol version and proposal.

## Implementation Notes

Waves 1 and 2 shipped the bridge-owned presentation catalog and palettes,
resolved registry metadata, atomic `configure()` semantics, MCP tool number 7,
the HTTP configure route, additive health/status metadata, ranked compact
`sv:1`/`ss` projection, UTF-8-safe summary and core clamps, the explicit
39-character `prompt.id` clamp, whole-line byte measurement, deterministic
degradation, and registry/API/projection/budget/backward-compatibility tests.
The implementation split the proposal's catalog module into
`sessions/species.js` and `sessions/palettes.js` so assignment and palette
validation remain independently testable.

The exact compact serializer measures **2,670 non-newline bytes** for the
ordinary maximum, rather than the proposal's approximate 2,702-byte estimate.
The estimate combined rounded component sizes; the checked-in compact JSON's
actual punctuation and field shapes are 32 bytes smaller. The escaped hostile
fixture initially exceeds the firmware ceiling, then deterministically degrades
to **2,999 non-newline bytes**, one byte below the 3,000-byte internal target.

Success criterion 4 is tighter in the implementation: when no live rows
project, the bridge omits both `sv` and `ss` entirely instead of emitting an
empty versioned roster. Legacy output is therefore byte-identical except for
the separately approved `prompt.id` clamp when that id exceeds 39 characters.

BLE snapshot coalescing now ships with the Wave 2 bridge behavior. Chunked
writes remain serialized, the active line always completes intact, and at most
one unsent snapshot waits behind it; a newer heartbeat replaces that stale
pending state. Time, owner, status, OTA, and transfer commands remain discrete
FIFO events and are never coalesced. Summary validation is also scalar-safe and
consistent across the registry, MCP, and HTTP: the shared contract replaces
isolated UTF-16 surrogates with U+FFFD, accepts at most 96 Unicode code points,
and leaves the wire projection's separate 48-byte clamp unchanged.

### Review record

On 2026-09-15, The Cheat reviewed the firmware-side claims and returned **APPROVED WITH CONDITIONS**. This revision incorporates condition 1 (escape-safe whole-line byte budgeting and degradation), condition 2 (honest all-species palette refactor scope), condition 3 (correct aligned RAM and shared-canvas accounting), and condition 4 (MTU-qualified BLE latency with pending-snapshot coalescing and slow-MTU coverage).

### Wave 3 implementation notes (firmware)

Wave 3 shipped the bounded parser, the per-session palette path, the carousel,
and per-session animation. Several details differ from the proposal text; each
is a deliberate decision, not drift.

**The palette refactor did not touch 18 species files.** The proposal
recommended threading five colors through every species renderer. That is not
what the code needed. All 18 species already paint their body with exactly the
RGB565 literal recorded in their own `Species::bodyColor`, and every draw call
funnels through `buddyPrintLine()` / `buddySetColor()` in `buddy.cpp`. Resolving
the palette in those two shared helpers makes `bodyColor` genuinely load-bearing
for the first time — the previously dead field is now the key that identifies
"this ink is the animal" — while keeping the diff surgical and leaving the art
untouched. Background follows `c[1]`, `BUDDY_DIM` follows `c[3]`, and the
reserved semantics (warning red, heart red, yellow, cyan, white highlights) pass
through unchanged, exactly as the proposal required. The rule itself lives in
`sessionMapColor()` in `session_pals.h` so it is host-testable, and
`firmware/test` asserts by source inspection that every species still paints
with its declared `bodyColor` — the invariant the whole path rests on.

**The session override does not disturb the user's pet.** `buddySetSessionPal()`
sets a separate species index rather than reusing `currentSpeciesIdx`, so the
saved "ascii pet" preference, its NVS value, and the settings readout are
unaffected and return intact when the card yields.

**A GIF character cannot be a session pal.** While the card owns home the device
renders ASCII even when a GIF is installed, because a GIF cannot be the species
the bridge assigned. Per-session GIFs remain deferred. The user's GIF returns on
every other screen.

**The idle clock yields to the card.** `clocking` now also requires zero
projected sessions. Without that, a roster of explicitly-idle sessions would
report `running == 0 && waiting == 0` and the clock would hide the pals.

**`DISP_ACTIVITY` is conditional.** It is skipped entirely in the button cycle
when no sessions are projected, so the pre-carousel order (home → pet → info) is
preserved exactly rather than gaining an empty screen. It also ignores the
`transcript` setting toggle, since reaching it is an explicit navigation.

**Cross-session urgency is carried by dots, chirp, and the full edge ring.** Any
current waiting or blocked row keeps the ring and chirp visible while another
pal is selected. A blocked row anywhere in the bounded current roster raises the
ring to the 200 ms cadence; waiting-only attention uses 400 ms. The selected dot
still identifies the browsed pal, so attention remains visible without making
color the sole urgency cue.

**Summaries are flattened before wrapping.** The built-in M5GFX font is
single-byte, so the stored UTF-8 summary is converted to one display column per
code point (non-ASCII becomes `?`, control characters become spaces) before
word wrapping. Counting code points rather than bytes is what keeps the 22-column
arithmetic honest; overflow ends in `..` rather than clipping at the round edge.

**Measured cost.** `sizeof(SessionPal)` is 76 bytes and `sizeof(SessionPalSet)`
is 610, matching the proposal's ~76/~612 estimates. A full build grew RAM by
**760 bytes** (91,552 → 92,312, 28.2% of 327,680) and flash by **3,900 bytes**
(1,268,849 → 1,272,749, 62.6% of 2,031,616). The extra RAM beyond the record set
is the carousel's selection key and the previous-state snapshot used for
attention edge detection. No canvas was added; the single 112.5 KiB sprite is
reused.

**Testing without a new stack.** `session_pals.h` carries no Arduino or M5
dependency, so `firmware/test/run-host-tests.sh` compiles it with a plain C++
compiler and asserts against wire lines produced by the real bridge pipeline
(`firmware/test/fixtures/generate.js`). 1,397 checks cover legacy snapshots, one
and eight sessions, over-cap truncation, malformed and hostile rows, duplicate
IDs, truncated lines, unknown schema versions, a 4,095-byte line, UTF-8 clamping
and validation, wrapping, selection persistence and removal, state mapping,
palette rules, and firmware/bridge catalog order. This replaces the proposal's
planned Unity-based `firmware/test/test_session_protocol` and
`test_session_ui` targets, which would have required a new PlatformIO test
environment and heavy Arduino mocking for the same coverage.

**Not covered by automated tests.** Golden framebuffer fixtures for all 18
species under all palettes at 1x/2x remain unimplemented; pixel output has not
been verified on hardware because the device is disconnected. The rendering
changes are therefore build-verified and logic-verified, not visually verified.


### 2026-09-16 completion-latch bridge implementation note

The bridge now owns a separate single-slot `CompletionLatch` at
`bridge/src/sessions/completionLatch.js`. It is deliberately outside the
registry and therefore outside session capacity, TTL, eviction, live counts,
ranking, and `ss`. `Bridge.completeTask()` snapshots resolved presentation and
task duration before returning the long-lived conversation to idle.
`Bridge.endSession()` only retires the conversation and never creates a
completion. Passive completion uses the source's startup-primed newest-turn edge
and produces an ownerless success slot only for a later timestamp.

Negotiation reuses status acks: integer `data.cl:1` enables stable process
epoch `sg` plus optional `sc={g,o,i,p,c,m,d}`; `i/p/c/m` are all-or-none,
and missing `sc` authoritatively clears. Capability resets per connection.
Dismissal requires exact epoch and generation. Semantic passive identities are
tracked separately for prompt, user message, tool start, and AI-request open,
so historical replay, file growth, token/model changes, and steady state cannot
accidentally clear or relatch.

The budget ladder now sheds projected sessions and entries before optional
completion duration and completed-pal metadata; `sg/sc.g/sc.o` are mandatory
core and an impossible fit throws. The legacy `ss` schema/version and all
aggregate fields are unchanged. The bridge implementation and deterministic
clock/epoch seams are covered in `bridge/test/completion-latch.js`.

**Firmware half is implemented.** `firmware/src/completion_latch.h` owns the dependency-free bounded mirror, legacy edge tracker, rollover-safe watchdog, presentation predicates, dismissal policy, and wake-consumption state machine. `completion_latch_json.h` is the strict ArduinoJson adapter; `data.h` applies snapshots atomically and clears on BLE falling edge or OTA begin; `main.cpp` owns rendering and the exact dismissal command.

The shipped visual order is OTA > passkey > prompt > blocked/waiting > completion > selected live pal > aggregate > sleep/idle. Success traverses the existing celebrate sequence once over 5.6 seconds and then uses an effect-free fixed final pose. Failed and aborted transition for 0.8s and 0.4s respectively and then freeze. Completion rendering never changes `selSessionId`, `selSessionIdx`, or `lastCarouselMs`, so the underlying carousel returns exactly where it was.

The wake fix is deliberately stateful rather than a one-frame mask: a button wake is consumed through release, and encoder/touch input must remain quiet for 150ms. This prevents a wake gesture from dismissing, navigating, changing prompt choice, or opening the menu without blocking the loop. Firmware advertises `cl:1` because parser, mirror, render, dismissal, retry, watchdog, legacy fallback, and host coverage are all present.

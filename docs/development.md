# Development and architecture

For a quick introduction and installation, start with the [README](../README.md).
Commands in this document run from the repository root.

**Current implementation:** GPT Image-generated sprites, with an ESP32 playback
engine and a native character review at **http://127.0.0.1:8765/character-preview.html**.
The earlier image-morphing atlas is retained only as a superseded comparison.

A quietly expressive desktop companion for the **Waveshare
ESP32-S3-Touch-AMOLED-1.75-B**: the supplied blue/violet Copilot artwork, deep
directional head turns, relaxed pauses,
and occasional asymmetric-timed blinks and double blinks. No scrolling text,
cloud service or Wi-Fi is required for standalone animation.
Optional local Wi-Fi carries daemon state when USB data is disconnected. Sound
cues require a compatible speaker, but all visual behavior works without one.

## Run on this Mac

```bash
cd ~/Desktop/projects/esp32-agent-companion
bash tools/arduino.sh build
bash tools/arduino.sh upload /dev/cu.usbmodem2101
```

**Uploading replaces the current firmware.** It does not erase the whole flash,
but the application and partition table change. Do not assume existing factory
application data remains compatible. This project never writes to the battery
charger configuration.

The current source uses a custom **2 MiB application partition** and a separate
**13.875 MiB character partition** that holds exactly one character pack. The
application is a shell: it contains no artwork or frame tables. A complete
upload writes the application, partition table, and default Copilot pack
together. Firmware verifies the pack's SHA-256 before animation starts. There is
no OTA slot or flash filesystem.

### 16 MiB is a hard ceiling, even on a 32 MB board

Some boards carry 32 MB of flash rather than 16 MB. **It does not help.** The
firmware can only *read* the low 16 MiB: the runtime cache addresses flash with
24 bits, so anything at or above `0x1000000` wraps back to offset 0. The
character partition already ends just below that line, so it cannot grow.

This was measured on hardware. A payload placed at `0xFF0000`, crossing the line
64 KB in, flashed and verified cleanly and even mapped successfully, but the
mapped bytes past the boundary were wrong -- the read at physical `0x1000000`
returned the bootloader's `0xe9` image magic instead of the payload.

**esptool cannot catch this.** Its stub does its own 4-byte addressing, so a
write to the upper half succeeds and `Hash of data verified` prints happily.
Only the running firmware sees the wrap. For a character pack that shows up as a
SHA-256 failure at boot, not at upload time; for any other new partition, verify
it by reading it back *on the device*.

The cause is that Arduino's ESP32 core ships precompiled ESP-IDF libraries built
with `CONFIG_ESPTOOLPY_FLASHSIZE_16MB=y`. Its sdkconfig has
`SOC_SPI_MEM_SUPPORT_CACHE_32BIT_ADDR_MAP=y`, so the hardware is capable, but
nothing enables it; `boards.txt` offering `FlashSize=32M` and esptool's
`--flash-size 32MB` only change the bootloader header. The MMU is not the
binding constraint -- `SOC_MMU_ENTRY_NUM` is 512 entries of 64 KB, and two
~9.5 MB packs plus PSRAM and the application measured about 448 of them and
mapped without complaint. The data was simply wrong.

That is why `tools/firmware_artifacts.py`, `tools/flash_release.py` and
`characters/copilot/tools/embed_sprites.py` all bound the layout at 16 MiB:
an oversized partition is rejected on the host rather than discovered on the
device.

The scripts use the existing Arduino IDE CLI, its configuration, and Waveshare's
bundled GFX library. Overrides: `ARDUINO_CLI`, `ARDUINO_CONFIG`, `WAVESHARE_DIR`.
Do not substitute a generic display library: the vendor version includes the
CO5300 panel driver and QSPI path this board needs.

### Reproduce the toolchain

- Arduino ESP32 core **3.3.10**
- Waveshare repository `https://github.com/waveshareteam/ESP32-S3-Touch-AMOLED-1.75`
- Vendor revision used: `e4344e70c2fa78a13e8a06566507f1ba8af6672a`
- Libraries: `examples/arduino/libraries/GFX_Library_for_Arduino`, version 1.6.4,
  and `examples/arduino/libraries/SensorLib`, version 0.3.1 (CST9217 touch)

On another machine, install Arduino CLI, configure the Espressif board URL,
install the pinned core, and clone the vendor repository:

```bash
arduino-cli config init
arduino-cli config add board_manager.additional_urls \
  https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json
arduino-cli core update-index
arduino-cli core install esp32:esp32@3.3.10
git clone https://github.com/waveshareteam/ESP32-S3-Touch-AMOLED-1.75.git .deps/waveshare
git -C .deps/waveshare checkout e4344e70c2fa78a13e8a06566507f1ba8af6672a
```

Set the three path overrides before running the build script. `ARDUINO_CONFIG`
should point to the configuration created by `arduino-cli config init`.
Python 3 is used for the core-version check; no Python packages are needed
to compile or upload the checked-in firmware assets.

### Arduino IDE settings

Open `firmware/AgentCompanion/AgentCompanion.ino`. Make the vendor GFX library available
to your sketchbook, then select:

| Setting | Value |
| --- | --- |
| Board | ESP32S3 Dev Module |
| CPU | 240 MHz |
| Flash | QIO 80 MHz, 16 MB |
| PSRAM | OPI PSRAM |
| Partition | Custom: sketch `partitions.csv` (2 MiB application plus sprite data) |
| USB mode | Hardware CDC and JTAG |
| USB CDC on boot | Enabled |
| Arduino core / event core | 1 / 1 |
| Core debug level | Error |
| Erase all flash | Disabled |

Hardware: 466 x 466 CO5300 AMOLED; QSPI CS=12, CLK=38, D0..D3=4..7,
RESET=39; vendor column offset=6. The `-B` variant is the standard board
with a protective case. USB data uses GPIO19/20 and is not repurposed.

Use the CLI workflow to upload: it builds the character packs, derives offsets
and size limits from the partition CSV, and includes the default Copilot pack.
An ordinary IDE sketch upload alone doesn't install a character; the device then
shows **No character installed** until the daemon pushes one. Build/upload
guards reject changed inputs or mismatched binaries rather than flashing an
incompatible set. `bash tools/arduino.sh upload-code PORT` updates only the
application and keeps the installed character, as long as the partition layout
is unchanged.

## Character packs

`tools/character_pack.py build` wraps each validated export into a
self-describing pack in `build/characters/`: a 256-byte header (id, display
name, layout, animation model, base/patch bounds, motion speed, walk cycle, and
SHA-256), the frame table, and the unchanged compressed RGB565 frames. The
format is documented at the top of that script. The daemon reruns this build
when a character's top-level files or a built pack change, before it lists or
installs characters (`daemon/src/character-build.ts`). A failed build is logged,
and the daemon keeps using the packs that are already built. Two layouts are supported:

- **Base/patch** (Copilot, 9,540,870 bytes; Claude, 1,818,488 bytes): one base
  image per reachable pose plus four blink patches around the eyes.
- **Full frame** (OpenClaw, 10,000,700 bytes): one complete image per pose and
  blink level, with a 12 FPS walk cycle on the Working track.

At boot the firmware reads the header, memory-maps only that pack from flash,
validates every table entry, and checks the SHA-256. Frames are decoded straight
from the mapped flash, so PSRAM holds only the framebuffers and the active
layout's decode caches. OpenClaw no longer needs an SD card or its PSRAM block
cache, and its cold blink frames no longer stall on card reads.

Install a pack with the daemon over USB or Wi-Fi:

```bash
npm run character openclaw
npm run character /path/to/custom.acpk
```

Over USB the daemon sends `u`; the device pauses rendering, erases the first
64 KiB of the partition, and answers `UPLOAD_READY max_bytes=N chunk=4096`. The
daemon then sends 4 KiB chunks and waits for `UPLOAD_ACK received=N total=N`
after each one, because the USB Serial/JTAG receive queue drops bytes when it's
full. Over Wi-Fi the daemon posts the pack to `POST /character` with the paired
bearer token and an exact `Content-Length`; the web server streams the raw body
into the same installer. Flash is erased 64 KiB at a time as data arrives. The
first 4 KiB sector, which holds the header, is written only after the whole
stream's SHA-256 matches, and the installed pack is then re-verified from flash.
Every attempt ends in a restart. A failed or interrupted install leaves no valid
header, so the shell boots without a character, reports `character=none` over
USB and in `GET /status`, and the daemon reinstalls the remembered character
(`character.json` beside `state.json`, default `copilot`).

Query the installed pack without changing it:

```bash
.venv/bin/python tools/device.py --character --seconds 6
python3 tools/character_pack.py validate build/characters/openclaw.acpk
```

## Preview and development

### Copilot CLI companion daemon

`daemon/` contains the TypeScript listener used by local AI-agent sessions.
Agent hooks send lifecycle JSON over a user-private Unix socket; the daemon
aggregates concurrent sessions and subagents, then writes bounded mode commands
through USB or a paired local Wi-Fi device. USB remains preferred and does not
toggle DTR/RTS or HUPCL.
Needs attention has global priority, followed by Working; Complete plays only
when the last active task finishes.

```bash
npm run setup
npm run agents
npm --prefix daemon test
npm run status
```

The daemon has adapter modules under `daemon/src/agents/`. Each adapter owns
detection, hook install/uninstall, hook status, and native-event normalization.
Hook file edits are read-modify-write and create a `.bak` beside a previous file
the first time the companion changes it. Our entries are identified by the
compiled `cli.js` path plus `hook <agent>` arguments, so reinstalling doesn't
duplicate commands and uninstalling doesn't remove another tool's hook.

| Agent | Install target | Event notes | Approval notes |
| --- | --- | --- | --- |
| Copilot CLI | `~/.copilot/hooks/agent-companion.json` | Existing v1 event names map directly. The old `hook <event>` command still works and is treated as Copilot. | Restart Copilot CLI after setup. |
| Claude Code | `~/.claude/settings.json` | `PermissionRequest`, `Elicitation`, and selected notifications become Needs attention. `AskUserQuestion` and `ExitPlanMode` are treated as waiting for the user. | Claude may ask for folder trust. |
| Codex CLI | `~/.codex/hooks.json` | `PermissionRequest` becomes Needs attention. `Interrupt` clears the session. Hook groups are appended so Codex trust keys for existing hooks don't shift. | Approve once with `/hooks`; status shows `needs-approval` until trust is visible. |
| Grok Build | `~/.grok/hooks/agent-companion.json` | Permission and elicitation notifications become Needs attention. `Stop` only completes when its reason is `end_turn`; channel shutdown clears. | Grok's hook directory is trusted. Claude hooks invoked by Grok are ignored when Grok's own hook is installed and enabled. |
| Hermes Agent | `~/.hermes/config.yaml` | `pre_llm_call` starts work, `pre_tool_call`/`post_tool_call` track tools, `pre_approval_request` surfaces attention, and turn `on_session_end` completes. | Hermes asks you to approve the shell hook the first time it runs. Don't pre-seed its allowlist. |
| OpenClaw | `<daemon data>/integrations/openclaw-plugin/` | Native plugin forwards lifecycle events directly to the daemon socket. Gateway WebSocket approvals aren't implemented yet. | Installer links/enables the plugin through `openclaw` only when the command is on `PATH`. |

Agent enablement lives in `agents.json` beside `state.json`. Missing entries
mean "enabled if detected", so setup monitors all detected agents by default.
The daemon checks this file when a hook arrives, which means `npm run agents
disable claude` takes effect immediately without editing Claude's settings.
Status includes per-agent detection, hook status, enabled state, last event time,
active session count, and the agents currently driving the display.

Agent badges are negotiated through device protocol 6. The firmware stays
agent-agnostic: the daemon sends icon data after connect or after a boot-id
change, then sends the current active list. Older protocol 5 devices only
receive state packets.

USB packets:

| Packet | Meaning |
| --- | --- |
| `%<id>:<RRGGBB>:<base64 mask>\n` | Defines or replaces an in-RAM icon. `id` is up to 16 `[a-z0-9-]` characters, color is badge fill, and the mask is 72 bytes for a 24 x 24 1-bit glyph. The device replies `ICON accepted=<id>`. |
| `&<id>=<w|a|c>,<id>=<w|a|c>\n` | Sets the active badge list in display order. `w` means Working, `a` means Needs attention, and `c` means Complete. `&\n` clears the list. The device replies `AGENTS accepted=N`. |

Malformed badge packets return `COMMAND_ERROR ...`. The firmware stores up to
eight icon definitions and eight active entries in RAM, protected by a short
critical section so USB/Wi-Fi updates on core 1 don't race the render task on
core 0. Rendering copies a snapshot once per frame, draws at most four badges,
and uses the same restore/damage tracking as the other character effects.

Wi-Fi exposes the same data as authenticated text bodies:

| Endpoint | Body | Notes |
| --- | --- | --- |
| `POST /icon` | the `%...` icon packet | Requires `Authorization: Bearer <token>`. |
| `POST /agents` | the `&...` active-list packet | `&\n` clears badges. |

`GET /status` includes the firmware `protocol` number so the daemon can skip
badge endpoints for older firmware. Badge visibility lives in `display.json`
beside `state.json` and defaults to on. The settings page exposes the toggle and
shows badge previews from the same 24 x 24 masks the daemon sends to the device.

Default glyphs live in `daemon/src/agent-badges.ts` as 24-line ASCII masks with
brand-evocative colors. They're hand-drawn pixel art, and some (like OpenClaw's
critter and Grok's ring) are simplified takes on the agent's own logo. Users can
override them locally with `<daemon data>/icons/<id>.png`; the dependency-free
decoder accepts 8-bit, non-interlaced grayscale, grayscale+alpha, RGB, and RGBA
PNGs and converts alpha or luminance to the mask. An optional adjacent
`<id>.json` can set `{ "color": "#RRGGBB" }`, the accent used for the glyph and ring on the dark badge.

### Settings page

The daemon serves a dependency-free settings page from `daemon/web/` at
`http://127.0.0.1:4667` (override with `AGENT_COMPANION_SETTINGS_PORT`).
`npm run settings` asks the daemon for the session link and opens it. The page
and CLI share `CompanionService`, so status, Wi-Fi setup, connection mode, and
character installs behave the same in both. Live status streams over
server-sent events from `/api/events`.

The server treats every request as potentially hostile because browsers let any
website send requests to loopback addresses:

- It listens on `127.0.0.1` only.
- It rejects any `Host` other than `127.0.0.1:<port>` or `localhost:<port>`,
  which blocks DNS rebinding, and any cross-site `Origin`.
- Every `/api/` call needs the random token from the link. It's passed in the
  URL fragment, stored in `sessionStorage`, and sent in the `X-Companion-Token`
  header. Only the event stream and thumbnail images, which can't set headers,
  accept it as a query parameter. The daemon reuses the token saved in
  `settings.json` when it restarts, so open tabs keep working; delete that file
  to issue a new one. A page opened without the link, or with an old one, shows
  only instructions to run `npm run settings`.
- JSON and upload routes require their exact `Content-Type`, uploads are capped
  at 16 MiB, and responses carry a strict CSP, `X-Frame-Options: DENY`,
  `nosniff`, and `no-store`.
- The link is written to `settings.json` in the daemon's private data
  directory, and the Wi-Fi password is never stored.

Characters added from the page are saved in `characters/` inside that data
directory and installed by id like the built-in ones; built-in ids can't be
replaced. Each pack's optional thumbnail PNG sits between the frame table and
the frame data, and the header records its offset and size at bytes 148-155.
Older firmware already accepts that gap and ignores those reserved bytes.

`npm run connection auto|wifi|usb` stores the transport preference in
`connection.json` beside `state.json`; `wifi` closes the serial port so a cable
supplies power only. The root `package.json` has no dependencies; its scripts call
`tools/companion.mjs`, which installs and rebuilds `daemon/` when needed and then
runs the daemon CLI. `npm --prefix daemon run ...` scripts remain available.

The installer writes detected-agent hooks and either a macOS LaunchAgent or
Linux systemd user service. On Windows, run both agent CLIs and the daemon inside
the same WSL distribution, with systemd enabled and the ESP32 USB serial device
attached to WSL; native Windows service installation is not currently supported.
Hook failures are intentionally ignored so a missing daemon or disconnected
device never blocks the agent. Restart running agent CLIs after changing hook
configuration. The hook path extracts only lifecycle fields before forwarding;
it doesn't send prompts, responses, source code, or tool arguments to the ESP32.

The daemon persists minimal lease metadata in
`~/Library/Application Support/ESP32 Agent Companion/state.json`, written
atomically with user-only permissions. Main-agent work leases last ten minutes;
attention and subagent leases last thirty minutes and are renewed by subsequent
events. Pre- and post-tool hooks renew main-agent work so a long build does not
expire immediately after it finishes. Expired leases return the aggregate to the
next valid state instead of leaving the display stuck after a crashed CLI. Hook
timestamps reject delayed main-agent or subagent events. Complete is
intentionally not recovered after a restart, preventing an old celebration from
replaying when the device reconnects. Subagent starts that provide only a shared
name are correlated with stops that later add a unique agent ID; stop events are
resolved against their parent lease, and legacy name-only leases are discarded
on restart so completed task agents cannot leave the display stuck in Working.

The preferred Wi-Fi provisioning path is
`npm run wifi "SSID"` while USB is connected. The CLI
reads the password without echoing it, sends it through the user-private daemon
socket, and the daemon forwards a base64-framed protocol 4 command over USB.
The ESP32 saves the credentials in the `agent-network` NVS namespace and returns
its existing device ID and random token over USB, allowing the daemon to pair
automatically without storing the SSID or password.

The on-device Settings screen remains the no-USB fallback. The ESP32 creates a
WPA2 access point whose eight-digit password is also a temporary pairing code. A
captive page at `192.168.4.1` saves the 2.4 GHz credentials. The access point and
pairing window expire after ten minutes. The device then advertises
`_agent-companion._tcp` through mDNS and responds to
`ESP32_AGENT_COMPANION_DISCOVER_V1` broadcasts on UDP 4666.

`npm run pair CODE` exchanges the displayed one-time
code for a random 128-bit device token. The daemon stores it in `wifi.json` beside
`state.json`, with user-only permissions. Runtime `POST /state` and `GET /status`
requests require `Authorization: Bearer TOKEN`; prompts, source code, and hook
payloads are never sent. The daemon first probes the last known address, then
uses UDP discovery if DHCP changed it. A boot identifier ensures the desired
state is resent after the ESP32 restarts without periodically replaying commands.
Networks with wireless client isolation must disable it or place both systems on
a LAN where local HTTP and UDP traffic is permitted.

### Character Lab

Run `python3 tools/serve_preview.py`, then open **http://127.0.0.1:8765**.
The browser displays frames rendered by the same C++ motion, sprite, and effects
code as the device. Each tab has its own isolated native process. The original
eight-direction study remains at `/sprite-preview.html`.

**Current deployed version:** the touch reaction uses a short spring recoil
instead of the long double-take. It briefly gets smaller while widening its eyes,
rebounds slightly, and settles in about 0.8 seconds once centered. Working has a
400 x 400 circular orbit, slow glances, and binary digits flowing through the top
edge; the three bottom activity dots are removed. Alternating attention tilts
remain unchanged. After two uninterrupted Idle minutes, Sleeping centers the
character, adds subtle side movement, slowly peeks through drowsy eyelids, and
alternates rising Zs between both sides for one minute. The device and native web
preview use the same implementation.

| Signal | Visual behavior | Duration |
| --- | --- | --- |
| Surprise | Quick uniform shrink and widening eyes, followed by a small damped rebound | About 0.8 seconds once centered, then resumes the previous persistent mode |
| Working | Normal-to-focused eyes, slow randomized side glances, tiny bidirectional binary streams and cyan orbit | Until another signal arrives |
| Complete | Happy crescent eyes, rising fireworks and falling confetti | One celebration, then idle |
| Needs attention | Alternating large/small eyes and slow questioning head tilts, with a breathing amber question badge | Until explicitly changed; a surprise does not dismiss it |
| Sleeping | Closed, slowly peeking eyelids, shallow side movement, and alternating rising Zs | Automatically after two Idle minutes; sleeps for one minute, then repeats |

Click/tap the character, or focus it and press Enter/Space, to trigger surprise.
Keys 1-6 select the six modes including Idle and Sleeping. Pause freezes both expression and
effects; the speed selector includes half and quarter speed for inspection.
On the physical device, a tap is recognized only after release so a swipe cannot
trigger Surprise first. A tapped Surprise returns to Idle after the spring,
regardless of the previous persistent state. Explicit Surprise signals retain
their existing resume behavior. Swipe up opens the settings menu for brightness,
0-100% sound volume, and character-state selection; swipe down or tap Close to
dismiss it. Sound defaults to 50% and is persisted in internal NVS.
All five non-Idle mode links are also available on `/sprite-preview.html`.
Transitions use shared-center artwork before switching tracks. The spring
reaction settles forward to its neutral final frame rather than reversing the impact.
Working stays visibly active during its slow, partial-depth side glances, then
returns to its focused expression.

The spring reaction reuses the approved eye-light rendering over the same head.
Uniform scale and small rigid recoil follow a damped impulse; there is no
nonuniform warping or crossfading. The 24 stored samples already contain the
physical timing, so native playback advances uniformly instead of applying a
second easing curve. Start and end match the shared neutral artwork at every
blink level. Original generated and earlier smooth surprise images remain intact.
Run `python3 tools/spring_surprise.py` to rebuild the active reaction.
Surprise/joy retain their defining expressions rather than interrupting them
with an unrelated eye closure.

An active blink finishes before entry. A new mode waits for the quick forward
settle, and repeated touches queue at most one fresh reaction at neutral.
The latest explicit mode wins without cutting between different head sizes.
Export rejects a surprise endpoint that is not the shared neutral, preventing
the archived recoil track from being paired with the new one-way playback.

Working adds eight miniature 5x9 cyan binary digits in four
lanes between the head and the physical top edge: two flowing inward and two
outward. Digit identities stay stable in transit, with smooth fades near the
head and offscreen recycling above the display. The four-second cycle wraps
seamlessly with the effect clock. The effect
continues through focused poses and side glances, alongside the orbit,
and uses the same fixed damage buffer without additional allocations. The three
bottom activity dots have been removed to reduce clutter.
The orbit uses equal 200-pixel radii (400-pixel diameter), replacing
the 183 x 148-pixel oval radii. It leaves more room around the head and stays
inside the display, including the full leading ball. Every Working pose retains
more than twelve pixels between its nonblack artwork and the largest ball.

## Audio cues

Five original 24 kHz, 16-bit mono PCM cues live under `assets/audio/`.
`tools/embed_audio.py` validates them and generates the application-flash arrays
used by firmware. Working, Needs attention, Complete, and Surprise play once when
the visible animation enters that mode; duplicate daemon reconciliation commands
do not replay a cue. Settings actions use the short tick. There is no continuous
Working loop.

`AudioPlayer` runs on a separate low-priority task, duplicates mono samples into
the ES8311 stereo I2S stream, and uses a one-item replacement queue so stale
sounds cannot accumulate. The NS4150B amplifier on GPIO46 stays disabled between
cues and whenever sound is Off. Codec or I2S initialization failures are logged
without stopping animation. The checked-in ES8311 driver retains Espressif's
Apache-2.0 SPDX headers and matches the driver in Waveshare's pinned example.

The board routes audio through MCLK GPIO42, BCLK GPIO9, WS GPIO45, playback data
GPIO8, and its two-pin speaker connector. A compatible external speaker is
required when the board or enclosure does not include one.

The character output spans 412 x 466 pixels at panel position (27, 0),
giving the 400-pixel orbit room for the balls themselves. The original 400 x 352
artwork keeps its exact pixels and physical location within a logical 412 x 352
sprite canvas. The exporter finds one shared nonblack rectangle across all
reachable poses: currently (32, 23), size 348 x 304. Only that rectangle is stored;
every pose and blink is checked to be black outside it. The streaming decoder
places reconstructed rows directly into their original position, with no image
scaling or row relocation. Black padding is initialized once per framebuffer;
effects restore their own pixels before each render.
The renderer's default output remains 412 x 352, while the 412 x 466 character
canvas adds vertical space for effects. Both frame caches are warmed before the
presentation clock and brightness fade start.
The wider buffers add 22,368 bytes total compared with the previous 400 x 466
buffers, and display transfers grow another 3%. In-place whole-frame row copies
and a full-canvas prediction pass both exceeded the hardware frame budget.
The cropped streaming path preserves the same output while sustaining 30 fps,
as measured below.

Needs attention holds each curious side for 2.2-4.2 seconds, then eases through
center to the opposite tilt. The original attention track remains untouched.
An additional 24-pose track swaps only its eye-light layers and counter-rotates
the complete head, preserving the original shell, lighting, and eye shapes.
The question badge and waiting state remain active throughout; repeated attention
signals do not restart the cycle. Run `python3 tools/alternate_attention.py` to
rebuild the alternate track. No new AI generation is used for either refinement.

Effects write only to black background pixels, with additional face protection.
Each framebuffer records its small effect footprint so it can be cleared without
copying the entire image. The fixed effects workspace is 32,816 bytes.
The art was reviewed in this web app before device deployment; generated shading
still has minor frame-to-frame variation rather than mathematically rigid 3D geometry.

```bash
bash tools/test_character.sh
bash tools/test_working_bits.sh
bash tools/test_device_inputs.sh
python3 -m unittest discover -s tests -p test_smooth_surprise.py
python3 -m unittest discover -s tests -p test_spring_surprise.py
python3 -m unittest discover -s tests -p test_alternate_attention.py
NODE_PATH="$(npm root -g)" node tests/character-preview.browser.cjs
```

### GPT Image sprite-sheet experiment

`tools/generate_sprite_sheet.py` reads `AI_IMAGE_ENDPOINT`, `AI_IMAGE_API_KEY`
and `AI_IMAGE_MODEL` from `~/.env` at runtime. It sends the original supplied
artwork to the configured Azure image-edit endpoint as a visual reference.
Credentials are never copied into this project or logged.

```bash
python3 tools/generate_sprite_sheet.py
python3 tools/prepare_generated_sprites.py
```

The selected second pass uses an explicit angle/layout guide:

```bash
python3 tools/create_sprite_guide.py
python3 tools/generate_sprite_sheet.py \
  --prompt characters/copilot/source/sprite-prompts/right-turn-refined.txt \
  --guide characters/copilot/source/generated-sprites/right-turn-layout.png \
  --output characters/copilot/source/generated-sprites/right-turn-refined-sheet.png
python3 tools/prepare_generated_sprites.py \
  --source characters/copilot/source/generated-sprites/right-turn-refined-sheet.png
```

Requests use 1536 x 1024, high quality, PNG, one image per request. Original
generated sheets, prompts, provenance, and hashes are retained under
`characters/copilot/source/generated-sprites/` and `characters/copilot/source/sprite-prompts/`.

The sprite review page defaults to one generated frame at a time, using the exact
reverse sequence to return to center. It never applies image warping.
Registration only translates and uniformly scales each whole sprite to correct
camera drift; it does not reshape the head. The expanded review now includes
**right, left, up and down**, with 24 poses per direction and one identical
approved center image. Vertical tracks preserve apparent width rather than
forcing constant height, retaining pitch foreshortening.

The same preview also includes **up-left, up-right, down-left and down-right**
as newly generated, reference-guided GPT Image sprite sheets. Each has 24
combined yaw/pitch poses and localized blink variants, using the same approved
center as the cardinal tracks. The former firmware-atlas diagonals were rejected
for visible morphing and are no longer referenced by the current manifest.
Raw generations, prompts, guides and API provenance remain under `assets/`.

All eight directions are available in buttons, the queued track selector,
random playback and the review cycle. Straight up/down remains capped at 50%;
the new diagonals use their full generated sequences. Requested diagonal angles
run up to 46 degrees yaw and 23 degrees pitch; these are prompt targets, not
measured rotations. The preview displays the current track's artwork source.

The player adds randomized look-around timing, queued direction requests,
complete reverse returns, and an all-direction review cycle. Track changes
occur only at the shared center. Long stalls do not fast-forward a gesture;
playback advances at most one pose per rendered update. Pause, frame inspection,
timing changes and resume retain the selected pose.
Up/down playback uses 50% of the original travel range in random, queued and
review modes (through frame 12 of 24, rounded down to a whole sprite).
Left/right travel is unchanged. All images remain intact and available for
explicit inspection, including the deeper vertical poses.
The duration control specifies a full-range turn. Shorter looks scale duration
by the square root of their relative travel, so reduced vertical motion does
not stretch fewer poses over the same long interval. Fractional timing carries
between adjacent poses, avoiding refresh-rate-dependent rounding at every step.
Sprites are decoded before playback; unchanged telemetry and controls are not
rewritten on every animation tick.

**Crossfade between frames** is an optional, default-off browser control.
It blends the current and adjacent pose at the same eyelid level, using the
existing motion progress; toggling it never restarts or changes the timeline.
Only the current direction is blended, and vertical travel limits still apply.
Pause freezes the blend; explicit frame inspection shows an unblended original.
Screenshots capture the displayed blend, and copied feedback records its setting
and frame weights. This is opacity blending, not shape morphing: it can reduce
stepping but may introduce ghosted edges. No image assets or firmware are changed.

Generate and stage diagonal sheets without regenerating cardinal images:

```bash
python3 tools/create_diagonal_guides.py
# Repeat the generation command for up_right, up_left, down_right, down_left.
# Generation is a paid API operation; preparation/review below is local.
python3 tools/generate_sprite_sheet.py \
  --reference characters/copilot/source/generated-sprites/approved-center.png \
  --guide characters/copilot/source/generated-sprites/up_right-generated-layout.png \
  --prompt characters/copilot/source/sprite-prompts/up_right-generated.txt \
  --output characters/copilot/source/generated-sprites/up_right-generated-sheet.png
python3 tools/prepare_generated_diagonals.py
SPRITE_ASSETS=build/generated-diagonals python3 -m unittest discover -s tests -p 'test_sprite_assets.py'
# After inspecting the contact sheets and blink masks:
python3 tools/prepare_generated_diagonals.py --publish
```

Preparation isolates colored heads from neutral sheet labels, then applies only
uniform scaling and translation. Eye components are matched between adjacent
poses to avoid blinking a nearby goggle rim instead. The old image files stay
intact; new filenames are copied first and the manifest is replaced last.
The full `prepare_sprite_animation.py` pipeline now uses generated diagonals,
never the native exporter. `prepare_device_diagonals.py` is retained only as a
superseded experiment; do not run it to rebuild the current review.

All generated tracks use four pre-baked eyelid closure levels around each visible eye,
not another AI redraw of the whole head. Pixels outside the eye neighborhoods
and the outer silhouette stay unchanged. At the deepest downward angles the
eyes are hidden or clipped against the visor rim; those frames intentionally
reuse the open image rather than painting over the rim. There are occasional
double blinks, plus manual blink and automatic-blinking controls.
Blink timing is independent of head motion: a blink never pauses a turn, and
reopening displays the current pose rather than restoring an earlier one.

Rebuild the full animation assets after generating the directional sheets:

```bash
python3 tools/create_direction_guides.py
# For each direction: left, up, down. Image generation is a paid API operation.
# Left uses only the approved center and its guide; up/down also use
# --reference characters/copilot/source/generated-sprites/right-turn-refined-sheet.png.
python3 tools/generate_sprite_sheet.py \
  --reference characters/copilot/source/generated-sprites/approved-center.png \
  --guide characters/copilot/source/generated-sprites/left-turn-layout.png \
  --prompt characters/copilot/source/sprite-prompts/left-turn.txt \
  --output characters/copilot/source/generated-sprites/left-turn-sheet.png
python3 tools/prepare_sprite_animation.py
python3 -m unittest discover -s tests -p 'test_sprite_assets.py'
```

`characters/copilot/sprites/animation.json` contains direction/frame references, eye
bounds, closure images and the shared-center hash. The raw left-sheet first
attempt is retained as `left-turn-rejected-wrong-direction.png`: it turned right
despite its instructions and was not selected. Prompt angle labels describe
requested angles, not measured physical rotations.

The browser PNG directory is not copied directly to flash. The firmware exporter
converts the selected manifest into compressed RGB565 poses and small blink
patches; see the firmware section below.

GPT Image does not guarantee temporal identity or precise angular increments.
This is a quality experiment, not a claim that generative images alone solve
smooth character animation. Judge the actual neighboring frames in the preview.

### Local server and retained morph experiment

```bash
python3 tools/serve_preview.py
```

Open **http://127.0.0.1:8765** for Character Lab, or `/sprite-preview.html` for the detailed generated-sprite study.
The superseded experiment remains at `/morph-studio.html`. That Motion Studio runs the previous C++ atlas-based
motion engine and renderer in a persistent native process; the browser displays
its RGB565 frames. It is not an approximation of the animation in JavaScript.

Controls include eight queued look directions, automatic looking, an
all-directions round-trip test, quarter/half speed, pause, single-frame stepping,
and a separate paused pose/blink inspector. Look requests complete the current
gesture and pass through center rather than cutting to the requested pose.
The turn-depth trace and largest-frame-step readout help locate discontinuities.
Replay a seed, save a screenshot, or copy feedback with the exact simulation time.
Each browser tab gets its own native animation process, so opening a second
preview cannot reset or change the first tab's motion.

The server binds only to loopback and needs Python 3, `clang++`, and the host's
standard zlib library, but no Python packages. `--port` selects another port.
Stop it with Ctrl+C. Browser preview validates motion and image transitions,
not physical AMOLED scanout or ESP32 frame throughput.

### Legacy offline preview and atlas regeneration

Open `preview/index.html` directly in a browser. The animated WebP is an
18-second **deterministic sample of the previous C++ atlas renderer**, not a separate
JavaScript approximation. It is offline, honors reduced-motion preferences,
and includes a pause button. Device randomness is seeded from `esp_random()`,
so the device will not repeat the preview sequence.
`preview/turn-contact-sheet.png` and `preview/turn-directions.webp` show the
full pose range separately from the random animation.

To regenerate the image assets or preview:

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements-art.txt
.venv/bin/python characters/copilot/legacy-atlas/tools/prepare_turn_atlas.py
.venv/bin/python tools/preview.py
bash tools/test.sh
```

Preview generation also requires `clang++` (Xcode Command Line Tools on macOS),
and temporarily writes approximately 152 MB of raw frames inside `build/`.
The compressed pose atlas and its metadata are included; ordinary builds do not need
asset-generation dependencies.

## Generated-sprite firmware

Regenerate the display-ready firmware assets after changing any selected sprite or
the browser manifest:

```bash
python3 characters/copilot/tools/export_sprite_firmware.py
python3 tools/character_pack.py build
bash tools/run_sprite_motion_tests.sh
bash tools/test_sprite_renderer.sh
python3 -m unittest discover -s tests -p 'test_sprite_firmware_assets.py'
bash tools/arduino.sh build
bash tools/arduino.sh upload /dev/cu.usbmodem2101
```

Export requires the art dependencies, including pinned `zopfli==0.2.3.post1`
from `requirements-art.txt`; use the project virtual environment when regenerating
assets. Embedding and ordinary builds use
the exported binary and generated metadata. Stale source assets are rejected
rather than silently uploading an older sprite set.
The exporter checks the packed payload against its flash budget. Poses are
pre-scaled offline to the original 400 x 352 display region within the logical
412-pixel row stride. Shared black borders are then cropped without changing
any displayed pixels. The deployed thirteen-track payload is **9,526,790 bytes**,
down from 13,776,811 bytes: **4,250,021 bytes saved (30.85%)**, with
**5,022,202 bytes free** in the character partition. The largest decoded eye patch remains
14,904 bytes. Its SHA256 is
`ca175574c42c39d0c40b07a2d484cf9a7b463f721eb911c292e1187d8f1764e3`.
Install changed artwork with a full upload or `npm run character copilot`.

- Thirteen tracks remain: eight idle directions and five expression tracks,
  including the alternate attention tilt. Firmware stores 288 reachable poses:
  12 each for up/down and 24 for every other track. Only up/down indices 12-23,
  already beyond the motion engine's travel limit, are omitted. This saves
  938,011 bytes before compression changes. No active animation samples,
  diagonals, expressions, or blink levels are removed. All original PNG poses
  remain in the detailed sprite study. Compact track offsets/counts reject
  unavailable poses explicitly.
- Each RGB565 word is losslessly predicted from the word above it using
  subtraction modulo 65536, then compressed with Zopfli (one iteration,
  standard zlib format). The first row uses a zero predictor; every base/patch
  starts independently. Export uses a validated, atomic cache under ignored
  `build/sprite-compression/` to avoid repeating expensive compression.
  There is no palette reduction, quantization change, or lossy codec.
  Four blink levels are rectangular patches over each open pose,
  not four additional full images. Identical blocks are deduplicated.
- `SpriteMotion` ports the preview's discrete timing: random directions avoid
  immediate repetition, target depth and holds vary, returns retrace adjacent
  poses through center, and shorter looks finish sooner. Fractional timing is
  retained while stalls cannot advance more than one pose per rendered update.
  A single-entry edge-duration cache avoids repeated inverse-easing calculations
  without changing the motion formulas or allocating a lookup table.
- Blinks advance independently while the head continues moving. The hardware
  seeds randomness from `esp_random()` at startup. No network is involved.
- The exporter preserves the spatial bilinear filtering used by the earlier
  device renderer. A 32 KiB internal-RAM DEFLATE history preserves filtered bytes
  while a separate 824-byte row buffer reconstructs pixels and copies row spans
  into the destination framebuffer. This avoids mutating inflater history or
  making a second full-image pass through PSRAM. `SpriteRenderer` applies the
  selected eye patch in display byte order. It never
  blends different poses or uses the browser's optional crossfade.
- Per-framebuffer render keys avoid decoding or copying unchanged poses. Each
  output keeps only a small original-eye patch for reopening; there are no
  full-size decoded or working sprites in SRAM and no third PSRAM frame cache.
  Persistent workspaces avoid allocation in the animation loop. Core 0 renders;
  core 1 transfers complete big-endian RGB565 buffers to the display through the
  existing DMA staging path. Presentation is paced independently of rendering,
  so cached frames cannot arrive early and newly decoded poses late. The target
  remains 30 displayed frames per second.

The optimized eight-track idle baseline completed a five-minute device soak:
all 59 reports were **30.0 fps**, the maximum presentation interval was
**33.345 ms**, and maximum rendering time was **31.44 ms**. Internal free heap
stayed at 256,672 bytes, its largest block at 212,980 bytes, and free PSRAM at
7,812,340 bytes. Minimum remaining render/display stack was 15,072/5,900 bytes;
the on-device heap integrity check passed. These are baseline measurements,
not a substitute for rechecking new emotional modes and effects.
Repeated USB diagnostics also showed two stable capture cycles, but a later
capture lost its USB connection; that transport interruption is not evidence
of a memory leak or proof that every diagnostic path is stable.

Host renderer tests reconstruct all 1,440 reachable pose/eye states, check exact source
RGB565 pixels, shared centers, both independent output caches, complete reopening,
buffer guards and recovery after a partially failed decode
under address/undefined-behavior sanitizers. Motion tests also compare deterministic
C++ and JavaScript traces and verify allocation-free updates. Actual display throughput and
panel appearance must also be checked after uploading. The driver does not
synchronize to panel TE, so software buffering is not a guarantee of tear-free
physical scanout.

The compact lossless build immediately before Sleeping was added completed a
five-minute mixed-mode run:
all 60 reports were **30.0 fps**, with a maximum normal presentation interval
of **33.346 ms**, also the lifetime maximum at the final check. All five modes,
both attention tilts, and a Working side glance were observed. All 60 memory
reports held **184,624 bytes** free internal heap, **139,252 bytes** as the largest
internal block, and **7,614,224 bytes** free PSRAM. Minimum remaining render/display
stack was **14,924/5,612 bytes**; heap integrity passed. Captured on-device artwork
for Working, Attention (including closed eyes), Surprise, and Complete matched
the decoded reference pixels exactly. The device was returned to automatic Idle.

The pre-compression spring/circular-orbit version with 412 x 466 output completed a
five-minute mixed-mode run: all 60 reports were **30.0 fps**, with a maximum
normal presentation interval of **33.345 ms**, also the lifetime maximum at
the final check. All five modes, both attention tilts, and both working-glance
directions were observed. All 60 memory reports held **218,264 bytes** free
internal heap, **172,020 bytes** as the largest internal block, and
**7,614,224 bytes** free PSRAM. Minimum remaining render/display stack was
**14,940/5,612 bytes**; heap integrity passed. Device captures confirmed the
spring shrink and widened eyes, the circular Working orbit, and the full-height
binary streams. Surprise resumed Attention and Complete returned to Idle.
The device was returned to automatic Idle after the soak.

The previous 400 x 466 full-height version completed its own five-minute mixed-mode run:
all 60 reports were **30.0 fps**, and the maximum measured normal presentation
interval was **33.348 ms** (33.349 ms over the device lifetime at the final check).
All five modes, both attention tilts, and both working-glance directions were
observed. All 60 memory reports held **218,272 bytes** free internal heap,
**172,020 bytes** as the largest internal block, and **7,630,608 bytes** free
PSRAM. Minimum remaining render/display stack was **14,956/5,612 bytes**;
heap integrity passed. The device was returned to automatic idle afterward.

The earlier thirteen-track deployment with 352-pixel-high output completed a five-minute mixed-mode run:
all 60 reports were **30.0 fps**, maximum normal presentation interval was
**33.346 ms**, and internal free heap stayed at **218,272 bytes** with
**7,810,832 bytes** free PSRAM. Heap integrity passed. Both attention tilts,
both working-glance directions, and three additional physical touches were
observed during the measured window. The soak harness now accounts for physical
touches alongside its twelve scripted signals rather than treating them as
unexpected commands. These measurements precede the double-take and full-height
binary-stream implementation.

## Legacy atlas experiment (not current firmware)

- Uses the frontal, three-quarter, profile, upward and downward views from
  the supplied sheet. Left-facing views are mirrored. Pale backgrounds are
  removed while preserving the blue/violet shading and antialiased edges.
- Deep looks reveal the side shell, top dome, and underside rather than simply
  distorting a front-facing texture. Landmark-aligned image morphs synthesize
  33 poses in each of eight directions. Neighboring poses are blended at
  runtime for continuous motion between stored samples.
- This is **multi-view image interpolation**, not a fully reconstructed 3D
  model. Missing geometry is approximated between reference views; there is
  no claim of physically exact hidden surfaces or measured yaw/pitch angles.
- Independent emissive eyes follow per-pose position, size, angle, and visibility,
  so the far eye disappears during a deep side turn. Blinks close quickly, hold briefly, and reopen
  more slowly, with occasional double blinks and blink-on-turn behavior.
- Quintic easing gives head and eyes zero velocity and acceleration at the
  ends of each move. Eyes lead the head by about 90 ms. Weighted randomized
  targets include left, right, up, down and diagonals. Changes of direction
  pass naturally through center instead of abruptly switching view tracks,
  with varied dwell times rather than a metronomic loop.
- Pose images use per-frame RGB565 palettes and zlib compression. Two neighboring
  decoded index buffers and palettes live in internal SRAM. The ESP32's ROM
  decompressor and a persistent workspace avoid allocating during animation.
- Two complete, display-byte-order RGB565 frame buffers live in PSRAM
  (about 550 KiB). Core 0 decodes and composites the head and eyes.
  Core 1 uploads completed frames through a preallocated DMA staging buffer.
  The display never receives a partially rendered software buffer.
- Animation uses monotonic 64-bit time, not frame counts. The target is
  **30 fps**. Actual sustained throughput is
  reported over USB serial.
  The vendor driver does not synchronize transfers to panel TE, so software
  double buffering does not constitute a guarantee of panel-level tear-free
  scanout.
- Playback advances by at most one nominal frame per rendered image. A delayed
  frame or diagnostic capture therefore slows/pauses the gesture rather than
  skipping ahead to center when rendering resumes.
- No per-frame allocation, blocking animation delays, or flash writes.
  Brightness fades in at startup.

`firmware/AgentCompanion/build_opt.h` enables `-O3` and the vendor QSPI chunk size for
both CLI and Arduino IDE builds. Do not remove it when copying the sketch.

For current firmware, tune display brightness (0..255), target frame rate and SPI
clock in `Config.h`, and sprite motion in `SpriteMotion.cpp`. The following
atlas-specific settings apply only to the old experiment. Turn depth comes from the
atlas endpoints and `Motion.cpp`'s target magnitude, not a 2D warp angle.
The pose landmarks and eye locations are calibrated to this supplied artwork.
The current source initializes CST9217 touch for character taps. The IMU remains
unused. Touch uses SDA15/SCL14, interrupt11, reset40, and the vendor's mirrored
XY orientation, with pixel bounds 0..465.

## Diagnostics and recovery

Use the non-resetting observer below rather than an ordinary serial monitor.

Every five seconds, `PERF` reports displayed fps, rendering and transfer time,
maximum render time, and free PSRAM. `STAGES` breaks down the last frame's
motion, decompression, open-eye cache copy, eye rendering, and effects time.
`PACING` reports minimum/maximum presentation intervals rather than relying on
average fps alone. `MEM` reports current/minimum internal heap, largest internal
free block, free PSRAM, and both tasks' minimum remaining stack. All memory and
stack values are **bytes**, as defined by the pinned ESP-IDF headers.
USB diagnostics use a preallocated transmit buffer, zero write timeout, and
whole-message capacity checks. A missing/slow reader drops diagnostic messages
instead of blocking animation; `dropped_logs` makes that backpressure visible.
`INFO max_gap_us` retains the worst normal presentation interval since boot.
Explicit framebuffer captures are excluded from that lifetime interval because
they intentionally pause animation.

`INFO patch_internal` counts the blink buffers (two open-eye caches and one
patch, each `maxPatchPixels` × 2 bytes) that fit in internal RAM, and
`startup_internal` is the internal heap free just before they were allocated
(218,696 bytes on the current build). A buffer goes in internal RAM only while
`kPatchInternalReserveBytes` (176 KiB) stays free, because the render task, Wi-Fi,
and TCP/IP take about 130 KB afterward and Wi-Fi needs about 40 KB spare while
running. Firmware before this rule kept all three buffers in internal RAM, so
Claude's 14,100-pixel patches left 3.5 KB free and every Wi-Fi packet failed with
`ENOMEM`. Measured on hardware, Copilot now keeps two buffers internal and Claude
one. Both run at the same frame rate as before and keep at least 43 KB free.
`INFO patch_ram=adaptive` and `"patchRam":"adaptive"` in `GET /status` advertise
this, and the daemon refuses packs with patches over Copilot's 7,452 pixels on
firmware that doesn't.

`INFO wifi_connected` and `ssid_b64`, and `"ssidBase64"` in `GET /status`, report
the Wi-Fi network the device is set up for. The name is base64 because it can
contain spaces, quotes, or any other byte. The settings page's Status card and
`npm run status` show it under the connection. The daemon only relays it and
never stores it. Older firmware omits these fields, so no network line appears.
Allocation, panel startup,
and renderer-stall errors print `FATAL` rather than silently continuing.
If a panel is unstable at 80 MHz, lower `kSpiFrequency` to 40000000 and rebuild.

For tooling, sending the single serial byte `s` captures a completed framebuffer.
`CAPTURE_POSE` identifies its direction, zero-based sprite index and blink level.
The image protocol then sends:
ASCII `FRAME_BE 412 466 383984\n`, followed by exactly 383984 big-endian RGB565
bytes, then `\nEND_FRAME`. Place the captured region at (27, 0) on a black
466 x 466 canvas. The observer also accepts the deployed
`FRAME_BE 400 466 372800\n` format at (33, 0), and the older
`FRAME_BE 400 352 281600\n` format at (33, 57).
Diagnostic capture temporarily interrupts animation while
USB transfers the frame; do not request it continuously.

A bounded health check and PNG capture are also included:

```bash
.venv/bin/pip install -r requirements-device.txt -r requirements-art.txt
.venv/bin/python tools/device.py --seconds 60 --capture preview/device-capture.png
# A five-minute memory/pacing soak; initial warmup is logged separately.
.venv/bin/python tools/device.py --warmup-seconds 30 --seconds 300 \
  --check-memory --max-gap-ms 35 --log build/device-soak.log
```

The command fails on runtime errors, missing telemetry, or five-second
frame-rate reports below 29 fps. Capturing a frame proves the MCU's rendered
output, not the physical panel's orientation, brightness, or scanout quality.
On macOS/Linux this observer leaves DTR/RTS untouched and disables hang-up
line dropping, so opening/closing it does not intentionally reset the ESP32.
Ordinary serial tools that toggle those lines can reboot the board and make
the character suddenly reappear at center.

`--check-memory` requires at least three memory reports, checks exact heap
stability by default, requires internal-heap/stack headroom, and requests an
on-device heap integrity check (`h`) after the measured interval. A bounded soak
can find leaks or fragmentation but is not proof that every possible execution
is leak-free. `--memory-tolerance` explicitly permits a measured variation; the
default is zero. Warmup records remain visible and are marked in the log.

### Character event protocol

New character firmware accepts `!idle\n`, `!surprise\n`, `!working\n`,
`!complete\n`, and `!attention\n`. Packets are bounded and time out after one
second of inactivity. `COMMAND accepted=...` acknowledges queueing;
`STATE mode=... requested=... event=...` distinguishes the visible mode from a
pending transition. The single byte `i` reports protocol version, uptime,
reset reason, current/requested mode, character pack size and id, and Wi-Fi
status. Protocol 3 adds local Wi-Fi transport, protocol 4 adds USB Wi-Fi
provisioning, and protocol 5 replaces the SD OpenClaw upload with character-pack
installation (`u`). Protocol 7 adds a USB Wi-Fi scan (`w`): the device
scans without blocking the render loop and replies with up to 30
`WIFI_NETWORK rssi=<dBm> secure=<0|1> ssid_b64=<base64>` lines, then
`WIFI_SCAN_END count=N` or `WIFI_SCAN_ERROR <reason>`. A join attempt in
progress pauses for the scan and resumes when it ends. The settings page reads
the merged list from `GET /api/wifi/networks`. While the device reports a saved
network that it hasn't joined, the daemon re-reads `i` every five seconds so the
status updates when the join finishes. The boot banner `READY: ... character=ID` also tells the
daemon about software restarts, which keep the USB port open.

The observer negotiates protocol support before sending a mode packet, so it
does not accidentally trigger legacy capture commands on older firmware:

```bash
.venv/bin/python tools/device.py --mode working --seconds 15
.venv/bin/python tools/device.py --mode attention --seconds 15
.venv/bin/python tools/device.py --mode complete --seconds 15
.venv/bin/python tools/device.py --mode surprise --seconds 15
```

These are explicit local triggers for a later Copilot CLI connection, not an
automatic CLI integration. New behaviors must be reviewed in the web preview
before uploading them to the device.

If the board is not detected, use `arduino-cli board list` to find its new port.
Close any serial monitor before uploading. If necessary, hold BOOT while
resetting, release BOOT, and upload to the newly appearing USB port.

The existing Waveshare repository contains factory-recovery documentation and
images. Use its exact full-image recovery procedure for this board rather than
flashing a factory image through this project's application-upload command.
This project does not modify that repository or its factory image.

## Artwork

Source: [GitHub brand mascot sheet](https://brand.github.com/_next/static/media/mascots-02.51566f45.png).
The source image is preserved in `characters/copilot/source/copilot-source.png`.
SHA-256: `a93a701f4ce2d99129735fee1f19812646fd06d19b4ed248b89e3e83f159d31e`.

GitHub Copilot artwork and marks belong to GitHub. This project does not
relicense them or imply endorsement. Review the applicable
[GitHub brand guidance](https://brand.github.com/) before distributing or
publishing the artwork or modified animations.

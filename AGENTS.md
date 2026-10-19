# Agent instructions

Agent Buddy is an ESP32-S3 desk companion that shows what coding agents (GitHub
Copilot, Claude Code, Codex, Grok, Hermes, OpenClaw) are doing, plus a desktop
app that shows the same character. Start with [README.md](README.md); the
architecture, hook formats, and serial protocol are in
[docs/development.md](docs/development.md).

## Layout

| Path | What it is |
| --- | --- |
| `firmware/` | Arduino firmware for the device |
| `daemon/` | Companion service (TypeScript, Node.js 24): agent hooks, USB and Wi-Fi transport, Settings |
| `desktop/` | Tauri desktop app and the WebAssembly engine; `desktop/apps/desktop/scripts/bundle-daemon.mjs` bundles the service into it |
| `characters/` | Built-in character sources; `tools/character_pack.py` builds `.acpk` packs |
| `tools/` | Build, packaging, flashing, and release scripts |
| `tests/` | Python and native renderer tests |

## Tests

Run the smallest set that covers a change:

- Companion service: `npm test` in `daemon/`
- Desktop app: `npm test` in `desktop/` (its parity tests need `clang++` and built packs), and `cargo test` in `desktop/apps/desktop/src-tauri`
- Python tools: `python -m unittest discover -s tests -p 'test_*.py'`
- Native renderer and firmware logic: the `tools/test*.sh` scripts that `.github/workflows/build.yml` runs

On Windows, set `AGENT_COMPANION_BUILD_SERIALPORT=1` to also build and load the
patched serialport binding (`desktop/engine/test/serialport-windows.test.mjs`);
it needs Visual Studio's C++ build tools and Python.

## Releases

Publish a release only with the **Release** workflow
([`.github/workflows/release.yml`](.github/workflows/release.yml)): Actions,
**Release**, **Run workflow** on `main`, with the next version without a `v`
(for example `0.14.17`). Nothing is needed locally on any OS. Details are in
[docs/releases.md](docs/releases.md).

- Don't edit `VERSION` or `CHANGELOG.md` by hand, and don't create or push `v*`
  tags yourself. The workflow runs `tools/release.py`, which updates both files
  with a pinned `git-cliff` (`requirements-release.txt`), commits, tags, and
  pushes atomically.
- The workflow then starts **Build and Release** on the tag, because a tag that a
  workflow's token pushes starts no workflow by itself. That run publishes the
  GitHub release once every job passes.
- Changelog sections come from commit messages, so write each commit (or squash
  merge) title as a clear summary of the change.
- Keep the `git-cliff` version in `requirements-release.txt` and in the release
  notes step of `build.yml` the same.

## Things to know

- Windows desktop builds patch and rebuild `@serialport/bindings-cpp` from source
  (`desktop/apps/desktop/scripts/serialport-windows.mjs`) so USB writes work on
  Windows on Arm. The patch is tied to version 13.0.0; a dependency bump fails the
  build until the patch is checked against the new version.
- Copilot denies a tool call when a `preToolUse` hook can't run, so the Copilot
  hook goes through the system shell and exits with 0 when the app is gone. Claude's
  hook must keep running Node.js directly. See the agent table in
  [docs/development.md](docs/development.md).
- Changing an agent's hooks needs the user's approval, so don't rewrite hook files
  the user already approved without going through Settings.

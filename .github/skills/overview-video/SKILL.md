---
name: overview-video
description: Rebuild or update the ESP32 Agent Companion overview video in videos/overview (HyperFrames, 1920x1080). Use when a feature, agent, character, state, Settings screen, or the desktop app changes and the video should show it, or when asked to re-render, re-time, add music, or add phone footage to the overview video.
---

# Overview video

The project is in `videos/overview/`. Read its `README.md` (commands, scenes,
footage, music) and `frame.md` (design system) first. It was built with the
user-level `app-promo-video` skill; read that skill's `references/lessons.md`
for the pacing and design rules.

## How it fits together

- `video.config.json` holds everything: `sequence` (scene order), each scene's
  copy and timing, `takes` (device clips), `chapters` (screenshot cards), and
  `music`. Never edit `index.html`; it is generated.
- `scripts/timing.mjs` computes scene times. Both `build.mjs` and
  `render-device.mjs` use it, so device events that set `"scene"` stay in sync
  when a scene changes length.
- Device screens are rendered by `scripts/render-device.mjs` from the firmware's
  engine (`desktop/engine/prebuilt/engine.js`) and the packs in
  `build/characters/`. Each take has a fixed `seed`. If the character turns away
  at a bad moment, try other seeds and look at a frame strip.
- The device case and agent badges come from the desktop app and daemon code
  (`render-case.mjs`, `render-badges.mjs`), so they follow those sources.

## Common updates

| Change | What to do |
|---|---|
| New or changed agent | `cd daemon && npm run build`, then `npm run assets`. Check the agents scene: it lays out the badges in two columns of three |
| New character pack | `python3 tools/character_pack.py build`, add a take and an item in `characters.items`, then `npm run assets` |
| Firmware animation change | Rebuild the desktop engine, then `npm run assets` |
| Settings page change | `node scripts/capture-settings.mjs` (needs the companion service), then `npm run build` |
| Desktop app change | Quit the app, `node scripts/capture-desktop.mjs`, open the app again. Ask the user which display to use first |
| Phone footage arrives | Save it as `assets/footage/<name>.mp4` (see the README's table). The build uses it in place of the rendered device |
| Music arrives | Follow the README's Music section and the skill's `references/music.md` |

## Checks before you show the user

1. `npm run assets` (when takes changed) and `npm run check`: lint 0 errors,
   check passes, and all text passes WCAG AA.
2. Remove `snapshots/`, then snapshot each scene's settled time and 0.1 s
   before and 0.2 s after every cut. Zoom into every headline; no letter may be
   clipped.
3. Look at every frame of new captures (every 0.5 s) for names, paths, and
   network names. `capture-settings.mjs` replaces them, but check anyway.
4. Show the contact sheet and ask for review before you render.

## Rules

- Ask before you close the user's desktop app, and use only the display they name.
- Use the dark theme for Settings, and demo data only.
- The repo has no license file, so say "Source on GitHub", not "open source".
- Do not commit `renders/`, `snapshots/`, or `assets/shots/*.png`. Commit the
  web export (`npm run export`), not the full render.
- Do not commit, push, or open a PR until the user asks.

# Agent Buddy overview video

A 79.5 s, 1920x1080 overview of Agent Buddy, built with the
`app-promo-video` skill and [HyperFrames](https://hyperframes.heygen.com)
(HTML + GSAP, rendered to MP4).

The characters are the star. Every device screen in the video comes from the
firmware's own animation engine (the desktop app's WebAssembly build of
`firmware/AgentCompanion/src`), so the character moves exactly as it does on
the device.

## Commands

```bash
npm run assets     # device case, agent badges, and the device clips (fast, about 10 s)
npm run build      # trim screenshots into assets/frames, then write index.html
npm run check      # build, then HyperFrames lint and check
npm run snapshot   # contact sheet in snapshots/
npm run dev        # build, then open HyperFrames Studio
npm run render     # renders/video.mp4
npm run music      # renders/video-with-music.mp4 (music settings in video.config.json)
npm run export     # export/video.mp4: web copy to commit
```

Capture scripts (run when the app or the Settings page changes):

```bash
node scripts/capture-settings.mjs   # Settings tabs, dark theme, demo data (needs the companion service); add shot names to capture only those
node scripts/capture-desktop.mjs    # the desktop app over a neutral backdrop (quit the app first)
```

Requires Node.js 18+, ffmpeg, ImageMagick (`magick`), Google Chrome, and for
the capture scripts Playwright (`npm i -g playwright`). It also needs the
repository's built packs (`python3 tools/character_pack.py build`), the built
daemon (`cd daemon && npm run build`), and the installed desktop app (macOS) for
the desktop recording. The render loads GSAP from a CDN.

## Files

| Path | What it is |
|---|---|
| `video.config.json` | **Edit this.** Copy, scene order, timing, device takes, screenshots, music |
| `scripts/timing.mjs` | Scene times, shared by the build and the device clips |
| `scripts/render-device.mjs` | Device clips from the firmware engine (`takes` in the config) |
| `scripts/render-case.mjs` | The device case, drawn by the desktop app's own code |
| `scripts/render-badges.mjs` | The six agent badges, from the daemon's pixel art |
| `scripts/capture-settings.mjs` | Settings screenshots with demo data |
| `scripts/capture-desktop.mjs`, `scripts/backdrop.html` | Desktop app recording with a private demo service |
| `scripts/build.mjs`, `src/` | Generator, motion, and styles |
| `assets/clips/` | Device clips (generated) and the desktop recording |
| `assets/shots/`, `assets/frames/` | Settings captures (PNG, not committed) and their WebP copies |
| `assets/footage/` | Real device footage from a phone, when you have it (see below) |
| `frame.md` | Design system |
| `index.html` | Generated. Do not edit by hand |

## Scenes

| Start | Scene | What it shows |
|---|---|---|
| 0:00 | Hook | Eleven agent windows work. One finishes, one asks for approval: "Your agent is done. Another needs your attention. Did you notice?" Then they fly into the device |
| 0:08 | Meet | The screen turns on and the character wakes up; a tap at 0:11 shows Surprise. "Introducing Agent Buddy" |
| 0:15 | States | Working (0:15), Needs attention (0:20), Complete (0:25). Each step shows the agent event first, then the device reacts, with its badge |
| 0:30 | Agents | "Six agents. One buddy." The six badges around the device |
| 0:36.5 | Little touches | Tap to say hi, usage at a glance (a magnifier shows AIC, then fades to Tokens), naps when idle |
| 0:44.5 | Characters | Copilot, Claude, OpenClaw, and "Your own", with "More coming soon" under the title |
| 0:51.5 | Desktop app | The Desktop Agent Buddy recording: Working, Needs attention, Complete |
| 0:58 | Settings | "Deploy different characters and change app settings." Characters tab, then the full Agents tab (dark theme), which pans down to show all six agents, on a taller card |
| 1:05 | Values | "Local. Private. Yours." No cloud, no account, no extra subscription, USB or Wi-Fi, source on GitHub |
| 1:11.5 | End | The name; two ways to use it (the Waveshare device, or the desktop app with no ESP32 device); "Get it on GitHub" and the repository URL |

One engine take (`hero`) runs from Meet through Agents, so the character never
cuts while the device moves between those scenes. Its events use the scene
times, so they stay in sync when a scene changes length.

## Device footage

Three spots use real phone footage when the file exists, and the rendered device
until then (the build prints a "fallback" warning for each):

| File | Scene | Shot |
|---|---|---|
| `assets/footage/desk-wake.mp4` | Meet (7 s) | Device on a desk next to a laptop; the screen wakes |
| `assets/footage/tap.mp4` | Little touches | A finger taps the screen and the character reacts |
| `assets/footage/desk-hero.mp4` | End (8 s) | Calm hero shot of the device on a desk |

Film at 1080p or 4K, 30 fps, landscape, with the phone on a tripod or resting
on something. Use soft daylight or a desk lamp from the side, not overhead, so
the round glass has no hard glare. Lower the exposure (tap and drag down on the
iPhone) until the screen's blacks are black. Turn on Do Not Disturb, and keep
other screens, names, and papers out of the frame.

1. **Desk wake (10 s).** Device on the desk, slightly left of center, a laptop
   blurred behind it. Camera at desk height, 30–40 cm away. Start with the
   device asleep (or covered), then let it wake. Hold still.
2. **Screen close-up, each state (8 s each).** Fill most of the frame with the
   screen, straight on. Record Idle, Working, Needs attention, and Complete. To
   make a state happen, run an agent, or `npm run send working` from the
   repository.
3. **Tap (6 s).** Same framing as 2. One finger comes in from the lower right,
   taps the center, and leaves. Do it two times, 3 s apart.
4. **Rotate (6 s).** Hands turn the device a quarter turn; the character stays
   upright.
5. **Desk hero (10 s).** Device on the right third of the frame, a slow push in
   if you can. Calm, no hands.

Trim each clip to the part you want, remove the audio, and save it as
`assets/footage/<name>.mp4`. Shots 2 and 4 are extras for later edits.

## Music

Plan the track for 120 BPM: every cut sits on the 0.5 s grid, so the beats land
on the cuts. In Suno, turn on Instrumental, and ask for at least 1:50, so there
is room to choose sections. Then set `music.src` and `music.segments` (see
`~/.copilot/skills/app-promo-video/references/music.md` for the beat matching)
and run `npm run music`. Remove the MP3's metadata before you commit it.

The current track, `assets/music/power-up-stomp.mp3`, is a Suno indie-pop
track at about 137 BPM (Suno did not follow the 120 BPM prompt). It plays at its
own tempo, because a 12.5% slowdown takes away its energy. The MP3 has no
metadata:

```bash
ffmpeg -i "Power-Up Stomp.mp3" -map 0:a:0 -map_metadata -1 -fflags +bitexact \
  -c:a libmp3lame -b:a 256k -id3v2_version 0 -write_xing 0 assets/music/power-up-stomp.mp3
```

Four segments put its big moments on the key cuts. Each edit moves exactly
8 beats, so the beat stays steady:

| Video | Track | What happens |
|---|---|---|
| 0:00 | from 0.56 s | The piano starts at once, on its first beat |
| 0:04.17 | back 1 bar | The piano intro is one bar longer, so the band comes in at 0:08, when the screen turns on |
| 0:58 | back 2 bars | The soft part repeats, so the final section starts on "Local." at 1:05 |
| 1:11.5 | forward 2 bars | Four rising hits from 1:15.9, then the final chord at 1:17.6 |

`music.fadeIn` is 0.1 s, so the piano is heard at once, and `music.fadeOut` is 0.8 s, so the final chord rings out.

Style options (Suno "Style of Music"):

**A. Playful electronic gadget (recommended):**
```
Instrumental, 120 BPM, 4/4, playful modern electronic, soft analog synth plucks, glassy bell arpeggios, warm sub bass, light crisp percussion with rimshots and finger snaps, tiny bleeps and chirps, friendly and curious, polished product commercial, bright and uncluttered, gentle build to a warm finale
```

**B. Warm lo-fi pop:**
```
Instrumental, 120 BPM, 4/4, warm lo-fi pop, bouncy groove, Rhodes electric piano chords, round plucked bass, soft dusty drums with brushes and shaker, playful marimba hook, cozy and cheerful, light tape warmth, clean mix, builds gently to a happy ending
```

**C. Indie-tronic toy box:**
```
Instrumental, 120 BPM, 4/4, indie electronic, music box and celesta melody over a bouncy synth bass, handclaps, soft kick, ukulele strums, whimsical and smart, small risers before section changes, optimistic, polished, not childish
```

Exclude styles:
```
vocals, lyrics, rap, EDM drop, dubstep, trap hi-hats, heavy distortion, horror, sad, cinematic trailer braams, orchestral
```

Structure for the Lyrics field (match it to the cuts above):

```
[Intro - curious, 4 bars]
(0:00-0:08) Light plucks and a soft ticking pulse, like windows working. Small chime at 0:01.6 (a task finishes), a questioning two-note figure at 0:02.6 (an agent waits), a short lift into 0:04 ("Did you notice?").
[Wake up - 1 beat of silence, then the theme, 4 bars]
(0:08-0:15) A sparkle as the screen turns on, then the main melody. Small playful hit at 0:11 (the tap).
[Groove A - three states, 8 bars]
(0:15-0:30) Steady, friendly groove. Small fills at 0:20 and 0:25. A warm, bright lift at 0:25 for Complete.
[Groove B - agents and touches, 8 bars]
(0:30-0:44) Fuller, add a counter-melody. Fill at 0:36.5.
[Groove C - characters and desktop, 10 bars]
(0:44-1:05) Same energy, new texture. Light fills at 0:51.5 and 0:58.
[Lift - values, 3 bars]
(1:05-1:11) Build with three short rising hits at 1:05, 1:05.5, 1:06.
[Finale - end card, 4 bars]
(1:11.5-1:19.5) Warm final statement of the theme, gentle last chord that rings out.
[End]
```

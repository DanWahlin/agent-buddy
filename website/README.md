# Agent Buddy website

The product page at <https://danwahlin.github.io/agent-buddy/>. It is static
HTML, CSS, and JavaScript with no build tools. [GSAP](https://gsap.com/) loads
from a CDN and adds motion. The page works without it.

## Preview it

```bash
npm run website        # builds website/dist and serves it on http://127.0.0.1:4173
```

Or run the two steps yourself:

```bash
node website/scripts/build.mjs   # website/dist
node website/scripts/serve.mjs   # PORT=8080 to change the port
```

The build copies the page and adds what the live demo ("Try it") needs:

- `engine/engine.js`, the firmware's animation engine compiled to WebAssembly,
  from `desktop/engine/prebuilt/engine.js`.
- `engine/<character>.acpk`, the character packs. The build uses
  `build/characters` when it has all three packs
  (`python3 tools/character_pack.py build`). If not, it downloads the latest
  release's `-characters.zip` with the GitHub CLI (`gh`). Add `--download` to
  always download them.

If the packs are missing, the live demo shows a recording.

## Deploy

[`.github/workflows/pages.yml`](../.github/workflows/pages.yml) builds and
deploys the site when `website/` changes on `main`, when a release is published
(so the demo gets the new packs), and on demand. In the repository's
**Settings > Pages**, set **Source** to **GitHub Actions**.

## Edit it

| File | What it holds |
| --- | --- |
| `index.html` | All the copy and sections |
| `styles.css` | The design. Colors are in `:root` and match the overview video. |
| `main.js` | Scroll scenes, video playback, the character picker, and the live demo controls |
| `live.js` | Runs the engine on a canvas: packs, modes, badges, usage, and taps |

**The video.** When the overview video is on YouTube, set `VIDEO_YOUTUBE_ID` at
the top of `main.js` to its video ID. Until then, the video section shows
"Coming soon".

## Media

The clips and images in `assets/` come from the overview video project
(`videos/overview`). The device clips are the firmware engine's own frames.

- `assets/media/idle`, `working`, `attention`, `complete`, and `agents` are
  cut from `device-hero.mp4` (0, 8, 13, 18, and 22.6 s).
- The other clips are the video's `device-*.mp4` and `desktop-app.mp4`, made
  smaller for the web with H.264 (`-crf 19` to `22`) and a WebP poster for each.
- `assets/badges/packets.json` holds the agent badge glyphs as the engine reads
  them, from the daemon's `loadAgentBadgeIcons` and `iconPacket`.

Icons are [Octicons](https://primer.style/octicons/) (MIT, `assets/icons/LICENSE`).
JetBrains Mono is under the SIL Open Font License (`assets/fonts/OFL.txt`).

# Agent Buddy website

The product page at <https://getagentbuddy.com/>. It is static
HTML, CSS, and JavaScript with no build tools. [GSAP](https://gsap.com/) loads
from a CDN and adds motion. The page works without it. Until `main.js` starts
the motion, the `intro` class keeps the parts that GSAP animates hidden (for at
most 2.5 s), so they don't show and then jump back. When you animate a new part
with GSAP, add it to the `.intro` rule in `styles.css`.

## Preview it

```bash
npm run website        # builds website/dist and serves it on http://127.0.0.1:4790
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
  `build/characters` when it has all four built-in packs
  (`python3 tools/character_pack.py build`). If not, it downloads the latest
  release's `-characters.zip` with the GitHub CLI (`gh`). Add `--download` to
  always download them.
- `packs/`, the list (`index.json`) and card images of the Characters page's
  add-on packs (see below). Their `.acpk` files go to `engine/`.

If the packs are missing, the live demo shows a recording.

## Characters page

`characters.html` (<https://getagentbuddy.com/characters.html>) lists the characters
that people can add to Agent Buddy, with a live preview of each one. People
download a character, then add it in Settings with **Add character pack**, which
copies it into the app's own folder. Every app version since 0.14 can do this.
The page's old addresses, `gallery.html` and `buddies.html`, now only send
visitors to `characters.html`, with the `#pack-<id>` part of the link, so old
links still work.

The page groups characters into packs, such as the Animal Pack. Each pack's
characters show as chips under **Character packs** in the live preview's panel,
and as cards with **Preview** and **Download** buttons. The first character of
the first pack shows first in the page's live preview.

The packs come from a folder that holds a `packs.json` (see below) and each
character's finished `.acpk` file as `<id>.acpk`, where `<id>` is the id in its
header. The live site uses the files on the `character-previews` pre-release
([Deploy](#deploy)). A local build uses `website/packs/`, which lists no packs,
unless you add `--packs <folder>`.

The home page shows the packs too. Its live demo has chips for four characters
of each pack, with a link to the pack on the Characters page
(`characters.html#pack-<id>`). `packs.js` makes the chips for both pages.

```json
{
  "packs": [
    {
      "id": "example",
      "name": "Example Pack",
      "description": "One or two sentences for the pack.",
      "note": "Optional: a line under the description.",
      "preview": false,
      "featured": ["robot"],
      "characters": [
        { "id": "robot", "name": "Bolt", "kind": "robot", "description": "One sentence for its card." }
      ]
    }
  ]
}
```

- `name` and `kind` of a character are optional. Without `name`, the card uses
  the name in the character's pack. With `kind`, the chip's label reads, for
  example, "Bolt, the robot".
- `"preview": true` marks free previews of paid characters. Their cards say
  **Free preview**, and their buttons say **Download preview**.
- `featured` is optional. It lists the characters that the home page's live
  demo shows first, in that order. Without it, the demo shows the pack's first
  four characters. The Characters page always shows every character, in the order
  of `characters`.
- A character whose blink patches need firmware with adaptive patch RAM gets a
  "Needs current device firmware" line on its card.

The build stops with an error when a file is not a version 1 pack, is larger
than 16 MB, has a SHA-256 that doesn't match its contents, holds another id, or
uses a built-in character's id. It then writes `packs/index.json` (which the
page reads), copies each character to `engine/`, and saves the pack's thumbnail
as the card's image. The live preview and the **Download** button use the same
file, so the site keeps one copy of each character. For a sharper card, add
`<id>.webp` to the folder, a square still of the character on a black screen,
like the posters in `assets/media/`.

To see the Characters page with packs on your computer, build the site from a pack
folder. For example, the Animal Pack's free previews, which
`tools/build_previews.py` in the private `agent-buddy-packs` repository makes:

```bash
node website/scripts/build.mjs --packs ../agent-buddy-packs/dist/preview && node website/scripts/serve.mjs
```

## Deploy

[`.github/workflows/pages.yml`](../.github/workflows/pages.yml) builds and
deploys the site when `website/` changes on `main`, after **Build and Release**
publishes a release (it starts the deploy, so the demo gets the new packs), and
on demand. In the repository's
**Settings > Pages**, set **Source** to **GitHub Actions**.

**The Characters page's packs.** The workflow downloads `character-previews.zip`
from the `character-previews` release and builds with `--packs`. The zip holds
`packs.json` and each character's `.acpk` and `.webp` files. The release is a
pre-release, so it never becomes the latest release, and the app's download
links don't change. To change the packs, upload a new zip, then run the
workflow:

```bash
gh release upload character-previews character-previews.zip --clobber --repo DanWahlin/agent-buddy
gh workflow run pages.yml --repo DanWahlin/agent-buddy
```

The `agent-buddy-packs` README shows how to make the Animal Pack's zip.

The site uses the custom domain `getagentbuddy.com`, set in **Settings > Pages**
with **Enforce HTTPS** on. A workflow-deployed site needs no `CNAME` file. The
domain's DNS is at Cloudflare, with records set to **DNS only** so that GitHub can
issue the certificate:

| Type | Name | Value |
| --- | --- | --- |
| A | `getagentbuddy.com` | `185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153` |
| AAAA | `getagentbuddy.com` | `2606:50c0:8000::153`, `2606:50c0:8001::153`, `2606:50c0:8002::153`, `2606:50c0:8003::153` |
| CNAME | `www` | `danwahlin.github.io` |

## Edit it

| File | What it holds |
| --- | --- |
| `index.html` | All the copy and sections |
| `characters.html` | The Characters page, with the characters that people can add |
| `gallery.html`, `buddies.html` | The page's old addresses. They send visitors on to `characters.html`. |
| `styles.css` | The design of both pages. Colors are in `:root` and match the overview video. |
| `main.js` | Scroll scenes, video playback, and the live demo controls |
| `characters.js` | The Characters page's pack cards and its live preview |
| `packs.js` | Reads `packs/index.json` and makes the pack chips of the live demo and the Characters page |
| `live.js` | Runs the engine on a canvas: packs, modes, badges, usage, and taps |
| `packs/` | The Characters page's character packs and `packs.json` |

**The video.** `assets/media/overview.mp4` is the overview video's final render
with music (`renders/video-with-music.mp4`), made smaller for the web. To update
it after a new render:

```bash
ffmpeg -i video-with-music.mp4 -c:v libx264 -preset slow -crf 26 -pix_fmt yuv420p \
  -c:a aac -b:a 128k -movflags +faststart website/assets/media/overview.mp4
```

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

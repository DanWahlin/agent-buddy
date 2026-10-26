# frame.md: design system

Warm, playful, and character-driven, but still professional. The look comes from
the project logo (a hexagon badge with a glowing screen face) and the character
art: deep navy, electric blue, and a cyan glow, with warm amber and mint for the
device's states. The device and its characters are always the brightest thing
on screen.

To change the colors, edit the tokens in `src/styles.css` (`:root`).

## Color

| Token | Value | Use |
|---|---|---|
| `--bg` | `#040A1A` | Canvas (navy) |
| `--ink` | `#F4F7FF` | Primary text |
| `--soft` / `--muted` | `#CAD5EC` / `#95A3C3` | Secondary text, labels |
| `--g1` → `--g2` → `--g3` | `#8FF3FF` → `#4FA6FF` → `#8F86FF` | Accent gradient: the logo's cyan into electric blue and the character's periwinkle |
| `--work` | `#5FD3FF` | Working |
| `--attn` | `#FFB547` | Needs attention (the device's amber question mark) |
| `--done` | `#5EE0A0` | Complete |
| `--warm` | `#FF9E6B` | Small warm accents |

Background: blue and cyan aurora fields with one warm glow, a faint hexagon
grid (the logo's shape), slow particles, film grain, and a vignette. The device
glow takes the color of the current state.

## Type

- Display and body: **Nunito** variable (rounded and friendly), weight 650–900,
  tracking −0.03em on headlines.
- Labels: **JetBrains Mono**, uppercase, tracking 0.06em.
- Words rise out of a mask. Both fonts are under the SIL Open Font License
  (`assets/fonts/OFL.txt`).

## Components

- **Device**: the case PNG drawn by the desktop app's own code
  (`scripts/render-case.mjs`), a round screen that plays a firmware-engine clip,
  a soft state-colored glow, and a light shine on the glass.
- **Agent badge**: the device's own 24x24 pixel-art glyph in a dark disc with
  the agent's color ring (`scripts/render-badges.mjs`).
- **Agent window / event row**: rounded navy cards with a badge, the agent's
  name, a task, and a progress bar or a state mark.
- **Screenshot card**: 22px radius, light border, deep shadow with a blue glow.
  Holds still before any camera move; screens change by crossfade.
- **Magnifier**: a ringed circle with a close-up clip, for small device text.

## Motion

- Eases: `expo.out` to enter, `power2.in` to leave, `power2.inOut` to move,
  `sine.inOut` to drift. No `back`, `elastic`, or bounce.
- Show cause, then effect: the agent event appears before the device reacts.
- Light sweep at major scene changes. Cuts sit on a 0.5 s grid (120 BPM).

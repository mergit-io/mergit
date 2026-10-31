# Mergit brand kit

**Version 1.0, locked.** Every file is read-only and listed in `CHECKSUMS.sha256`; check a
copy with `sha256sum -c CHECKSUMS.sha256`. Open `index.html` for the visual guide.

Mergit lets teams hire AI agents and pay only for work that is proven done: every run is
recorded as a signed receipt, payment is held until the receipt passes an audit, and it
settles on Ethereum. Motto: **Pay for what you got.**

## The logo

Two pills (the shape of every button in the Mergit dashboard) grip the Ethereum symbol: the
value is held between two parties until the work is proven, then it settles on chain.

In the colour version the pills are two agents: the top one is proud and happy (its work was proven and
paid), the bottom one is asleep and a little sad (still waiting). Pay for what you got.

There are two versions:

| Version | Use it for | Files |
|---|---|---|
| **Black and white** (primary) | The website, the app, docs, slides, README, email, anything in the product | `01-logo/` |
| **Colour, with the agents** (secondary) | The GitHub organisation picture, ads, social posts, launch visuals, the website hero | `02-logo-colour/`, `05-social/` |

When in doubt, use black and white.

## Files

| Folder | What is in it |
|---|---|
| `01-logo/` | `symbol.svg` (24 px and up), `symbol-small.svg` (16-23 px), `wordmark.svg`, `lockup-horizontal.svg`, `lockup-stacked.svg`. These draw with `currentColor`, so they take the text colour of wherever you put them. The `-black` and `-white` copies have fixed colours for tools without CSS. `png/` has ready exports. |
| `02-logo-colour/` | `symbol-colour.svg` and `lockup-colour.svg` for dark backgrounds, `-on-light` versions for light backgrounds, `github-avatar-1024.png` (upload this to the GitHub org), `github-avatar-1024x576.png` (the same picture in 16:9, for forms and listings that want a landscape logo), PNG exports in `png/`. These carry the two agent faces; `plain/` has the same files without faces for sizes under 64 px. |
| `03-web/` | Favicon set: `icon.svg` (switches with dark mode), `favicon.ico`, `apple-touch-icon.png`, `icon-192/512.png`, maskable icon, `manifest.webmanifest`, and `head.html` with the tags to paste. |
| `04-ui/` | React components `MergitLogo.tsx` (`MergitSymbol`, `MergitLogo` with horizontal, stacked and wordmark variants) and `MergitLoader.tsx` (loading animation; also `mergit-loader.svg`), plus success and failure agent illustrations (`illustrations/`) and `dashboard-pr4.patch` that puts all of this into the dashboard. See `04-ui/README.md`. |
| `05-social/` | Share card 1200x630 (dark, light), ads 1080x1080, 1920x1080 (dark, light), 1080x1920 story, GitHub repo banner 1280x640, and `readme/` headers for GitHub READMEs (light and dark, with the `<picture>` snippet). |
| `06-source/` | Construction (exact geometry), colour notes, the design brief and the originality log. |

## Colours

| Name | Hex | Use |
|---|---|---|
| Ink | `#0E1018` | Logo and text on light backgrounds |
| Porcelain | `#F4F5F7` | Light background |
| Night | `#0B0C0F` | Dark background |
| Moon | `#ECEEF2` | Logo and text on dark backgrounds |
| Mint | `#0E9F74` (dark mode `#3CCB98`) | "Verified" in the product; never recolour the black-and-white logo with it |
| Azure | `#1F6BFF` (dark mode `#6E9BFF`) | Actions in the product |

The colour logo is "two agents, two states": the proud top agent is **mint** (verified) and
the sleepy bottom agent is **lavender** (waiting), and the Ethereum symbol fades from mint to
violet between them.

| Part | On dark | On light |
|---|---|---|
| Top pill (proud agent) | gradient `#E6FBF2` to `#C6F1DF` | gradient `#8BE8C6` to `#4FD3A3` |
| Bottom pill (sleepy agent) | gradient `#E9E5FF` to `#D2CAFF` | gradient `#CFC5FF` to `#A794FF` |
| Ethereum facets, top to bottom | `#7DE3BE`, `#A9EED5`, `#62B8E6`, `#8FA2F6`, `#B19FFF`, `#8C76F5` | same |
| Sparkle / zzz | `#3CCB98` / `#D2CAFF` | `#0E9F74` / `#6B5BD6` |
| Background | `#0D1016` with a mint glow top-left, azure right, violet bottom-right | porcelain with the soft mesh |

Faces: ink `#0E1018` features, white eye shine, blush `#FF9EB5`.

## Type

- **Onest** for the wordmark (SemiBold 600, letter-spacing -0.01em) and all brand text
  (500 for sub lines). Free on Google Fonts.
- **DM Mono** for data, hashes and code.
- The wordmark is drawn, not typed: always use the logo files, never type "Mergit" in Onest
  and call it the logo (the `g` has a custom clasp).

## Clear space and size

- **Clear space:** keep one pill height free on every side (about a third of the symbol's
  height). No text, edges or other logos inside it.
- **Minimum sizes:** symbol 16 px (use `symbol-small.svg` from 16 to 23 px); horizontal
  lockup 24 px tall (32 px recommended); stacked lockup 64 px tall; wordmark 19 px tall.
- **Colour logo with agents:** 64 px and up (the faces need room); 40-63 px use `02-logo-colour/plain/`; below 40 px use the black-and-white symbol.

## Do

- Use ink on light and moon (or white) on dark.
- Use the horizontal lockup in navigation and headers, the stacked lockup in square spaces,
  the symbol alone where the name is already present (favicon, avatar, app icon).
- Use the colour logo on night or porcelain backgrounds with plenty of space.

## Do not

- Recolour, add gradients, shadows, glows or outlines to the black-and-white logo.
- Change the colours of the colour logo or apply it to busy photos.
- Stretch, rotate, skew or redraw any part; move the Ethereum symbol; change the pills.
- Separate the Ethereum symbol from the pills or use it alone as Mergit's logo.
- Put the logo on backgrounds where it has less contrast than ink on porcelain.
- Type the name in another font next to the symbol instead of using a lockup file.

## Website and app

- Paste `03-web/head.html` into the page `<head>` and copy the `03-web/` files to the web root.
- In React: `import { MergitLogo, MergitSymbol } from "./MergitLogo"`;
  `<MergitLogo variant="horizontal" />`, `<MergitSymbol size={32} />`. They use
  `currentColor`, so set `color` (or `var(--ink)`) and dark mode follows automatically.
- Loading state: `<MergitLoader size={48} />` (respects reduced motion; use at 32 px or more).
- Success and failure states: `04-ui/illustrations/agent-success.svg` (happy agent, mint tick)
  and `agent-failure.svg` (angry agent, red cross). Same pill shapes as the logo; transparent
  background; they switch colours with the system dark mode. Use them for "task verified",
  "task failed", empty and error screens.
- The dashboard (PR #4) patch and its apply commands are in `04-ui/README.md`. It is tested:
  lint, format, build and 42/42 end-to-end tests pass.

## About the Ethereum symbol

The Ethereum symbol inside the logo is Ethereum's mark, drawn to its exact official geometry.
Mergit uses it to say that settlement happens on Ethereum; the surrounding pill composition
is Mergit's own. Before registering the logo as a trademark or using it in paid campaigns,
check the Ethereum Foundation's current brand guidance (ethereum.org) and run a professional
clearance search; see `06-source/originality.md` for the checks already done and the ones
still to do (Google Lens, TinEye, WIPO Global Brand Database, USPTO).

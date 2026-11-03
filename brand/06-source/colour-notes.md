# Mergit colour version

Marketing and avatar use only. The master logo stays one colour (`../symbol.svg`).
Shapes are taken unchanged from `../symbol.svg` and `../lockup-horizontal.svg`; only fills are
added. The Ethereum facets are the official six regions, checked against the official
vertices on every build.

## Treatments (`symbol-colour-N.svg`, preview `.png` on the intended background)

| File | Pills | Ethereum symbol | Background |
|---|---|---|---|
| `-1` | azure `#6E9BFF` to mint `#3CCB98` gradient | white, official facet opacities | dark only |
| `-2` (picked) | moon `#ECEEF2` | flat facets: azure, violet, mint, periwinkle | dark |
| `-2-on-light` (picked) | ink `#0E1018` | the same facets, deeper | light |
| `-3` | ink | mint `#0E9F74` to azure `#1F6BFF` gradient, light facet overlay | light |
| `-3-on-dark` | moon | lighter mint to azure | dark |

Light / dark: use `symbol-colour.svg` and `lockup-colour.svg` on night `#0B0C0F` or surface
`#121317` (moon pills and wordmark); use `symbol-colour-on-light.svg` and
`lockup-colour-on-light.svg` on porcelain `#F4F5F7` or white (ink pills and wordmark).
Treatment 1 is dark-only; treatment 3 is light-first.

## Files

- `github-avatar.svg`, `-1024.png`, `-460.png`: night with the dashboard mesh; the symbol's
  farthest point is 76% of the circle's radius, so a circle crop keeps it whole.
- `github-avatar-1024x576.svg`, `.png`: the same picture in 16:9. The symbol takes the same
  share of the short side as in the square (390 of 576 px), centred; the glows keep their x
  positions and radii, with y scaled to the new height.
- `../marketing/`: og 1200x630 (dark + light), square 1080, landscape 1920x1080 (dark + light),
  story 1080x1920, GitHub repo preview 1280x640. Text is Onest outlines (600 headline,
  500 sub line), shaped with HarfBuzz kerning.

## Rebuild

```sh
UV_CACHE_DIR=$TMPDIR/uv uv run --with fonttools --with brotli --with uharfbuzz --with pillow \
  python final/colour/_gen/build.py [--symbol PATH] [--wordmark PATH] [--lockup PATH]
```
Inputs default to `final/symbol.svg`, `final/wordmark.svg`, `final/lockup-horizontal.svg`.

# Brand assets

Exported logo, emblem, and wordmark SVGs for Harnery.

## Naming

The brand name is **Harnery** (initial capital) in prose, headings, and UI. The
lowercase `harnery` is reserved for technical identifiers: the npm package, the
`harn` command, the `.harnery/` state dir, import paths, and config keys. The
logo wordmark is set in all caps (HARNERY) as a typographic treatment.

## Families

| Family | Base files | What |
|--------|-----------|------|
| Full lockup | `harnery-logo.svg`, `harnery-logo-transparent.svg` | emblem + wordmark, square (1000x1000) |
| Emblem | `harnery-emblem.svg`, `harnery-emblem-transparent.svg` | the H mark on its own, square (1000x1000) |
| Wordmark | `harnery-wordmark.svg`, `harnery-wordmark-transparent.svg` | the "HARNERY" lettering, wide (1000x163) |

Every file also has a minified (`.min.svg`) twin for embedding.

## Color treatments

Beyond the default (full color) and `-transparent`, families ship tinted
variants for different backgrounds (availability varies per family):

| Suffix | Treatment | Use on |
|--------|-----------|--------|
| `-reversed` | emblem colors kept, dark elements flipped light | dark backgrounds |
| `-white` | solid white (monochrome) | dark / photographic backgrounds |
| `-black` | solid black (monochrome) | light backgrounds, one-color print |
| `-grayscale` | desaturated | neutral contexts |
| `-grayscale-reversed` | desaturated, lightened for dark bg | dark grayscale contexts |

## Proof sheet

`assets/showcase.html` is a self-contained page that inlines every SVG here and
shows the lockups on a background matrix, over transparency, in their color
variants, at favicon sizes, in real-world mockups (browser tab, app icon, avatar,
nav, dark UI), and reduced to one color. Open it straight in a browser (GitHub
shows the source, not the rendered page).

## Where they're used

| Surface | File |
|---------|------|
| `README.md` banner | `harnery-logo-transparent.svg` (light) + `harnery-logo-reversed-transparent.svg` (dark), via `<picture>` |
| web favicon (`web/app/icon.svg`) | emblem (transparent) |
| web navbar (`web/public/harnery-emblem.svg`) | emblem (transparent) |
| docs header (`docs/src/assets/harnery-emblem.svg`) | emblem (transparent) |

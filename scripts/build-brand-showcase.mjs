#!/usr/bin/env node
// Generate a self-contained brand proof sheet: every logo lockup shown on the
// backgrounds, sizes, and placements it has to hold up in. Reads the exported
// SVGs in assets/ and inlines them into one standalone HTML file (no external
// assets), so it opens straight in a browser. Output is gitignored; regenerate
// with `npm run brand:showcase`.
//
// Sections: background matrix, transparency, color variants, scale ramp,
// real-world mockups, single-color reduction. Dependency-free (Node stdlib).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ASSETS = path.join(ROOT, "assets");
const OUT = path.join(ASSETS, "showcase.html");

// Inlining the same SVG many times in one document collides their internal ids
// (clip-paths, gradients, filter): a url(#hny-otop-clip) resolves to the FIRST
// match in the document, so a later copy borrows the wrong, differently-scaled
// defs and renders broken. Namespacing every hny- id per copy keeps each one
// self-referential.
function loadSvg(name, tag) {
  let svg = fs.readFileSync(path.join(ASSETS, `${name}-transparent.min.svg`), "utf8");
  svg = svg.replaceAll("hny-", `hny-${tag}-`);
  const i = svg.indexOf(">");
  let head = svg.slice(0, i);
  const rest = svg.slice(i + 1);
  head = head.replace(/\s+width="[^"]*"/, "");
  head = head.replace(/\s+height="[^"]*"/, "");
  head = head.replace("<svg ", '<svg class="art" ');
  return `${head}>${rest}`;
}

const CSS = `
:root { --gap: 22px; }
* { box-sizing: border-box; }
body {
  margin: 0; padding: 40px 28px 80px;
  font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  color: #1a1f24; background: #fafafa;
}
.wrap { max-width: 1180px; margin: 0 auto; }
header h1 { margin: 0 0 6px; font-size: 30px; letter-spacing: -0.5px; }
header p { margin: 0; color: #5a636b; max-width: 60ch; }
h2 {
  margin: 56px 0 4px; font-size: 13px; font-weight: 700; letter-spacing: 1.4px;
  text-transform: uppercase; color: #8a929a;
}
h2 + .note { margin: 0 0 20px; color: #8a929a; font-size: 13px; }

.grid { display: grid; gap: var(--gap); grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); }
.card {
  border-radius: 14px; overflow: hidden; border: 1px solid rgba(0,0,0,.08);
  box-shadow: 0 1px 3px rgba(0,0,0,.06);
}
.swatch {
  min-height: 150px; display: flex; align-items: center; justify-content: center;
  gap: 26px; padding: 30px 24px; flex-wrap: wrap;
}
.swatch .art { width: 120px; height: auto; }
.swatch .art.sm { width: 64px; }
.swatch .art.word { width: 150px; }
.cap {
  padding: 9px 13px; font-size: 12px; font-weight: 600; background: #fff;
  border-top: 1px solid rgba(0,0,0,.07); display: flex; justify-content: space-between;
}
.cap .hex { color: #9aa0a6; font-weight: 500; font-variant-numeric: tabular-nums; }

.checker {
  background-image:
    linear-gradient(45deg, #ccc 25%, transparent 25%),
    linear-gradient(-45deg, #ccc 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, #ccc 75%),
    linear-gradient(-45deg, transparent 75%, #ccc 75%);
  background-size: 22px 22px;
  background-position: 0 0, 0 11px, 11px -11px, -11px 0;
  background-color: #fff;
}
.dots {
  background-color: #2b3038;
  background-image: radial-gradient(rgba(255,255,255,.16) 1.4px, transparent 1.5px);
  background-size: 16px 16px;
}
.photo  { background: linear-gradient(135deg, #3a4a63 0%, #6b4a6b 45%, #b6724a 100%); }
.gradient { background: linear-gradient(120deg, #F25A0E 0%, #06738A 100%); }

/* scale ramp */
.ramp { display: flex; align-items: flex-end; gap: 30px; flex-wrap: wrap;
  background: #fff; border: 1px solid rgba(0,0,0,.08); border-radius: 14px; padding: 30px; }
.ramp figure { margin: 0; text-align: center; }
.ramp .art { display: block; margin: 0 auto 8px; image-rendering: auto; }
.ramp figcaption { font-size: 11px; color: #9aa0a6; font-variant-numeric: tabular-nums; }

/* mockups */
.mocks { display: grid; gap: var(--gap); grid-template-columns: repeat(auto-fill, minmax(330px, 1fr)); }
.mock { border-radius: 14px; overflow: hidden; border: 1px solid rgba(0,0,0,.08);
  box-shadow: 0 1px 3px rgba(0,0,0,.06); background: #fff; }
.mock .body { padding: 26px; }
.mock .lbl { padding: 9px 13px; font-size: 12px; font-weight: 600; background: #fafafa;
  border-top: 1px solid rgba(0,0,0,.07); color: #5a636b; }

/* browser tab */
.browser { background: #dde1e6; padding: 12px 12px 0; }
.tabs { display: flex; align-items: flex-end; }
.tab { background: #fff; border-radius: 9px 9px 0 0; padding: 9px 14px; display: flex;
  align-items: center; gap: 8px; font-size: 12.5px; font-weight: 600; max-width: 200px; }
.tab .art { width: 16px; height: 16px; flex: none; }
.tab span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.urlbar { background: #fff; padding: 8px; }
.urlbar div { background: #eef1f4; border-radius: 16px; padding: 6px 14px; font-size: 12px; color: #6b7178; }

/* app icon home screen */
.home { background: linear-gradient(160deg, #5b7cc4, #8a5bb0 60%, #c46a7c);
  display: flex; gap: 26px; justify-content: center; padding: 34px 26px; }
.appicon { text-align: center; color: #fff; }
.appicon .tile { width: 88px; height: 88px; border-radius: 22px; background: #fff;
  display: flex; align-items: center; justify-content: center; margin: 0 auto 8px;
  box-shadow: 0 6px 16px rgba(0,0,0,.28); }
.appicon .tile .art { width: 60px; }
.appicon .tile.charcoal { background: #232931; }
.appicon small { font-size: 12px; text-shadow: 0 1px 2px rgba(0,0,0,.3); }

/* avatars */
.avatars { display: flex; gap: 24px; align-items: center; justify-content: center;
  flex-wrap: wrap; background: #eef1f4; padding: 30px; }
.avatar { width: 78px; height: 78px; border-radius: 50%; display: flex;
  align-items: center; justify-content: center; box-shadow: 0 2px 8px rgba(0,0,0,.12); }
.avatar .art { width: 52px; }
.avatar.w { background: #fff; }
.avatar.c { background: #232931; }
.avatar.o { background: #F25A0E; }

/* site nav */
.nav { background: #1b2128; display: flex; align-items: center; gap: 14px;
  padding: 16px 22px; color: #c7ccd2; }
.nav .art { height: 30px; width: auto; }
.nav .menu { margin-left: auto; display: flex; gap: 20px; font-size: 13px; font-weight: 500; }
.nav .menu .cta { background: #F25A0E; color: #fff; padding: 6px 14px; border-radius: 7px; }
.navlight { background: #fff; border-bottom: 1px solid #e6e9ec; color: #4a525a; }

/* dark dashboard */
.dash { background: #14181d; padding: 24px; color: #aeb6bf; }
.dash .top { display: flex; align-items: center; gap: 10px; margin-bottom: 18px; }
.dash .top .art { height: 26px; }
.dash .top b { color: #fff; font-size: 14px; }
.dash .row { height: 10px; border-radius: 5px; background: #232a31; margin: 10px 0; }
.dash .row.s { width: 60%; } .dash .row.m { width: 85%; }

/* single color */
.mono .art { width: 110px; }
.mono .black { filter: brightness(0); }
.mono .gray  { filter: grayscale(1); }
.mono .white { filter: brightness(0) invert(1); }
`;

// primary lockups, loaded once and reused across sections
const SVG = {
  "harnery-logo": loadSvg("harnery-logo", "l"),
  "harnery-emblem": loadSvg("harnery-emblem", "e"),
  "harnery-wordmark": loadSvg("harnery-wordmark", "w"),
};

const sm = (svg) => svg.replace('class="art"', 'class="art sm"');

function swatch(name, bg, hexlabel) {
  const builtin = ["checker", "dots", "photo", "gradient"].some((c) => bg.startsWith(c));
  const style = builtin ? "" : ` style="background:${bg}"`;
  const cls = builtin ? bg : "";
  const arts = SVG["harnery-logo"] + sm(SVG["harnery-emblem"]);
  const hexspan = hexlabel ? `<span class="hex">${hexlabel}</span>` : "";
  return `<div class="card"><div class="swatch ${cls}"${style}>${arts}</div>` +
    `<div class="cap">${name}${hexspan}</div></div>`;
}

function variantCard(distname, tag, title, sub, bg, cls = "art") {
  let svg = loadSvg(distname, tag);
  if (cls !== "art") svg = svg.replace('class="art"', `class="${cls}"`);
  return `<div class="card"><div class="swatch" style="background:${bg}">${svg}</div>` +
    `<div class="cap">${title}<span class="hex">${sub}</span></div></div>`;
}

function buildHtml() {
  const bgMatrix = [
    ["White", "#FFFFFF", "#FFFFFF"],
    ["Paper", "#F4F1EC", "#F4F1EC"],
    ["Light gray", "#E4E7EA", "#E4E7EA"],
    ["Mid gray", "#9AA0A6", "#9AA0A6"],
    ["Dark gray", "#4A525A", "#4A525A"],
    ["Near-black", "#15191D", "#15191D"],
    ["Brand orange", "#F25A0E", "#F25A0E"],
    ["Brand teal", "#06738A", "#06738A"],
    ["Charcoal", "#232931", "#232931"],
    ["Brand gradient", "gradient", "orange to teal"],
    ["Faux photo", "photo", "gradient"],
    ["Busy pattern", "dots", "dotted"],
  ];
  const cards = bgMatrix.map(([n, bg, hx]) => swatch(n, bg, hx)).join("");

  const trans =
    '<div class="card"><div class="swatch checker">' +
    SVG["harnery-logo"] + sm(SVG["harnery-emblem"]) +
    '</div><div class="cap">Full + emblem<span class="hex">transparent</span></div></div>' +
    '<div class="card"><div class="swatch checker">' +
    SVG["harnery-wordmark"].replace('class="art"', 'class="art word"') +
    '</div><div class="cap">Wordmark<span class="hex">transparent</span></div></div>';

  const vspecs = [
    ["harnery-logo", "Primary", "color + ink wordmark", "#FFFFFF"],
    ["harnery-logo-reversed", "Reversed", "white wordmark", "#232931"],
    ["harnery-logo-black", "Mono black", "one ink, flat", "#FFFFFF"],
    ["harnery-logo-white", "Mono white", "knockout", "#232931"],
    ["harnery-logo-grayscale", "Grayscale", "desaturated", "#FFFFFF"],
    ["harnery-logo-grayscale-reversed", "Grayscale reversed", "desat + white", "#232931"],
  ];
  const especs = [
    ["harnery-emblem", "Color", "#FFFFFF"],
    ["harnery-emblem-black", "Black", "#FFFFFF"],
    ["harnery-emblem-white", "White", "#232931"],
    ["harnery-emblem-grayscale", "Grayscale", "#FFFFFF"],
  ];
  const vfull = vspecs.map(([n, t, s, bg], i) => variantCard(n, `v${i}`, t, s, bg)).join("");
  const vemb = especs.map(([n, t, bg], i) => variantCard(n, `ve${i}`, t, "emblem", bg, "art sm")).join("");

  let ramp = "";
  for (const px of [16, 24, 32, 48, 64, 128]) {
    const art = SVG["harnery-emblem"].replace('class="art"', `class="art" style="width:${px}px"`);
    ramp += `<figure>${art}<figcaption>${px}px</figcaption></figure>`;
  }

  const mono =
    '<div class="card"><div class="swatch mono" style="background:#fff">' +
    SVG["harnery-emblem"].replace('class="art"', 'class="art black"') +
    '</div><div class="cap">Pure black<span class="hex">brightness(0)</span></div></div>' +
    '<div class="card"><div class="swatch mono" style="background:#fff">' +
    SVG["harnery-emblem"].replace('class="art"', 'class="art gray"') +
    '</div><div class="cap">Grayscale<span class="hex">grayscale(1)</span></div></div>' +
    '<div class="card"><div class="swatch mono" style="background:#232931">' +
    SVG["harnery-emblem"].replace('class="art"', 'class="art white"') +
    '</div><div class="cap">White knockout<span class="hex">on charcoal</span></div></div>';

  const A = SVG;
  const mocks = `
    <div class="mock">
      <div class="browser">
        <div class="tabs"><div class="tab">${A["harnery-emblem"]}<span>harnery · Dashboard</span></div></div>
        <div class="urlbar"><div>app.harnery.com/dashboard</div></div>
      </div>
      <div class="lbl">Browser tab, 16px favicon</div>
    </div>

    <div class="mock">
      <div class="home">
        <div class="appicon"><div class="tile">${A["harnery-emblem"]}</div><small>harnery</small></div>
        <div class="appicon"><div class="tile charcoal">${A["harnery-emblem"]}</div><small>harnery</small></div>
      </div>
      <div class="lbl">App icon, home-screen tile</div>
    </div>

    <div class="mock">
      <div class="avatars">
        <div class="avatar w">${A["harnery-emblem"]}</div>
        <div class="avatar c">${A["harnery-emblem"]}</div>
        <div class="avatar o">${A["harnery-emblem"]}</div>
      </div>
      <div class="lbl">Social avatar, circular crop</div>
    </div>

    <div class="mock">
      <div class="nav">${A["harnery-logo"]}
        <div class="menu"><span>Product</span><span>Pricing</span><span>Docs</span><span class="cta">Sign in</span></div>
      </div>
      <div class="nav navlight">${A["harnery-logo"]}
        <div class="menu"><span>Product</span><span>Pricing</span><span>Docs</span><span class="cta">Sign in</span></div>
      </div>
      <div class="lbl">Site header, dark and light nav</div>
    </div>

    <div class="mock">
      <div class="dash">
        <div class="top">${A["harnery-emblem"]}<b>harnery</b></div>
        <div class="row m"></div><div class="row s"></div><div class="row m"></div><div class="row s"></div>
      </div>
      <div class="lbl">Dark dashboard chrome</div>
    </div>
  `;

  return `<title>harnery brand assets</title>
<style>${CSS}</style>
<div class="wrap">
<header>
  <h1>harnery brand assets</h1>
  <p>Every lockup on the places it has to work: background colors, transparency,
     tiny sizes, real-world placements, and single-color reduction.
     Inlined from <code>assets/</code>, self-contained, with no external assets.</p>
</header>

<h2>Background matrix</h2>
<p class="note">Full lockup + emblem on each. Watch the dark bevels and charcoal straps on the dark and brand backgrounds.</p>
<div class="grid">${cards}</div>

<h2>Transparency</h2>
<p class="note">Transparent variants over a checkerboard, to confirm there's no baked-in background.</p>
<div class="grid">${trans}</div>

<h2>Color variants</h2>
<p class="note">The tinted treatments shipped in <code>assets/</code>: reversed, mono black/white, and grayscale. Dark-background variants are shown on charcoal.</p>
<div class="grid">${vfull}</div>
<div class="grid" style="margin-top:20px">${vemb}</div>

<h2>Scale ramp</h2>
<p class="note">Emblem from favicon size up. Does the split-pillar H stay readable when tiny?</p>
<div class="ramp">${ramp}</div>

<h2>Real-world mockups</h2>
<div class="mocks">${mocks}</div>

<h2>Single-color reduction</h2>
<p class="note">The mark stripped to one color, for stamps, faxes, embroidery, engraving, and dark-UI knockout.</p>
<div class="grid">${mono}</div>
</div>
`;
}

fs.writeFileSync(OUT, buildHtml());
const kb = (fs.statSync(OUT).size / 1024).toFixed(0);
console.log(`assets/showcase.html (${kb} KB)`);

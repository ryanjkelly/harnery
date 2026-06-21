#!/usr/bin/env node
// Post-emit fixup for the Node build.
//
// `tsc --rewriteRelativeImportExtensions` (TS 5.7+) rewrites relative `.ts`
// import specifiers to `.js` in the emitted *JavaScript*, but as of TS 5.9 it
// leaves type-position specifiers in the *declaration* output untouched:
// `.d.ts` files keep `from "../foo/index.ts"`. No `.ts` ships in dist/, so a
// downstream TypeScript consumer fails to resolve those types. This walks dist/
// and rewrites relative `.ts`/`.tsx` specifiers in `from "…"` / `import("…")`
// positions to `.js`, which a consumer's tsc resolves to the sibling `.d.ts`.
//
// Plain Node + node:fs so it runs under `npm run build` on a Bun-free host.

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DIST = new URL("../dist/", import.meta.url).pathname;

// `from "<rel>.ts"` / `from '<rel>.tsx'` and `import("<rel>.ts")`: relative
// specifiers only (must start with ./ or ../), single or double quoted.
const FROM = /(\bfrom\s*)(['"])(\.\.?\/[^'"]*?)\.tsx?\2/g;
const DYNAMIC = /(\bimport\(\s*)(['"])(\.\.?\/[^'"]*?)\.tsx?\2/g;

function rewrite(src) {
  return src
    .replace(FROM, (_m, kw, q, path) => `${kw}${q}${path}.js${q}`)
    .replace(DYNAMIC, (_m, kw, q, path) => `${kw}${q}${path}.js${q}`);
}

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (full.endsWith(".d.ts")) yield full;
  }
}

let changed = 0;
for (const file of walk(DIST)) {
  const before = readFileSync(file, "utf8");
  const after = rewrite(before);
  if (after !== before) {
    writeFileSync(file, after);
    changed++;
  }
}
console.log(`rewrite-dts-extensions: fixed ${changed} .d.ts file(s)`);

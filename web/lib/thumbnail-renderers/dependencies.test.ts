import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { __resetFilesCaches, type FileCategory } from "../files";
import { thumbnailDependencyGraph, thumbnailDependencyKey } from "./dependencies";

let root: string;
let fd: number;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "harn-thumb-dependencies-"));
  mkdirSync(path.join(root, ".harnery"));
  mkdirSync(path.join(root, "pages"));
  writeFileSync(
    path.join(root, "pages", "index.html"),
    '<html><head><link rel="stylesheet" href="main.css"></head><body><img src="image.png"></body></html>',
  );
  writeFileSync(path.join(root, "pages", "main.css"), "body{color:blue}");
  writeFileSync(path.join(root, "pages", "image.png"), "initial-image");
  fd = openSync(path.join(root, "pages", "index.html"), "r");
  __resetFilesCaches();
});
afterEach(() => {
  closeSync(fd);
  __resetFilesCaches();
  rmSync(root, { recursive: true, force: true });
});
const key = () =>
  thumbnailDependencyKey({ fd, relPath: "pages/index.html", category: "html" }, root);

test("linked CSS and image changes invalidate unchanged HTML", async () => {
  const initial = await key();
  expect(await key()).toBe(initial);
  writeFileSync(path.join(root, "pages", "main.css"), "body{color:rebeccapurple}");
  const cssChanged = await key();
  expect(cssChanged).not.toBe(initial);
  writeFileSync(path.join(root, "pages", "image.png"), "changed-image-data");
  expect(await key()).not.toBe(cssChanged);
  expect(initial).toMatch(/^[a-f0-9]{64}$/);
});

test("newly denied asset policy invalidates its previous thumbnail", async () => {
  const initial = await key();
  writeFileSync(
    path.join(root, ".harnery", "config.jsonc"),
    JSON.stringify({ files: { deny_globs: ["**/main.css"] } }),
  );
  expect(await key()).not.toBe(initial);
  const graph = await thumbnailDependencyGraph(
    { fd, relPath: "pages/index.html", category: "html" },
    root,
  );
  expect(graph.allowedPaths.has("/pages/main.css")).toBe(false);
  expect(graph.allowedPaths.has("/pages/image.png")).toBe(true);
  writeFileSync(path.join(root, ".harnery", "config.jsonc"), "{}");
  expect(await key()).toBe(initial);
});

test("nested CSS imports and relative image URLs participate in the key", async () => {
  mkdirSync(path.join(root, "pages", "styles"));
  writeFileSync(path.join(root, "pages", "main.css"), '@import "styles/nested.css";');
  writeFileSync(
    path.join(root, "pages", "styles", "nested.css"),
    "body{background:url('../image.png')}",
  );
  const initial = await key();
  writeFileSync(
    path.join(root, "pages", "styles", "nested.css"),
    "body{background:url('../missing.png')}",
  );
  const nestedChanged = await key();
  expect(nestedChanged).not.toBe(initial);
  writeFileSync(path.join(root, "pages", "missing.png"), "newly-created-image");
  expect(await key()).not.toBe(nestedChanged);
});

test("dependency reads retain the original main descriptor when its path changes", async () => {
  const initial = await key();
  renameSync(path.join(root, "pages", "index.html"), path.join(root, "pages", "original.html"));
  writeFileSync(path.join(root, "pages", "index.html"), '<img src="other.png">');
  expect(await key()).toBe(initial);
});

test("external references are excluded and cyclic CSS is bounded", async () => {
  writeFileSync(
    path.join(root, "pages", "main.css"),
    '@import "main.css"; body{background:url(https://example.invalid/image.png)}',
  );
  const graph = await thumbnailDependencyGraph(
    { fd, relPath: "pages/index.html", category: "html" },
    root,
  );
  expect([...graph.allowedPaths].sort()).toEqual(["/pages/image.png", "/pages/main.css"]);
});

test("non-HTML does not read the descriptor", async () => {
  expect(
    await thumbnailDependencyKey(
      { fd: -1, relPath: "image.png", category: "image" as FileCategory },
      root,
    ),
  ).toBe("");
});

test("inline CSS, HTML entities, and responsive image candidates are discovered", async () => {
  writeFileSync(
    path.join(root, "pages", "index.html"),
    '<style>body{background:url(image.png)}</style><img srcset="image.png 1x, larger.png 2x"><link rel="stylesheet" href="main.css?a=1&amp;b=2">',
  );
  const graph = await thumbnailDependencyGraph(
    { fd, relPath: "pages/index.html", category: "html" },
    root,
  );
  expect(graph.allowedPaths.has("/pages/main.css")).toBe(true);
  expect(graph.allowedPaths.has("/pages/image.png")).toBe(true);
  const initial = graph.key;
  writeFileSync(path.join(root, "pages", "larger.png"), "larger-image");
  expect(await key()).not.toBe(initial);
});

test("dependency graph caps the number of files the renderer may load", async () => {
  const images = Array.from({ length: 40 }, (_, index) => `image-${index}.png`);
  for (const image of images) writeFileSync(path.join(root, "pages", image), "image");
  writeFileSync(
    path.join(root, "pages", "index.html"),
    images.map((image) => `<img src="${image}">`).join(""),
  );
  const graph = await thumbnailDependencyGraph(
    { fd, relPath: "pages/index.html", category: "html" },
    root,
  );
  expect(graph.allowedPaths.size).toBe(32);
  expect(graph.allowedPaths.has("/pages/image-39.png")).toBe(false);
});

test("large unchanged HTML reuses discovery while retaining the same dependency key", async () => {
  writeFileSync(
    path.join(root, "pages", "index.html"),
    '<link rel="stylesheet" href="main.css"><img src="image.png">' +
      "<div>Example document text.</div>".repeat(30_000),
  );
  const start = performance.now();
  const initial = await key();
  const coldMs = performance.now() - start;
  const warmMs: number[] = [];
  for (let index = 0; index < 5; index++) {
    const warmStart = performance.now();
    expect(await key()).toBe(initial);
    warmMs.push(performance.now() - warmStart);
  }
  console.log(JSON.stringify({ benchmark: "960KB HTML dependency key", coldMs, warmMs }));
  writeFileSync(path.join(root, "pages", "main.css"), "body{color:orange}");
  expect(await key()).not.toBe(initial);
});

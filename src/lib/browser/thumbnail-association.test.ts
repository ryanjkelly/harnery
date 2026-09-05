import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { captureThumbnailFingerprint, registerCaptureThumbnail } from "./thumbnail-association.ts";

const roots: string[] = [];
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0l8AAAAASUVORK5CYII=",
  "base64",
);
function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "capture-association-"));
  roots.push(root);
  const workspace = path.join(root, ".harnery", "artifacts", "capture");
  mkdirSync(workspace, { recursive: true });
  const htmlPath = path.join(workspace, "snapshot.html");
  const pngPath = path.join(workspace, "different-name.png");
  const html = "<!doctype html><html><style>body{color:blue}</style><body>Snapshot</body></html>";
  writeFileSync(htmlPath, html);
  writeFileSync(pngPath, png);
  const input = {
    htmlPath,
    pngPath,
    html,
    preview: captureThumbnailFingerprint(pngPath)!,
    fullDocument: true,
    stylesheetsLinked: 0,
    resourcesLinked: 0,
  };
  return { root, workspace, input };
}
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

test("writes explicit exact-output receipts without relying on matching basenames", () => {
  const { root, input } = fixture();
  const relative = registerCaptureThumbnail(input);
  expect(relative).toMatch(/\.thumbnail-preview-[a-f0-9]{24}\.json$/);
  const result = JSON.parse(readFileSync(path.join(root, relative!), "utf8"));
  expect(result).toMatchObject({
    schema_version: 2,
    producer: "browser-standalone-capture",
    source: { path: ".harnery/artifacts/capture/snapshot.html" },
    preview: { path: ".harnery/artifacts/capture/different-name.png", ...input.preview },
  });
  expect(result.source.sha256).toHaveLength(64);
});

test("skips selector or viewport fragments and snapshots with unresolved assets", () => {
  const { input } = fixture();
  expect(registerCaptureThumbnail({ ...input, fullDocument: false })).toBeNull();
  expect(registerCaptureThumbnail({ ...input, resourcesLinked: 1 })).toBeNull();
  expect(registerCaptureThumbnail({ ...input, stylesheetsLinked: 1 })).toBeNull();
});

test("refuses HTML that no longer equals this capture's saved snapshot", () => {
  const { input } = fixture();
  writeFileSync(input.htmlPath, input.html.replace("blue", "pink"));
  expect(registerCaptureThumbnail(input)).toBeNull();
});

test("refuses a PNG replaced after the screenshot receipt was taken", () => {
  const { input } = fixture();
  writeFileSync(input.pngPath, Buffer.concat([png, Buffer.from("changed")]));
  expect(registerCaptureThumbnail(input)).toBeNull();
});

test("skips default cache output and cross-workspace preview files", () => {
  const { root, input } = fixture();
  const other = path.join(root, ".harnery/artifacts/other");
  mkdirSync(other);
  const preview = path.join(other, "other.png");
  writeFileSync(preview, png);
  expect(
    registerCaptureThumbnail({
      ...input,
      pngPath: preview,
      preview: captureThumbnailFingerprint(preview)!,
    }),
  ).toBeNull();
  const htmlPath = path.join(root, "snapshot.html");
  writeFileSync(htmlPath, input.html);
  expect(registerCaptureThumbnail({ ...input, htmlPath })).toBeNull();
});

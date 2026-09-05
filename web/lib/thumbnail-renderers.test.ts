import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import sharp from "sharp";
import type { FileCategory } from "./files";
import {
  canRenderThumbnail,
  escapeThumbnailText,
  renderThumbnail,
  runThumbnailCommand,
} from "./thumbnail-renderers";
import { closeThumbnailBrowser } from "./thumbnail-renderers/html";
import { closeOfficeThumbnailWorker, convertOfficeThumbnail } from "./thumbnail-renderers/office";

let root: string;
const hasMedia = !!Bun.which("ffmpeg");
const hasOffice =
  !!Bun.which("libreoffice") &&
  !!Bun.which("pdftoppm") &&
  spawnSync("python3", ["-c", "import uno"]).status === 0;
const hasBrowser = existsSync(chromium.executablePath());
beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "harn-thumb-test-"));
});
afterAll(async () => {
  await closeThumbnailBrowser();
  await closeOfficeThumbnailWorker();
  await rm(root, { recursive: true, force: true });
});
const input = (name: string, category: FileCategory) => ({
  inputPath: path.join(root, name),
  relPath: name,
  root,
  category,
});

test("text and JSON render as bounded WebP with escaped input", async () => {
  await writeFile(
    path.join(root, "example.json"),
    JSON.stringify({
      title: "Motion study <script>",
      frames: [1, 2, 3],
      description: "Readable example",
    }),
  );
  const timings: number[] = [];
  for (let n = 0; n < 6; n++) {
    const start = performance.now();
    const bytes = await renderThumbnail(input("example.json", "json"));
    timings.push(performance.now() - start);
    const meta = await sharp(bytes).metadata();
    expect(meta.format).toBe("webp");
    expect(meta.width).toBe(360);
    expect(meta.height).toBe(240);
  }
  console.log(
    JSON.stringify({ benchmark: "json renderer", coldMs: timings[0], warmMs: timings.slice(1) }),
  );
  expect(escapeThumbnailText('<script x="a">&')).toBe("&lt;script x=&quot;a&quot;&gt;&amp;");
});

test.skipIf(!hasMedia)(
  "video renderer extracts a bounded frame with limited decoder threads",
  async () => {
    await runThumbnailCommand("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=blue:s=640x360:d=2",
      "-threads",
      "1",
      "-pix_fmt",
      "yuv420p",
      "-y",
      path.join(root, "clip.mp4"),
    ]);
    const timings: number[] = [];
    for (let n = 0; n < 4; n++) {
      const start = performance.now();
      const bytes = await renderThumbnail(input("clip.mp4", "video"));
      timings.push(performance.now() - start);
      const meta = await sharp(bytes).metadata();
      expect(meta.format).toBe("webp");
      expect(meta.width).toBe(360);
      expect(meta.height).toBeLessThanOrEqual(240);
    }
    console.log(
      JSON.stringify({ benchmark: "video renderer", coldMs: timings[0], warmMs: timings.slice(1) }),
    );
  },
);

test("Markdown, CSV, code and text render without parsing executable markup", async () => {
  for (const category of ["markdown", "csv", "code", "text", "yaml"] as const) {
    await writeFile(
      path.join(root, "text.txt"),
      '# Readable heading\n<script>alert("no")</script>\nname,value\nhello,3\n' +
        "x".repeat(300_000),
    );
    expect((await sharp(await renderThumbnail(input("text.txt", category))).metadata()).width).toBe(
      360,
    );
  }
});

test("SVG rejects external references and entities but renders local shapes", async () => {
  await writeFile(
    path.join(root, "safe.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg" width="360" height="240"><rect width="360" height="240" fill="red"/></svg>',
  );
  expect((await sharp(await renderThumbnail(input("safe.svg", "svg"))).metadata()).format).toBe(
    "webp",
  );
  await writeFile(
    path.join(root, "bad.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg"><image href="file:///etc/passwd"/></svg>',
  );
  await expect(renderThumbnail(input("bad.svg", "svg"))).rejects.toThrow("thumbnail_unsafe_svg");
});

test("converter deadline and missing converter errors are explicit", async () => {
  await expect(runThumbnailCommand("missing-harnery-thumbnail-converter", [])).rejects.toThrow(
    "converter_missing:",
  );
  await expect(
    runThumbnailCommand(process.execPath, ["-e", "setTimeout(()=>{},10000)"], 50),
  ).rejects.toThrow("thumbnail_timeout");
});

test.skipIf(!hasMedia)("audio thumbnail renders a bounded waveform", async () => {
  await runThumbnailCommand("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=1",
    "-threads",
    "1",
    "-y",
    path.join(root, "tone.wav"),
  ]);
  const bytes = await renderThumbnail(input("tone.wav", "audio"));
  expect((await sharp(bytes).metadata()).width).toBe(360);
});

test.skipIf(!hasBrowser)(
  "HTML renders checked local styles while scripts and remote requests remain disabled",
  async () => {
    let requests = 0;
    const server = createServer((_req, res) => {
      requests++;
      res.end("body { background: red }");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    try {
      await mkdir(path.join(root, "pages"));
      await writeFile(
        path.join(root, "pages", "style.css"),
        "body { background: rgb(0, 0, 255); margin: 0 }",
      );
      await writeFile(
        path.join(root, "pages", "page.html"),
        `<html><head><link rel="stylesheet" href="style.css"><link rel="stylesheet" href="http://127.0.0.1:${port}/evil.css"></head><body><script>document.body.style.background='red';fetch('http://127.0.0.1:${port}/script')</script></body></html>`,
      );
      const timings: number[] = [];
      for (let n = 0; n < 2; n++) {
        const start = performance.now();
        const bytes = await renderThumbnail(input("pages/page.html", "html"));
        timings.push(performance.now() - start);
        const { data } = await sharp(bytes).raw().toBuffer({ resolveWithObject: true });
        expect(data[0]).toBeLessThan(20);
        expect(data[2]).toBeGreaterThan(230);
      }
      expect(requests).toBe(0);
      console.log(
        JSON.stringify({ benchmark: "html renderer", coldMs: timings[0], warmMs: timings[1] }),
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
  30_000,
);

test.skipIf(!hasOffice)(
  "Office document generates the first page through an isolated profile",
  async () => {
    await writeFile(
      path.join(root, "document.rtf"),
      "{\\rtf1\\ansi\\deff0 {\\fonttbl {\\f0 Arial;}}\\f0\\fs40 Thumbnail document\\par First page content.}",
    );
    const timings: number[] = [];
    for (let index = 0; index < 4; index++) {
      const start = performance.now();
      const bytes = await renderThumbnail(input("document.rtf", "binary"));
      timings.push(performance.now() - start);
      const meta = await sharp(bytes).metadata();
      expect(meta.format).toBe("webp");
      expect(meta.height).toBeLessThanOrEqual(240);
    }
    console.log(
      JSON.stringify({
        benchmark: "office renderer",
        coldMs: timings[0],
        warmMs: timings.slice(1),
      }),
    );
  },
  30_000,
);

test("thumbnail format capability includes Office files and rejects unrelated binaries", () => {
  expect(canRenderThumbnail("binary", "report.DOCX")).toBe(true);
  expect(canRenderThumbnail("binary", "report.exe")).toBe(false);
  expect(canRenderThumbnail("csv", "sheet.tsv")).toBe(true);
});

test("text secret signatures are refused before conversion", async () => {
  await writeFile(
    path.join(root, "secret.txt"),
    "-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n-----END PRIVATE KEY-----",
  );
  await expect(renderThumbnail(input("secret.txt", "text"))).rejects.toThrow("denied");
});

test("closing Office cancels queued work without starting a replacement worker", async () => {
  const pending = convertOfficeThumbnail(
    path.join(root, "never-open.rtf"),
    path.join(root, "never-created.pdf"),
    "writer_pdf_Export",
  );
  const result = pending.catch((error: Error) => error.message);
  await closeOfficeThumbnailWorker();
  expect(await result).toBe("thumbnail_closed");
  expect(existsSync(path.join(root, "never-created.pdf"))).toBe(false);
});

test.skipIf(!hasBrowser)(
  "browser worker can close and start again with a fresh context",
  async () => {
    await closeThumbnailBrowser();
    await writeFile(
      path.join(root, "restart.html"),
      '<html><body style="background:rgb(0,0,255)"></body></html>',
    );
    const bytes = await renderThumbnail(input("restart.html", "html"));
    const { data } = await sharp(bytes).raw().toBuffer({ resolveWithObject: true });
    expect(data[0]).toBeLessThan(20);
    expect(data[2]).toBeGreaterThan(230);
    await closeThumbnailBrowser();
  },
  30_000,
);

/** Run from web: bun scripts/thumbnail-benchmark.ts <fixture-dir> [base-url]. */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import sharp from "sharp";
import { coordRoot } from "../lib/coord-reader";
import { runThumbnailCommand } from "../lib/thumbnail-renderers";
import { __resetThumbnailMemory, serveFileThumbnail } from "../lib/thumbnail-service";

const directory = process.argv[2];
if (!directory)
  throw new Error("Provide an empty managed artifact directory for benchmark fixtures.");
const root = path.resolve(directory);
await mkdir(path.join(root, ".harnery"), { recursive: true });
await writeFile(
  path.join(root, "sequence.json"),
  JSON.stringify(
    {
      title: "Motion sequence",
      duration_seconds: 10,
      keyframes: Array.from({ length: 12 }, (_, index) => ({
        frame: index + 1,
        direction: "Follow the subject across the scene",
      })),
    },
    null,
    2,
  ),
);
await writeFile(
  path.join(root, "notes.md"),
  "# Preview benchmark\n\nA rendered document thumbnail.\n\n## Results\n\n- Files load immediately\n- Thumbnails arrive in the background\n",
);
await writeFile(
  path.join(root, "table.csv"),
  "Name,Count,Status\nImages,12,Ready\nDocuments,6,Ready\nVideo,1,Ready\n",
);
await writeFile(
  path.join(root, "page.html"),
  '<!doctype html><html><head><style>body{font:24px sans-serif;background:#e7eff6;padding:30px}h1{color:#075985}.card{background:white;padding:24px;border-radius:16px}</style></head><body><h1>File previews</h1><div class="card">A rendered HTML document</div></body></html>',
);
await writeFile(
  path.join(root, "document.rtf"),
  "{\\rtf1\\ansi\\deff0 {\\fonttbl {\\f0 Arial;}}\\f0\\fs40 Thumbnail benchmark\\par\\fs24 A document rendered through LibreOffice.}",
);
await sharp({ create: { width: 1600, height: 1000, channels: 3, background: "#075985" } })
  .png()
  .toFile(path.join(root, "image.png"));
await runThumbnailCommand("ffmpeg", [
  "-hide_banner",
  "-loglevel",
  "error",
  "-y",
  "-f",
  "lavfi",
  "-i",
  "testsrc2=size=640x360:rate=24",
  "-t",
  "2",
  "-threads",
  "1",
  "-c:v",
  "libx264",
  "-pix_fmt",
  "yuv420p",
  path.join(root, "video.mp4"),
]);
await runThumbnailCommand("ffmpeg", [
  "-hide_banner",
  "-loglevel",
  "error",
  "-y",
  "-f",
  "lavfi",
  "-i",
  "sine=frequency=440:duration=2",
  "-threads",
  "1",
  path.join(root, "audio.wav"),
]);
// A minimal valid one-page PDF avoids adding a document authoring dependency.
const stream = "BT /F1 28 Tf 40 170 Td (Preview benchmark) Tj ET";
const objects = [
  "<< /Type /Catalog /Pages 2 0 R >>",
  "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 360 240] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
  "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
];
let pdf = "%PDF-1.4\n";
const offsets = [0];
for (const [index, object] of objects.entries()) {
  offsets.push(Buffer.byteLength(pdf));
  pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
}
const xref = Buffer.byteLength(pdf);
pdf += `xref\n0 6\n0000000000 65535 f \n${offsets
  .slice(1)
  .map((n) => `${String(n).padStart(10, "0")} 00000 n \n`)
  .join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
await writeFile(path.join(root, "document.pdf"), pdf);
await mkdir(path.join(root, "folder"), { recursive: true });
await writeFile(
  path.join(root, "folder", "notes.md"),
  "# Folder collage\nA document inside the folder.",
);
const paths = [
  "image.png",
  "sequence.json",
  "notes.md",
  "table.csv",
  "video.mp4",
  "audio.wav",
  "document.pdf",
  "page.html",
  "document.rtf",
  "folder",
];
const request = (file: string) =>
  new Request(`http://localhost/api/file/thumbnail?path=${encodeURIComponent(file)}`);
const rows = [];
for (const file of paths) {
  const started = performance.now();
  const cold = await serveFileThumbnail(request(file), { root, wait: true });
  const bytes = (await cold.arrayBuffer()).byteLength;
  const coldMs = +(performance.now() - started).toFixed(2);
  const warm = [];
  for (let i = 0; i < 10; i++) {
    const t = performance.now();
    const r = await serveFileThumbnail(request(file), { root });
    await r.arrayBuffer();
    warm.push(performance.now() - t);
  }
  await __resetThumbnailMemory();
  const diskStart = performance.now();
  const disk = await serveFileThumbnail(request(file), { root });
  await disk.arrayBuffer();
  const row = {
    file,
    status: cold.status,
    coldMs,
    bytes,
    warmMedianMs: +warm.sort((a, b) => a - b)[5].toFixed(2),
    diskMs: +(performance.now() - diskStart).toFixed(2),
    diskCache: disk.headers.get("x-thumbnail-cache"),
  };
  rows.push(row);
  console.log(JSON.stringify(row));
}
await writeFile(
  path.join(root, "benchmark-results.json"),
  JSON.stringify(
    { kind: "in-process service, includes staging/render/cache writes", rows },
    null,
    2,
  ),
);

if (process.argv[3]) {
  const base = process.argv[3];
  const relative = path.relative(coordRoot(), root).split(path.sep).join("/");
  if (relative.startsWith(".."))
    throw new Error("HTTP benchmark fixtures must be inside the active project");
  const listTimes: number[] = [];
  const listWork = (async () => {
    for (let i = 0; i < 20; i++) {
      const t = performance.now();
      const response = await fetch(`${base}/api/file/list?dir=${encodeURIComponent(relative)}`, {
        signal: AbortSignal.timeout(20_000),
      });
      await response.arrayBuffer();
      if (!response.ok) throw new Error(`Listing failed: ${response.status}`);
      listTimes.push(performance.now() - t);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  })();
  const httpRows = await Promise.all(
    paths.map(async (file) => {
      const url = `${base}/api/file/thumbnail?path=${encodeURIComponent(`${relative}/${file}`)}`;
      const start = performance.now();
      let response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      const enqueueMs = +(performance.now() - start).toFixed(2);
      const initialStatus = response.status;
      while (response.status === 202 && performance.now() - start < 45_000) {
        await response.arrayBuffer();
        await new Promise((resolve) => setTimeout(resolve, 50));
        response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      }
      const bytes = (await response.arrayBuffer()).byteLength;
      const readyMs = +(performance.now() - start).toFixed(2);
      if (response.status !== 200)
        return {
          file,
          initialStatus,
          status: response.status,
          enqueueMs,
          readyMs,
          bytes,
          error: "Thumbnail did not complete",
        };
      const warmMs = [];
      for (let i = 0; i < 5; i++) {
        const t = performance.now();
        const r = await fetch(url, { signal: AbortSignal.timeout(20_000) });
        await r.arrayBuffer();
        if (r.status !== 200) throw new Error(`Cached thumbnail failed: ${r.status}`);
        warmMs.push(performance.now() - t);
      }
      return {
        file,
        initialStatus,
        status: response.status,
        enqueueMs,
        readyMs,
        bytes,
        warmMedianMs: +warmMs.sort((a, b) => a - b)[2].toFixed(2),
      };
    }),
  );
  await listWork;
  const sorted = listTimes.sort((a, b) => a - b);
  const result = {
    kind: "concurrent HTTP mixed grid; 50ms completion sampling",
    base,
    httpRows,
    listing: {
      samples: sorted.length,
      medianMs: +sorted[Math.floor(sorted.length / 2)].toFixed(2),
      p95Ms: +sorted[Math.floor(sorted.length * 0.95)].toFixed(2),
      maxMs: +sorted.at(-1)!.toFixed(2),
    },
  };
  console.log(JSON.stringify(result, null, 2));
  await writeFile(path.join(root, "benchmark-http.json"), JSON.stringify(result, null, 2));
  if (httpRows.some((row) => row.status !== 200)) process.exitCode = 1;
}

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Papa from "papaparse";
import sharp from "sharp";
import { type FileCategory, scanChunk } from "./files";
import { convertOfficeThumbnail } from "./thumbnail-renderers/office";

export interface ThumbnailInput {
  /** Private copy; unused when media is read from inputFd. */
  inputPath: string;
  /** Borrowed checked descriptor, retained by the caller until rendering completes. */
  inputFd?: number;
  relPath: string;
  category: FileCategory;
  root: string;
}

const WIDTH = 360;
const HEIGHT = 240;
const TEXT_BYTES = 256 * 1024;
const OUTPUT_BYTES = 4 * 1024 * 1024;
const OFFICE_EXTENSIONS = new Set([
  "doc",
  "docx",
  "odt",
  "rtf",
  "xls",
  "xlsx",
  "ods",
  "ppt",
  "pptx",
  "odp",
]);
const CATEGORIES = new Set<FileCategory>([
  "image",
  "svg",
  "video",
  "audio",
  "pdf",
  "text",
  "code",
  "json",
  "yaml",
  "csv",
  "markdown",
  "html",
]);

export function canRenderThumbnail(category: FileCategory, relPath: string): boolean {
  return (
    CATEGORIES.has(category) || OFFICE_EXTENSIONS.has(path.extname(relPath).slice(1).toLowerCase())
  );
}

/** Child fd 3 is inherited from the checked inode, never reopened by its original name. */
export function thumbnailDescriptorPath(): string | null {
  if (process.platform === "linux" && existsSync("/proc/self/fd")) return "/proc/self/fd/3";
  if (process.platform === "darwin" && existsSync("/dev/fd")) return "/dev/fd/3";
  return null;
}

/** Fixed argv, bounded pipes, and a hard deadline for each native converter. */
export function runThumbnailCommand(
  command: string,
  args: string[],
  timeoutMs = 8_000,
  inputFd?: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const grouped = process.platform !== "win32";
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe", ...(inputFd === undefined ? [] : [inputFd])],
      windowsHide: true,
      detached: grouped,
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let stderrSize = 0;
    let failure: Error | undefined;
    const stop = (message: string) => {
      failure ??= new Error(message);
      try {
        if (grouped && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        /* The converter may already have exited. */
      }
    };
    const timer = setTimeout(() => stop("thumbnail_timeout"), timeoutMs);
    child.stdout!.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > OUTPUT_BYTES) stop("thumbnail_output_limit");
      else chunks.push(chunk);
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      stderrSize += chunk.length;
      if (stderrSize > 64 * 1024) stop("thumbnail_output_limit");
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(
        new Error(error.code === "ENOENT" ? `converter_missing:${command}` : "converter_failed"),
      );
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error("converter_failed"));
      else resolve(Buffer.concat(chunks));
    });
  });
}

export function escapeThumbnailText(text: string): string {
  return (
    text
      .replace(
        /[&<>"']/g,
        (character) =>
          ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[character]!,
      )
      // biome-ignore lint/suspicious/noControlCharactersInRegex: Remove XML-invalid controls from arbitrary file text.
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
  );
}

async function readText(inputPath: string, limit = TEXT_BYTES): Promise<string> {
  const file = await open(inputPath, "r");
  try {
    const bytes = Buffer.alloc(limit);
    const { bytesRead } = await file.read(bytes, 0, limit, 0);
    const content = bytes.subarray(0, bytesRead);
    if (scanChunk(content).secret) throw new Error("denied");
    return content.toString("utf8");
  } finally {
    await file.close();
  }
}

/** Render text directly with libvips instead of starting a browser per file. */
export async function renderTextThumbnail(input: ThumbnailInput): Promise<Buffer> {
  let source = await readText(input.inputPath);
  if (input.category === "json") {
    try {
      source = JSON.stringify(JSON.parse(source), null, 2);
    } catch {
      /* A bounded excerpt can end mid-document. */
    }
  }
  if (input.category === "csv") {
    const rows = Papa.parse<string[]>(source, {
      preview: 9,
      delimiter: path.extname(input.relPath) === ".tsv" ? "\t" : "",
      skipEmptyLines: true,
    }).data;
    const columns = Math.max(1, Math.min(4, rows[0]?.length ?? 1));
    const width = 336 / columns;
    const table = rows
      .map((row, index) =>
        row
          .slice(0, columns)
          .map(
            (value, column) =>
              `<rect x="${12 + column * width}" y="${34 + index * 22}" width="${width}" height="22" fill="${index === 0 ? "#263749" : index % 2 ? "#14202c" : "#101820"}" stroke="#334155" stroke-width="0.5"/><text x="${18 + column * width}" y="${49 + index * 22}" font-size="10" fill="${index === 0 ? "#7dd3fc" : "#cbd5e1"}">${escapeThumbnailText(value.slice(0, Math.floor((width - 12) / 6)))}</text>`,
          )
          .join(""),
      )
      .join("");
    return webp(
      Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="360" height="240"><rect width="100%" height="100%" fill="#101820"/><g font-family="monospace"><text x="12" y="20" fill="#94a3b8" font-size="10">${escapeThumbnailText(path.basename(input.relPath).slice(0, 48))}</text>${table}</g></svg>`,
      ),
    );
  }
  const lines = source.replace(/\t/g, "  ").split(/\r?\n/).slice(0, 15);
  let y = 46;
  const body = lines
    .map((line) => {
      const heading = input.category === "markdown" && /^#{1,6}\s/.test(line);
      const text =
        input.category === "markdown"
          ? line
              .replace(/^#{1,6}\s+/, "")
              .replace(/!\[[^\]]*\]\([^)]*\)/g, "[image]")
              .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
              .replace(/\*\*([^*]+)\*\*/g, "$1")
          : line;
      const color = heading
        ? "#f8fafc"
        : /^\s*(\/\/|#|<!--)/.test(line)
          ? "#94a3b8"
          : /^\s*["']/.test(line)
            ? "#7dd3fc"
            : "#cbd5e1";
      const result = `<text x="16" y="${y}" font-size="${heading ? 14 : 10}" font-weight="${heading ? 700 : 400}" fill="${color}">${escapeThumbnailText(text.slice(0, 100))}</text>`;
      y += heading ? 20 : 14;
      return result;
    })
    .join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}"><rect width="100%" height="100%" fill="#101820"/><rect width="100%" height="28" fill="#1e293b"/><g font-family="monospace"><text x="16" y="18" fill="#94a3b8" font-size="10">${escapeThumbnailText(path.basename(input.relPath).slice(0, 48))}</text>${body}</g></svg>`;
  return webp(Buffer.from(svg));
}

async function webp(bytes: Buffer): Promise<Buffer> {
  return sharp(bytes, { limitInputPixels: 32_000_000, animated: false })
    .rotate()
    .resize(WIDTH, HEIGHT, { fit: "inside", withoutEnlargement: true })
    .webp({ quality: 72 })
    .timeout({ seconds: 5 })
    .toBuffer();
}

async function renderMedia(input: ThumbnailInput): Promise<Buffer> {
  const inputPath = input.inputFd === undefined ? input.inputPath : thumbnailDescriptorPath();
  if (!inputPath) throw new Error("thumbnail_descriptor_unavailable");
  const run = (args: string[]) => runThumbnailCommand("ffmpeg", args, 8_000, input.inputFd);
  const common = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    "-threads",
    "1",
    "-filter_threads",
    "1",
    "-protocol_whitelist",
    "file,pipe",
  ];
  if (input.category === "audio") {
    const bytes = await run([
      ...common,
      "-i",
      inputPath,
      "-t",
      "30",
      "-filter_complex",
      "[0:a]atrim=duration=30,showwavespic=s=360x240:colors=0x38bdf8",
      "-frames:v",
      "1",
      "-threads",
      "1",
      "-f",
      "image2pipe",
      "-vcodec",
      "png",
      "pipe:1",
    ]);
    return webp(bytes);
  }
  const frame = (seek: string) =>
    run([
      ...common,
      "-ss",
      seek,
      "-i",
      inputPath,
      "-an",
      "-vf",
      "scale=360:240:force_original_aspect_ratio=decrease",
      "-frames:v",
      "1",
      "-threads",
      "1",
      "-f",
      "image2pipe",
      "-vcodec",
      "png",
      "pipe:1",
    ]);
  let bytes = await frame("1");
  if (!bytes.length) bytes = await frame("0");
  return webp(bytes);
}

async function renderPdf(inputPath: string): Promise<Buffer> {
  const temp = await mkdtemp(path.join(tmpdir(), "harn-thumb-pdf-"));
  try {
    await runThumbnailCommand("pdftoppm", [
      "-f",
      "1",
      "-singlefile",
      "-scale-to",
      "360",
      "-png",
      inputPath,
      path.join(temp, "page"),
    ]);
    return webp(await readFile(path.join(temp, "page.png")));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

async function renderOffice(input: ThumbnailInput): Promise<Buffer> {
  const temp = await mkdtemp(path.join(tmpdir(), "harn-thumb-office-"));
  try {
    const ext = path.extname(input.relPath).slice(1).toLowerCase();
    const filter = ["xls", "xlsx", "ods"].includes(ext)
      ? "calc_pdf_Export"
      : ["ppt", "pptx", "odp"].includes(ext)
        ? "impress_pdf_Export"
        : "writer_pdf_Export";
    const pdf = path.join(temp, "page.pdf");
    await convertOfficeThumbnail(input.inputPath, pdf, filter);
    return await renderPdf(pdf);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

export async function renderThumbnail(input: ThumbnailInput): Promise<Buffer> {
  if (OFFICE_EXTENSIONS.has(path.extname(input.relPath).slice(1).toLowerCase()))
    return renderOffice(input);
  if (["text", "code", "json", "yaml", "csv", "markdown"].includes(input.category))
    return renderTextThumbnail(input);
  if (input.category === "image" || input.category === "svg") {
    const bytes = await readFile(input.inputPath);
    if (input.category === "svg") {
      const svg = bytes.toString("utf8");
      const references = [
        ...svg.matchAll(/(?:href\s*=\s*["']([^"']*)["']|url\(\s*["']?([^)'"\s]+))/gi),
      ];
      if (
        /<!DOCTYPE|<!ENTITY|@import/i.test(svg) ||
        references.some((match) => !/^(#|data:)/i.test(match[1] ?? match[2] ?? "")) ||
        scanChunk(bytes).secret
      )
        throw new Error("thumbnail_unsafe_svg");
    }
    return webp(bytes);
  }
  if (input.category === "audio" || input.category === "video") return renderMedia(input);
  if (input.category === "pdf") return renderPdf(input.inputPath);
  if (input.category === "html") {
    const { renderHtmlThumbnail } = await import("./thumbnail-renderers/html");
    return renderHtmlThumbnail(input);
  }
  throw new Error("thumbnail_unsupported");
}

import { type ChildProcess, spawn } from "node:child_process";
import { closeSync, readSync } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { resolveFile, sandboxedTreeMimeFor, scanChunk } from "../files";
import type { ThumbnailInput } from "../thumbnail-renderers";
import { thumbnailDependencyGraph, thumbnailDocumentUrl } from "./dependencies";
import { thumbnailHelperPath } from "./helper-path";

type Job = {
  child: ChildProcess;
  root: string;
  allowedPaths: Set<string>;
  assetCount: number;
  assetBytes: number;
  resolve: (bytes: Buffer) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};
let child: ChildProcess | undefined;
let sequence = 0;
let idle: ReturnType<typeof setTimeout> | undefined;
const jobs = new Map<number, Job>();
const stopped = new WeakSet<ChildProcess>();
const browserPids = new WeakMap<ChildProcess, number>();

function stop(instance: ChildProcess, reason: string): void {
  if (stopped.has(instance)) return;
  stopped.add(instance);
  if (child === instance) child = undefined;
  for (const [id, job] of jobs)
    if (job.child === instance) {
      clearTimeout(job.timer);
      jobs.delete(id);
      job.reject(new Error(reason));
    }
  instance.kill("SIGTERM");
  const timer = setTimeout(() => {
    // Chromium has its own process group; killing only its worker leaves it behind.
    for (const pid of [browserPids.get(instance), instance.pid]) {
      if (!pid) continue;
      try {
        process.kill(process.platform === "win32" ? pid : -pid, "SIGKILL");
      } catch {
        /* Already exited. */
      }
    }
  }, 1500);
  timer.unref?.();
}

function readAsset(job: Job, pathname: string): { bytes?: Buffer; mime?: string } {
  if (!job.allowedPaths.has(pathname) || ++job.assetCount > 32) return {};
  let relative: string;
  try {
    relative = decodeURIComponent(pathname.slice(1));
  } catch {
    return {};
  }
  const asset = resolveFile(relative, { root: job.root });
  if (!asset.ok) return {};
  try {
    if (asset.size > 4 * 1024 * 1024 || job.assetBytes + asset.size > 16 * 1024 * 1024) return {};
    job.assetBytes += asset.size;
    const bytes = Buffer.alloc(asset.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(asset.fd, bytes, offset, bytes.length - offset, offset);
      if (!count) break;
      offset += count;
    }
    const content = bytes.subarray(0, offset);
    if (scanChunk(content).secret) return {};
    return {
      bytes: content,
      mime: sandboxedTreeMimeFor(asset.category, path.extname(asset.relPath).slice(1)),
    };
  } finally {
    closeSync(asset.fd);
  }
}

function getWorker(): ChildProcess {
  clearTimeout(idle);
  if (child) return child;
  const instance = spawn(process.execPath, [thumbnailHelperPath("browser-worker.mjs")], {
    serialization: "advanced",
    detached: process.platform !== "win32",
    windowsHide: true,
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  child = instance;
  let stderr = 0;
  let completed = 0;
  const started = Date.now();
  instance.stderr?.on("data", (bytes: Buffer) => {
    stderr += bytes.length;
    if (stderr > 64 * 1024) stop(instance, "thumbnail_output_limit");
  });
  instance.on("error", () => stop(instance, "thumbnail_browser_failed"));
  instance.on("exit", () => stop(instance, "thumbnail_browser_failed"));
  instance.on(
    "message",
    (message: {
      type?: string;
      id?: number;
      assetId?: number;
      pathname?: string;
      bytes?: Uint8Array;
      error?: string;
      pid?: number;
    }) => {
      if (message.type === "browser-process" && typeof message.pid === "number") {
        browserPids.set(instance, message.pid);
        return;
      }
      if (typeof message.id !== "number") return;
      const job = jobs.get(message.id);
      if (!job || job.child !== instance) return;
      if (message.type === "asset") {
        let result = {};
        try {
          result = readAsset(job, message.pathname ?? "");
        } catch {
          /* Asset refusal is a failed request, not a failed page. */
        }
        if (instance.connected)
          instance.send({ type: "asset-result", assetId: message.assetId, ...result });
        return;
      }
      if (message.type !== "result") return;
      clearTimeout(job.timer);
      jobs.delete(message.id);
      completed++;
      if (message.error || !message.bytes || message.bytes.byteLength > 4 * 1024 * 1024)
        job.reject(new Error(message.error ?? "thumbnail_output_limit"));
      else job.resolve(Buffer.from(message.bytes));
      if (![...jobs.values()].some((pending) => pending.child === instance)) {
        if (completed >= 256 || Date.now() - started > 600_000) {
          stop(instance, "thumbnail_recycled");
          return;
        }
        idle = setTimeout(() => {
          stop(instance, "thumbnail_idle");
        }, 120_000);
        idle.unref?.();
      }
    },
  );
  instance.unref();
  instance.channel?.unref?.();
  return instance;
}

export async function closeThumbnailBrowser(): Promise<void> {
  clearTimeout(idle);
  const current = child;
  if (!current) return;
  const exited = new Promise<void>((resolve) => {
    if (current.exitCode !== null || current.signalCode !== null) resolve();
    else current.once("exit", () => resolve());
  });
  stop(current, "thumbnail_closed");
  await exited;
}

/** The web process reads checked assets; browser imports and rendering run elsewhere. */
export async function renderHtmlThumbnail(input: ThumbnailInput): Promise<Buffer> {
  const file = await open(input.inputPath, "r");
  let html: Buffer;
  let allowedPaths: Set<string>;
  try {
    if ((await file.stat()).size > 2 * 1024 * 1024) throw new Error("thumbnail_source_limit");
    html = await file.readFile();
    if (scanChunk(html).secret) throw new Error("denied");
    ({ allowedPaths } = await thumbnailDependencyGraph(
      { fd: file.fd, relPath: input.relPath, category: "html" },
      input.root,
    ));
  } finally {
    await file.close();
  }
  if (jobs.size >= 2) throw new Error("thumbnail_busy");
  const instance = getWorker();
  const id = ++sequence;
  const screenshot = await new Promise<Buffer>((resolve, reject) => {
    const timer = setTimeout(() => stop(instance, "thumbnail_timeout"), 25_000);
    jobs.set(id, {
      child: instance,
      root: input.root,
      allowedPaths,
      assetCount: 0,
      assetBytes: 0,
      resolve,
      reject,
      timer,
    });
    instance.send(
      {
        type: "render",
        id,
        html,
        allowedPaths: [...allowedPaths],
        url: thumbnailDocumentUrl(input.relPath),
      },
      (error) => {
        if (error) stop(instance, "thumbnail_browser_failed");
      },
    );
  });
  return sharp(screenshot).resize(360, 240).webp({ quality: 72 }).toBuffer();
}

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { thumbnailHelperPath } from "./helper-path";

type Job = {
  resolve: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};
type OfficeWorker = {
  child: ChildProcessWithoutNullStreams;
  jobs: Map<number, Job>;
  officePid?: number;
  profile?: string;
  stopped?: boolean;
};
let worker: OfficeWorker | undefined;
let sequence = 0;
let serial = Promise.resolve();
let queued = 0;
let generation = 0;

function stop(instance: OfficeWorker, reason: string): void {
  if (instance.stopped) return;
  instance.stopped = true;
  if (worker === instance) worker = undefined;
  for (const job of instance.jobs.values()) {
    clearTimeout(job.timer);
    job.reject(new Error(reason));
  }
  instance.jobs.clear();
  try {
    if (process.platform !== "win32" && instance.officePid)
      process.kill(-instance.officePid, "SIGKILL");
  } catch {
    /* Already exited. */
  }
  instance.child.kill("SIGTERM");
  const timer = setTimeout(() => instance.child.kill("SIGKILL"), 1000);
  timer.unref?.();
}

function getWorker(): OfficeWorker {
  if (worker) return worker;
  const child = spawn("python3", ["-u", thumbnailHelperPath("office-worker.py")], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const instance: OfficeWorker = { child, jobs: new Map() };
  worker = instance;
  let buffered = "";
  let stderrBytes = 0;
  child.stderr.on("data", (chunk: Buffer) => {
    stderrBytes += chunk.length;
    if (stderrBytes > 64 * 1024) stop(instance, "thumbnail_output_limit");
  });
  child.on("error", () => stop(instance, "converter_missing:python3"));
  child.stdin.on("error", () => stop(instance, "thumbnail_office_failed"));
  child.on("exit", () => {
    stop(instance, "thumbnail_office_failed");
    if (instance.profile)
      void rm(instance.profile, { recursive: true, force: true }).catch(() => {});
  });
  child.stdout.on("data", (chunk: Buffer) => {
    buffered += chunk.toString("utf8");
    if (buffered.length > 64 * 1024) {
      stop(instance, "thumbnail_output_limit");
      return;
    }
    while (true) {
      const end = buffered.indexOf("\n");
      if (end < 0) break;
      const line = buffered.slice(0, end);
      buffered = buffered.slice(end + 1);
      let message: {
        type?: string;
        pid?: number;
        profile?: string;
        id?: number;
        error?: string;
        retire?: boolean;
      };
      try {
        message = JSON.parse(line);
      } catch {
        stop(instance, "thumbnail_office_failed");
        return;
      }
      if (message.type === "office") {
        instance.officePid = message.pid;
        instance.profile = message.profile;
        continue;
      }
      if (message.id === undefined) {
        stop(instance, message.error ?? "thumbnail_office_failed");
        return;
      }
      const job = instance.jobs.get(message.id);
      if (!job) continue;
      clearTimeout(job.timer);
      instance.jobs.delete(message.id);
      if (message.error) job.reject(new Error(message.error));
      else job.resolve();
      if (message.retire) stop(instance, "thumbnail_recycled");
    }
  });
  child.unref();
  return instance;
}

export async function closeOfficeThumbnailWorker(): Promise<void> {
  generation++;
  const current = worker;
  if (!current) return;
  const exited = new Promise<void>((resolve) => {
    if (current.child.exitCode !== null || current.child.signalCode !== null) resolve();
    else current.child.once("exit", () => resolve());
  });
  stop(current, "thumbnail_closed");
  await exited;
}

/** A single UNO process exports documents sequentially without restarting Office. */
export async function convertOfficeThumbnail(
  inputPath: string,
  outputPath: string,
  filter: string,
): Promise<void> {
  if (queued >= 8) throw new Error("thumbnail_busy");
  queued++;
  const requestedGeneration = generation;
  const run = serial.then(
    () =>
      new Promise<void>((resolve, reject) => {
        if (requestedGeneration !== generation) {
          reject(new Error("thumbnail_closed"));
          return;
        }
        const instance = getWorker();
        const id = ++sequence;
        const timer = setTimeout(() => stop(instance, "thumbnail_timeout"), 25_000);
        instance.jobs.set(id, { resolve, reject, timer });
        instance.child.stdin.write(
          `${JSON.stringify({ id, inputPath, outputPath, filter })}\n`,
          (error) => {
            if (error) stop(instance, "thumbnail_office_failed");
          },
        );
      }),
  );
  serial = run.catch(() => {});
  try {
    await run;
  } finally {
    queued--;
  }
}

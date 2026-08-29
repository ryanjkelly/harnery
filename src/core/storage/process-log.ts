import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  fdatasyncSync,
  mkdirSync,
  openSync,
  renameSync,
  statSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createStorageCatalog } from "./catalog.ts";
import { familyLogDirectory } from "./segments.ts";

export interface RotatingTextSinkOptions {
  path: string;
  max_bytes: number;
  backups?: number;
  durable?: boolean;
}

export interface ProcessLogDestinationOptions {
  coord_root: string;
  project_root?: string;
  family_id: string;
  filename: string;
  legacy_path: string;
  env?: Readonly<Record<string, string | undefined>>;
}

export interface RotatingProcessOptions {
  path: string;
  command: string;
  arguments?: string[];
  env?: Readonly<Record<string, string | undefined>>;
  max_bytes?: number;
  backups?: number;
}

const DEFAULT_PROCESS_LOG_BYTES = 5 * 1024 * 1024;
const DEFAULT_PROCESS_LOG_BACKUPS = 3;

/** Resolve one catalog-owned partition path, with an explicit legacy rollback. */
export function processLogDestination(options: ProcessLogDestinationOptions): string {
  const env = options.env ?? process.env;
  if (env.HARNERY_SHARED_LOGS === "0") return resolve(options.legacy_path);
  if (
    basename(options.filename) !== options.filename ||
    !/^[a-z0-9][a-z0-9.-]*$/i.test(options.filename)
  ) {
    throw new Error("invalid process log filename");
  }
  const catalog = createStorageCatalog({
    coord_root: resolve(options.coord_root),
    project_root: resolve(options.project_root ?? options.coord_root),
  });
  return join(familyLogDirectory(catalog.require(options.family_id)), options.filename);
}

export class RotatingTextSink {
  readonly #options: Required<RotatingTextSinkOptions>;
  #closed = false;

  constructor(options: RotatingTextSinkOptions) {
    if (!Number.isSafeInteger(options.max_bytes) || options.max_bytes <= 0)
      throw new Error("invalid text log size limit");
    const backups = options.backups ?? 3;
    if (!Number.isSafeInteger(backups) || backups < 1)
      throw new Error("invalid text log backup limit");
    this.#options = {
      ...options,
      backups,
      durable: options.durable ?? false,
    };
  }

  append(text: string): void {
    if (this.#closed) throw new Error("text sink is closed");
    const bytes = Buffer.from(text, "utf8");
    mkdirSync(dirname(this.#options.path), { recursive: true, mode: 0o700 });
    let offset = 0;
    while (offset < bytes.byteLength) {
      let current = existsSync(this.#options.path) ? statSync(this.#options.path).size : 0;
      if (current >= this.#options.max_bytes) {
        this.#rotate();
        current = 0;
      }
      const length = Math.min(bytes.byteLength - offset, this.#options.max_bytes - current);
      const fd = openSync(this.#options.path, "a", 0o600);
      try {
        writeSync(fd, bytes.subarray(offset, offset + length));
        if (this.#options.durable) fdatasyncSync(fd);
      } finally {
        closeSync(fd);
      }
      offset += length;
    }
  }

  startGeneration(): void {
    if (this.#closed) throw new Error("text sink is closed");
    if (existsSync(this.#options.path) && statSync(this.#options.path).size > 0) this.#rotate();
  }

  flush(): void {}
  close(): void {
    this.#closed = true;
  }

  #rotate(): void {
    for (let index = this.#options.backups; index >= 1; index -= 1) {
      const from = index === 1 ? this.#options.path : `${this.#options.path}.${index - 1}`;
      const to = `${this.#options.path}.${index}`;
      if (existsSync(from)) renameSync(from, to);
    }
  }
}

/** Spawn a detached-compatible Bun wrapper that continuously rotates child stdout/stderr. */
export function spawnRotatingProcess(options: RotatingProcessOptions): ChildProcess {
  const path = resolve(options.path);
  const sink = new RotatingTextSink({
    path,
    max_bytes: options.max_bytes ?? DEFAULT_PROCESS_LOG_BYTES,
    backups: options.backups ?? DEFAULT_PROCESS_LOG_BACKUPS,
  });
  sink.startGeneration();
  sink.close();
  const specification = JSON.stringify({
    path,
    max_bytes: options.max_bytes ?? DEFAULT_PROCESS_LOG_BYTES,
    backups: options.backups ?? DEFAULT_PROCESS_LOG_BACKUPS,
    command: options.command,
    arguments: options.arguments ?? [],
  });
  return spawn("bun", [fileURLToPath(import.meta.url), "--run", specification], {
    detached: true,
    stdio: "ignore",
    env: { ...(options.env ?? process.env) } as NodeJS.ProcessEnv,
  });
}

/** Run a short process synchronously while keeping its captured output bounded. */
export function runRotatingProcessSync(options: RotatingProcessOptions): number | null {
  const sink = new RotatingTextSink({
    path: options.path,
    max_bytes: options.max_bytes ?? DEFAULT_PROCESS_LOG_BYTES,
    backups: options.backups ?? DEFAULT_PROCESS_LOG_BACKUPS,
  });
  sink.startGeneration();
  const result = spawnSync(options.command, options.arguments ?? [], {
    encoding: "utf8",
    env: { ...(options.env ?? process.env) } as NodeJS.ProcessEnv,
  });
  if (result.stdout) sink.append(result.stdout);
  if (result.stderr) sink.append(result.stderr);
  if (result.error) sink.append(`${result.error.message}\n`);
  sink.close();
  return result.status;
}

async function runProcessLogWorker(raw: string | undefined): Promise<void> {
  const parsed = JSON.parse(raw ?? "null") as RotatingProcessOptions | null;
  if (!parsed || typeof parsed.command !== "string" || !Array.isArray(parsed.arguments)) {
    throw new Error("invalid process log worker specification");
  }
  const sink = new RotatingTextSink({
    path: resolve(parsed.path),
    max_bytes: parsed.max_bytes ?? DEFAULT_PROCESS_LOG_BYTES,
    backups: parsed.backups ?? DEFAULT_PROCESS_LOG_BACKUPS,
  });
  sink.startGeneration();
  const child = spawn(parsed.command, parsed.arguments, {
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk) => sink.append(String(chunk)));
  child.stderr?.on("data", (chunk) => sink.append(String(chunk)));
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => child.kill(signal));
  }
  const code = await new Promise<number>((resolveExit) => {
    child.once("error", (error) => {
      sink.append(`${error.message}\n`);
      resolveExit(1);
    });
    child.once("exit", (exitCode) => resolveExit(exitCode ?? 1));
  });
  sink.close();
  process.exitCode = code;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === resolve(fileURLToPath(import.meta.url)) && process.argv[2] === "--run") {
  void runProcessLogWorker(process.argv[3]).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

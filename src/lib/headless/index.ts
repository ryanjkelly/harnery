/**
 * Headless harness calling — run a one-shot prompt (optionally with images)
 * through a locally installed AI coding harness CLI and return its reply.
 *
 * Backends, in default preference order (subscription seats an embedding
 * host already pays for, before any metered API a host might add on top):
 *
 *   1. claude-code   `claude -p`         JSON envelope on stdout
 *   2. codex         `codex exec`        last message written to a file
 *   3. cursor        `cursor-agent -p`   plain text on stdout
 *
 * Design rules, each learned from a live failure:
 *
 * - Every call runs from a NEUTRAL temp cwd holding only the staged images,
 *   so the nested session loads no repo instructions, hooks, or coordination
 *   rituals from the caller's checkout.
 * - The child's stdin is CLOSED immediately. execFile leaves it open as a
 *   pipe, and codex interprets that as "more prompt coming" and blocks on
 *   it, then exits with no output.
 * - An empty reply THROWS instead of returning "": a one-shot call that
 *   produced nothing was inconclusive, and callers gating on the result must
 *   fail closed rather than read silence as success.
 * - `runHeadless` walks the backend chain PER CALL: a backend that is
 *   installed but errors (rate limit, timeout, transient exec failure) hands
 *   the same request to the next backend instead of failing the call. "On
 *   PATH" is not "working", and under parallel load the first backend can
 *   flake on a fraction of calls while the second runs clean.
 *
 * Env knobs (read through coordEnv, so the HARNERY_ prefix stays in one
 * place): HARNERY_HEADLESS_BACKEND forces one backend and disables the
 * fallback walk; HARNERY_HEADLESS_MODEL overrides the model passed to
 * whichever backend runs.
 */

import { execFile } from "node:child_process";
import {
  accessSync,
  constants,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { coordEnv } from "../env.ts";

const execFileAsync = promisify(execFile);

/** Names accepted by `runHeadlessOn`, `runHeadless({backends})`, and the
 * HARNERY_HEADLESS_BACKEND env knob. */
export type HeadlessBackendName = "claude-code" | "codex" | "cursor";

/** An image to stage into the call's neutral cwd. `data` is the PNG bytes
 * (Buffer) or their base64 encoding (string). */
export interface HeadlessImage {
  data: Buffer | string;
  /** Staged filename inside the neutral dir (default `image-<n>.png`). */
  name?: string;
}

export interface HeadlessRequest {
  /**
   * The prompt, or a builder receiving the staged image paths. Backends that
   * cannot attach an image natively (claude-code, cursor) rely on the prompt
   * naming the staged paths so the harness reads them with its own tools;
   * codex additionally attaches every image via `-i`.
   */
  prompt: string | ((ctx: { imagePaths: string[] }) => string);
  images?: HeadlessImage[];
  /** Model override for this call; HARNERY_HEADLESS_MODEL wins over it. */
  model?: string;
  /** Kill the child after this long (default 240_000 ms). */
  timeoutMs?: number;
  /** Agentic turn budget where the backend supports one (default 4). */
  maxTurns?: number;
}

export interface HeadlessResult {
  /** The harness's final reply text, never empty (empty replies throw). */
  text: string;
  /** Which backend produced it. */
  backend: HeadlessBackendName;
}

export interface RunHeadlessOptions {
  /** Preference order (default: HEADLESS_BACKENDS order). */
  backends?: HeadlessBackendName[];
  /** Walk the chain past a failing backend (default true). Forcing a backend
   * via HARNERY_HEADLESS_BACKEND implies false. */
  fallback?: boolean;
}

const MAX_BUFFER = 32 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 240_000;
const DEFAULT_MAX_TURNS = 4;

/** Cross-runtime `which`: walk PATH (and PATHEXT on Windows) for an
 * executable. Node has no built-in and Bun.which only exists under Bun. */
export function whichBin(bin: string): string | undefined {
  if (isAbsolute(bin)) return isExecutable(bin) ? bin : undefined;
  const paths = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  const exts =
    process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";") : [""];
  for (const dir of paths) {
    for (const ext of exts) {
      const candidate = join(dir, bin + ext.toLowerCase());
      if (isExecutable(candidate)) return candidate;
      if (ext) {
        const upper = join(dir, bin + ext);
        if (isExecutable(upper)) return upper;
      }
    }
  }
  return undefined;
}

function isExecutable(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

interface StagedCall {
  dir: string;
  imagePaths: string[];
  prompt: string;
  model?: string;
  timeoutMs: number;
  maxTurns: number;
}

/** Write the request's images into a fresh neutral dir and resolve the
 * prompt against their staged paths. Caller must clean the dir up. */
function stageCall(req: HeadlessRequest): StagedCall {
  const dir = mkdtempSync(join(tmpdir(), "harnery-headless-"));
  const imagePaths = (req.images ?? []).map((img, i) => {
    const path = join(dir, img.name ?? `image-${i + 1}.png`);
    writeFileSync(path, typeof img.data === "string" ? Buffer.from(img.data, "base64") : img.data);
    return path;
  });
  const prompt = typeof req.prompt === "function" ? req.prompt({ imagePaths }) : req.prompt;
  return {
    dir,
    imagePaths,
    prompt,
    model: coordEnv("HEADLESS_MODEL") ?? req.model,
    timeoutMs: req.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxTurns: req.maxTurns ?? DEFAULT_MAX_TURNS,
  };
}

/** Run a harness CLI from the neutral dir with stdin CLOSED (see module
 * comment: an open stdin pipe deadlocks codex). */
function execHarness(bin: string, args: string[], call: StagedCall) {
  const pending = execFileAsync(bin, args, {
    cwd: call.dir,
    timeout: call.timeoutMs,
    maxBuffer: MAX_BUFFER,
  });
  pending.child.stdin?.end();
  return pending;
}

function assertReply(text: string, backend: HeadlessBackendName): HeadlessResult {
  if (!text.trim()) throw new Error(`${backend}: empty reply (inconclusive; failing closed)`);
  return { text, backend };
}

async function runClaudeCode(bin: string, call: StagedCall): Promise<HeadlessResult> {
  const args = ["-p", call.prompt, "--output-format", "json", "--max-turns", String(call.maxTurns)];
  if (call.imagePaths.length) args.push("--allowedTools", "Read");
  if (call.model) args.push("--model", call.model);
  const { stdout } = await execHarness(bin, args, call);
  const envelope = JSON.parse(stdout) as { is_error?: boolean; result?: unknown };
  if (envelope.is_error) {
    throw new Error(
      typeof envelope.result === "string" ? envelope.result : "claude-code: headless error",
    );
  }
  return assertReply(typeof envelope.result === "string" ? envelope.result : "", "claude-code");
}

async function runCodex(bin: string, call: StagedCall): Promise<HeadlessResult> {
  const outPath = join(call.dir, "last-message.txt");
  const args = ["exec", "--skip-git-repo-check"];
  for (const png of call.imagePaths) args.push("-i", png);
  args.push("--output-last-message", outPath);
  if (call.model) args.push("-m", call.model);
  args.push(call.prompt);
  await execHarness(bin, args, call);
  return assertReply(existsSync(outPath) ? readFileSync(outPath, "utf-8") : "", "codex");
}

/** `-f` trusts the neutral dir so cursor's read tool runs without a prompt. */
async function runCursor(bin: string, call: StagedCall): Promise<HeadlessResult> {
  const args = ["-p", call.prompt, "--output-format", "text", "-f"];
  if (call.model) args.push("--model", call.model);
  const { stdout } = await execHarness(bin, args, call);
  return assertReply(stdout, "cursor");
}

type BackendRunner = (bin: string, call: StagedCall) => Promise<HeadlessResult>;

/** The backend registry in default preference order. */
export const HEADLESS_BACKENDS: ReadonlyArray<{ name: HeadlessBackendName; bin: string }> = [
  { name: "claude-code", bin: "claude" },
  { name: "codex", bin: "codex" },
  { name: "cursor", bin: "cursor-agent" },
];

const RUNNERS: Record<HeadlessBackendName, BackendRunner> = {
  "claude-code": runClaudeCode,
  codex: runCodex,
  cursor: runCursor,
};

function backendBin(name: HeadlessBackendName): string | undefined {
  const entry = HEADLESS_BACKENDS.find((b) => b.name === name);
  return entry ? whichBin(entry.bin) : undefined;
}

/** Backends whose binary is on PATH right now, in preference order. Being
 * listed means installed, not proven working — that is what the per-call
 * fallback in `runHeadless` is for. */
export function availableHeadlessBackends(): HeadlessBackendName[] {
  return HEADLESS_BACKENDS.filter((b) => whichBin(b.bin)).map((b) => b.name);
}

/** Run the request on exactly one named backend. Throws when the backend is
 * not installed or the call fails. */
export async function runHeadlessOn(
  name: HeadlessBackendName,
  req: HeadlessRequest,
): Promise<HeadlessResult> {
  const bin = backendBin(name);
  if (!bin) throw new Error(`headless backend not installed: ${name}`);
  const call = stageCall(req);
  try {
    return await RUNNERS[name](bin, call);
  } finally {
    rmSync(call.dir, { recursive: true, force: true });
  }
}

/**
 * Run the request on the first backend that succeeds, walking the preference
 * order past installed-but-failing backends (unless fallback is disabled or a
 * backend is forced via HARNERY_HEADLESS_BACKEND). Throws when no backend is
 * installed, or every attempted backend failed — the error message carries
 * each backend's failure so a flaky chain is diagnosable.
 */
export async function runHeadless(
  req: HeadlessRequest,
  opts: RunHeadlessOptions = {},
): Promise<HeadlessResult> {
  const forced = coordEnv("HEADLESS_BACKEND") as HeadlessBackendName | undefined;
  if (forced && !opts.backends) {
    if (!HEADLESS_BACKENDS.some((b) => b.name === forced)) {
      throw new Error(`unknown HARNERY_HEADLESS_BACKEND: ${forced}`);
    }
    return runHeadlessOn(forced, req);
  }
  const order = opts.backends ?? HEADLESS_BACKENDS.map((b) => b.name);
  const installed = order.filter((name) => backendBin(name));
  if (!installed.length) {
    throw new Error(`no headless backend installed (looked for: ${order.join(", ")})`);
  }
  const fallback = opts.fallback ?? true;
  const attempts = fallback ? installed : installed.slice(0, 1);
  const failures: string[] = [];
  for (const name of attempts) {
    try {
      return await runHeadlessOn(name, req);
    } catch (err) {
      failures.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new Error(`every headless backend failed:\n  ${failures.join("\n  ")}`);
}

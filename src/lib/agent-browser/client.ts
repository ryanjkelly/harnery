import { type SpawnSyncOptions, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import {
  type CookieJar,
  type CookieStore,
  type Cookie as JarCookie,
  mergeCookies,
} from "../cookies/index.ts";

/**
 * Thin wrapper over Vercel Labs' `agent-browser` Rust CLI.
 *
 * agent-browser is a process that wraps a managed Chrome for Testing
 * binary and exposes verbs over its own daemon (state persists across
 * invocations within a shell). This wrapper exec's the binary; it does
 * **not** manage the daemon itself.
 *
 * Optional cookie-jar integration: if a CookieJar is passed in the
 * options, the wrapper will write the jar contents to a temp state file
 * and `state load` it before any nav, then `cookies get` and merge the
 * result back into the jar after work is done. Cookies are best-effort:
 * the wrapper never fails because a load/save round-trip blew up.
 *
 * Canonical for `harn browse-ai` (dev side); ready to be the shared core of
 * the agent-side `browse` wrapper (sandbox side) when that wrapper gets refactored.
 */

export interface AgentBrowserOptions {
  /** Override the binary path. Default: looks up `agent-browser` on PATH. */
  binary?: string;
  /** Cookie jar for cross-tool sharing. Pass `null` to skip. */
  jar?: CookieJar | null;
  /** Default per-call timeout in ms. Default 60000. */
  timeoutMs?: number;
  /** Extra env vars to merge into every spawn. */
  env?: Record<string, string>;
  /**
   * Path used as the `state load` source when seeding cookies into the
   * agent-browser session. Defaults to a tmp file derived from the jar.
   */
  stateFilePath?: string;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  ok: boolean;
  exitCode: number | null;
}

const DEFAULT_TIMEOUT_MS = 60_000;

export class AgentBrowser {
  private readonly opts: AgentBrowserOptions;
  private cookiesSeeded = false;

  constructor(opts: AgentBrowserOptions = {}) {
    this.opts = opts;
  }

  /**
   * Run an `agent-browser` subcommand. Returns a structured result.
   * Throws only on spawn failure (e.g., binary not found); non-zero exit
   * returns ok=false.
   */
  exec(args: string[], timeoutMs?: number): ExecResult {
    const binary = this.opts.binary ?? "agent-browser";
    const env = this.scrubEnv();
    const result = spawnSync(binary, args, {
      timeout: timeoutMs ?? this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      encoding: "utf8",
      env,
    } satisfies SpawnSyncOptions);

    if (result.error && (result.error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        `agent-browser binary not found at "${binary}". Install once with:\n  curl -fsSL https://github.com/vercel-labs/agent-browser/releases/download/v0.25.4/agent-browser-linux-x64 \\\n    -o ~/.local/bin/agent-browser && chmod +x ~/.local/bin/agent-browser\n  agent-browser install`,
      );
    }
    if (result.error) {
      throw result.error;
    }
    return {
      stdout: (result.stdout ?? "").toString(),
      stderr: (result.stderr ?? "").toString(),
      ok: result.status === 0,
      exitCode: result.status,
    };
  }

  /**
   * Same as `exec` but throws on non-zero exit code, with stderr in the
   * error message. Use when the caller can't recover from a failure.
   */
  execOrThrow(args: string[], timeoutMs?: number): ExecResult {
    const result = this.exec(args, timeoutMs);
    if (!result.ok) {
      throw new Error(
        `agent-browser ${args.join(" ")} failed (exit ${result.exitCode ?? "?"}): ${result.stderr.trim() || result.stdout.trim()}`,
      );
    }
    return result;
  }

  // -------------------------------------------------------------------------
  // High-level verbs
  // -------------------------------------------------------------------------

  /**
   * Seed the jar's cookies into the agent-browser session via `state load`.
   * Called automatically by `open()`. Safe to call multiple times; only
   * the first call does work.
   */
  seedCookies(): void {
    if (this.cookiesSeeded) return;
    if (!this.opts.jar) {
      this.cookiesSeeded = true;
      return;
    }
    try {
      const jarStore = this.opts.jar.load();
      if (jarStore.cookies.length === 0) {
        this.cookiesSeeded = true;
        return;
      }
      const stateFile =
        this.opts.stateFilePath ?? `/tmp/harn-agent-browser-state-${process.pid}.json`;
      writeFileSync(stateFile, JSON.stringify(jarStore, null, 2));
      this.exec(["state", "load", stateFile], 10_000);
      this.cookiesSeeded = true;
    } catch {
      // Cookie seeding is best-effort; never fail the session because
      // the jar couldn't be written/loaded.
      this.cookiesSeeded = true;
    }
  }

  open(url: string, timeoutMs?: number): ExecResult {
    this.seedCookies();
    return this.execOrThrow(["open", url], timeoutMs);
  }

  snapshot(opts: { interactive?: boolean } = {}): string {
    const args = ["snapshot"];
    if (opts.interactive) args.push("-i");
    return this.execOrThrow(args).stdout.trim();
  }

  screenshot(path: string, opts: { full?: boolean; annotate?: boolean } = {}): void {
    const args = ["screenshot"];
    if (opts.full) args.push("--full");
    if (opts.annotate) args.push("--annotate");
    args.push(path);
    this.execOrThrow(args);
  }

  click(refOrSelector: string): ExecResult {
    return this.execOrThrow(["click", refOrSelector]);
  }

  fill(refOrSelector: string, value: string): ExecResult {
    return this.execOrThrow(["fill", refOrSelector, value]);
  }

  press(key: string): ExecResult {
    return this.execOrThrow(["press", key]);
  }

  wait(selectorOrMs: string): ExecResult {
    return this.execOrThrow(["wait", selectorOrMs]);
  }

  evaluate(script: string): string {
    return this.execOrThrow(["eval", script]).stdout.trim();
  }

  /**
   * Run a semicolon-separated batch of agent-browser sub-commands in a
   * single session. Each step is exec'd with the same daemon, so state
   * persists. Returns one ExecResult per step in order.
   */
  batch(steps: string[]): ExecResult[] {
    this.seedCookies();
    const results: ExecResult[] = [];
    for (const step of steps) {
      const trimmed = step.trim();
      if (!trimmed) continue;
      // Naive shell-like splitting; agent-browser's own argv parser handles
      // the actual command; we just split on whitespace for the wrapper.
      const args = trimmed.split(/\s+/);
      results.push(this.exec(args));
    }
    return results;
  }

  /** Start HAR recording. Pair with `harStop`. */
  harStart(path: string): ExecResult {
    return this.execOrThrow(["network", "har", "start", path]);
  }

  /** Stop HAR recording. Returns the same result for symmetry with start. */
  harStop(path: string): ExecResult {
    return this.execOrThrow(["network", "har", "stop", path]);
  }

  /**
   * Pull cookies out of the agent-browser session via `cookies get --json`,
   * merge them into the jar (if one was provided), and persist. Best-effort:
   * a parse failure or missing jar returns 0 without raising.
   */
  syncCookiesToJar(): { saved: number } {
    if (!this.opts.jar) return { saved: 0 };
    try {
      const result = this.exec(["cookies", "get", "--json"], 10_000);
      if (!result.ok) return { saved: 0 };
      const parsed = JSON.parse(result.stdout);
      const cookies: JarCookie[] = parsed.data?.cookies ?? parsed.cookies ?? [];
      if (!Array.isArray(cookies) || cookies.length === 0) return { saved: 0 };
      const jar = this.opts.jar;
      const store: CookieStore = jar.load();
      const merged = mergeCookies(store, cookies);
      jar.save(merged);
      return { saved: cookies.length };
    } catch {
      return { saved: 0 };
    }
  }

  /**
   * Some shell environments leak XDG_CONFIG_HOME into Chrome's crashpad
   * lookup, which can cause SIGTRAP if the path is read-only (e.g. in
   * containerized sandbox environments). Strip it here defensively.
   */
  private scrubEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env, ...this.opts.env };
    env.XDG_CONFIG_HOME = undefined;
    return env;
  }
}

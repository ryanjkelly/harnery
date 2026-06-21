import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Command } from "commander";
import type { EmitContext } from "../commander.ts";
import { lazyFetchWebRoot, webRunner } from "./web-fetch.ts";

/**
 * `harn web`: Next.js dashboard for harnery's coord state.
 *
 * Subcommands:
 *   up [--prod]:   start the server (dev mode default; --prod runs next start)
 *   build:         next build (production bundle)
 *   start:         next start (must `harn web build` first)
 *
 * Launches the Next.js app under `harnery/web/` against the user's current
 * working directory. The web app reads `.harnery/` via `HARNERY_COORD_ROOT`;
 * passing cwd here lets the dashboard show the right project regardless
 * of where the user invokes `harn web up` from.
 *
 * The dashboard is not bundled in the npm package (ADR 0001/0003), so on an
 * npm install `resolveWebRoot` lazy-fetches it on first use (see web-fetch.ts).
 *
 * Localhost-only by default. Network exposure is intentionally out of
 * scope for v1.
 */

function webRoot(): string {
  // src/commands/web.ts → src/ → harnery/ → harnery/web/
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..", "web");
}

/**
 * Resolve the web app root. A local `web/` (source checkout / submodule) wins.
 * Otherwise, on an npm install, lazy-fetch it (clone + install) unless the
 * caller passed --no-fetch, in which case emit the honest manual hint.
 */
function resolveWebRoot(emit: EmitContext, allowFetch: boolean): string | null {
  const local = webRoot();
  if (existsSync(path.join(local, "package.json"))) return local;
  if (allowFetch) return lazyFetchWebRoot(emit);
  emit.error({
    code: "web_missing",
    message: `harnery/web/ not found at ${local}`,
    hint:
      "The dashboard is not bundled in the npm package. Re-run without --no-fetch to fetch it " +
      "automatically, or clone https://github.com/ryanjkelly/harnery and run it from there. " +
      "See https://harnery.com/cli/web/.",
  });
  return null;
}

interface UpOpts {
  port: string;
  coordRoot?: string;
  prod?: boolean;
  fetch?: boolean;
}

export function registerWebCommand(program: Command, emit: EmitContext): void {
  const web = program
    .command("web")
    .description("Standalone read-only dashboard for harnery's coord state");

  web
    .command("up")
    .description(
      "Start the dashboard. Default: dev mode (HMR, no build needed). With " +
        "--prod, runs next start (requires a prior `harn web build`).",
    )
    .option("-p, --port <port>", "Listen port", "9000")
    .option(
      "--coord-root <dir>",
      "Override the coord root (default: cwd; web walks up looking for .harnery/)",
    )
    .option("--prod", "Use next start instead of next dev (requires prior build)")
    .option("--no-fetch", "Don't auto-fetch the dashboard if it's missing (npm installs)")
    .action(async (opts: UpOpts) => {
      const root = resolveWebRoot(emit, opts.fetch !== false);
      if (!root) {
        process.exitCode = 1;
        return;
      }

      const coordRoot = opts.coordRoot ?? process.cwd();
      const port = String(opts.port);
      const mode = opts.prod ? "start" : "dev";

      if (opts.prod) {
        const nextDir = path.join(root, ".next");
        if (!existsSync(nextDir)) {
          emit.error({
            code: "no_build",
            message: `--prod requires a prior build (no .next at ${nextDir})`,
            hint: "Run `harn web build` first.",
          });
          process.exitCode = 1;
          return;
        }
      }

      emit.log(`harn web · http://localhost:${port} (${mode})`, "info");
      emit.log(`reading .harnery/ from: ${coordRoot}`, "info");

      const child = spawn(webRunner(), ["run", mode], {
        cwd: root,
        env: {
          ...process.env,
          HARNERY_COORD_ROOT: coordRoot,
          HARNERY_WEB_PORT: port,
        },
        stdio: "inherit",
      });

      const cleanup = (sig: NodeJS.Signals) => {
        if (!child.killed) child.kill(sig);
      };
      process.on("SIGINT", () => cleanup("SIGINT"));
      process.on("SIGTERM", () => cleanup("SIGTERM"));

      child.on("exit", (code, sig) => {
        if (sig) {
          emit.log(`web exited on ${sig}`, "info");
        } else if (code !== 0) {
          emit.error({ code: "web_exit", message: `next exited with code ${code}` });
          process.exitCode = code ?? 1;
        }
      });
    });

  web
    .command("build")
    .description("Build the production bundle (next build).")
    .option("--no-fetch", "Don't auto-fetch the dashboard if it's missing (npm installs)")
    .action((opts: { fetch?: boolean }) => {
      const root = resolveWebRoot(emit, opts.fetch !== false);
      if (!root) {
        process.exitCode = 1;
        return;
      }
      emit.log("running next build…", "info");
      const r = spawnSync(webRunner(), ["run", "build"], {
        cwd: root,
        stdio: "inherit",
      });
      process.exitCode = r.status ?? 1;
    });

  web
    .command("start")
    .description("Start the production server (next start). Requires prior `harn web build`.")
    .option("-p, --port <port>", "Listen port", "9000")
    .option("--coord-root <dir>", "Override the coord root")
    .option("--no-fetch", "Don't auto-fetch the dashboard if it's missing (npm installs)")
    .action((opts: { port: string; coordRoot?: string; fetch?: boolean }) => {
      const root = resolveWebRoot(emit, opts.fetch !== false);
      if (!root) {
        process.exitCode = 1;
        return;
      }
      const nextDir = path.join(root, ".next");
      if (!existsSync(nextDir)) {
        emit.error({
          code: "no_build",
          message: `no .next/ found at ${nextDir}`,
          hint: "Run `harn web build` first.",
        });
        process.exitCode = 1;
        return;
      }
      const coordRoot = opts.coordRoot ?? process.cwd();
      const port = String(opts.port);
      emit.log(`harn web · http://localhost:${port} (start)`, "info");
      emit.log(`reading .harnery/ from: ${coordRoot}`, "info");

      const child = spawn(webRunner(), ["run", "start"], {
        cwd: root,
        env: {
          ...process.env,
          HARNERY_COORD_ROOT: coordRoot,
          HARNERY_WEB_PORT: port,
        },
        stdio: "inherit",
      });

      const cleanup = (sig: NodeJS.Signals) => {
        if (!child.killed) child.kill(sig);
      };
      process.on("SIGINT", () => cleanup("SIGINT"));
      process.on("SIGTERM", () => cleanup("SIGTERM"));

      child.on("exit", (code) => {
        process.exitCode = code ?? 0;
      });
    });
}

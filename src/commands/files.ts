import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import type { EmitContext, HarneryProgramContext } from "../commander.ts";
import { resolveCoordRoot } from "../core/agents/coord-client.ts";
import { DEFAULT_WEB_PORT, resolveWebPort } from "../core/config.ts";
import { localFilesOriginUrl, localFileViewerUrl } from "../lib/local-file-url.ts";

export { FILES_ORIGIN_HOST } from "../lib/local-file-url.ts";

export type LocalFileUrlMode = "auto" | "raw" | "viewer";

export interface LocalFileUrlOptions {
  coordRoot: string;
  port: number;
  mode?: LocalFileUrlMode;
}

export interface LocalFileUrl {
  url: string;
  relPath: string;
  mode: Exclude<LocalFileUrlMode, "auto">;
}

function isOutsideRoot(relPath: string): boolean {
  return relPath === "" || relPath === ".." || relPath.startsWith(`..${path.sep}`);
}

function canonicalRepoPath(input: string, coordRoot: string): string {
  if (input.trim() === "") throw new Error("path must not be empty");
  // biome-ignore lint/suspicious/noControlCharactersInRegex: URL output must stay one clean line
  if (/[\u0000-\u001f\u007f]/.test(input)) throw new Error("path contains control bytes");

  let root: string;
  try {
    root = realpathSync(coordRoot);
  } catch {
    throw new Error(`coord root does not exist: ${coordRoot}`);
  }

  const candidate = path.isAbsolute(input) ? input : path.resolve(root, input);
  let canonical: string;
  try {
    canonical = realpathSync(candidate);
  } catch {
    throw new Error(`file does not exist: ${input}`);
  }

  const relPath = path.relative(root, canonical);
  if (isOutsideRoot(relPath) || path.isAbsolute(relPath)) {
    throw new Error(`file is outside the coord root: ${input}`);
  }
  if (!statSync(canonical).isFile()) throw new Error(`path is not a file: ${input}`);
  return relPath.split(path.sep).join("/");
}

function isHtmlPath(relPath: string): boolean {
  const lower = relPath.toLowerCase();
  return lower.endsWith(".html") || lower.endsWith(".htm");
}

/**
 * Mint the local browser URL for a file under the dashboard's coord root.
 * HTML defaults to the isolated files origin so scripts and relative assets
 * work. Other files default to the dashboard viewer.
 */
export function mintLocalFileUrl(input: string, options: LocalFileUrlOptions): LocalFileUrl {
  const relPath = canonicalRepoPath(input, options.coordRoot);
  const requestedMode = options.mode ?? "auto";
  const mode = requestedMode === "auto" ? (isHtmlPath(relPath) ? "raw" : "viewer") : requestedMode;
  const url =
    mode === "raw"
      ? localFilesOriginUrl(relPath, options.port)
      : localFileViewerUrl(relPath, options.port);
  return { url, relPath, mode };
}

export function registerFilesCommand(
  program: Command,
  emit: EmitContext,
  context?: HarneryProgramContext,
): void {
  const files = program
    .command("files")
    .description("Mint browser links for files served by the local dashboard");

  files
    .command("url")
    .description("Mint the local browser URL for a repo file")
    .argument("<path>", "Repo-relative path, or an absolute path inside the coord root")
    .option("-p, --port <port>", `Dashboard port (default ${DEFAULT_WEB_PORT})`)
    .option("--coord-root <dir>", "Override the coord root")
    .option("--raw", "Use the isolated files origin, regardless of extension")
    .option("--viewer", "Use the dashboard file viewer, regardless of extension")
    .action(
      (
        filePath: string,
        opts: { port?: string; coordRoot?: string; raw?: boolean; viewer?: boolean },
      ) => {
        if (opts.raw && opts.viewer) {
          emit.error({
            code: "conflicting_url_modes",
            message: "--raw and --viewer cannot be used together",
          });
          emit.setExitCode(1);
          return;
        }
        const coordRoot =
          opts.coordRoot ??
          context?.resolveCoordRoot?.() ??
          context?.repoRoot ??
          resolveCoordRoot(process.cwd()) ??
          process.cwd();
        let port: number;
        try {
          port = resolveWebPort(opts.port, coordRoot);
        } catch (error) {
          emit.error({
            code: "invalid_web_port",
            message: error instanceof Error ? error.message : "invalid web port",
            hint: `Use an integer from 1024 through 65535; the default is ${DEFAULT_WEB_PORT}.`,
          });
          emit.setExitCode(1);
          return;
        }
        try {
          const result = mintLocalFileUrl(filePath, {
            coordRoot,
            port,
            mode: opts.raw ? "raw" : opts.viewer ? "viewer" : "auto",
          });
          emit.text(`${result.url}\n`);
        } catch (error) {
          emit.error({
            code: "invalid_local_file",
            message: error instanceof Error ? error.message : "invalid local file path",
            hint: "Pass an existing file inside the dashboard coord root.",
          });
          emit.setExitCode(1);
        }
      },
    );
}

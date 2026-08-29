import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { exec } from "./exec.ts";

export type DocsRepositorySource = "worktree" | "index";

interface IndexEntry {
  oid: string;
  stage: number;
}

/**
 * One coherent repository view for documentation commands.
 *
 * Worktree mode preserves the interactive commands' existing behavior. Index
 * mode reads both path membership and file bytes through Git, so a pre-commit
 * hook validates the exact index Git handed to it. During a path-scoped commit,
 * Git exposes its temporary partial-commit index through GIT_INDEX_FILE; the
 * view deliberately inherits that environment instead of rediscovering the
 * shared working tree.
 */
export interface DocsRepositoryView {
  readonly root: string;
  readonly source: DocsRepositorySource;
  readonly trackedPaths: readonly string[];
  has(path: string): boolean;
  directFileNames(directory: string): string[];
  readTexts(paths: readonly string[]): Promise<Map<string, string>>;
  byteLength(path: string): Promise<number | null>;
}

function normalize(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

function trackedPathList(stdout: string): string[] {
  return stdout.split("\0").map(normalize).filter(Boolean);
}

async function worktreePaths(root: string): Promise<string[]> {
  const result = await exec(["git", "ls-files", "--cached", "-z"], { cwd: root, trim: false });
  if (result.exitCode !== 0) {
    // Worktree lint historically supports non-repository fixtures and simply
    // has no tracked-file checks to run there. Index mode remains strict.
    return [];
  }
  return trackedPathList(result.stdout);
}

async function indexEntries(root: string): Promise<Map<string, IndexEntry>> {
  const result = await exec(["git", "ls-files", "--cached", "--stage", "-z"], {
    cwd: root,
    trim: false,
  });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || "git ls-files --stage failed");
  }

  const entries = new Map<string, IndexEntry>();
  for (const record of result.stdout.split("\0").filter(Boolean)) {
    const tab = record.indexOf("\t");
    if (tab === -1) throw new Error(`invalid git ls-files --stage record: ${record}`);
    const [mode, oid, stageText] = record.slice(0, tab).split(" ");
    const path = normalize(record.slice(tab + 1));
    const stage = Number.parseInt(stageText ?? "", 10);
    if (!mode || !oid || !Number.isInteger(stage)) {
      throw new Error(`invalid git ls-files --stage record for ${path}`);
    }
    if (stage !== 0) {
      throw new Error(`cannot validate an index with unmerged entry: ${path}`);
    }
    entries.set(path, { oid, stage });
  }
  return entries;
}

function parseBatch(stdout: Buffer, requested: readonly string[]): Map<string, Buffer> {
  const blobs = new Map<string, Buffer>();
  let offset = 0;
  for (const oid of requested) {
    const newline = stdout.indexOf(0x0a, offset);
    if (newline === -1) throw new Error(`git cat-file omitted the header for ${oid}`);
    const header = stdout.subarray(offset, newline).toString("utf8");
    offset = newline + 1;
    const [reportedOid, type, sizeText] = header.split(" ");
    const size = Number.parseInt(sizeText ?? "", 10);
    if (reportedOid !== oid || type !== "blob" || !Number.isInteger(size) || size < 0) {
      throw new Error(`git cat-file returned an invalid blob header for ${oid}: ${header}`);
    }
    const end = offset + size;
    if (end > stdout.length) throw new Error(`git cat-file truncated blob ${oid}`);
    blobs.set(oid, stdout.subarray(offset, end));
    offset = end;
    if (stdout[offset] !== 0x0a) throw new Error(`git cat-file omitted the separator for ${oid}`);
    offset += 1;
  }
  return blobs;
}

function readIndexBlobs(root: string, oids: readonly string[]): Promise<Map<string, Buffer>> {
  const unique = [...new Set(oids)];
  if (unique.length === 0) return Promise.resolve(new Map());

  return new Promise((resolveResult, rejectResult) => {
    const process = spawn("git", ["cat-file", "--batch"], {
      cwd: root,
      env: { ...globalThis.process.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timer = setTimeout(() => process.kill(), 30_000);
    process.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    process.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    process.on("error", (error) => {
      clearTimeout(timer);
      rejectResult(error);
    });
    process.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        rejectResult(
          new Error(Buffer.concat(stderr).toString("utf8").trim() || "git cat-file failed"),
        );
        return;
      }
      try {
        resolveResult(parseBatch(Buffer.concat(stdout), unique));
      } catch (error) {
        rejectResult(error);
      }
    });
    process.stdin.end(`${unique.join("\n")}\n`);
  });
}

function directIndexFiles(paths: readonly string[], directory: string): string[] {
  const normalizedDirectory = normalize(directory).replace(/\/$/, "");
  return paths
    .filter((path) => normalize(dirname(path)) === normalizedDirectory)
    .map((path) => basename(path));
}

export async function createDocsRepositoryView(
  root: string,
  source: DocsRepositorySource = "worktree",
): Promise<DocsRepositoryView> {
  if (source === "worktree") {
    const trackedPaths = await worktreePaths(root);
    return {
      root,
      source,
      trackedPaths,
      has: (path) => existsSync(join(root, path)),
      directFileNames: (directory) => {
        try {
          return readdirSync(join(root, directory)).filter((entry) => {
            try {
              return statSync(join(root, directory, entry)).isFile();
            } catch {
              return false;
            }
          });
        } catch {
          return [];
        }
      },
      readTexts: async (paths) => {
        const texts = new Map<string, string>();
        for (const path of paths) {
          try {
            texts.set(path, readFileSync(join(root, path), "utf8"));
          } catch {
            // The caller decides whether a missing tracked path is a finding.
          }
        }
        return texts;
      },
      byteLength: async (path) => {
        try {
          return statSync(join(root, path)).size;
        } catch {
          return null;
        }
      },
    };
  }

  const entries = await indexEntries(root);
  const trackedPaths = [...entries.keys()];
  const textCache = new Map<string, string>();
  const loadTexts = async (paths: readonly string[]): Promise<Map<string, string>> => {
    const wanted = [...new Set(paths.map(normalize))].filter((path) => entries.has(path));
    const missing = wanted.filter((path) => !textCache.has(path));
    const oids = missing.map((path) => entries.get(path)!.oid);
    const blobs = await readIndexBlobs(root, oids);
    for (const path of missing) {
      const blob = blobs.get(entries.get(path)!.oid);
      if (blob) textCache.set(path, blob.toString("utf8"));
    }
    return new Map(
      wanted.flatMap((path) => (textCache.has(path) ? [[path, textCache.get(path)!]] : [])),
    );
  };

  return {
    root,
    source,
    trackedPaths,
    has: (path) => entries.has(normalize(path)),
    directFileNames: (directory) => directIndexFiles(trackedPaths, directory),
    readTexts: loadTexts,
    byteLength: async (path) => {
      const normalized = normalize(path);
      const text = (await loadTexts([normalized])).get(normalized);
      return text === undefined ? null : Buffer.byteLength(text, "utf8");
    },
  };
}

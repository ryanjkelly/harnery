import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ParsedPayload } from "../../hooks/adapter/parse.ts";

export interface LineChanges {
  added: number;
  removed: number;
}

// Unknown tools remain unmeasured: a shell, script, or connector can write files.
const READ_TOOLS = new Set(["Read", "Glob", "Grep", "LS", "view_image"]);
const MAX_BYTES = 2 * 1024 * 1024;

function object(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "string") {
    try {
      return object(JSON.parse(value));
    } catch {
      return undefined;
    }
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function lineCount(text: string): number {
  return text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

function readText(path: string): string {
  if (statSync(path).size > MAX_BYTES) throw new Error("unmeasured file");
  const bytes = readFileSync(path);
  if (bytes.length > MAX_BYTES || bytes.includes(0)) throw new Error("unmeasured file");
  return bytes.toString("utf8");
}

/** Use Git's line semantics without retaining file contents in producer state. */
function compare(before: string, after: string): LineChanges | undefined {
  if (Buffer.byteLength(after) > MAX_BYTES || after.includes("\0")) return;
  if (before === after) return { added: 0, removed: 0 };
  const directory = mkdtempSync(join(tmpdir(), "harnery-lines-"));
  try {
    const oldPath = join(directory, "before");
    const newPath = join(directory, "after");
    writeFileSync(oldPath, before, { mode: 0o600 });
    writeFileSync(newPath, after, { mode: 0o600 });
    const result = spawnSync(
      "git",
      ["diff", "--no-index", "--no-ext-diff", "--no-textconv", "--numstat", "--", oldPath, newPath],
      {
        encoding: "utf8",
        timeout: 2000,
        maxBuffer: 4096,
      },
    );
    if (result.status !== 0 && result.status !== 1) return;
    const match = /^(\d+)\t(\d+)\t/.exec(result.stdout);
    return match ? { added: Number(match[1]), removed: Number(match[2]) } : undefined;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** Proposed edit counts, captured before execution; publish only on success. */
export function prepareToolLineChanges(
  payload: ParsedPayload,
  cwd: string,
): LineChanges | undefined {
  try {
    const name = payload.tool_name ?? "";
    if (READ_TOOLS.has(name)) return { added: 0, removed: 0 };
    const input = object(payload.tool_input);
    if (name === "apply_patch") {
      const patch =
        typeof payload.tool_input === "string" && payload.tool_input.startsWith("*** Begin Patch")
          ? payload.tool_input
          : (input?.patch ?? input?.input ?? input?.command);
      if (
        typeof patch !== "string" ||
        !patch.startsWith("*** Begin Patch\n") ||
        !patch.includes("*** End Patch")
      )
        return;
      let added = 0;
      let removed = 0;
      let inFile = false;
      for (const line of patch.split("\n")) {
        if (line.startsWith("*** Delete File: ")) {
          removed += lineCount(readText(resolve(cwd, line.slice(17))));
          inFile = false;
        } else if (/^\*\*\* (?:Add|Update) File: /.test(line)) {
          inFile = true;
        } else if (line === "*** End Patch") {
          inFile = false;
        } else if (inFile && line.startsWith("+")) added++;
        else if (inFile && line.startsWith("-")) removed++;
      }
      return { added, removed };
    }
    if (!["Write", "Edit", "StrReplace", "MultiEdit"].includes(name) || !input) return;
    const path = input.file_path ?? input.path;
    if (typeof path !== "string") return;
    let before: string;
    try {
      before = readText(resolve(cwd, path));
    } catch (error) {
      if (name !== "Write" || (error as NodeJS.ErrnoException).code !== "ENOENT") return;
      before = "";
    }
    if (name === "Write")
      return typeof input.content === "string" ? compare(before, input.content) : undefined;
    let after = before;
    const edits = name === "MultiEdit" ? input.edits : [input];
    if (!Array.isArray(edits)) return;
    for (const entry of edits) {
      const edit = object(entry);
      if (
        !edit ||
        typeof edit.old_string !== "string" ||
        typeof edit.new_string !== "string" ||
        !edit.old_string
      )
        return;
      const occurrences = after.split(edit.old_string).length - 1;
      if (occurrences === 0 || (occurrences > 1 && edit.replace_all !== true)) return;
      after =
        edit.replace_all === true
          ? after.split(edit.old_string).join(edit.new_string)
          : after.replace(edit.old_string, () => edit.new_string as string);
    }
    return compare(before, after);
  } catch {
    return undefined;
  }
}

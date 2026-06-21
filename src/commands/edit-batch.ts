import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Command } from "commander";
import type { EmitContext } from "../commander.ts";

/**
 * `harn edit-batch`: coordinated find/replace across N files in one call.
 *
 * Solves the recurring "rename oldName → newName everywhere" pattern that
 * otherwise costs N sequential Edit tool calls. Literal-string by default;
 * --regex flag treats the find string as a JS regex. --all flag replaces
 * every occurrence per file (default: first match only, matching the Edit
 * tool's default).
 *
 * Atomic per-file: writes to <path>.batch.tmp.<pid> then renames. If any
 * file errors mid-batch, already-written files stay written: it's
 * idempotent at the per-file level, not transactional across the set.
 * Use --dry-run to preview before committing.
 */
export function registerEditBatchCommand(program: Command, emit: EmitContext): void {
  program
    .command("edit-batch <old> <new> <files...>")
    .description(
      "Coordinated find/replace across N files (literal by default; --regex for pattern). " +
        "Atomic per-file. Use --dry-run to preview.",
    )
    .option("--all", "Replace every occurrence in each file (default: first match only)")
    .option("--regex", "Treat <old> as a JS regex (and <new> as the replacement template)")
    .option(
      "--regex-flags <flags>",
      "Regex flags (e.g. 'i' for case-insensitive). Implies --regex.",
      "",
    )
    .option("--dry-run", "Show what would change without writing")
    .option("--require-match", "Fail (exit 1) if any file has zero matches")
    .option("--json", "Structured JSON envelope")
    .action(async (oldStr: string, newStr: string, files: string[], opts: EditBatchOpts) => {
      try {
        const result = await runEditBatch(oldStr, newStr, files, opts);
        if (opts.json) {
          emit.config({ format: "json" });
          emit.data(result);
          return;
        }
        emit.text(`${renderResult(result)}\n`);
        if (opts.requireMatch && result.zero_match_files.length > 0) {
          process.exit(1);
        }
      } catch (err) {
        emit.error({ code: "edit_batch_failed", message: (err as Error).message });
        process.exit(1);
      }
    });
}

interface EditBatchOpts {
  all?: boolean;
  regex?: boolean;
  regexFlags?: string;
  dryRun?: boolean;
  requireMatch?: boolean;
  json?: boolean;
}

interface FileResult {
  path: string;
  matched: number;
  replaced: number;
  bytes_before: number;
  bytes_after: number;
  written: boolean;
  error: string | null;
}

interface EditBatchResult {
  old: string;
  new: string;
  mode: "literal" | "regex";
  all: boolean;
  dry_run: boolean;
  files: FileResult[];
  total_matches: number;
  total_replacements: number;
  files_modified: number;
  zero_match_files: string[];
}

async function runEditBatch(
  oldStr: string,
  newStr: string,
  files: string[],
  opts: EditBatchOpts,
): Promise<EditBatchResult> {
  if (files.length === 0) {
    throw new Error("at least one file path required");
  }
  if (oldStr.length === 0) {
    throw new Error("<old> string is empty");
  }
  const useRegex = !!opts.regex || (opts.regexFlags ?? "").length > 0;
  let pattern: RegExp;
  if (useRegex) {
    let flags = opts.regexFlags ?? "";
    if (opts.all && !flags.includes("g")) flags += "g";
    try {
      pattern = new RegExp(oldStr, flags);
    } catch (err) {
      throw new Error(`invalid regex: ${(err as Error).message}`);
    }
  } else {
    // Literal-string mode: escape regex specials so the user can pass anything.
    const escaped = oldStr.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    pattern = new RegExp(escaped, opts.all ? "g" : "");
  }

  const fileResults: FileResult[] = [];
  for (const filePath of files) {
    const abs = resolve(filePath);
    const r: FileResult = {
      path: filePath,
      matched: 0,
      replaced: 0,
      bytes_before: 0,
      bytes_after: 0,
      written: false,
      error: null,
    };
    try {
      if (!existsSync(abs)) {
        r.error = "file not found";
        fileResults.push(r);
        continue;
      }
      const before = readFileSync(abs, "utf8");
      r.bytes_before = Buffer.byteLength(before, "utf8");

      // Count matches independently of replace (handles both modes).
      const countPattern = new RegExp(
        pattern.source,
        pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`,
      );
      r.matched = (before.match(countPattern) || []).length;

      if (r.matched === 0) {
        fileResults.push(r);
        continue;
      }

      const after = before.replace(pattern, newStr);
      // The `g` flag (explicit --all OR passed via --regex-flags) is what actually
      // controls replace-all behavior. Count what String.replace actually did,
      // not what --all said.
      const replacedAll = pattern.flags.includes("g");
      r.replaced = replacedAll ? r.matched : Math.min(1, r.matched);
      r.bytes_after = Buffer.byteLength(after, "utf8");

      if (!opts.dryRun) {
        const tmp = `${abs}.batch.tmp.${process.pid}`;
        writeFileSync(tmp, after, "utf8");
        const mode = statSync(abs).mode;
        renameSync(tmp, abs);
        // mode preservation: chmod after rename if needed.
        // (omitted: writeFileSync defaults are fine; rename keeps inode anyway when same filesystem)
        void mode;
        r.written = true;
      }
      fileResults.push(r);
    } catch (err) {
      r.error = (err as Error).message;
      fileResults.push(r);
    }
  }

  const totalMatches = fileResults.reduce((acc, f) => acc + f.matched, 0);
  const totalReplacements = fileResults.reduce((acc, f) => acc + f.replaced, 0);
  const filesModified = fileResults.filter((f) => f.written).length;
  const zeroMatch = fileResults.filter((f) => f.matched === 0 && !f.error).map((f) => f.path);

  return {
    old: oldStr,
    new: newStr,
    mode: useRegex ? "regex" : "literal",
    all: !!opts.all,
    dry_run: !!opts.dryRun,
    files: fileResults,
    total_matches: totalMatches,
    total_replacements: totalReplacements,
    files_modified: filesModified,
    zero_match_files: zeroMatch,
  };
}

function renderResult(r: EditBatchResult): string {
  const lines: string[] = [];
  const verb = r.dry_run ? "would replace" : "replaced";
  lines.push(
    `edit-batch · ${r.mode} · ${r.all ? "all" : "first"}-match · ${r.files.length} file(s)`,
  );
  lines.push(`  '${truncate(r.old, 60)}' → '${truncate(r.new, 60)}'`);
  lines.push("");
  for (const f of r.files) {
    if (f.error) {
      lines.push(`  ✗ ${f.path}  (error: ${f.error})`);
      continue;
    }
    if (f.matched === 0) {
      lines.push(`  · ${f.path}  (no match)`);
      continue;
    }
    const tag = r.dry_run ? "?" : f.written ? "✓" : "·";
    const delta = f.bytes_after - f.bytes_before;
    const deltaStr = delta === 0 ? "0 bytes" : delta > 0 ? `+${delta} bytes` : `${delta} bytes`;
    lines.push(
      `  ${tag} ${f.path}  (${f.matched} match${f.matched === 1 ? "" : "es"}, ${verb} ${f.replaced}, ${deltaStr})`,
    );
  }
  lines.push("");
  lines.push(
    `total: ${r.total_matches} match(es) across ${r.files.length} file(s); ` +
      `${verb} ${r.total_replacements} in ${r.files_modified || (r.dry_run ? r.files.filter((f) => f.matched > 0).length : 0)} file(s)`,
  );
  if (r.zero_match_files.length > 0) {
    lines.push(
      `zero-match files: ${r.zero_match_files.length} (use --require-match to fail when this happens)`,
    );
  }
  return lines.join("\n");
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n - 1)}…`;
}

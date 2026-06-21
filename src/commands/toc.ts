import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Command } from "commander";
import type { EmitContext } from "../commander.ts";
import { resolveBinName } from "../core/config.ts";

/**
 * `harn toc <file.md>`: markdown header outline (level + text + line number).
 * `harn section <file.md> <header>`: extract one section by header substring.
 *
 * Companion to `harn outline` for code files. Both let you navigate long docs
 * without reading the whole thing.
 */

interface TocOpts {
  json?: boolean;
  depth?: string;
  withSizes?: boolean;
}

interface SectionOpts {
  json?: boolean;
  caseSensitive?: boolean;
}

interface Header {
  level: number;
  text: string;
  line: number;
  size_lines?: number;
}

interface TocResult {
  file: string;
  total_lines: number;
  headers: Header[];
}

interface SectionResult {
  file: string;
  matched_header: string;
  matched_level: number;
  line_start: number;
  line_end: number;
  content: string;
}

export function registerTocCommand(program: Command, emit: EmitContext): void {
  program
    .command("toc <file>")
    .description("Print the markdown header outline (level + text + line number).")
    .option("--json", "Structured JSON envelope")
    .option("-d, --depth <n>", "Maximum header depth (1-6)")
    .option("--with-sizes", "Include line count per section")
    .action(async (file: string, opts: TocOpts) => {
      try {
        const result = await runToc(file, opts);
        if (opts.json) {
          emit.config({ format: "json" });
          emit.data(result);
          return;
        }
        emit.text(`${renderToc(result)}\n`);
      } catch (err) {
        emit.error({ code: "toc_failed", message: (err as Error).message });
        process.exit(1);
      }
    });
}

export function registerSectionCommand(program: Command, emit: EmitContext): void {
  program
    .command("section <file> <header...>")
    .description(
      "Extract one section from a markdown file by header substring (case-insensitive by default). " +
        "Joins multi-word args into one query string.",
    )
    .option(
      "--json",
      "Structured JSON envelope: {file, matched_header, line_start, line_end, content}",
    )
    .option("--case-sensitive", "Case-sensitive header match")
    .action(async (file: string, header: string[], opts: SectionOpts) => {
      try {
        const result = await runSection(file, header.join(" "), opts);
        if (opts.json) {
          emit.config({ format: "json" });
          emit.data(result);
          return;
        }
        emit.text(`${result.content}\n`);
      } catch (err) {
        emit.error({ code: "section_failed", message: (err as Error).message });
        process.exit(1);
      }
    });
}

async function runToc(file: string, opts: TocOpts): Promise<TocResult> {
  const absPath = resolve(file);
  if (!existsSync(absPath)) throw new Error(`no such file: ${file}`);
  const content = readFileSync(absPath, "utf8");
  const lines = content.split("\n");
  const maxDepth = opts.depth ? Number.parseInt(opts.depth, 10) : 6;
  if (!Number.isFinite(maxDepth) || maxDepth < 1 || maxDepth > 6) {
    throw new Error(`--depth must be 1-6 (got ${opts.depth})`);
  }

  const headers: Header[] = [];
  let inFence = false;
  let fenceMarker = "";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fenceMatch = line.match(/^(\s*)(`{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[2];
      if (!inFence) {
        inFence = true;
        fenceMarker = marker[0];
      } else if (marker[0] === fenceMarker) {
        inFence = false;
      }
      continue;
    }
    if (inFence) continue;

    const headerMatch = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (headerMatch) {
      const level = headerMatch[1].length;
      if (level > maxDepth) continue;
      headers.push({
        level,
        text: headerMatch[2],
        line: i + 1,
      });
    }
  }

  if (opts.withSizes) {
    for (let i = 0; i < headers.length; i++) {
      const nextLine = i + 1 < headers.length ? headers[i + 1].line : lines.length + 1;
      headers[i].size_lines = nextLine - headers[i].line;
    }
  }

  return {
    file,
    total_lines: lines.length,
    headers,
  };
}

function renderToc(r: TocResult): string {
  const lines: string[] = [];
  lines.push(
    `toc · ${r.file} (${r.headers.length} header${r.headers.length === 1 ? "" : "s"}, ${r.total_lines} lines)`,
  );

  if (r.headers.length === 0) {
    lines.push("(no markdown headers found)");
    return lines.join("\n");
  }

  lines.push("");
  for (const h of r.headers) {
    const indent = "  ".repeat(h.level - 1);
    const lineMark = `L${h.line}`.padEnd(6);
    const size = h.size_lines !== undefined ? `  (${h.size_lines}L)` : "";
    lines.push(`  ${lineMark}${indent}${"#".repeat(h.level)} ${h.text}${size}`);
  }
  return lines.join("\n");
}

async function runSection(file: string, query: string, opts: SectionOpts): Promise<SectionResult> {
  if (!query.trim()) throw new Error("header query required");
  const tocResult = await runToc(file, {});
  const absPath = resolve(file);
  const lines = readFileSync(absPath, "utf8").split("\n");

  const matches = tocResult.headers.filter((h) =>
    opts.caseSensitive
      ? h.text.includes(query)
      : h.text.toLowerCase().includes(query.toLowerCase()),
  );
  if (matches.length === 0) {
    throw new Error(
      `no header matching "${query}". Run \`${resolveBinName()} toc ${file}\` to list available headers.`,
    );
  }
  if (matches.length > 1) {
    const list = matches.map((h) => `  L${h.line}  ${"#".repeat(h.level)} ${h.text}`).join("\n");
    throw new Error(
      `multiple headers match "${query}":\n${list}\n\nRefine the query or use exact text.`,
    );
  }

  const matched = matches[0];
  const idx = tocResult.headers.findIndex((h) => h.line === matched.line);
  let endLine = lines.length;
  for (let i = idx + 1; i < tocResult.headers.length; i++) {
    if (tocResult.headers[i].level <= matched.level) {
      endLine = tocResult.headers[i].line - 1;
      break;
    }
  }

  const content = lines.slice(matched.line - 1, endLine).join("\n");

  return {
    file,
    matched_header: matched.text,
    matched_level: matched.level,
    line_start: matched.line,
    line_end: endLine,
    content,
  };
}

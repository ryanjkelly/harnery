#!/usr/bin/env bun
/**
 * Guard: every child process started from `src/` passes `windowsHide`.
 *
 * On Windows, a process with no console of its own (a detached background
 * worker, a hook runner, a scheduled sync) that starts a console program
 * without `windowsHide: true` makes Windows open a new terminal window for that
 * child. One missed call in a loop is a window per iteration. The option is a
 * no-op on macOS and Linux, so the rule is: every `node:child_process` call
 * (`spawn`, `spawnSync`, `execFile`, `execFileSync`, `exec`, `execSync`) and
 * every `Bun.spawn` / `Bun.spawnSync` names `windowsHide` in its arguments.
 *
 * A call that deliberately opens a visible window (an interactive editor, a
 * headed browser, a terminal the user asked for) carries a waiver comment on
 * the call's line or the line above it:
 *
 *     // windows-hide-allow: <reason>
 *
 * The scan is textual, not a type-checker: it resolves the names a file
 * imports from `node:child_process` (named, aliased, namespace, and
 * `promisify(...)` wrappers), masks comments and string contents, and checks the
 * balanced argument list of each call. An options object built elsewhere and
 * passed by name counts as missing; spread it into a literal that also sets
 * `windowsHide: true` so the guarantee is visible at the call site.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export interface WindowsHideViolation {
  file: string;
  line: number;
  call: string;
}

const CHILD_PROCESS_FUNCTIONS = new Set([
  "spawn",
  "spawnSync",
  "execFile",
  "execFileSync",
  "exec",
  "execSync",
]);

const BUN_FUNCTIONS = ["spawn", "spawnSync"] as const;

export const WAIVER_TOKEN = "windows-hide-allow:";

export function scanWindowsHide(root: string): WindowsHideViolation[] {
  const sourceRoot = join(root, "src");
  if (!existsSync(sourceRoot)) return [];
  const violations: WindowsHideViolation[] = [];
  for (const absolute of walk(sourceRoot)) {
    const file = relative(root, absolute).split("\\").join("/");
    violations.push(...scanWindowsHideSource(file, readFileSync(absolute, "utf8")));
  }
  return violations.sort(
    (left, right) => left.file.localeCompare(right.file) || left.line - right.line,
  );
}

/** Scan one file's source text. Exported so tests can drive it with fixtures. */
export function scanWindowsHideSource(file: string, source: string): WindowsHideViolation[] {
  const masked = maskSource(source);
  const callees = calleeNames(source, masked);
  const lines = source.split("\n");
  const lineStarts = lineStartOffsets(source);
  const violations: WindowsHideViolation[] = [];

  const patterns: Array<{ regex: RegExp; label: (match: RegExpExecArray) => string }> = [];
  if (callees.direct.size > 0) {
    const names = [...callees.direct].map(escapeRegex).join("|");
    patterns.push({
      regex: new RegExp(`(?<![.\\w$])(${names})\\s*\\(`, "g"),
      label: (match) => match[1] ?? "",
    });
  }
  if (callees.namespaces.size > 0) {
    const spaces = [...callees.namespaces].map(escapeRegex).join("|");
    const fns = [...CHILD_PROCESS_FUNCTIONS].join("|");
    patterns.push({
      regex: new RegExp(`(?<![.\\w$])(${spaces})\\s*\\.\\s*(${fns})\\s*\\(`, "g"),
      label: (match) => `${match[1]}.${match[2]}`,
    });
  }
  patterns.push({
    regex: new RegExp(`(?<![.\\w$])Bun\\s*\\.\\s*(${BUN_FUNCTIONS.join("|")})\\s*\\(`, "g"),
    label: (match) => `Bun.${match[1]}`,
  });

  for (const { regex, label } of patterns) {
    for (let match = regex.exec(masked); match; match = regex.exec(masked)) {
      if (isDeclaration(masked, match.index)) continue;
      const open = match.index + match[0].length - 1;
      const close = matchingParen(masked, open);
      const args = masked.slice(open + 1, close < 0 ? masked.length : close);
      if (/(?<![\w$])windowsHide(?![\w$])/.test(args)) continue;
      const line = lineOf(lineStarts, match.index);
      if (hasWaiver(lines, line)) continue;
      violations.push({ file, line, call: label(match) });
    }
  }
  return violations.sort((left, right) => left.line - right.line);
}

/** A waiver needs a non-empty reason on the call's line or the line above. */
function hasWaiver(lines: string[], line: number): boolean {
  for (const candidate of [lines[line - 1], lines[line - 2]]) {
    if (candidate === undefined) continue;
    const at = candidate.indexOf(WAIVER_TOKEN);
    if (at >= 0 && candidate.slice(at + WAIVER_TOKEN.length).trim().length > 0) return true;
  }
  return false;
}

interface Callees {
  direct: Set<string>;
  namespaces: Set<string>;
}

const MODULE = `["'](?:node:)?child_process["']`;

/**
 * Local names bound to child_process functions in this file. Imports are read
 * from the original source (the module specifier is a string, which masking
 * blanks); aliases are read from the masked source so commented-out code is
 * ignored.
 */
function calleeNames(source: string, masked: string): Callees {
  const direct = new Set<string>();
  const namespaces = new Set<string>();
  const addNamed = (list: string, separator: RegExp): void => {
    for (const raw of list.split(",")) {
      const entry = raw.trim();
      if (entry === "" || entry.startsWith("type ")) continue;
      const [imported, local] = entry.split(separator).map((part) => part.trim());
      if (imported && CHILD_PROCESS_FUNCTIONS.has(imported)) direct.add(local || imported);
    }
  };

  const importRegex = new RegExp(String.raw`import\s+(type\s+)?([^;]*?)\s+from\s+${MODULE}`, "g");
  for (const match of source.matchAll(importRegex)) {
    if (match[1]) continue;
    const clause = (match[2] ?? "").trim();
    const braces = clause.match(/\{([\s\S]*)\}/);
    if (braces) addNamed(braces[1] ?? "", /\s+as\s+/);
    const outside = clause.replace(/\{[\s\S]*\}/, "").replace(/,/g, " ");
    const star = outside.match(/\*\s*as\s+([\w$]+)/);
    if (star?.[1]) namespaces.add(star[1]);
    const defaultName = outside.replace(/\*\s*as\s+[\w$]+/, "").trim();
    if (/^[\w$]+$/.test(defaultName)) namespaces.add(defaultName);
  }

  const requireRegex = new RegExp(
    String.raw`(?:const|let|var)\s+(\{[^}]*\}|[\w$]+)\s*=\s*require\(\s*${MODULE}\s*\)`,
    "g",
  );
  for (const match of source.matchAll(requireRegex)) {
    const binding = match[1] ?? "";
    if (binding.startsWith("{")) addNamed(binding.slice(1, -1), /\s*:\s*/);
    else namespaces.add(binding);
  }

  // Follow simple rebindings until no new name appears:
  //   const run = promisify(execFile);   const run = spawnSync;
  //   function f(run: typeof spawnSync = spawnSync)   const run = opts.run ?? spawn;
  for (let grew = true; grew; ) {
    grew = false;
    if (direct.size === 0) break;
    const names = [...direct].map(escapeRegex).join("|");
    const alias = new RegExp(
      String.raw`([\w$]+)\s*(?::\s*typeof\s+[\w$]+\s*)?(?<![=!<>])=(?![=>])\s*` +
        String.raw`(?:promisify\(\s*(?:${names})\s*\)|(?:[\w$.]+\s*\?\?\s*)?(?:${names})\b(?!\s*[(.\w$]))`,
      "g",
    );
    for (const match of masked.matchAll(alias)) {
      const name = match[1];
      if (name && !direct.has(name) && !/^(?:const|let|var)$/.test(name)) {
        direct.add(name);
        grew = true;
      }
    }
  }
  return { direct, namespaces };
}

function lineStartOffsets(source: string): number[] {
  const starts = [0];
  for (let index = 0; index < source.length; index++) {
    if (source[index] === "\n") starts.push(index + 1);
  }
  return starts;
}

function lineOf(starts: number[], offset: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if ((starts[mid] ?? 0) <= offset) low = mid;
    else high = mid - 1;
  }
  return low + 1;
}

/** `function spawn(` or `async spawn(` style declarations are not calls. */
function isDeclaration(masked: string, offset: number): boolean {
  const before = masked.slice(Math.max(0, offset - 20), offset);
  return /\bfunction\s*\*?\s*$/.test(before);
}

function escapeRegex(value: string): string {
  return value.replace(/[$]/g, "\\$");
}

/** Index of the `)` that closes the `(` at `open` in masked text, or -1. */
function matchingParen(masked: string, open: number): number {
  let depth = 0;
  for (let index = open; index < masked.length; index++) {
    const char = masked[index];
    if (char === "(") depth++;
    else if (char === ")") {
      depth--;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/**
 * Replace comment bodies and string/template contents with spaces, keeping
 * newlines, delimiters, and `${...}` template expressions, so offsets and line
 * numbers still match the original and no paren or identifier inside text is
 * mistaken for code.
 */
export function maskSource(source: string): string {
  const out = source.split("");
  const blank = (from: number, to: number): void => {
    for (let index = from; index < to; index++) {
      if (out[index] !== "\n") out[index] = " ";
    }
  };
  // Stack of open template literals; each entry is the brace depth at which
  // the current `${` expression returns to template text.
  const templates: number[] = [];
  let braceDepth = 0;
  let index = 0;
  const length = source.length;
  const scanTemplateText = (start: number): number => {
    // start is just after a backtick or a closing `}` of an expression.
    let at = start;
    while (at < length) {
      const char = source[at];
      if (char === "\\") {
        blank(at, Math.min(at + 2, length));
        at += 2;
        continue;
      }
      if (char === "`") {
        templates.pop();
        return at + 1;
      }
      if (char === "$" && source[at + 1] === "{") {
        braceDepth++;
        const top = templates.length - 1;
        templates[top] = braceDepth;
        return at + 2;
      }
      blank(at, at + 1);
      at++;
    }
    return at;
  };

  while (index < length) {
    const char = source[index];
    const next = source[index + 1];
    if (char === "/" && next === "/") {
      const end = source.indexOf("\n", index);
      const stop = end < 0 ? length : end;
      blank(index, stop);
      index = stop;
      continue;
    }
    if (char === "/" && next === "*") {
      const end = source.indexOf("*/", index + 2);
      const stop = end < 0 ? length : end + 2;
      blank(index, stop);
      index = stop;
      continue;
    }
    if (char === "/" && startsRegexLiteral(source, index)) {
      let at = index + 1;
      let inClass = false;
      while (at < length && source[at] !== "\n") {
        const current = source[at];
        if (current === "\\") {
          at += 2;
          continue;
        }
        if (current === "[") inClass = true;
        else if (current === "]") inClass = false;
        else if (current === "/" && !inClass) break;
        at++;
      }
      blank(index + 1, Math.min(at, length));
      index = at + 1;
      continue;
    }
    if (char === '"' || char === "'") {
      let at = index + 1;
      while (at < length && source[at] !== char && source[at] !== "\n") {
        at += source[at] === "\\" ? 2 : 1;
      }
      blank(index + 1, Math.min(at, length));
      index = at + 1;
      continue;
    }
    if (char === "`") {
      templates.push(-1);
      index = scanTemplateText(index + 1);
      continue;
    }
    if (char === "{") {
      braceDepth++;
      index++;
      continue;
    }
    if (char === "}") {
      const top = templates[templates.length - 1];
      if (top !== undefined && top === braceDepth) {
        braceDepth--;
        templates[templates.length - 1] = -1;
        index = scanTemplateText(index + 1);
        continue;
      }
      braceDepth--;
      index++;
      continue;
    }
    index++;
  }
  return out.join("");
}

/** A `/` starts a regex literal when what precedes it cannot end an operand. */
function startsRegexLiteral(source: string, index: number): boolean {
  let at = index - 1;
  while (at >= 0 && /\s/.test(source[at] ?? "")) at--;
  if (at < 0) return true;
  const previous = source[at] ?? "";
  if ("(,=:[!&|?{};+-*%<>~^".includes(previous)) return true;
  const word = source.slice(Math.max(0, at - 9), at + 1).match(/[\w$]+$/)?.[0];
  return word !== undefined && /^(?:return|typeof|case|do|else|in|of|void|yield|await)$/.test(word);
}

function walk(root: string): string[] {
  const files: string[] = [];
  for (const name of readdirSync(root).sort()) {
    const path = join(root, name);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      if (name === "node_modules") continue;
      files.push(...walk(path));
    } else if (
      stat.isFile() &&
      (name.endsWith(".ts") || name.endsWith(".tsx")) &&
      !name.endsWith(".test.ts") &&
      !name.endsWith(".test.tsx") &&
      !name.endsWith(".d.ts")
    ) {
      files.push(path);
    }
  }
  return files;
}

if (import.meta.main) {
  const root = process.argv[2] ?? process.cwd();
  const violations = scanWindowsHide(root);
  if (violations.length === 0) {
    console.log("windows-hide: clean, every child process in src/ passes windowsHide.");
    process.exit(0);
  }
  console.error(`windows-hide: ${violations.length} child process call(s) without windowsHide:`);
  for (const violation of violations) {
    console.error(`  ${violation.file}:${violation.line} (${violation.call})`);
  }
  console.error(
    `Add \`windowsHide: true\` to the call's options, or \`// ${WAIVER_TOKEN} <reason>\` ` +
      "on the line above when the window is meant to be seen.",
  );
  process.exit(1);
}

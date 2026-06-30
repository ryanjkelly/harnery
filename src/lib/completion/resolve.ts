/**
 * Runtime completion resolver — the authoritative, in-process answer to
 * "what should I suggest at this cursor position?".
 *
 * The static bash/zsh/fish generators bake the whole command tree into shell
 * case-tables, which go stale the moment a command/flag is added (the script
 * must be regenerated + reinstalled). The DYNAMIC completion path instead
 * installs a thin, tree-independent shim that, on every <Tab>, hands the live
 * command line back to the binary and calls THIS function. Because the binary
 * always knows its own current command tree, a dynamic shim never goes stale —
 * install once, ever.
 *
 * This mirrors the path-walking the static bash driver does, but in one place
 * and in TypeScript, so all three shells share identical behavior. It is
 * deliberately decoupled from Commander internals via the CommandSpec tree
 * (walkProgram), exactly like the static generators.
 */

import type { Command } from "commander";
import { type CommandSpec, type CompletionContextLookup, walkProgram } from "./walk.js";

/** Bitmask of post-processing hints for the shell shim (Cobra-style). */
export const Directive = {
  /** Use the returned candidates as completion values. */
  Default: 0,
  /** No candidates apply here — the shell should fall back to file completion. */
  File: 1,
} as const;

export interface Candidate {
  value: string;
  description?: string;
}

export interface CompletionResult {
  candidates: Candidate[];
  directive: number;
}

/** Provider runner injected by the host CLI (same contract as `__complete`). */
export type CompletionProviderRunner = (provider: string, partial: string) => Promise<string[]>;

interface PathTables {
  subcommandsByPath: Map<string, CommandSpec[]>;
  /** path → flag (long or short) → spec, for both forms. */
  optionsByPath: Map<string, CommandSpec["options"]>;
  positionalsByPath: Map<string, CommandSpec["positionals"]>;
}

function buildTables(root: CommandSpec): PathTables {
  const subcommandsByPath = new Map<string, CommandSpec[]>();
  const optionsByPath = new Map<string, CommandSpec["options"]>();
  const positionalsByPath = new Map<string, CommandSpec["positionals"]>();
  const walk = (s: CommandSpec): void => {
    subcommandsByPath.set(s.path, s.subcommands);
    optionsByPath.set(s.path, s.options);
    positionalsByPath.set(s.path, s.positionals);
    for (const sub of s.subcommands) walk(sub);
  };
  walk(root);
  return { subcommandsByPath, optionsByPath, positionalsByPath };
}

function optionAt(tables: PathTables, path: string, flag: string) {
  const opts = tables.optionsByPath.get(path) ?? [];
  return opts.find((o) => o.long === flag || o.short === flag);
}

function isKnownSubcommand(tables: PathTables, path: string, name: string): boolean {
  return (tables.subcommandsByPath.get(path) ?? []).some((c) => c.name === name);
}

/**
 * Walk the words before the cursor to determine the current command path,
 * skipping options and the values they consume (mirrors the static driver).
 * Returns the resolved command path ("" = root).
 */
function resolvePath(tables: PathTables, words: string[], cword: number): string {
  let path = "";
  let i = 1; // words[0] is the bin name
  while (i < cword) {
    const w = words[i] ?? "";
    if (w.startsWith("-")) {
      const opt = optionAt(tables, path, w);
      if (opt?.takesValue) i += 1; // skip the option's value
    } else if (isKnownSubcommand(tables, path, w)) {
      path = path ? `${path} ${w}` : w;
    }
    i += 1;
  }
  return path;
}

/** Count positional args consumed at the resolved path (non-option, non-subcommand words). */
function positionalIndex(tables: PathTables, words: string[], cword: number): number {
  let seen = "";
  let after = 0;
  let j = 1;
  while (j < cword) {
    const w = words[j] ?? "";
    if (w.startsWith("-")) {
      const opt = optionAt(tables, seen, w);
      if (opt?.takesValue) j += 1;
    } else if (isKnownSubcommand(tables, seen, w)) {
      seen = seen ? `${seen} ${w}` : w;
    } else {
      after += 1;
    }
    j += 1;
  }
  return after;
}

/** Resolve the value source (enum / dynamic-provider / file) for a value slot. */
async function valueCandidates(
  source: { valueChoices?: string[]; dynamicProvider?: string },
  partial: string,
  runProvider: CompletionProviderRunner,
): Promise<CompletionResult> {
  if (source.dynamicProvider) {
    try {
      const values = await runProvider(source.dynamicProvider, partial);
      return { candidates: values.map((value) => ({ value })), directive: Directive.Default };
    } catch {
      return { candidates: [], directive: Directive.File };
    }
  }
  if (source.valueChoices && source.valueChoices.length > 0) {
    return {
      candidates: source.valueChoices.map((value) => ({ value })),
      directive: Directive.Default,
    };
  }
  // A value is expected but we have nothing to suggest → let the shell try files.
  return { candidates: [], directive: Directive.File };
}

/**
 * Compute completion candidates for `words` with the cursor at `cword`.
 * `words[0]` is the bin name; `words[cword]` is the (possibly empty) token
 * being completed. The shell shim does the final prefix-filtering against that
 * token, so this returns the full candidate set for the slot.
 */
export async function resolveCompletions(
  program: Command,
  words: string[],
  cword: number,
  lookup: CompletionContextLookup,
  runProvider: CompletionProviderRunner,
): Promise<CompletionResult> {
  const tables = buildTables(walkProgram(program, lookup));
  const path = resolvePath(tables, words, cword);
  const cur = words[cword] ?? "";
  const prev = cword > 0 ? (words[cword - 1] ?? "") : "";

  // Case 1: previous word is an option that takes a value → complete the value.
  if (prev.startsWith("-")) {
    const opt = optionAt(tables, path, prev);
    if (opt?.takesValue) return valueCandidates(opt, cur, runProvider);
  }

  // Case 2: completing an option name (cur starts with "-").
  if (cur.startsWith("-")) {
    const opts = tables.optionsByPath.get(path) ?? [];
    const candidates: Candidate[] = [];
    for (const o of opts) {
      if (o.long) candidates.push({ value: o.long, description: o.description });
      if (o.short) candidates.push({ value: o.short, description: o.description });
    }
    return { candidates, directive: Directive.Default };
  }

  // Case 3: subcommands available at this path → suggest them.
  const subs = tables.subcommandsByPath.get(path) ?? [];
  if (subs.length > 0) {
    return {
      candidates: subs.map((c) => ({ value: c.name, description: c.description })),
      directive: Directive.Default,
    };
  }

  // Case 4: positional value slot.
  const positionals = tables.positionalsByPath.get(path) ?? [];
  const idx = positionalIndex(tables, words, cword);
  const pos =
    positionals[idx] ??
    (positionals[positionals.length - 1]?.variadic
      ? positionals[positionals.length - 1]
      : undefined);
  if (pos) return valueCandidates(pos, cur, runProvider);

  // Nothing structured to suggest → file completion.
  return { candidates: [], directive: Directive.File };
}

/** Sentinel prefix for the trailing directive line in the wire protocol. */
export const DIRECTIVE_PREFIX = "\x1f:";

/**
 * Serialize a result for the shell shim: one `value\tdescription` line per
 * candidate, then a final `\x1f:<directive>` line. The \x1f (unit separator)
 * prefix makes the directive line unambiguous against real candidate values.
 */
export function encodeResult(result: CompletionResult): string {
  const lines = result.candidates.map((c) =>
    c.description ? `${c.value}\t${c.description}` : c.value,
  );
  lines.push(`${DIRECTIVE_PREFIX}${result.directive}`);
  return `${lines.join("\n")}\n`;
}

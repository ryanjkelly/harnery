/**
 * Walks the Commander program tree and produces a normalized CommandSpec tree
 * that the bash/zsh/fish completion generators consume. Decoupled from
 * Commander internals so the generators don't have to know about Option/Argument
 * classes, just the spec types defined here.
 */

import type { Argument, Command, Option } from "commander";

/**
 * Caller-injected lookup that maps a (commandPath, option-or-positional)
 * pair to a dynamic-provider key. The shell completion script later
 * invokes `<bin> __complete <key>` at tab-time and the consumer's
 * provider registry produces the actual values. harn standalone uses
 * the default no-op lookup (no dynamic completion).
 */
export type CompletionContextLookup = (key: {
  commandPath: string;
  option?: string;
  positional?: number;
}) => string | undefined;

const noopLookup: CompletionContextLookup = () => undefined;

export interface CommandSpec {
  /** Bare command name (e.g., "anthropic", "cost"). */
  name: string;
  /** Full path from root, space-separated (e.g., "anthropic cost"). Empty for the root program. */
  path: string;
  description: string;
  subcommands: CommandSpec[];
  options: OptionSpec[];
  positionals: PositionalSpec[];
  /** True if this command has the `--help` flag (default for all Commander commands). */
  hasHelp: boolean;
  /** True if this is a hidden command; completion can skip it. */
  hidden: boolean;
}

export interface OptionSpec {
  /** Long form including `--`, e.g., "--workspace". May be empty if only short form exists. */
  long: string;
  /** Short form including `-`, e.g., "-w". May be empty. */
  short: string;
  description: string;
  /** True if the option requires a value (e.g., `--workspace <id>`). */
  takesValue: boolean;
  /** Optional static choice list for the value (e.g. `--format json|csv|table`). */
  valueChoices?: string[];
  /** Optional dynamic-value provider key; completion script calls back via `harn __complete <key>`. */
  dynamicProvider?: string;
  /** True if the option can be repeated. */
  variadic: boolean;
}

export interface PositionalSpec {
  name: string;
  description: string;
  required: boolean;
  variadic: boolean;
  valueChoices?: string[];
  dynamicProvider?: string;
}

/**
 * Walks the Commander program tree and returns the root CommandSpec.
 * The root represents `harn` itself; its `subcommands` are the top-level
 * subcommands.
 */
export function walkProgram(
  program: Command,
  lookup: CompletionContextLookup = noopLookup,
): CommandSpec {
  return walkCommand(program, "", true, lookup);
}

function walkCommand(
  cmd: Command,
  parentPath: string,
  isRoot: boolean,
  lookup: CompletionContextLookup,
): CommandSpec {
  const name = cmd.name();
  // The root program represents `harn` itself; its path stays empty so that
  // top-level subcommands have paths like "anthropic", not "harn anthropic".
  // The shell driver walks COMP_WORDS[1..], so it's already operating in
  // post-`harn` space and shouldn't see the host bin name in its lookup keys.
  const path = isRoot ? "" : parentPath ? `${parentPath} ${name}` : name;

  const subcommands: CommandSpec[] = cmd.commands
    .filter((c) => !isHidden(c))
    // Skip the auto-injected `help` subcommand; noisy without being useful.
    .filter((c) => c.name() !== "help")
    .map((c) => walkCommand(c, path, false, lookup));

  // Sort subcommands alphabetically for predictable output.
  subcommands.sort((a, b) => a.name.localeCompare(b.name));

  const options: OptionSpec[] = cmd.options
    .filter((o) => !o.hidden)
    .map((o) => optionSpec(o, path, lookup));

  // Commander auto-injects `-h, --help` for every command but doesn't expose
  // it in `cmd.options`. Add a synthetic entry so tab-completion suggests it.
  options.push({
    long: "--help",
    short: "-h",
    description: "Show help for this command",
    takesValue: false,
    variadic: false,
  });

  const positionals: PositionalSpec[] = cmd.registeredArguments.map((a, i) =>
    positionalSpec(a, path, i, lookup),
  );

  return {
    name,
    path,
    description: (cmd.description() || "").replace(/\s+/g, " ").trim(),
    subcommands,
    options,
    positionals,
    hasHelp: true,
    hidden: isHidden(cmd),
  };
}

function optionSpec(opt: Option, commandPath: string, lookup: CompletionContextLookup): OptionSpec {
  const long = opt.long ?? "";
  const short = opt.short ?? "";
  const takesValue = opt.required || opt.optional;
  const provider = lookup({
    commandPath,
    option: long || short,
  });
  return {
    long,
    short,
    description: (opt.description || "").replace(/\s+/g, " ").trim(),
    takesValue,
    valueChoices: opt.argChoices ? [...opt.argChoices] : undefined,
    dynamicProvider: provider,
    variadic: opt.variadic,
  };
}

function positionalSpec(
  arg: Argument,
  commandPath: string,
  index: number,
  lookup: CompletionContextLookup,
): PositionalSpec {
  const provider = lookup({
    commandPath,
    positional: index,
  });
  return {
    name: arg.name(),
    description: (arg.description || "").replace(/\s+/g, " ").trim(),
    required: arg.required,
    variadic: arg.variadic,
    valueChoices: arg.argChoices ? [...arg.argChoices] : undefined,
    dynamicProvider: provider,
  };
}

function isHidden(cmd: Command): boolean {
  // Commander marks hidden commands via `command(..., { hidden: true })`.
  // The flag lives on a private field; we read it defensively via `any`.
  const c = cmd as unknown as { _hidden?: boolean };
  return c._hidden === true;
}

/** Flatten the spec tree into a list of (path, spec) entries for code generation. */
export function flatten(root: CommandSpec): Array<{ path: string; spec: CommandSpec }> {
  const out: Array<{ path: string; spec: CommandSpec }> = [];
  const walk = (s: CommandSpec): void => {
    out.push({ path: s.path, spec: s });
    for (const sub of s.subcommands) walk(sub);
  };
  walk(root);
  return out;
}

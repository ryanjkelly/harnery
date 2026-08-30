import { type Command, Option, type ParseOptions } from "commander";

const lazyState = Symbol("harnery.lazy-command-state");

export interface LazyCommandDefinition {
  /** Commander signature, including any top-level positional arguments. */
  command: string;
  description: string;
  aliases?: readonly string[];
  hidden?: boolean;
  /** Preserve the `[options]` marker in root help without loading the implementation. */
  hasOptions?: boolean;
}

export interface LazyCommandBundle {
  commands: readonly LazyCommandDefinition[];
  load(program: Command): void | Promise<void>;
}

type LoadStatus = "placeholder" | "loading" | "loaded";

interface RegisteredBundle {
  readonly definition: LazyCommandBundle;
  readonly placeholders: Map<string, Command>;
  status: LoadStatus;
}

interface LazyCommandState {
  readonly bundles: RegisteredBundle[];
  readonly byName: Map<string, RegisteredBundle>;
  readonly hooks: Map<string, Array<(program: Command) => void | Promise<void>>>;
  readonly originalParse: Command["parse"];
  readonly originalParseAsync: Command["parseAsync"];
}

/**
 * Add lightweight top-level command placeholders whose implementations load
 * immediately before Commander parses the selected command.
 */
export function registerLazyCommandBundles(
  program: Command,
  definitions: readonly LazyCommandBundle[],
): Command {
  const state = stateFor(program);
  for (const definition of definitions) {
    const registered: RegisteredBundle = {
      definition,
      placeholders: new Map(),
      status: "placeholder",
    };
    for (const metadata of definition.commands) {
      const name = commandName(metadata.command);
      const claimedNames = [name, ...(metadata.aliases ?? [])];
      for (const claimedName of claimedNames) {
        if (state.byName.has(claimedName) || findCommand(program, claimedName)) {
          throw new Error(`Cannot register lazy command "${claimedName}": name already exists`);
        }
      }

      const placeholder = program
        .command(metadata.command, { hidden: metadata.hidden === true })
        .description(metadata.description);
      for (const alias of metadata.aliases ?? []) placeholder.alias(alias);
      if (metadata.hasOptions) {
        placeholder.addOption(new Option("--__lazy-command-placeholder").hideHelp());
      }

      registered.placeholders.set(name, placeholder);
      for (const claimedName of claimedNames) state.byName.set(claimedName, registered);
    }
    state.bundles.push(registered);
  }
  return program;
}

/** Load one top-level command by canonical name or alias. */
export async function loadLazyCommand(
  program: Command,
  name: string,
): Promise<Command | undefined> {
  const state = getState(program);
  const bundle = state?.byName.get(name);
  if (!state || !bundle) return findCommand(program, name);
  await loadBundle(program, state, bundle);
  return findCommand(program, name);
}

/** Materialize every remaining lazy bundle, for whole-tree discovery and completion. */
export async function loadAllLazyCommands(program: Command): Promise<Command> {
  const state = getState(program);
  if (!state) return program;
  for (const bundle of state.bundles) await loadBundle(program, state, bundle);
  return program;
}

/** Run a host hook after a named lazy command becomes concrete. */
export async function onLazyCommandLoaded(
  program: Command,
  name: string,
  hook: (program: Command) => void | Promise<void>,
): Promise<void> {
  const state = getState(program);
  const bundle = state?.byName.get(name);
  if (!state || !bundle || bundle.status === "loaded") {
    await hook(program);
    return;
  }
  const hooks = state.hooks.get(name) ?? [];
  hooks.push(hook);
  state.hooks.set(name, hooks);
}

function stateFor(program: Command): LazyCommandState {
  const existing = getState(program);
  if (existing) return existing;

  const originalParse = program.parse;
  const originalParseAsync = program.parseAsync;
  const state: LazyCommandState = {
    bundles: [],
    byName: new Map(),
    hooks: new Map(),
    originalParse,
    originalParseAsync,
  };
  Object.defineProperty(program, lazyState, { value: state });

  program.parseAsync = async function lazyParseAsync(
    argv?: readonly string[],
    parseOptions?: ParseOptions,
  ): Promise<Command> {
    const selected = selectedCommand(program, state, argv, parseOptions);
    if (selected) await loadBundle(program, state, selected);
    return originalParseAsync.call(this, argv, parseOptions);
  };

  program.parse = function lazyParse(
    argv?: readonly string[],
    parseOptions?: ParseOptions,
  ): Command {
    const selected = selectedCommand(program, state, argv, parseOptions);
    if (selected && selected.status !== "loaded") {
      throw new Error(
        `Command "${selected.definition.commands[0]?.command ?? "unknown"}" loads asynchronously; use parseAsync()`,
      );
    }
    return originalParse.call(this, argv, parseOptions);
  };

  return state;
}

function getState(program: Command): LazyCommandState | undefined {
  return (program as Command & { [lazyState]?: LazyCommandState })[lazyState];
}

async function loadBundle(
  program: Command,
  state: LazyCommandState,
  bundle: RegisteredBundle,
): Promise<void> {
  if (bundle.status === "loaded" || bundle.status === "loading") return;
  bundle.status = "loading";

  const positions = new Map<string, number>();
  for (const [name, placeholder] of bundle.placeholders) {
    const index = program.commands.indexOf(placeholder);
    if (index >= 0) positions.set(name, index);
  }
  for (const placeholder of [...bundle.placeholders.values()].sort(
    (a, b) => program.commands.indexOf(b) - program.commands.indexOf(a),
  )) {
    const index = program.commands.indexOf(placeholder);
    if (index >= 0) mutableCommands(program).splice(index, 1);
  }

  const commandsBefore = new Set(program.commands);
  try {
    await bundle.definition.load(program);
    for (const metadata of bundle.definition.commands) {
      const name = commandName(metadata.command);
      const concrete = program.commands.find(
        (candidate) => !commandsBefore.has(candidate) && candidate.name() === name,
      );
      if (!concrete) {
        throw new Error(`Lazy command loader did not register "${name}"`);
      }
    }

    restoreCommandOrder(program, bundle, positions);
    bundle.status = "loaded";
    for (const metadata of bundle.definition.commands) {
      const name = commandName(metadata.command);
      for (const hook of state.hooks.get(name) ?? []) await hook(program);
      state.hooks.delete(name);
    }
  } catch (error) {
    for (let index = program.commands.length - 1; index >= 0; index--) {
      if (!commandsBefore.has(program.commands[index]!)) mutableCommands(program).splice(index, 1);
    }
    restorePlaceholders(program, bundle, positions);
    bundle.status = "placeholder";
    throw error;
  }
}

function restoreCommandOrder(
  program: Command,
  bundle: RegisteredBundle,
  positions: ReadonlyMap<string, number>,
): void {
  const ordered = bundle.definition.commands
    .map((metadata) => {
      const name = commandName(metadata.command);
      const command = findCommand(program, name);
      const position = positions.get(name);
      return command && position !== undefined ? { command, position } : undefined;
    })
    .filter((entry): entry is { command: Command; position: number } => entry !== undefined)
    .sort((a, b) => a.position - b.position);

  for (const { command } of ordered) {
    const index = program.commands.indexOf(command);
    if (index >= 0) mutableCommands(program).splice(index, 1);
  }
  for (const { command, position } of ordered) {
    mutableCommands(program).splice(Math.min(position, program.commands.length), 0, command);
  }
}

function restorePlaceholders(
  program: Command,
  bundle: RegisteredBundle,
  positions: ReadonlyMap<string, number>,
): void {
  const ordered = [...bundle.placeholders]
    .map(([name, command]) => ({ command, position: positions.get(name) }))
    .filter(
      (entry): entry is { command: Command; position: number } => entry.position !== undefined,
    )
    .sort((a, b) => a.position - b.position);
  for (const { command, position } of ordered) {
    mutableCommands(program).splice(Math.min(position, program.commands.length), 0, command);
  }
}

function selectedCommand(
  program: Command,
  state: LazyCommandState,
  argv: readonly string[] | undefined,
  parseOptions: ParseOptions | undefined,
): RegisteredBundle | undefined {
  const args = userArguments(argv ?? process.argv, parseOptions?.from);
  for (let index = 0; index < args.length; index++) {
    const token = args[index]!;
    if (token === "--") return undefined;
    if (token.startsWith("-")) {
      const option = findRootOption(program, token);
      if (option?.required || (option?.optional && !args[index + 1]?.startsWith("-"))) index++;
      continue;
    }
    if (token === "help") return state.byName.get(args[index + 1] ?? "");
    return state.byName.get(token);
  }
  return undefined;
}

function userArguments(
  argv: readonly string[],
  from: ParseOptions["from"] | undefined,
): readonly string[] {
  if (from === "user") return argv;
  if (from === "electron") return argv.slice(1);
  return argv.slice(2);
}

function findRootOption(program: Command, token: string): Option | undefined {
  const flag = token.includes("=") ? token.slice(0, token.indexOf("=")) : token;
  return program.options.find((option) => option.short === flag || option.long === flag);
}

function findCommand(program: Command, name: string): Command | undefined {
  return program.commands.find(
    (candidate) => candidate.name() === name || candidate.aliases().includes(name),
  );
}

function mutableCommands(program: Command): Command[] {
  return program.commands as Command[];
}

function commandName(signature: string): string {
  return signature.trim().split(/[\s|]/, 1)[0] ?? signature;
}

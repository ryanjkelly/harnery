import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Command } from "commander";
import type { EmitContext, HarneryProgramContext } from "../commander.ts";
import {
  type CompletionContextLookup,
  type CompletionProviderRunner,
  encodeResult,
  generateBash,
  generateBashDynamic,
  generateFish,
  generateFishDynamic,
  generateZsh,
  generateZshDynamic,
  resolveCompletions,
  walkProgram,
} from "../lib/completion/index.ts";

const noopProviderRunner = async (): Promise<string[]> => [];
const noopLookup: CompletionContextLookup = () => undefined;

/**
 * `harn completion`: emit / install shell completion scripts.
 *
 *   harn completion bash | zsh | fish    → write generated script to stdout
 *   harn completion install [--shell ...] → install to the conventional location
 *
 * And the hidden internal entry point:
 *
 *   harn __complete <provider> -- <partial>
 *     Called by the generated shell scripts at tab-time for dynamic-value
 *     completion. Returns newline-separated candidate values. Empty exit
 *     code 0 even on errors (don't disrupt the user's tab).
 */
export function registerCompletionCommand(
  program: Command,
  _emit: EmitContext,
  context?: HarneryProgramContext,
): void {
  const lookup = context?.completionLookup ?? noopLookup;
  const runProvider = context?.completionRunner ?? noopProviderRunner;
  const root = program
    .command("completion")
    .description(
      "Shell tab-completion. Emit a script per shell or install to the standard location.",
    );

  const dynamicHint =
    "Emit a thin shim that calls the binary at tab-time (never goes stale; install once)";

  root
    .command("bash")
    .description("Emit bash completion script to stdout")
    .option("--dynamic", dynamicHint)
    .action((opts: { dynamic?: boolean }) => {
      const out = opts.dynamic
        ? generateBashDynamic(program.name())
        : generateBash(walkProgram(program, lookup), program.name());
      process.stdout.write(out); // raw bytes: shell completion scripts must be unframed (consumer evals stdout).
    });

  root
    .command("zsh")
    .description("Emit zsh completion script to stdout")
    .option("--dynamic", dynamicHint)
    .action((opts: { dynamic?: boolean }) => {
      const out = opts.dynamic
        ? generateZshDynamic(program.name())
        : generateZsh(walkProgram(program, lookup), program.name());
      process.stdout.write(out); // raw bytes: shell completion scripts must be unframed (consumer evals stdout).
    });

  root
    .command("fish")
    .description("Emit fish completion script to stdout")
    .option("--dynamic", dynamicHint)
    .action((opts: { dynamic?: boolean }) => {
      const out = opts.dynamic
        ? generateFishDynamic(program.name())
        : generateFish(walkProgram(program, lookup), program.name());
      process.stdout.write(out); // raw bytes: shell completion scripts must be unframed (consumer evals stdout).
    });

  root
    .command("install")
    .description("Write completion script to the conventional location for the chosen shell")
    .option("--shell <name>", "bash | zsh | fish (default: auto-detect from $SHELL)")
    .option("--path <file>", "Override destination path")
    .option("--print-path", "Print the destination path and exit (no write)")
    .option("--dynamic", `${dynamicHint} (recommended)`)
    .action(async (opts: InstallOpts) => {
      await installCompletion(program, opts, lookup);
    });

  // Hidden internal entry: shells call this at tab-time. `hidden: true` so
  // `harn --help` doesn't surface it.
  const hidden = program
    .command("__complete <provider> [partial]", { hidden: true })
    .description("Internal: dynamic-value completion callback for the shell")
    .allowExcessArguments(true)
    .action(async (provider: string, partial: string | undefined) => {
      try {
        const values = await runProvider(provider, partial ?? "");
        for (const v of values) {
          process.stdout.write(`${v}\n`); // lint-ok-emission: shell callback; newline-delimited raw values is the contract with compgen/_describe/fish.
        }
      } catch {
        // Swallow errors silently: failure during tab completion should not
        // break the user's shell.
      }
    });
  // Keep TS happy that the variable is used.
  void hidden;

  // Hidden internal entry for DYNAMIC completion: the thin shim passes the live
  // command line (cursor index + all words after `--`) and we compute the full
  // candidate set from the live command tree. `--` stops option parsing so
  // words like `-h` reach the variadic instead of being read as our flags.
  const hiddenLine = program
    .command("__complete-line <cword> [words...]", { hidden: true })
    .description("Internal: full-line completion callback for the dynamic shell shim")
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .action(async (cword: string, words: string[] | undefined) => {
      try {
        const result = await resolveCompletions(
          program,
          words ?? [],
          Number.parseInt(cword, 10) || 0,
          lookup,
          runProvider as CompletionProviderRunner,
        );
        process.stdout.write(encodeResult(result)); // lint-ok-emission: shell callback; the encoded candidate/directive stream is the contract with the shim.
      } catch {
        // Never break the user's tab: emit just the file-fallback directive.
        process.stdout.write("\x1f:1\n"); // lint-ok-emission: shell callback fallback directive.
      }
    });
  void hiddenLine;
}

interface InstallOpts {
  shell?: string;
  path?: string;
  printPath?: boolean;
  dynamic?: boolean;
}

async function installCompletion(
  program: Command,
  opts: InstallOpts,
  lookup: CompletionContextLookup,
): Promise<void> {
  const shell = opts.shell ?? detectShell();
  if (!shell) {
    process.stderr.write("Could not auto-detect shell. Pass --shell bash|zsh|fish explicitly.\n"); // lint-ok-emission: install error; stderr keeps stdout clean for --print-path piping.
    process.exit(1);
  }

  const destination = opts.path ?? defaultInstallPath(shell, program.name());
  if (opts.printPath) {
    process.stdout.write(`${destination}\n`); // lint-ok-emission: --print-path is meant to be piped (e.g., dest=$(harn completion install --print-path)).
    return;
  }

  const name = program.name();
  let content: string;
  switch (shell) {
    case "bash":
      content = opts.dynamic
        ? generateBashDynamic(name)
        : generateBash(walkProgram(program, lookup), name);
      break;
    case "zsh":
      content = opts.dynamic
        ? generateZshDynamic(name)
        : generateZsh(walkProgram(program, lookup), name);
      break;
    case "fish":
      content = opts.dynamic
        ? generateFishDynamic(name)
        : generateFish(walkProgram(program, lookup), name);
      break;
    default:
      process.stderr.write(`Unknown shell: ${shell}\n`); // lint-ok-emission: install-time error, see above.
      process.exit(1);
  }

  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, content);
  process.stderr.write(`Installed ${shell} completion to ${destination}\n`); // lint-ok-emission: install progress; stderr keeps stdout clean.

  // Hint how to activate.
  printActivationHint(shell, destination);
}

function detectShell(): string | null {
  const shellPath = process.env.SHELL ?? "";
  if (shellPath.endsWith("/bash")) return "bash";
  if (shellPath.endsWith("/zsh")) return "zsh";
  if (shellPath.endsWith("/fish")) return "fish";
  return null;
}

function defaultInstallPath(shell: string, binName: string): string {
  const home = process.env.HOME ?? "";
  switch (shell) {
    case "bash": {
      // bash-completion v2 user-level location.
      const xdg = process.env.XDG_DATA_HOME ?? resolve(home, ".local/share");
      return resolve(xdg, `bash-completion/completions/${binName}`);
    }
    case "zsh": {
      // Common $fpath user location. zsh auto-loads from ~/.zsh/completions if
      // it's in $fpath.
      return resolve(home, `.zsh/completions/_${binName}`);
    }
    case "fish": {
      // Fish auto-loads everything in ~/.config/fish/completions/.
      return resolve(home, `.config/fish/completions/${binName}.fish`);
    }
    default:
      return resolve(home, `.${binName}-completion.${shell}`);
  }
}

function printActivationHint(shell: string, path: string): void {
  switch (shell) {
    case "bash":
      if (existsSync(resolve(process.env.HOME ?? "", ".bashrc"))) {
        const bashHint = `\nTo activate now in this shell: source "${path}"\nNew shells will pick it up automatically if bash-completion is enabled.\nIf completions don't fire in new shells, add this to ~/.bashrc:\n  [ -f "${path}" ] && source "${path}"\n`;
        process.stderr.write(bashHint); // lint-ok-emission: post-install activation hint; stderr keeps stdout clean.
      }
      break;
    case "zsh": {
      const zshHint = `\nTo activate now: autoload -U compinit && compinit\nMake sure ${resolve(path, "..")} is in your $fpath. Add to ~/.zshrc:\n  fpath=(${resolve(path, "..")} $fpath)\n  autoload -U compinit && compinit\n`;
      process.stderr.write(zshHint); // lint-ok-emission: post-install activation hint; stderr keeps stdout clean.
      break;
    }
    case "fish": {
      const fishHint = `\nFish auto-loads completions from ${resolve(path, "..")}. New shells pick it up.\nTo activate now: source "${path}"\n`;
      process.stderr.write(fishHint); // lint-ok-emission: post-install activation hint; stderr keeps stdout clean.
      break;
    }
  }
}

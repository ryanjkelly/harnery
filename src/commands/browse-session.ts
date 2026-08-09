import type { Readable } from "node:stream";
import type { Command } from "commander";
import type { EmitContext } from "../commander.ts";
import type { BrowserSessionLocator } from "../lib/browser/client.ts";
import {
  BROWSER_SESSION_MAX_FILL_BYTES,
  BrowserSessionError,
  sendBrowserSessionRequest,
} from "../lib/browser/session-control.ts";

interface ControlFileOpts {
  controlFile: string;
}

interface LocatorOpts extends ControlFileOpts {
  selector?: string;
  role?: string;
  name?: string;
  label?: string;
  text?: string;
  partial?: boolean;
}

export function registerBrowseSessionCommand(program: Command, emit: EmitContext): void {
  const session = program
    .command("browse-session")
    .description("Control an opted-in headed browse session through an owner-only descriptor");

  session
    .command("status")
    .requiredOption("--control-file <path>", "Owner-only session descriptor")
    .action((opts: ControlFileOpts) => runAction(emit, opts.controlFile, "status", {}));

  addLocatorOptions(
    session
      .command("inspect")
      .description("Inspect sanitized text, controls, focus, and active-tab state")
      .requiredOption("--control-file <path>", "Owner-only session descriptor"),
  ).action((opts: LocatorOpts) => {
    const locator = parseLocatorOptions(opts, false);
    return runAction(emit, opts.controlFile, "inspect", locator ? { locator } : {});
  });

  session
    .command("screenshot")
    .requiredOption("--control-file <path>", "Owner-only session descriptor")
    .requiredOption("--out <path>", "New PNG path in an existing directory")
    .action((opts: ControlFileOpts & { out: string }) =>
      runAction(emit, opts.controlFile, "screenshot", { out: opts.out }),
    );

  session
    .command("tabs")
    .requiredOption("--control-file <path>", "Owner-only session descriptor")
    .action((opts: ControlFileOpts) => runAction(emit, opts.controlFile, "tabs", {}));

  session
    .command("select-tab")
    .requiredOption("--control-file <path>", "Owner-only session descriptor")
    .requiredOption("--index <n>", "Stable session-local tab index", parseIndex)
    .action((opts: ControlFileOpts & { index: number }) =>
      runAction(emit, opts.controlFile, "select_tab", { index: opts.index }),
    );

  session
    .command("open-tab <url>")
    .requiredOption("--control-file <path>", "Owner-only session descriptor")
    .action((url: string, opts: ControlFileOpts) =>
      runAction(emit, opts.controlFile, "open_tab", { url }),
    );

  session
    .command("close-tab")
    .requiredOption("--control-file <path>", "Owner-only session descriptor")
    .requiredOption("--index <n>", "Stable session-local tab index", parseIndex)
    .action((opts: ControlFileOpts & { index: number }) =>
      runAction(emit, opts.controlFile, "close_tab", { index: opts.index }),
    );

  session
    .command("goto <url>")
    .requiredOption("--control-file <path>", "Owner-only session descriptor")
    .action((url: string, opts: ControlFileOpts) =>
      runAction(emit, opts.controlFile, "goto", { url }),
    );

  session
    .command("reload")
    .requiredOption("--control-file <path>", "Owner-only session descriptor")
    .action((opts: ControlFileOpts) => runAction(emit, opts.controlFile, "reload", {}));

  addLocatorOptions(
    session
      .command("click")
      .requiredOption("--control-file <path>", "Owner-only session descriptor"),
  ).action((opts: LocatorOpts) =>
    runAction(emit, opts.controlFile, "click", { locator: parseLocatorOptions(opts, true) }),
  );

  addLocatorOptions(
    session
      .command("fill")
      .description("Fill one strict locator with a value read once from standard input")
      .requiredOption("--control-file <path>", "Owner-only session descriptor"),
  ).action(async (opts: LocatorOpts) => {
    const value = await readFillValue(process.stdin);
    return runAction(emit, opts.controlFile, "fill", {
      locator: parseLocatorOptions(opts, true),
      value,
    });
  });

  session
    .command("press <key>")
    .requiredOption("--control-file <path>", "Owner-only session descriptor")
    .action((key: string, opts: ControlFileOpts) =>
      runAction(emit, opts.controlFile, "press", { key }),
    );

  addLocatorOptions(
    session
      .command("wait")
      .requiredOption("--control-file <path>", "Owner-only session descriptor"),
  ).action((opts: LocatorOpts) =>
    runAction(emit, opts.controlFile, "wait", { locator: parseLocatorOptions(opts, true) }),
  );

  session
    .command("close")
    .requiredOption("--control-file <path>", "Owner-only session descriptor")
    .action((opts: ControlFileOpts) => runAction(emit, opts.controlFile, "close", {}));
}

function addLocatorOptions(command: Command): Command {
  return command
    .option("--selector <css>", "CSS locator")
    .option("--role <role>", "Accessible role locator")
    .option("--name <name>", "Accessible name used with --role")
    .option("--label <text>", "Associated label locator")
    .option("--text <text>", "Visible text locator")
    .option("--partial", "Allow partial accessible-name, label, or text matching");
}

export function parseLocatorOptions(opts: LocatorOpts, required: true): BrowserSessionLocator;
export function parseLocatorOptions(
  opts: LocatorOpts,
  required: false,
): BrowserSessionLocator | undefined;
export function parseLocatorOptions(
  opts: LocatorOpts,
  required: boolean,
): BrowserSessionLocator | undefined {
  const forms = [opts.selector, opts.role, opts.label, opts.text].filter(
    (value): value is string => value !== undefined,
  );
  if (forms.length === 0) {
    if (!required) {
      if (opts.name !== undefined || opts.partial) {
        throw new BrowserSessionError(
          "invalid_locator",
          "--name and --partial require a locator form.",
        );
      }
      return undefined;
    }
    throw new BrowserSessionError(
      "invalid_locator",
      "Choose exactly one locator: --selector, --role, --label, or --text.",
    );
  }
  if (forms.length !== 1) {
    throw new BrowserSessionError(
      "invalid_locator",
      "Choose exactly one locator: --selector, --role, --label, or --text.",
    );
  }
  if (opts.name !== undefined && opts.role === undefined) {
    throw new BrowserSessionError("invalid_locator", "--name is valid only with --role.");
  }
  if (opts.selector !== undefined) {
    if (opts.partial) {
      throw new BrowserSessionError("invalid_locator", "--partial is not valid with --selector.");
    }
    return { kind: "selector", value: opts.selector, partial: false };
  }
  if (opts.role !== undefined) {
    return {
      kind: "role",
      value: opts.role,
      ...(opts.name === undefined ? {} : { name: opts.name }),
      partial: Boolean(opts.partial),
    };
  }
  if (opts.label !== undefined) {
    return { kind: "label", value: opts.label, partial: Boolean(opts.partial) };
  }
  return { kind: "text", value: opts.text!, partial: Boolean(opts.partial) };
}

export async function readFillValue(input: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of input) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += bytes.length;
    if (size > BROWSER_SESSION_MAX_FILL_BYTES) {
      throw new BrowserSessionError("fill_too_large", "Fill input exceeds the 64 KiB limit.");
    }
    chunks.push(bytes);
  }
  const value = Buffer.concat(chunks)
    .toString("utf8")
    .replace(/\r?\n$/, "");
  if (value.length === 0) {
    throw new BrowserSessionError("fill_empty", "Fill input from standard input was empty.");
  }
  return value;
}

async function runAction(
  emit: EmitContext,
  controlFile: string,
  action: Parameters<typeof sendBrowserSessionRequest>[1],
  args: Record<string, unknown>,
): Promise<void> {
  try {
    emit.data(await sendBrowserSessionRequest(controlFile, action, args));
  } catch (error) {
    if (error instanceof BrowserSessionError) {
      emit.error({ code: error.code, message: error.message });
      emit.setExitCode(1);
      return;
    }
    emit.error({ code: "browser_session_failed", message: "Browser session command failed." });
    emit.setExitCode(1);
  }
}

function parseIndex(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new BrowserSessionError("invalid_index", "Tab index must be a non-negative integer.");
  }
  return parsed;
}

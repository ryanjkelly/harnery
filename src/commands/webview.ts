import { resolve } from "node:path";
import type { Command } from "commander";
import type { EmitContext } from "../commander.ts";
import { commandPaceGate } from "../lib/pace/index.ts";
import {
  parseWebViewTypeStep,
  parseWebViewViewport,
  runWebView,
  type WebViewBackend,
  WebViewUnavailableError,
} from "../lib/webview/index.ts";

/**
 * `harn webview`: a lightweight headless page probe through Bun.WebView.
 *
 * Experimental and Bun-only (Bun 1.4+). It always launches a fresh browser with
 * ephemeral storage unless `--profile` is given, and never attaches to a
 * running user browser. Use `browse` for headed login, the shared cookie jar,
 * HAR capture, full-page screenshots, and page QA; use `browse-ai` for
 * accessibility-tree element references. On Node the command fails with a
 * clear message, matching how `tunnel` handles its Bun-only worker.
 */

interface WebviewOpts {
  backend: string;
  viewport: string;
  profile?: string;
  chromePath?: string;
  browserArg: string[];
  timeout: string;
  waitFor?: string;
  type: string[];
  click: string[];
  press: string[];
  evaluate?: string;
  settle: string;
  screenshot?: string;
  html?: boolean;
  json?: boolean;
  pace?: boolean;
}

export function registerWebviewCommand(program: Command, emit: EmitContext, binName: string): void {
  program
    .command("webview <url>")
    .description(
      "Lightweight headless page probe through Bun.WebView (experimental, Bun 1.4+). " +
        `Fresh ephemeral browser per call; use ${binName} browse for login, cookies, HAR, and QA.`,
    )
    .option("--backend <engine>", "Browser engine: auto | chrome | webkit", "auto")
    .option("--viewport <WxH>", "Viewport in CSS pixels", "1280x800")
    .option(
      "--profile <dir>",
      "Persist cookies and local storage in this directory (default is ephemeral)",
    )
    .option("--chrome-path <path>", "Chrome-family executable; implies the Chrome backend")
    .option("--browser-arg <flag>", "Extra Chrome launch flag (repeatable)", collect, [])
    .option("--timeout <ms>", "Navigation and selector timeout in milliseconds", "30000")
    .option("--wait-for <css>", "Wait for a CSS selector after navigation")
    .option(
      "--type <css=>text>",
      "Focus a selector and insert text (repeatable; runs before clicks)",
      collect,
      [],
    )
    .option("--click <css>", "Scroll to and click a CSS selector (repeatable)", collect, [])
    .option(
      "--press <key>",
      "Press a key in the currently focused element (repeatable)",
      collect,
      [],
    )
    .option("--evaluate <expression>", "Evaluate a JavaScript expression after actions")
    .option("--settle <ms>", "Extra delay after actions before capture", "0")
    .option(
      "--screenshot <path>",
      "Save a viewport PNG (Bun.WebView does not provide full-page capture)",
    )
    .option("--html", "Print the final document HTML instead of body text")
    .option("--json", "Print the full result envelope")
    .option(
      "--no-pace",
      "Skip the human-pace gap (3 to 9 s) between page loads of the same site for this run. " +
        "HARNERY_PACE=off disables it machine-wide; local and private hosts never wait.",
    )
    .action(async (url: string, opts: WebviewOpts) => {
      try {
        await runWebview(url, opts, emit);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        emit.error({
          code: err instanceof WebViewUnavailableError ? err.code : "webview_error",
          message,
        });
        process.exit(1);
      }
    });
}

async function runWebview(url: string, opts: WebviewOpts, emit: EmitContext): Promise<void> {
  if (!isBackend(opts.backend)) {
    throw new Error(`Invalid backend "${opts.backend}". Expected auto, chrome, or webkit.`);
  }
  const backend = opts.backend === "auto" && opts.chromePath ? "chrome" : opts.backend;
  const result = await runWebView(url, {
    backend,
    viewport: parseWebViewViewport(opts.viewport),
    profileDir: opts.profile ? resolve(opts.profile) : undefined,
    chromePath: opts.chromePath ? resolve(opts.chromePath) : undefined,
    browserArgs: opts.browserArg,
    timeoutMs: parseNonNegativeInteger(opts.timeout, "--timeout", false),
    waitFor: opts.waitFor,
    typeSteps: opts.type.map(parseWebViewTypeStep),
    clicks: opts.click,
    presses: opts.press,
    evaluate: opts.evaluate,
    settleMs: parseNonNegativeInteger(opts.settle, "--settle", true),
    screenshotPath: opts.screenshot ? resolve(opts.screenshot) : undefined,
    captureHtml: opts.html === true,
    pace: commandPaceGate(opts.pace !== false, (message) => emit.log(message, "info")),
  });

  if (opts.json) {
    emit.data(result);
  } else if (opts.html) {
    emit.text(result.html?.endsWith("\n") ? result.html : `${result.html ?? ""}\n`);
  } else if (opts.evaluate !== undefined) {
    const value =
      typeof result.evaluation === "string"
        ? result.evaluation
        : JSON.stringify(result.evaluation, null, 2);
    emit.text(`${value ?? "undefined"}\n`);
  } else {
    emit.text(result.text.endsWith("\n") ? result.text : `${result.text}\n`);
  }
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function isBackend(value: string): value is WebViewBackend {
  return value === "auto" || value === "chrome" || value === "webkit";
}

function parseNonNegativeInteger(value: string, flag: string, allowZero: boolean): number {
  if (!/^\d+$/.test(value)) throw new Error(`${flag} expects an integer, got "${value}".`);
  const parsed = Number.parseInt(value, 10);
  if ((!allowZero && parsed < 1) || (allowZero && parsed < 0)) {
    throw new Error(`${flag} must be ${allowZero ? "zero or greater" : "greater than zero"}.`);
  }
  return parsed;
}

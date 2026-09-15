/**
 * Bun.WebView probe: a lightweight headless page load through Bun's built-in
 * browser API (Bun 1.4+). Uses the system WKWebView on macOS and a fresh
 * headless Chrome-family process elsewhere. Always starts a fresh browser and
 * ephemeral storage unless a profile directory is given, and never attaches to
 * a user's running browser.
 *
 * This is a narrow probe, not a `browse` backend: no headed login, HAR, cookie
 * jar sync, full-page capture, or page QA. Bun-only; `detectRuntime` fails
 * with a clear message on Node.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { installedChromePath } from "../browser/launch-args.ts";
import { chromeMajorFromExecutable, resolveUserAgent } from "../browser/user-agent.ts";
import { PaceGate, pacePolicyFromEnv } from "../pace/index.ts";

export type WebViewBackend = "auto" | "chrome" | "webkit";

type WebViewConsoleHandler = (type: string, ...args: unknown[]) => void;

interface WebViewBackendOptions {
  type: "chrome";
  url: false;
  path?: string;
  argv?: string[];
}

interface WebViewConstructorOptions {
  width: number;
  height: number;
  backend?: "webkit" | WebViewBackendOptions;
  console?: WebViewConsoleHandler;
  dataStore?: "ephemeral" | { directory: string };
}

interface WebViewLike {
  readonly url: string;
  readonly title: string;
  readonly loading: boolean;
  onNavigated: ((url: string, title: string) => void) | null;
  onNavigationFailed: ((error: Error) => void) | null;
  navigate(url: string): Promise<void>;
  evaluate(script: string): Promise<unknown>;
  screenshot(options: {
    format: "png";
    encoding: "buffer";
  }): Promise<Blob | Buffer | string | { name: string; size: number }>;
  click(selector: string, options?: { timeout?: number }): Promise<void>;
  type(text: string): Promise<void>;
  press(key: string): Promise<void>;
  scrollTo(
    selector: string,
    options?: {
      block?: "start" | "center" | "end" | "nearest";
      timeout?: number;
    },
  ): Promise<void>;
  close(): void;
}

export interface BunWebViewRuntime {
  version?: string;
  WebView: new (options: WebViewConstructorOptions) => WebViewLike;
}

export interface WebViewTypeStep {
  selector: string;
  text: string;
}

export interface RunWebViewOptions {
  /** Explicit UA, "auto", or "native"; Chrome uses the shared store by default. */
  userAgent?: string;
  backend?: WebViewBackend;
  viewport?: { width: number; height: number };
  profileDir?: string;
  chromePath?: string;
  browserArgs?: string[];
  timeoutMs?: number;
  waitFor?: string;
  typeSteps?: WebViewTypeStep[];
  clicks?: string[];
  presses?: string[];
  evaluate?: string;
  settleMs?: number;
  screenshotPath?: string;
  captureHtml?: boolean;
  platform?: NodeJS.Platform;
  runtime?: BunWebViewRuntime;
  /**
   * Human-pace gate applied before the load. Unset resolves the default from
   * the `HARNERY_PACE*` environment; `null` disables pacing for this run.
   */
  pace?: PaceGate | null;
}

export interface WebViewConsoleEvent {
  type: string;
  args: unknown[];
}

export interface WebViewResult {
  backend: "chrome" | "webkit";
  runtimeVersion: string | null;
  url: string;
  title: string;
  text: string;
  html?: string;
  evaluation?: unknown;
  screenshotPath?: string;
  consoleEvents: WebViewConsoleEvent[];
  elapsedMs: number;
}

export class WebViewUnavailableError extends Error {
  readonly code = "webview_unavailable";

  constructor(message: string) {
    super(message);
    this.name = "WebViewUnavailableError";
  }
}

export function parseWebViewViewport(value: string): {
  width: number;
  height: number;
} {
  const match = /^(\d+)x(\d+)$/.exec(value.trim());
  if (!match) {
    throw new Error(`Invalid viewport "${value}". Expected WxH, for example 1280x800.`);
  }
  const width = Number.parseInt(match[1], 10);
  const height = Number.parseInt(match[2], 10);
  if (width < 1 || width > 16_384 || height < 1 || height > 16_384) {
    throw new Error(`Invalid viewport "${value}". Width and height must be between 1 and 16384.`);
  }
  return { width, height };
}

export function parseWebViewTypeStep(value: string): WebViewTypeStep {
  const separator = value.indexOf("=>");
  const selector = value.slice(0, separator).trim();
  if (separator <= 0 || selector.length === 0) {
    throw new Error(`Invalid type step "${value}". Expected <selector>=><text>.`);
  }
  return {
    selector,
    text: value.slice(separator + 2),
  };
}

export function buildWebViewBackend(
  backend: WebViewBackend,
  options: {
    platform: NodeJS.Platform;
    chromePath?: string;
    browserArgs?: string[];
  },
): {
  backend?: "webkit" | WebViewBackendOptions;
  resolved: "chrome" | "webkit";
} {
  if (backend === "webkit") {
    if (options.platform !== "darwin") {
      throw new Error("The Bun.WebView WebKit backend is only available on macOS.");
    }
    if (options.chromePath || options.browserArgs?.length) {
      throw new Error("--chrome-path and --browser-arg require --backend chrome.");
    }
    return { backend: "webkit", resolved: "webkit" };
  }

  if (backend === "auto" && options.platform === "darwin") {
    if (options.chromePath || options.browserArgs?.length) {
      throw new Error("--chrome-path and --browser-arg require --backend chrome on macOS.");
    }
    return { resolved: "webkit" };
  }

  return {
    backend: {
      type: "chrome",
      // Bun otherwise auto-connects to a Chrome profile with remote debugging
      // enabled. A CLI read must never open an unexpected tab in a user's
      // existing browser, so this command always spawns a fresh headless process.
      url: false,
      ...(options.chromePath ? { path: options.chromePath } : {}),
      ...(options.browserArgs?.length ? { argv: options.browserArgs } : {}),
    },
    resolved: "chrome",
  };
}

export async function runWebView(
  url: string,
  options: RunWebViewOptions = {},
): Promise<WebViewResult> {
  const runtime = options.runtime ?? detectRuntime();
  const platform = options.platform ?? process.platform;
  const backendChoice = options.backend ?? "auto";
  const selected = buildWebViewBackend(backendChoice, {
    platform,
    chromePath: options.chromePath,
    browserArgs: options.browserArgs,
  });
  if (typeof selected.backend === "object") {
    const executable = options.chromePath ?? installedChromePath(platform);
    const existingUa = options.browserArgs
      ?.find((arg) => arg.startsWith("--user-agent="))
      ?.slice(13);
    const userAgent = resolveUserAgent({
      requested: options.userAgent ?? existingUa,
      env: process.env.HARNERY_BROWSER_UA,
      chromeMajor: executable ? chromeMajorFromExecutable(executable) : undefined,
      platform,
    });
    const argv = [
      ...(selected.backend.argv ?? []).filter((arg) => !arg.startsWith("--user-agent=")),
      ...(userAgent ? [`--user-agent=${userAgent}`] : []),
    ];
    if (argv.length) selected.backend.argv = argv;
    else delete selected.backend.argv;
  }
  const viewport = options.viewport ?? { width: 1280, height: 800 };
  const timeoutMs = options.timeoutMs ?? 30_000;
  const consoleEvents: WebViewConsoleEvent[] = [];
  const startedAt = performance.now();

  const gate = options.pace === undefined ? new PaceGate(pacePolicyFromEnv()) : options.pace;
  await gate?.before(url);

  const view = new runtime.WebView({
    width: viewport.width,
    height: viewport.height,
    ...(selected.backend ? { backend: selected.backend } : {}),
    dataStore: options.profileDir ? { directory: options.profileDir } : "ephemeral",
    console: (type, ...args) => consoleEvents.push({ type, args }),
  });

  try {
    await withTimeout(view.navigate(url), timeoutMs, `Navigation timed out after ${timeoutMs}ms.`);

    if (options.waitFor) {
      await waitForSelector(view, options.waitFor, timeoutMs);
    }

    for (const step of options.typeSteps ?? []) {
      await view.scrollTo(step.selector, {
        block: "nearest",
        timeout: timeoutMs,
      });
      await view.click(step.selector, { timeout: timeoutMs });
      await view.type(step.text);
    }

    for (const selector of options.clicks ?? []) {
      // Unlike Playwright, Bun.WebView requires selector targets to already be
      // inside the viewport. Scroll first so below-the-fold targets do not sit
      // until the 30-second actionability timeout.
      await view.scrollTo(selector, { block: "nearest", timeout: timeoutMs });
      await runActionAndWaitForNavigation(
        view,
        () => view.click(selector, { timeout: timeoutMs }),
        timeoutMs,
      );
    }

    for (const key of options.presses ?? []) {
      await runActionAndWaitForNavigation(view, () => view.press(key), timeoutMs);
    }

    const settleMs = options.settleMs ?? 0;
    if (settleMs > 0) {
      await sleep(settleMs);
    }

    const evaluation = options.evaluate ? await view.evaluate(options.evaluate) : undefined;
    const text = String(await view.evaluate("document.body?.innerText ?? ''"));
    const html = options.captureHtml
      ? String(await view.evaluate("document.documentElement?.outerHTML ?? ''"))
      : undefined;

    if (options.screenshotPath) {
      const screenshot = await view.screenshot({
        format: "png",
        encoding: "buffer",
      });
      const bytes = await screenshotBytes(screenshot);
      await mkdir(dirname(options.screenshotPath), { recursive: true });
      await writeFile(options.screenshotPath, bytes);
    }

    return {
      backend: selected.resolved,
      runtimeVersion: runtime.version ?? null,
      url: view.url,
      title: view.title,
      text,
      ...(html === undefined ? {} : { html }),
      ...(options.evaluate === undefined ? {} : { evaluation }),
      ...(options.screenshotPath ? { screenshotPath: options.screenshotPath } : {}),
      consoleEvents,
      elapsedMs: Math.round((performance.now() - startedAt) * 10) / 10,
    };
  } finally {
    view.close();
  }
}

function detectRuntime(): BunWebViewRuntime {
  const runtime = (globalThis as typeof globalThis & { Bun?: Partial<BunWebViewRuntime> }).Bun;
  if (!runtime || typeof runtime.WebView !== "function") {
    throw new WebViewUnavailableError(
      "Bun.WebView requires Bun 1.4 or newer. Every other command runs on Node; use the Playwright browse command for that path.",
    );
  }
  return runtime as BunWebViewRuntime;
}

async function waitForSelector(
  view: WebViewLike,
  selector: string,
  timeoutMs: number,
): Promise<void> {
  const selectorJson = JSON.stringify(selector);
  const timeoutJson = JSON.stringify(timeoutMs);
  await withTimeout(
    view.evaluate(`new Promise((resolve, reject) => {
      const selector = ${selectorJson};
      const deadline = performance.now() + ${timeoutJson};
      const poll = () => {
        if (document.querySelector(selector)) return resolve(true);
        if (performance.now() >= deadline) return reject(new Error("timeout waiting for " + selector));
        requestAnimationFrame(poll);
      };
      poll();
    })`),
    timeoutMs + 250,
    `Timed out waiting for selector ${selector}.`,
  );
}

async function runActionAndWaitForNavigation(
  view: WebViewLike,
  action: () => Promise<void>,
  timeoutMs: number,
): Promise<void> {
  const beforeDocument = await readDocumentState(view);
  const previousNavigated = view.onNavigated;
  const previousFailed = view.onNavigationFailed;
  let navigated = false;
  let navigationError: Error | null = null;

  view.onNavigated = (url, title) => {
    previousNavigated?.(url, title);
    navigated = true;
  };
  view.onNavigationFailed = (error) => {
    previousFailed?.(error);
    navigationError = error;
  };

  try {
    await action();
    // Input completion does not include a navigation triggered by that input.
    // Observe briefly for a URL/loading/callback change. Bun's Chrome backend
    // can report onNavigated before the replacement DOM is ready, so the
    // callback is a detection signal rather than the settle barrier itself.
    await sleep(50);
    const observed = await readDocumentState(view).catch(() => null);
    if (!navigated && !view.loading && observed !== null && observed.href === beforeDocument.href) {
      return;
    }

    await withTimeout(
      (async () => {
        let priorSignature = "";
        let stableSince = performance.now();
        while (true) {
          if (navigationError) throw navigationError;
          const state = await readDocumentState(view).catch(() => null);
          if (!state || view.loading) {
            priorSignature = "";
            stableSince = performance.now();
            await sleep(10);
            continue;
          }
          const signature = JSON.stringify(state);
          if (signature !== priorSignature) {
            priorSignature = signature;
            stableSince = performance.now();
          }
          const changedDocument = navigated || state.href !== beforeDocument.href;
          const hasMaterialDocument =
            state.bodyHtmlLength > 0 || state.title !== beforeDocument.title;
          const quietFor = performance.now() - stableSince;
          if (
            changedDocument &&
            state.readyState === "complete" &&
            quietFor >= (hasMaterialDocument ? 150 : 750)
          ) {
            return;
          }
          await sleep(10);
        }
      })(),
      timeoutMs,
      `Navigation triggered by an action timed out after ${timeoutMs}ms.`,
    );
  } finally {
    view.onNavigated = previousNavigated;
    view.onNavigationFailed = previousFailed;
  }
}

interface DocumentState {
  href: string;
  title: string;
  readyState: string;
  bodyHtmlLength: number;
}

async function readDocumentState(view: WebViewLike): Promise<DocumentState> {
  return (await view.evaluate(`({
    href: location.href,
    title: document.title,
    readyState: document.readyState,
    bodyHtmlLength: document.body?.innerHTML.length ?? -1
  })`)) as DocumentState;
}

async function screenshotBytes(
  value: Blob | Buffer | string | { name: string; size: number },
): Promise<Buffer> {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Blob) return Buffer.from(await value.arrayBuffer());
  throw new Error("Bun.WebView returned an unexpected screenshot encoding.");
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

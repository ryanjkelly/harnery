import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  type BrowserContext,
  type ConsoleMessage,
  chromium,
  type Page,
  type Cookie as PWCookie,
  type Request,
} from "playwright";
import type { CookieJar, Cookie as JarCookie } from "../cookies/index.ts";
import {
  buildClearLayoutAnnotationsScript,
  buildLayoutAnnotateScript,
  buildOverflowCheck,
  buildWidthCheck,
  type OverflowResult,
  type WidthResult,
} from "./layout.js";
import {
  buildClearRuntsAnnotationsScript,
  buildRuntsAnnotateScript,
  buildRuntsCheck,
  type RuntsResult,
} from "./runts.js";
import {
  buildAnnotateScript,
  buildClearAnnotationsScript,
  buildVisibilityCheck,
  type CheckVisibilityOptions,
  type VisibilityResult,
} from "./visibility.js";

/**
 * Headless-Chromium wrapper for the `browse` command.
 *
 * Two persistence layers:
 *   1. Persistent profile (Playwright's `launchPersistentContext`) keeps
 *      browser state (localStorage, IndexedDB, login session) across runs.
 *   2. Optional cookie jar, shared with `fetch`/`cookies` so a session
 *      built up in one tool is visible to the others.
 *
 * Designed to be opened, used for one or more navigations, and closed.
 * It is not a long-lived service. For multi-step workflows, the caller drives
 * `navigate`/`click`/`fill` directly between `open()` and `close()`.
 */

export interface BrowserOptions {
  /** Persistent profile dir. Default `~/.cache/harnery/browser-profile/`. Created if missing. */
  profileDir?: string;
  /** Launch headed (visible window). Default false. */
  headed?: boolean;
  /** Cookie jar to seed/sync with. Pass `null` to skip jar entirely. */
  jar?: CookieJar | null;
  /** Viewport. Default 1280x800. */
  viewport?: { width: number; height: number };
  /** Default navigation timeout in ms. Default 30000. */
  navigationTimeout?: number;
  /**
   * `wait_until` strategy for `navigate`. Default `"load"`.
   * Use `"domcontentloaded"` for sites with long-running analytics scripts
   * that never let `"load"` fire.
   */
  waitUntil?: "load" | "domcontentloaded" | "networkidle" | "commit";
  /**
   * If set, record network traffic to a HAR file at this absolute path.
   * The HAR is finalized when `close()` is called.
   */
  recordHarPath?: string;
  /**
   * Optional callback returning extra headers to attach to every request,
   * keyed by request URL. Consumers can inject extra HTTP headers per-URL
   * via this callback (e.g., a Cloudflare-bypass header for specific zones).
   */
  extraHeaders?: (url: string) => Record<string, string>;
  /**
   * Extra Chromium command-line flags, passed through to Playwright's
   * `launchPersistentContext` `args`. Used for environment-specific
   * workarounds — most notably `--disable-gpu` for headed windows under
   * WSLg (see `./launch-args.ts`). Empty/undefined means Playwright's
   * defaults only.
   */
  launchArgs?: string[];
}

export interface NavigateResult {
  url: string;
  title: string;
  status: number | null;
}

export interface ConsoleEvent {
  type: string; // 'log' | 'error' | 'warning' | ...
  text: string;
  location?: { url: string; lineNumber?: number; columnNumber?: number };
}

export interface PageErrorEvent {
  message: string;
  stack?: string;
}

export interface FailedRequest {
  url: string;
  method: string;
  failure: string;
  resourceType: string;
  /** HTTP status for kind "http" entries; null for network-level failures. */
  status: number | null;
  /** "http" = request completed with a >=400 response; "network" = never completed (DNS, TLS, aborts, tunnel). */
  kind: "http" | "network";
  /** True when the entry is the main frame's document response — lets consumers
   *  distinguish an expected error-page status (a 404 route under test) from a
   *  broken subresource. */
  document?: boolean;
}

export interface Diagnostics {
  consoleEvents: ConsoleEvent[];
  consoleErrors: ConsoleEvent[];
  pageErrors: PageErrorEvent[];
  failedRequests: FailedRequest[];
  viewport: { width: number; height: number } | null;
}

const DEFAULT_PROFILE = resolve(homedir(), ".cache", "harnery", "browser-profile");

export class Browser {
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  readonly profileDir: string;
  private consoleEvents: ConsoleEvent[] = [];
  private pageErrors: PageErrorEvent[] = [];
  private failedRequests: FailedRequest[] = [];

  constructor(private opts: BrowserOptions = {}) {
    this.profileDir = opts.profileDir ?? DEFAULT_PROFILE;
  }

  /** Lazy: caller-side helper to find the active page if mid-flow. */
  get currentPage(): Page {
    if (!this.page) {
      throw new Error("Browser not opened. Call open() first.");
    }
    return this.page;
  }

  async open(): Promise<void> {
    if (this.context) return;
    mkdirSync(this.profileDir, { recursive: true });

    this.context = await chromium.launchPersistentContext(this.profileDir, {
      headless: !this.opts.headed,
      viewport: this.opts.viewport ?? { width: 1280, height: 800 },
      ...(this.opts.launchArgs && this.opts.launchArgs.length > 0
        ? { args: this.opts.launchArgs }
        : {}),
      ...(this.opts.recordHarPath
        ? { recordHar: { path: this.opts.recordHarPath, mode: "full" as const } }
        : {}),
    });
    this.context.setDefaultNavigationTimeout(this.opts.navigationTimeout ?? 30_000);

    if (this.opts.jar) {
      const jarCookies = this.opts.jar.list();
      if (jarCookies.length > 0) {
        await this.context.addCookies(jarCookies.map(toPWCookie));
      }
    }

    // Caller-injected extraHeaders callback (e.g., for Cloudflare-bypass
    // or custom auth headers). Per-request route handler so headers only
    // attach when the callback returns non-empty.
    const headersCb = this.opts.extraHeaders;
    if (headersCb) {
      await this.context.route("**/*", async (route, request) => {
        const extra = headersCb(request.url());
        if (Object.keys(extra).length === 0) return route.continue();
        const headers = { ...request.headers(), ...extra };
        return route.continue({ headers });
      });
    }

    const pages = this.context.pages();
    this.page = pages[0] ?? (await this.context.newPage());
    this.attachDiagnosticListeners(this.page);
  }

  /**
   * Hook console + pageerror + requestfailed events. Called on `open()`
   * before any navigation so we don't miss early-fired events.
   */
  private attachDiagnosticListeners(page: Page): void {
    page.on("console", (msg: ConsoleMessage) => {
      const loc = msg.location();
      this.consoleEvents.push({
        type: msg.type(),
        text: msg.text(),
        location: loc.url
          ? { url: loc.url, lineNumber: loc.lineNumber, columnNumber: loc.columnNumber }
          : undefined,
      });
    });
    page.on("pageerror", (err: Error) => {
      this.pageErrors.push({ message: err.message, stack: err.stack });
    });
    page.on("requestfailed", (req: Request) => {
      this.failedRequests.push({
        url: req.url(),
        method: req.method(),
        failure: req.failure()?.errorText ?? "unknown",
        resourceType: req.resourceType(),
        status: null,
        kind: "network",
      });
    });
    // HTTP-level failures: `requestfailed` only fires for requests that never
    // complete (DNS, TLS, aborts), so a script/stylesheet answered with a
    // 4xx/5xx would otherwise be invisible to failedRequests-based gates.
    page.on("response", (res) => {
      if (res.status() < 400) return;
      const req = res.request();
      this.failedRequests.push({
        url: res.url(),
        method: req.method(),
        failure: `HTTP ${res.status()}`,
        resourceType: req.resourceType(),
        status: res.status(),
        kind: "http",
        document: req.resourceType() === "document" && res.frame() === page.mainFrame(),
      });
    });
  }

  /**
   * Snapshot of every event captured since `open()`. Returned objects are
   * copies, so callers can safely store them after `close()`.
   */
  diagnostics(): Diagnostics {
    return {
      consoleEvents: [...this.consoleEvents],
      consoleErrors: this.consoleEvents.filter((e) => e.type === "error"),
      pageErrors: [...this.pageErrors],
      failedRequests: [...this.failedRequests],
      viewport: this.page?.viewportSize() ?? null,
    };
  }

  async navigate(url: string): Promise<NavigateResult> {
    const page = this.currentPage;
    const response = await page.goto(url, { waitUntil: this.opts.waitUntil ?? "load" });
    return {
      url: page.url(),
      title: await page.title(),
      status: response?.status() ?? null,
    };
  }

  /**
   * Reload the current page. Preserves cookies + sessionStorage so callers can
   * reproduce sessionStorage-restored UI state (e.g. drawers/modals that open
   * automatically on reload, where Dialog auto-focus + Tooltip-on-focus may
   * interact differently than the click-to-open path).
   */
  async reload(): Promise<NavigateResult> {
    const page = this.currentPage;
    const response = await page.reload({ waitUntil: this.opts.waitUntil ?? "load" });
    return {
      url: page.url(),
      title: await page.title(),
      status: response?.status() ?? null,
    };
  }

  /** Full-page PNG screenshot. Returns the byte count written. */
  async screenshot(path: string, opts: { fullPage?: boolean } = {}): Promise<number> {
    const page = this.currentPage;
    const buf = await page.screenshot({ path, fullPage: opts.fullPage ?? true, type: "png" });
    return buf.length;
  }

  /**
   * Plain-text snapshot of the document body. Suitable as a coarse "what's
   * on screen" signal for LLM iteration loops. For richer extraction, use
   * `htmlContent()` and pipe through a readability filter.
   */
  async textSnapshot(selector?: string): Promise<string> {
    const page = this.currentPage;
    if (selector) {
      const el = await page.$(selector);
      if (!el) throw new Error(`Selector matched nothing: ${selector}`);
      return await el.evaluate((node) => (node as HTMLElement).innerText ?? "");
    }
    return await page.evaluate(() => document.body?.innerText ?? "");
  }

  /** Raw outer HTML of the page (or a selector if provided). */
  async htmlContent(selector?: string): Promise<string> {
    const page = this.currentPage;
    if (selector) {
      const el = await page.$(selector);
      if (!el) throw new Error(`Selector matched nothing: ${selector}`);
      return await el.evaluate((node) => (node as Element).outerHTML);
    }
    return await page.content();
  }

  async click(selector: string): Promise<void> {
    await this.currentPage.click(selector);
  }

  async fill(selector: string, value: string): Promise<void> {
    await this.currentPage.fill(selector, value);
  }

  async press(key: string): Promise<void> {
    await this.currentPage.keyboard.press(key);
  }

  async waitForSelector(selector: string, timeout?: number): Promise<void> {
    await this.currentPage.waitForSelector(selector, timeout ? { timeout } : undefined);
  }

  /** Evaluate JS in the page context. Caller is responsible for safety. */
  async evaluate<T = unknown>(script: string): Promise<T> {
    return await this.currentPage.evaluate(script);
  }

  /**
   * Read the system clipboard via the page context. Grants `clipboard-read`
   * to the page's origin first because Chromium gates `navigator.clipboard
   * .readText()` behind a user-gesture + permission check; in headless
   * Playwright there is no user gesture, so the permission grant is the
   * substitute. Returns an empty string if the read returns nullish or
   * throws (insecure context, focus race). Used by `browse --batch
   * clipboard ...` to verify a UI Copy action end-to-end.
   */
  async readClipboard(): Promise<string> {
    if (!this.context) throw new Error("Browser not opened. Call open() first.");
    const url = this.currentPage.url();
    try {
      const origin = new URL(url).origin;
      await this.context.grantPermissions(["clipboard-read"], { origin });
    } catch {
      /* about:blank / data: URL, skip permission; evaluate may still work */
    }
    return await this.currentPage.evaluate(async () => {
      try {
        const text = await navigator.clipboard.readText();
        return typeof text === "string" ? text : "";
      } catch {
        return "";
      }
    });
  }

  /**
   * Run occlusion checks on one or more selectors. For each, samples a grid
   * of points inside the element's bounding rect and uses
   * `document.elementFromPoint` to detect whether the target is the topmost
   * paintable element at each sample. Catches the class of UI bugs where
   * an element's rect IS in-viewport but a higher-z-index sibling is
   * painting over it.
   */
  async checkVisibility(
    selectors: string[],
    opts: CheckVisibilityOptions = {},
  ): Promise<VisibilityResult[]> {
    return await this.currentPage.evaluate(buildVisibilityCheck(), {
      selectors,
      sampleGrid: opts.sampleGrid ?? 3,
    });
  }

  /** Inject annotation overlays for visibility results. Used before screenshot. */
  async annotateVisibility(results: VisibilityResult[]): Promise<void> {
    await this.currentPage.evaluate(buildAnnotateScript(), { results });
  }

  /** Remove visibility annotation overlays. */
  async clearVisibilityAnnotations(): Promise<void> {
    await this.currentPage.evaluate(buildClearAnnotationsScript());
  }

  /**
   * Measure each selector's bounding rect + viewport-fill + parent-fill
   * ratios. Catches the class of mobile-layout bug where a table sits at
   * (say) 85% viewport fill because of stacked padding: every per-element
   * check passes, but the user sees too-narrow content.
   */
  async checkWidth(selectors: string[]): Promise<WidthResult[]> {
    return await this.currentPage.evaluate(buildWidthCheck(), { selectors });
  }

  /**
   * Detect horizontal overflow at the document level. Returns viewport size,
   * `document.scrollWidth`, and the top N elements protruding past the
   * viewport's right edge. Catches the class of bug where a nav/table is
   * wider than the viewport, forcing horizontal scroll on mobile.
   */
  async checkOverflow(opts: { sampleLimit?: number } = {}): Promise<OverflowResult> {
    return await this.currentPage.evaluate(buildOverflowCheck(), {
      sampleLimit: opts.sampleLimit ?? 5,
    });
  }

  /**
   * Scan text blocks for runts — a single word alone on a block's last
   * visual line. Word-count per line via per-word Range rects (the width
   * of the last line is deliberately NOT the signal; see runts.ts).
   */
  async checkRunts(opts: { scope?: string | null; minChars?: number } = {}): Promise<RuntsResult> {
    return await this.currentPage.evaluate(buildRuntsCheck(), {
      scope: opts.scope ?? null,
      minChars: opts.minChars ?? 40,
    });
  }

  /** Inject annotation overlays for runt hits. Used before screenshot. */
  async annotateRunts(result: RuntsResult): Promise<void> {
    await this.currentPage.evaluate(buildRuntsAnnotateScript(), { runts: result.runts });
  }

  /** Remove runt annotation overlays. */
  async clearRuntsAnnotations(): Promise<void> {
    await this.currentPage.evaluate(buildClearRuntsAnnotationsScript());
  }

  /** Inject annotation overlays for width + overflow results. Used before screenshot. */
  async annotateLayout(args: {
    widths: WidthResult[];
    overflow: OverflowResult | null;
    widthThreshold: number;
  }): Promise<void> {
    await this.currentPage.evaluate(buildLayoutAnnotateScript(), args);
  }

  /** Remove layout annotation overlays. */
  async clearLayoutAnnotations(): Promise<void> {
    await this.currentPage.evaluate(buildClearLayoutAnnotationsScript());
  }

  /**
   * Inject a script that runs in every page context before page scripts
   * execute. Useful for seeding localStorage before an SSR/CSR comparison;
   * without this, state-dependent hydration mismatches are invisible to a
   * clean-profile probe. Must be called after `open()` and before
   * `navigate()`.
   */
  async addInitScript(script: string): Promise<void> {
    if (!this.context) throw new Error("Browser not opened. Call open() first.");
    await this.context.addInitScript(script);
  }

  /**
   * Sync cookies from the live context back into the jar (if one was provided),
   * then tear everything down. Safe to call multiple times.
   */
  async close(): Promise<void> {
    if (!this.context) return;
    if (this.opts.jar) {
      try {
        const live = await this.context.cookies();
        for (const c of live) {
          this.opts.jar.set(toJarCookie(c));
        }
      } catch {
        // Cookie persist is best-effort; never block close on it.
      }
    }
    await this.context.close().catch(() => {});
    this.context = null;
    this.page = null;
  }
}

// ---------------------------------------------------------------------------
// Cookie shape conversion
// ---------------------------------------------------------------------------

function toPWCookie(c: JarCookie): PWCookie {
  // Playwright's PWCookie type requires sameSite to be a literal; undefined
  // is not allowed. Default to "Lax" (matches Chromium's modern default).
  return {
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    expires: c.expires,
    httpOnly: c.httpOnly,
    secure: c.secure,
    sameSite: normalizeSameSite(c.sameSite) ?? "Lax",
  };
}

function toJarCookie(c: PWCookie): JarCookie {
  return {
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    expires: c.expires,
    httpOnly: c.httpOnly,
    secure: c.secure,
    sameSite: c.sameSite ?? undefined,
    session: c.expires <= 0,
    size: c.name.length + c.value.length,
  };
}

function normalizeSameSite(s: string | undefined): "Strict" | "Lax" | "None" | undefined {
  if (!s) return undefined;
  const lower = s.toLowerCase();
  if (lower === "strict") return "Strict";
  if (lower === "lax") return "Lax";
  if (lower === "none") return "None";
  return undefined;
}

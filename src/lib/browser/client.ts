import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import axe from "axe-core";
import {
  type BrowserContext,
  type ConsoleMessage,
  chromium,
  type Page,
  type Cookie as PWCookie,
  type Request,
} from "playwright";
import type { CookieJar, Cookie as JarCookie } from "../cookies/index.ts";
import { type AssertResult, type AssertSpec, buildAssertCheck } from "./asserts.js";
import {
  buildClearContentAnnotationsScript,
  buildContentAnnotateScript,
  buildContentChecks,
  type ContentAnnotationBox,
  type ContentChecksRequest,
  type ContentChecksResult,
} from "./content-checks.js";
import {
  buildClearLayoutLintAnnotationsScript,
  buildLayoutLintAnnotateScript,
  buildLayoutLintCheck,
  type LayoutLintRequest,
  type LayoutLintResult,
} from "./geometry.js";
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
  buildClearTargetSizeAnnotationsScript,
  buildTargetSizeAnnotateScript,
  buildTargetSizeCheck,
  type TargetSizeProfile,
  type TargetSizeResult,
} from "./target-size.js";
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

// Bound how many Chromium processes SPAWN at the same moment. When many Browser
// instances open at once — a full test suite, a fan-out of browse calls — the
// simultaneous `child_process.spawn`s exhaust the OS's stdio-pipe/socket
// resources and Chromium launch dies with an unhandled ENOENT that a per-call
// retry can't catch. Serializing only the brief launch phase (never the
// browser's lifetime, so N browsers still run concurrently) removes the burst
// that causes it. Overridable via HARNERY_MAX_BROWSER_LAUNCHES.
const MAX_CONCURRENT_LAUNCHES = Math.max(
  1,
  Number.parseInt(process.env.HARNERY_MAX_BROWSER_LAUNCHES ?? "3", 10) || 3,
);
let activeLaunches = 0;
const launchWaiters: Array<() => void> = [];

async function acquireLaunchSlot(): Promise<void> {
  if (activeLaunches < MAX_CONCURRENT_LAUNCHES) {
    activeLaunches++;
    return;
  }
  // Queue; the releaser transfers its slot to us (activeLaunches unchanged).
  await new Promise<void>((resolve) => launchWaiters.push(resolve));
}

function releaseLaunchSlot(): void {
  const next = launchWaiters.shift();
  if (next) {
    next();
  } else {
    activeLaunches = Math.max(0, activeLaunches - 1);
  }
}

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

  /**
   * Launch the context and wire up the first page. Factored out of `open()` so
   * the whole sequence — not just the launch — can be retried as a unit.
   */
  private async openOnce(): Promise<void> {
    // Hold a launch slot only across the spawn itself, not the browser's life.
    await acquireLaunchSlot();
    try {
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
    } finally {
      releaseLaunchSlot();
    }
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
   * Open the browser, retrying a few times on a transient startup failure.
   * Chromium occasionally fails to hand off its CDP port ("Failed to connect",
   * "Target closed") when many instances launch at once — a busy CI box or a
   * full test suite — and the failure can surface on the launch OR on a
   * follow-up call (addCookies, newPage) when the process dies right after
   * spawning. So the entire open sequence retries as a unit, tearing down any
   * half-built context between attempts. A genuinely broken config fails every
   * attempt and throws with the underlying message.
   */
  async open(): Promise<void> {
    if (this.context) return;
    mkdirSync(this.profileDir, { recursive: true });

    const maxAttempts = 3;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await this.openOnce();
        return;
      } catch (err) {
        lastErr = err;
        // Tear down a partial context + reset diagnostics collected on the
        // failed attempt, so the retry starts clean. (openOnce() reassigns
        // this.context, which TS can't see across the call, so re-widen.)
        const partial = this.context as BrowserContext | null;
        if (partial) {
          try {
            await partial.close();
          } catch {
            // ignore — the process is likely already gone
          }
        }
        this.context = null;
        this.page = null;
        this.consoleEvents = [];
        this.pageErrors = [];
        this.failedRequests = [];
        if (attempt < maxAttempts) {
          await new Promise((resolve) => setTimeout(resolve, attempt * 250));
        }
      }
    }
    throw new Error(
      `Failed to open browser after ${maxAttempts} attempts: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
    );
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

  /** Full document + viewport dimensions, for tiling a page into bands. */
  async pageMetrics(): Promise<{
    scrollWidth: number;
    scrollHeight: number;
    viewportWidth: number;
    viewportHeight: number;
  }> {
    return await this.currentPage.evaluate(() => ({
      scrollWidth: Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth ?? 0),
      scrollHeight: Math.max(
        document.documentElement.scrollHeight,
        document.body?.scrollHeight ?? 0,
      ),
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    }));
  }

  /** Base64 PNG of a document-space clip rect. Used to capture one critique tile. */
  async screenshotClipBase64(rect: {
    x: number;
    y: number;
    width: number;
    height: number;
  }): Promise<string> {
    const buf = await this.currentPage.screenshot({ type: "png", clip: rect });
    return buf.toString("base64");
  }

  /** Document-space rects + labels for each element matching `selector` (semantic tiling). */
  async elementTiles(
    selector: string,
  ): Promise<Array<{ label: string; x: number; y: number; width: number; height: number }>> {
    return await this.currentPage.evaluate((sel) => {
      const out: Array<{ label: string; x: number; y: number; width: number; height: number }> = [];
      const sx = window.scrollX;
      const sy = window.scrollY;
      for (const el of Array.from(document.querySelectorAll(sel))) {
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) continue;
        const tag = el.tagName.toLowerCase();
        const cls = typeof el.className === "string" ? el.className.trim().split(/\s+/)[0] : "";
        out.push({
          label: el.id ? `${tag}#${el.id}` : cls ? `${tag}.${cls}` : tag,
          x: Math.max(0, r.x + sx),
          y: Math.max(0, r.y + sy),
          width: r.width,
          height: r.height,
        });
      }
      return out;
    }, selector);
  }

  /**
   * Capture a full-page screenshot from an explicit capture viewport and
   * evaluate the caller's final evidence expression immediately before the
   * pixels are written. Playwright normally manages the full-page viewport
   * internally, which leaves callers unable to inspect fixed/sticky geometry
   * in the state the PNG actually renders.
   */
  async screenshotWithEvaluation<T = unknown>(
    path: string,
    evaluation: string,
    opts: { fullPage?: boolean } = {},
  ): Promise<{
    bytes: number;
    evaluation: T;
    viewport: { width: number; height: number };
    evidence: {
      converged: boolean;
      reason: string;
      passes: number;
      max_passes: number;
      max_dimension: number;
      max_pixels: number;
      original_viewport: { width: number; height: number };
      evaluated_viewport: { width: number; height: number };
      document_extent_before_evaluation: { width: number; height: number };
      document_extent_after_evaluation: { width: number; height: number };
      document_extent_after_screenshot: { width: number; height: number };
      screenshot: { width: number; height: number; bytes: number };
    };
  }> {
    const page = this.currentPage;
    const fullPage = opts.fullPage ?? true;
    const maxPasses = 4;
    const maxDimension = 32_000;
    const maxPixels = 128_000_000;
    const documentExtent = () =>
      page.evaluate(() => ({
        width: Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth ?? 0),
        height: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0),
      }));
    const originalViewport = page.viewportSize();
    if (!originalViewport) {
      throw new Error("Capture-state evaluation requires a page with an explicit viewport.");
    }
    let captureViewport = originalViewport;
    let passes = fullPage ? 0 : 1;
    let extentBeforeEvaluation = await documentExtent();
    let bounded = true;
    if (fullPage) {
      for (let pass = 0; pass < maxPasses; pass += 1) {
        passes = pass + 1;
        const nextViewport = {
          width: originalViewport.width,
          height: Math.max(originalViewport.height, Math.ceil(extentBeforeEvaluation.height)),
        };
        bounded =
          nextViewport.width <= maxDimension &&
          nextViewport.height <= maxDimension &&
          nextViewport.width * nextViewport.height <= maxPixels;
        if (!bounded) break;
        if (
          nextViewport.width === captureViewport.width &&
          nextViewport.height === captureViewport.height &&
          extentBeforeEvaluation.width <= captureViewport.width &&
          extentBeforeEvaluation.height === captureViewport.height
        ) {
          break;
        }
        captureViewport = nextViewport;
        await page.setViewportSize(captureViewport);
        extentBeforeEvaluation = await documentExtent();
      }
    }
    try {
      const evaluationResult = await page.evaluate<T>(evaluation);
      const extentAfterEvaluation = await documentExtent();
      const buf = await page.screenshot({ path, fullPage: fullPage && bounded, type: "png" });
      const extentAfterScreenshot = await documentExtent();
      const screenshot = {
        width: buf.readUInt32BE(16),
        height: buf.readUInt32BE(20),
        bytes: buf.length,
      };
      const exact = fullPage
        ? bounded &&
          captureViewport.width === extentBeforeEvaluation.width &&
          captureViewport.height === extentBeforeEvaluation.height &&
          captureViewport.width === extentAfterEvaluation.width &&
          captureViewport.height === extentAfterEvaluation.height &&
          captureViewport.width === extentAfterScreenshot.width &&
          captureViewport.height === extentAfterScreenshot.height &&
          captureViewport.width === screenshot.width &&
          captureViewport.height === screenshot.height
        : captureViewport.width === screenshot.width &&
          captureViewport.height === screenshot.height;
      const reason = !bounded
        ? "capture_bounds_exceeded"
        : exact
          ? "capture_viewport_converged"
          : "capture_viewport_non_convergent";
      return {
        bytes: buf.length,
        evaluation: evaluationResult,
        viewport: captureViewport,
        evidence: {
          converged: exact,
          reason,
          passes,
          max_passes: maxPasses,
          max_dimension: maxDimension,
          max_pixels: maxPixels,
          original_viewport: originalViewport,
          evaluated_viewport: captureViewport,
          document_extent_before_evaluation: extentBeforeEvaluation,
          document_extent_after_evaluation: extentAfterEvaluation,
          document_extent_after_screenshot: extentAfterScreenshot,
          screenshot,
        },
      };
    } finally {
      if (
        captureViewport.width !== originalViewport.width ||
        captureViewport.height !== originalViewport.height
      ) {
        await page.setViewportSize(originalViewport);
      }
    }
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

  /** Run the selector-scoped rendered-geometry rule family in one page evaluation. */
  async checkLayoutLint(request: LayoutLintRequest): Promise<LayoutLintResult> {
    return await this.currentPage.evaluate(buildLayoutLintCheck(), request);
  }

  /** Draw one document-space annotation layer for rendered-geometry results. */
  async annotateLayoutLint(result: LayoutLintResult): Promise<void> {
    await this.currentPage.evaluate(buildLayoutLintAnnotateScript(), result);
  }

  /** Remove rendered-geometry annotations. */
  async clearLayoutLintAnnotations(): Promise<void> {
    await this.currentPage.evaluate(buildClearLayoutLintAnnotationsScript());
  }

  /** Run the requested content checks (placeholder/image/truncation/contrast) in one evaluation. */
  async checkContent(request: ContentChecksRequest): Promise<ContentChecksResult> {
    return await this.currentPage.evaluate(buildContentChecks(), request);
  }

  /** Evaluate value assertions (text/contains/matches/count/exists/absent) against the page. */
  async checkAsserts(specs: AssertSpec[]): Promise<AssertResult[]> {
    return await this.currentPage.evaluate(buildAssertCheck(), specs);
  }

  /** Draw one document-space annotation layer for content-check hits. */
  async annotateContent(boxes: ContentAnnotationBox[]): Promise<void> {
    await this.currentPage.evaluate(buildContentAnnotateScript(), { boxes });
  }

  /** Remove content-check annotations. */
  async clearContentAnnotations(): Promise<void> {
    await this.currentPage.evaluate(buildClearContentAnnotationsScript());
  }

  /**
   * Run the target-size rule against the page or explicit scopes. The
   * dependency's browser bundle is evaluated directly in the page context so
   * a document CSP cannot silently block a script element.
   */
  async checkTargetSize(
    selectors: Array<string | null>,
    profile: TargetSizeProfile,
  ): Promise<TargetSizeResult[]> {
    await this.currentPage.evaluate(axe.source);
    const results: TargetSizeResult[] = [];
    for (const selector of selectors) {
      results.push(
        await this.currentPage.evaluate(buildTargetSizeCheck(), {
          selector,
          profile,
        }),
      );
    }
    return results;
  }

  /** Draw target-size failures and unknowns on the screenshot. */
  async annotateTargetSize(results: TargetSizeResult[]): Promise<void> {
    await this.currentPage.evaluate(buildTargetSizeAnnotateScript(), results);
  }

  /** Remove target-size annotations. */
  async clearTargetSizeAnnotations(): Promise<void> {
    await this.currentPage.evaluate(buildClearTargetSizeAnnotationsScript());
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

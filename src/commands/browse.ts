import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import type { Command } from "commander";
import type { EmitContext, HarneryProgramContext } from "../commander.ts";
import { resolveBinName } from "../core/config.ts";
import {
  Browser,
  captureDevOverlay,
  type DevOverlayResult,
  type Diagnostics,
  type OverflowResult,
  type RuntsResult,
  type VisibilityResult,
  type WidthResult,
} from "../lib/browser/index.ts";
import {
  type DiffResult,
  diffAgainstBaseline,
  type SaveBaselineResult,
  saveBaseline,
} from "../lib/browser/visual-diff.ts";
import { CookieJar } from "../lib/cookies/index.ts";

/**
 * `harn browse <url>`: Playwright-backed page navigation with shared
 * cookie jar + persistent profile + diagnostics capture for LLM
 * iteration loops.
 *
 * **Default behavior is "trio of files":** running `harn browse <url>` writes:
 *
 *   <prefix>.png    Full-page screenshot (omit with --no-screenshot)
 *   <prefix>.html   Post-JS-render serialized DOM
 *   <prefix>.json   Diagnostics: title, url, status, viewport, console
 *                    events, console errors, page errors, failed requests
 *
 * `<prefix>` defaults to `~/.cache/harnery/browse/last`. Override with
 * `--out <prefix>`.
 *
 * Print modes (`--snapshot`, `--html`, `--json`) skip file writes and
 * print to stdout instead, handy for shell pipelines like
 * `harn browse <url> --html | harn read -`.
 */

const DEFAULT_PROFILE = resolve(homedir(), ".cache", "harnery", "browser-profile");
const DEFAULT_STORE = resolve(homedir(), ".cache", "harnery", "cookies.json");
const FALLBACK_OUT_PREFIX = resolve(homedir(), ".cache", "harnery", "browse", "last");

interface BrowseOpts {
  out?: string;
  // Commander expands `--no-X` into `opts.x = false` (default true), not
  // `opts.noX`. So `--no-screenshot` toggles `screenshot`, `--no-full-page`
  // toggles `fullPage`, `--no-cookies` toggles `cookies`.
  screenshot?: boolean;
  domOnly?: boolean;
  fullPage?: boolean;
  snapshot?: boolean;
  html?: boolean;
  selector?: string;
  click?: string;
  fill?: string;
  press?: string;
  waitFor?: string;
  evaluate?: string;
  batch?: string;
  networkHar?: string;
  login?: boolean;
  headed?: boolean;
  cookies?: boolean;
  store?: string;
  profile?: string;
  viewport?: string;
  waitUntil: string;
  timeout: string;
  json?: boolean;
  // Visibility / occlusion checks
  checkVisible?: string[];
  checkVisibleThreshold?: string;
  checkVisibleFail?: boolean;
  checkVisibleSampleGrid?: string;
  // Commander maps `--no-check-visible-annotate` to `checkVisibleAnnotate: false`.
  checkVisibleAnnotate?: boolean;
  // Width-fill check
  checkWidth?: string[];
  checkWidthThreshold?: string;
  checkWidthFail?: boolean;
  checkWidthAnnotate?: boolean;
  // `--check-runts [selector]`: true = whole body, string = scope selector.
  checkRunts?: boolean | string;
  checkRuntsMinChars?: string;
  checkRuntsFail?: boolean;
  checkRuntsAnnotate?: boolean;
  // Horizontal-overflow check
  checkOverflow?: boolean;
  checkOverflowFail?: boolean;
  checkOverflowAnnotate?: boolean;
  // Visual regression
  baseline?: string;
  diff?: string;
  diffThreshold?: string;
  diffFail?: boolean;
  // Next.js dev-overlay capture (auto-on; --no-dev-overlay opts out)
  devOverlay?: boolean;
}

const VIEWPORT_PRESETS: Record<string, { width: number; height: number }> = {
  mobile: { width: 390, height: 844 },
  tablet: { width: 820, height: 1180 },
  desktop: { width: 1280, height: 800 },
  hd: { width: 1920, height: 1080 },
};

// Module-scoped emit assigned by registerBrowseCommand. Same pattern as
// cookies/read: the many helper functions in this large file close over
// `emit` so action callbacks stay concise.
let emit: EmitContext;

export function registerBrowseCommand(
  program: Command,
  emitParam: EmitContext,
  context?: HarneryProgramContext,
): void {
  emit = emitParam;
  program
    .command("browse <url>")
    .description(
      "Headless Chromium with persistent profile + cookie jar. Default writes a trio of files (last.png, last.html, last.json) for the LLM iteration loop; --snapshot/--html/--json switch to stdout-print mode.",
    )
    .option(
      "--out <prefix>",
      "Output prefix for the trio (writes <prefix>.png, .html, .json). Defaults to ~/.cache/harnery/browse/last.",
    )
    .option("--no-screenshot", "Skip the .png in the trio (DOM + JSON only)")
    .option("--dom-only", "Alias for --no-screenshot")
    .option("--no-full-page", "Capture only the viewport, not the full scrollable page")
    .option("--snapshot", "Print body innerText to stdout (skips file writes)")
    .option(
      "--html",
      `Print raw outer HTML to stdout (skips file writes; pair with \`${resolveBinName()} read -\`)`,
    )
    .option("--json", "Print full JSON envelope to stdout (skips file writes)")
    .option("--selector <css>", "Scope --html / --snapshot to one element")
    .option("--click <selector>", "Click this selector after navigation")
    .option("--fill <selector=>value>", "Fill an input: 'input[name=q]=>hello' (separator is `=>`)")
    .option("--press <key>", "Press a key after navigation/fill (e.g., Enter)")
    .option("--wait-for <selector>", "Wait for this selector before capturing output")
    .option(
      "--evaluate <js>",
      "Run JS in the page context after navigation; result printed to stdout",
    )
    .option(
      "--batch <steps>",
      "Run multiple steps in one session, semicolon-separated. Each step is one of: " +
        "`click <selector>`, `fill <selector=>value>`, `press <key>`, `wait <selector|ms>`, `eval <js>`, `reload`. " +
        'Example: `--batch "click button; wait 1500; reload; wait 3000"`. `reload` preserves sessionStorage + cookies, which is how to repro sessionStorage-restored UI state.',
    )
    .option("--network-har <path>", "Record network traffic to a HAR file (finalized on close)")
    .option(
      "--viewport <preset|WxH>",
      "Viewport: mobile (390x844), tablet (820x1180), desktop (1280x800), hd (1920x1080), or explicit '1920x1080'",
      "desktop",
    )
    .option("--login", "Headed mode for one-time auth flow (cookies persist in profile)")
    .option("--headed", "Headed mode for one-off (no auth-flow framing)")
    .option("--no-cookies", "Skip cookie-jar attach and persist")
    .option("--store <path>", `Cookie store path (default ${DEFAULT_STORE})`)
    .option("--profile <dir>", `Persistent Chromium profile dir (default ${DEFAULT_PROFILE})`)
    .option(
      "--wait-until <strategy>",
      "Navigation wait strategy: load | domcontentloaded | networkidle | commit",
      "load",
    )
    .option("--timeout <ms>", "Navigation timeout in milliseconds", "30000")
    .option(
      "--check-visible <selector>",
      "Run an occlusion check on this selector after navigation + batch. " +
        "Samples a 3×3 grid inside the element's bounding rect, reports " +
        "`visibleRatio` + the dominant occluder in the JSON envelope, and " +
        "(by default) overlays green/red/amber boxes on the screenshot. " +
        "Repeat the flag for multiple targets.",
      (value: string, prev: string[] = []) => [...prev, value],
      [] as string[],
    )
    .option(
      "--check-visible-threshold <num>",
      "visibleRatio threshold below which a target is considered occluded " +
        "(0–1, default 0.9). Used by the screenshot annotation color + by " +
        "--check-visible-fail.",
      "0.9",
    )
    .option(
      "--check-visible-fail",
      "Exit non-zero if any --check-visible target falls below threshold. " +
        "Use in deploy scripts to break the build on UI regressions.",
    )
    .option(
      "--check-visible-sample-grid <n>",
      "Grid size for occlusion sampling (n×n points). Default 3 (9 samples).",
      "3",
    )
    .option(
      "--no-check-visible-annotate",
      "Skip drawing target + occluder boxes on the screenshot (JSON still emitted).",
    )
    .option(
      "--check-width <selector>",
      "Assert this selector's bounding rect width is at least --check-width-threshold " +
        "of the viewport. Catches the class of mobile-layout bug where a table or card " +
        "sits at e.g. 85% viewport fill because of stacked padding. Repeat the flag for " +
        "multiple targets. Reports viewportFill + parentFill in the JSON envelope.",
      (value: string, prev: string[] = []) => [...prev, value],
      [] as string[],
    )
    .option(
      "--check-width-threshold <ratio>",
      "viewportFill threshold below which a target is considered too-narrow (0–1, default 0.9). " +
        "Used by the screenshot annotation color + by --check-width-fail.",
      "0.9",
    )
    .option(
      "--check-width-fail",
      "Exit non-zero if any --check-width target falls below threshold.",
    )
    .option(
      "--no-check-width-annotate",
      "Skip drawing width-check boxes on the screenshot (JSON still emitted).",
    )
    .option(
      "--check-overflow",
      "Assert the document has no horizontal overflow (document.scrollWidth <= window.innerWidth). " +
        "Surfaces protruding elements in the JSON envelope and annotates them on the screenshot. " +
        "Catches the class of mobile-layout bug where a nav/table overflows the viewport edge.",
    )
    .option(
      "--check-overflow-fail",
      "Exit non-zero if --check-overflow detects horizontal overflow.",
    )
    .option(
      "--no-check-overflow-annotate",
      "Skip drawing overflow annotations on the screenshot (JSON still emitted).",
    )
    .option(
      "--check-runts [selector]",
      "Scan text blocks for runts (a single word alone on a block's last visual line) " +
        "by counting words on the last line via per-word Range rects — width thresholds " +
        "miss narrow-column runts. Optional selector scopes the sweep (default: whole body). " +
        "Atomic tokens (URLs, emails, phone numbers) are excluded. Reports hits in the JSON " +
        "envelope under `runts` and annotates them on the screenshot.",
    )
    .option(
      "--check-runts-min-chars <n>",
      "Minimum block text length to scan (default 40; smaller labels can't meaningfully wrap).",
      "40",
    )
    .option("--check-runts-fail", "Exit non-zero if any runt is detected.")
    .option(
      "--no-check-runts-annotate",
      "Skip drawing runt boxes on the screenshot (JSON still emitted).",
    )
    .option(
      "--baseline <name>",
      "Save the captured screenshot as a named baseline at " +
        "~/.cache/harnery/visual-baselines/<name>.png. Use --diff <name> later to " +
        "compare future captures against it (visual-regression check).",
    )
    .option(
      "--diff <name>",
      "Pixel-diff the captured screenshot against the named baseline. Writes " +
        "the diff PNG next to the screenshot, reports mismatchedPixels + " +
        "similarity in the JSON envelope.",
    )
    .option(
      "--diff-threshold <ratio>",
      "mismatchRatio (mismatchedPixels / totalPixels) below which the diff is " +
        "considered a match (0–1, default 0.01 = 1%).",
      "0.01",
    )
    .option("--diff-fail", "Exit non-zero if --diff mismatchRatio exceeds --diff-threshold.")
    .option(
      "--no-dev-overlay",
      "Skip auto-capture of Next.js dev-overlay issues. Default: capture every queued error (kind/code/message/stack) when a <nextjs-portal> shadow root is present. Necessary because Next.js 16 + React 19 route hydration errors + most React warnings through onCaughtError → next-devtools' errorQueue, NOT through console.error, so Playwright's standard listener doesn't see them. Surfaces them in the JSON envelope under `devOverlay`.",
    )
    .action(async (url: string, opts: BrowseOpts) => {
      try {
        await runBrowse(url, opts, context);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        emit.error({ code: "browse_error", message: msg });
        process.exit(1);
      }
    });
}

async function runBrowse(
  url: string,
  opts: BrowseOpts,
  context: HarneryProgramContext | undefined,
): Promise<void> {
  // Commander: `--no-cookies` turns `opts.cookies` into `false`. Default is `true`.
  const jar =
    opts.cookies === false
      ? null
      : new CookieJar({ path: opts.store ?? DEFAULT_STORE, source: "harn-browse" });
  const headed = opts.login || opts.headed;
  const viewport = parseViewport(opts.viewport ?? "desktop");

  const browser = new Browser({
    profileDir: opts.profile ?? DEFAULT_PROFILE,
    headed,
    jar,
    viewport,
    navigationTimeout: Number.parseInt(opts.timeout, 10),
    waitUntil: opts.waitUntil as BrowseOpts["waitUntil"] as never,
    recordHarPath: opts.networkHar ? resolve(opts.networkHar) : undefined,
    extraHeaders: context?.extraHeaders,
  });

  // Print mode: --snapshot / --html / --json all suppress file writes.
  const printMode = opts.snapshot || opts.html || opts.json;

  try {
    await browser.open();
    const navResult = await browser.navigate(url);

    if (opts.fill) {
      const sep = opts.fill.indexOf("=>");
      if (sep < 0) {
        throw new Error(
          `--fill expects 'selector=>value' (got: ${opts.fill}). The separator is '=>' (not '='), so CSS attribute selectors like input[name=q] don't collide.`,
        );
      }
      await browser.fill(opts.fill.slice(0, sep), opts.fill.slice(sep + 2));
    }
    if (opts.click) await browser.click(opts.click);
    if (opts.press) await browser.press(opts.press);
    if (opts.waitFor)
      await browser.waitForSelector(opts.waitFor, Number.parseInt(opts.timeout, 10));

    let batchResult: BatchResult | undefined;
    if (opts.batch) {
      batchResult = await runBatch(browser, opts.batch, Number.parseInt(opts.timeout, 10));
    }

    let evalResult: unknown;
    if (opts.evaluate) {
      evalResult = await browser.evaluate<unknown>(opts.evaluate);
    }

    // Run visibility checks AFTER any --batch interactions but BEFORE the
    // screenshot. Annotation injection happens between sampling and capture
    // so the boxes show on the saved PNG; they're cleared post-screenshot
    // so the live profile state isn't polluted.
    let visibility: VisibilityResult[] | undefined;
    if (opts.checkVisible && opts.checkVisible.length > 0) {
      visibility = await browser.checkVisibility(opts.checkVisible, {
        sampleGrid: Number.parseInt(opts.checkVisibleSampleGrid ?? "3", 10),
      });
      if (opts.checkVisibleAnnotate !== false) {
        await browser.annotateVisibility(visibility);
      }
    }

    let widths: WidthResult[] | undefined;
    if (opts.checkWidth && opts.checkWidth.length > 0) {
      widths = await browser.checkWidth(opts.checkWidth);
    }
    let overflow: OverflowResult | undefined;
    if (opts.checkOverflow) {
      overflow = await browser.checkOverflow();
    }
    let runts: RuntsResult | undefined;
    if (opts.checkRunts) {
      runts = await browser.checkRunts({
        scope: typeof opts.checkRunts === "string" ? opts.checkRunts : null,
        minChars: Number.parseInt(opts.checkRuntsMinChars ?? "40", 10),
      });
    }
    const widthThreshold = Number.parseFloat(opts.checkWidthThreshold ?? "0.9");
    const annotateWidth = widths && opts.checkWidthAnnotate !== false;
    const annotateOverflow = overflow && opts.checkOverflowAnnotate !== false;
    if (annotateWidth || annotateOverflow) {
      await browser.annotateLayout({
        widths: annotateWidth ? widths! : [],
        overflow: annotateOverflow ? overflow! : null,
        widthThreshold,
      });
    }
    const annotateRunts = runts && runts.runts.length > 0 && opts.checkRuntsAnnotate !== false;
    if (annotateRunts) {
      await browser.annotateRunts(runts!);
    }

    if (opts.login) {
      await new Promise<void>((res) => {
        emit.log(
          "[--login] Headed Chromium is open. Walk through your auth flow now. Press Enter here to close + persist cookies into the profile.",
          "info",
        );
        process.stdin.once("data", () => res());
      });
    }

    // Auto-capture Next.js dev-overlay issues unless --no-dev-overlay was passed.
    // Cheap no-op when no <nextjs-portal> shadow host is present (non-Next.js page).
    let devOverlay: DevOverlayResult | undefined;
    if (opts.devOverlay !== false) {
      devOverlay = await captureDevOverlay(browser.currentPage);
    }

    if (printMode) {
      if (opts.baseline || opts.diff) {
        throw new Error(
          "--baseline / --diff require trio mode (screenshot file). Remove --snapshot/--html/--json or capture the screenshot first.",
        );
      }
      await runPrintMode(
        browser,
        navResult,
        opts,
        evalResult,
        visibility,
        widths,
        overflow,
        runts,
        devOverlay,
        batchResult,
      );
    } else {
      await runTrioMode(
        browser,
        navResult,
        opts,
        evalResult,
        visibility,
        widths,
        overflow,
        runts,
        devOverlay,
        batchResult,
      );
    }

    if (visibility && opts.checkVisibleAnnotate !== false) {
      await browser.clearVisibilityAnnotations();
    }
    if (annotateWidth || annotateOverflow) {
      await browser.clearLayoutAnnotations();
    }
    if (annotateRunts) {
      await browser.clearRuntsAnnotations();
    }

    if (opts.checkVisibleFail && visibility) {
      const threshold = Number.parseFloat(opts.checkVisibleThreshold ?? "0.9");
      const failed = visibility.filter(
        (r) => !r.found || !r.cssVisible || r.visibleRatio < threshold,
      );
      if (failed.length > 0) {
        for (const f of failed) {
          let reason: string;
          if (!f.found) {
            reason = "element not found";
          } else if (!f.cssVisible) {
            const hb = f.hiddenBy;
            reason = hb
              ? `CSS-hidden via ${hb.reason} on ${hb.ancestorTag}${hb.ancestorId ? `#${hb.ancestorId}` : hb.ancestorClass ? `.${hb.ancestorClass.split(" ").slice(0, 2).join(".")}` : ""} (${hb.propertyValue})`
              : "CSS-hidden (display/visibility/opacity/content-visibility)";
          } else {
            reason = `visibleRatio ${(f.visibleRatio * 100).toFixed(0)}% < ${(threshold * 100).toFixed(0)}%${f.occludedBy ? ` (occluded by ${f.occludedBy.tagName}${f.occludedBy.id ? `#${f.occludedBy.id}` : f.occludedBy.className ? `.${f.occludedBy.className.split(" ").slice(0, 2).join(".")}` : ""})` : ""}`;
          }
          emit.log(`check-visible FAIL ${f.selector}: ${reason}`, "warn");
        }
        process.exitCode = 2;
      }
    }

    if (opts.checkWidthFail && widths) {
      const failed = widths.filter((w) => !w.found || w.viewportFill < widthThreshold);
      if (failed.length > 0) {
        for (const f of failed) {
          const reason = !f.found
            ? "element not found"
            : `viewportFill ${(f.viewportFill * 100).toFixed(0)}% < ${(widthThreshold * 100).toFixed(0)}% (rect=${f.rect.width}px, viewport=${f.viewportWidth}px)`;
          emit.log(`check-width FAIL ${f.selector}: ${reason}`, "warn");
        }
        process.exitCode = 2;
      }
    }

    if (opts.checkRuntsFail && runts && runts.runts.length > 0) {
      for (const hit of runts.runts) {
        emit.log(
          `check-runts FAIL ${hit.block}: last line is a lone "${hit.word}" ("…${hit.snippet.slice(-40)}")`,
          "warn",
        );
      }
      process.exitCode = 2;
    }

    if (opts.checkOverflowFail && overflow?.hasHorizontalOverflow) {
      const culprit = overflow.widerThanViewport[0] ?? overflow.rightOverflow[0] ?? null;
      const detail = culprit
        ? `, top culprit: ${culprit.tagName}${culprit.id ? `#${culprit.id}` : culprit.className ? `.${culprit.className.split(" ").slice(0, 2).join(".")}` : ""} (${culprit.widthOverflowPx > 0 ? `+${culprit.widthOverflowPx}px wider` : `+${culprit.rightOverflowPx}px past right`})`
        : "";
      emit.log(
        `check-overflow FAIL: documentScrollWidth ${overflow.documentScrollWidth}px > viewport ${overflow.viewport.width}px (+${overflow.overflowPx}px)${detail}`,
        "warn",
      );
      process.exitCode = 2;
    }
  } finally {
    await browser.close();
  }
}

// ---------------------------------------------------------------------------
// Batch mode parser. Each step is `<verb> <args>`; verbs are click, fill,
// press, wait, eval. Steps are separated by `;` (escape with `\;` if a value
// genuinely contains a semicolon, rare for the supported verbs).
// ---------------------------------------------------------------------------

interface BatchResult {
  /** Each `clipboard [<label>]` step's read, in order. Empty if no clipboard steps ran. */
  clipboardReads: Array<{ label: string; value: string }>;
}

async function runBatch(
  browser: Browser,
  batch: string,
  defaultTimeoutMs: number,
): Promise<BatchResult> {
  const result: BatchResult = { clipboardReads: [] };
  const steps = splitBatchSteps(batch);
  for (const step of steps) {
    const trimmed = step.trim();
    if (!trimmed) continue;
    const spaceIdx = trimmed.indexOf(" ");
    const verb = (spaceIdx < 0 ? trimmed : trimmed.slice(0, spaceIdx)).toLowerCase();
    const rest = spaceIdx < 0 ? "" : trimmed.slice(spaceIdx + 1).trim();

    switch (verb) {
      case "click":
        if (!rest) throw new Error(`batch: 'click' needs a selector (got: '${trimmed}')`);
        await browser.click(rest);
        break;
      case "fill": {
        const sep = rest.indexOf("=>");
        if (sep < 0) {
          throw new Error(`batch: 'fill' expects '<selector>=><value>' (got: '${trimmed}')`);
        }
        await browser.fill(rest.slice(0, sep), rest.slice(sep + 2));
        break;
      }
      case "press":
        if (!rest) throw new Error(`batch: 'press' needs a key (got: '${trimmed}')`);
        await browser.press(rest);
        break;
      case "wait": {
        if (!rest) throw new Error(`batch: 'wait' needs a selector or ms (got: '${trimmed}')`);
        const asNum = Number(rest);
        if (Number.isFinite(asNum)) {
          await new Promise((res) => setTimeout(res, asNum));
        } else {
          await browser.waitForSelector(rest, defaultTimeoutMs);
        }
        break;
      }
      case "eval":
        if (!rest) throw new Error(`batch: 'eval' needs a JS expression (got: '${trimmed}')`);
        await browser.evaluate(rest);
        break;
      case "reload":
        // Reload preserves cookies + sessionStorage on the same origin: the
        // only programmatic path that reproduces "drawer auto-restored from
        // sessionStorage" focus + tooltip behavior. Pair with a `wait` step
        // after to let hydration + Dialog auto-focus settle.
        await browser.reload();
        break;
      case "clipboard": {
        // Read the system clipboard and record the result so regression
        // tests can assert against it. `rest` is an optional label for the
        // stored value; defaults to "clipboard" so a bare `clipboard` verb
        // works in one-shot use. Reads land in the JSON envelope under
        // `batchClipboardReads` (see runTrioMode + runPrintMode).
        const label = rest || "clipboard";
        const value = await browser.readClipboard();
        result.clipboardReads.push({ label, value });
        break;
      }
      default:
        throw new Error(
          `batch: unknown verb '${verb}'. Supported: click, fill, press, wait, eval, reload, clipboard.`,
        );
    }
  }
  return result;
}

function splitBatchSteps(input: string): string[] {
  const steps: string[] = [];
  let buf = "";
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === "\\" && input[i + 1] === ";") {
      buf += ";";
      i++;
      continue;
    }
    if (ch === ";") {
      steps.push(buf);
      buf = "";
      continue;
    }
    buf += ch;
  }
  if (buf.trim()) steps.push(buf);
  return steps;
}

// ---------------------------------------------------------------------------
// Print mode (--snapshot / --html / --json): stdout, no file writes
// ---------------------------------------------------------------------------

async function runPrintMode(
  browser: Browser,
  navResult: { url: string; title: string; status: number | null },
  opts: BrowseOpts,
  evalResult: unknown,
  visibility: VisibilityResult[] | undefined,
  widths: WidthResult[] | undefined,
  overflow: OverflowResult | undefined,
  runts: RuntsResult | undefined,
  devOverlay: DevOverlayResult | undefined,
  batchResult: BatchResult | undefined,
): Promise<void> {
  let body: string | null = null;
  if (opts.html) {
    body = await browser.htmlContent(opts.selector);
  } else if (opts.snapshot) {
    body = opts.selector
      ? await browser.evaluate<string>(
          `(() => { const el = document.querySelector(${JSON.stringify(opts.selector)}); return el ? el.innerText : ''; })()`,
        )
      : await browser.textSnapshot();
  }

  if (opts.json) {
    const result: Record<string, unknown> = {
      url: navResult.url,
      title: navResult.title,
      status: navResult.status,
      ...summarizeDiagnostics(browser.diagnostics()),
    };
    if (body !== null) result.body = body;
    if (opts.evaluate) result.eval = evalResult;
    if (opts.networkHar) result.har = resolve(opts.networkHar);
    if (visibility) result.visibility = visibility;
    if (widths) result.width = widths;
    if (overflow) result.overflow = overflow;
    if (runts) result.runts = runts;
    if (devOverlay) result.devOverlay = devOverlay;
    if (batchResult && batchResult.clipboardReads.length > 0) {
      result.batchClipboardReads = batchResult.clipboardReads;
    }
    emit.data(result);
  } else if (body !== null) {
    emit.text(body);
  } else if (opts.evaluate) {
    // --evaluate alone (no other print flag): emit the result
    if (typeof evalResult === "string") {
      emit.text(evalResult);
    } else {
      emit.data(evalResult as Record<string, unknown>);
    }
  }
}

// ---------------------------------------------------------------------------
// Trio mode (default): write <prefix>.{png,html,json}
// ---------------------------------------------------------------------------

async function runTrioMode(
  browser: Browser,
  navResult: { url: string; title: string; status: number | null },
  opts: BrowseOpts,
  evalResult: unknown,
  visibility: VisibilityResult[] | undefined,
  widths: WidthResult[] | undefined,
  overflow: OverflowResult | undefined,
  runts: RuntsResult | undefined,
  devOverlay: DevOverlayResult | undefined,
  batchResult: BatchResult | undefined,
): Promise<void> {
  const prefix = resolveOutPrefix(opts.out);
  mkdirSync(dirname(prefix), { recursive: true });

  const written: string[] = [];

  const skipScreenshot = opts.screenshot === false || opts.domOnly === true;
  let pngPath: string | undefined;
  let pngBytes: number | undefined;
  if (!skipScreenshot) {
    pngPath = `${prefix}.png`;
    pngBytes = await browser.screenshot(pngPath, { fullPage: opts.fullPage !== false });
    written.push(pngPath);
  }

  const htmlPath = `${prefix}.html`;
  const html = await browser.htmlContent(opts.selector);
  writeFileSync(htmlPath, html);
  written.push(htmlPath);

  const diag = browser.diagnostics();
  const jsonPath = `${prefix}.json`;
  const envelope: Record<string, unknown> = {
    url: navResult.url,
    title: navResult.title,
    status: navResult.status,
    files: {
      png: pngPath ?? null,
      html: htmlPath,
      json: jsonPath,
    },
    ...summarizeDiagnostics(diag),
  };
  if (pngBytes !== undefined) envelope.screenshotBytes = pngBytes;
  if (opts.evaluate) envelope.eval = evalResult;
  if (opts.networkHar) envelope.har = resolve(opts.networkHar);
  if (visibility) envelope.visibility = visibility;
  if (widths) envelope.width = widths;
  if (overflow) envelope.overflow = overflow;
  if (runts) envelope.runts = runts;
  if (devOverlay) envelope.devOverlay = devOverlay;
  if (batchResult && batchResult.clipboardReads.length > 0) {
    envelope.batchClipboardReads = batchResult.clipboardReads;
  }

  // Visual-regression: save baseline and/or diff against an existing one.
  // Both depend on the PNG being captured, so guard against --no-screenshot.
  let savedBaseline: SaveBaselineResult | undefined;
  let diff: DiffResult | undefined;
  if ((opts.baseline || opts.diff) && !pngPath) {
    throw new Error(
      "--baseline / --diff require a screenshot; --no-screenshot / --dom-only disables it.",
    );
  }
  if (opts.baseline && pngPath) {
    savedBaseline = saveBaseline(pngPath, opts.baseline);
    envelope.baselineSaved = savedBaseline;
    written.push(savedBaseline.path);
  }
  if (opts.diff && pngPath) {
    diff = diffAgainstBaseline(pngPath, opts.diff);
    envelope.diff = diff;
    written.push(diff.diffPath);
  }

  writeFileSync(jsonPath, `${JSON.stringify(envelope)}\n`);
  written.push(jsonPath);

  // Echo --evaluate result to stdout so 'harn browse <url> --evaluate ...' is
  // shell-composable without forcing the user into --json print mode.
  if (opts.evaluate) {
    if (typeof evalResult === "string") {
      emit.text(evalResult);
    } else {
      emit.data(evalResult as Record<string, unknown>);
    }
  }

  emit.log(
    `${navResult.status ?? "?"}  ${navResult.title || "(no title)"}  ${navResult.url}; wrote ${written.length} file${written.length === 1 ? "" : "s"}: ${written.join(", ")}`,
    "info",
  );

  const errSummary = [
    diag.consoleErrors.length ? `${diag.consoleErrors.length} console errors` : "",
    diag.pageErrors.length ? `${diag.pageErrors.length} page errors` : "",
    diag.failedRequests.length ? `${diag.failedRequests.length} failed requests` : "",
  ]
    .filter(Boolean)
    .join(", ");
  if (errSummary) {
    emit.log(errSummary, "warn");
  }

  if (visibility && visibility.length > 0) {
    const threshold = Number.parseFloat(opts.checkVisibleThreshold ?? "0.9");
    const lines = visibility.map((r) => {
      if (!r.found) return `  [FAIL] ${r.selector}: not found`;
      if (!r.cssVisible) {
        const hb = r.hiddenBy;
        const detail = hb
          ? `CSS-hidden [${hb.reason}] via ${hb.ancestorTag}${hb.ancestorId ? `#${hb.ancestorId}` : hb.ancestorClass ? `.${hb.ancestorClass.split(" ").slice(0, 2).join(".")}` : ""}`
          : "CSS-hidden";
        return `  [HIDDEN] ${r.selector}: ${detail}`;
      }
      const pct = (r.visibleRatio * 100).toFixed(0);
      const ok = r.visibleRatio >= threshold;
      const why =
        !ok && r.occludedBy
          ? ` (occluded by ${r.occludedBy.tagName}${r.occludedBy.id ? `#${r.occludedBy.id}` : ""}${r.occludedBy.className ? `.${r.occludedBy.className.split(" ").slice(0, 2).join(".")}` : ""})`
          : "";
      return `  [${ok ? "OK" : "FAIL"}] ${r.selector}: ${pct}% visible${why}`;
    });
    emit.log(
      `check-visible (threshold ${(threshold * 100).toFixed(0)}%):\n${lines.join("\n")}`,
      "info",
    );
  }

  if (widths && widths.length > 0) {
    const threshold = Number.parseFloat(opts.checkWidthThreshold ?? "0.9");
    const lines = widths.map((w) => {
      if (!w.found) return `  [FAIL] ${w.selector}: not found`;
      const pct = (w.viewportFill * 100).toFixed(0);
      const ok = w.viewportFill >= threshold;
      return `  [${ok ? "OK" : "FAIL"}] ${w.selector}: ${pct}% viewport-fill (${w.rect.width}px of ${w.viewportWidth}px)`;
    });
    emit.log(
      `check-width (threshold ${(threshold * 100).toFixed(0)}%):\n${lines.join("\n")}`,
      "info",
    );
  }

  if (overflow) {
    const ok = !overflow.hasHorizontalOverflow;
    const culprit = overflow.widerThanViewport[0] ?? overflow.rightOverflow[0] ?? null;
    const detail = ok
      ? "no horizontal overflow"
      : `documentScrollWidth ${overflow.documentScrollWidth}px > viewport ${overflow.viewport.width}px (+${overflow.overflowPx}px)${
          culprit
            ? `; top culprit: ${culprit.tagName}${culprit.id ? `#${culprit.id}` : culprit.className ? `.${culprit.className.split(" ").slice(0, 2).join(".")}` : ""}`
            : ""
        }`;
    emit.log(`check-overflow: [${ok ? "OK" : "FAIL"}] ${detail}`, ok ? "info" : "warn");
  }

  if (savedBaseline) {
    emit.log(
      `baseline saved: ${savedBaseline.name} → ${savedBaseline.path} (${savedBaseline.bytes} bytes)`,
      "info",
    );
  }
  if (diff) {
    const pct = (diff.mismatchRatio * 100).toFixed(2);
    const detail = diff.sizeMismatch
      ? `size mismatch (baseline ${diff.baselineDims.width}×${diff.baselineDims.height}, current ${diff.currentDims.width}×${diff.currentDims.height})`
      : `${diff.mismatchedPixels.toLocaleString()} / ${diff.totalPixels.toLocaleString()} pixels differ (${pct}%)`;
    emit.log(
      `diff vs '${diff.name}': ${detail} → ${diff.diffPath}`,
      diff.matched ? "info" : "warn",
    );
    if (opts.diffFail) {
      const threshold = Number.parseFloat(opts.diffThreshold ?? "0.01");
      if (diff.sizeMismatch || diff.mismatchRatio > threshold) {
        emit.log(
          `diff FAIL: ${pct}% mismatch > ${(threshold * 100).toFixed(2)}% threshold`,
          "warn",
        );
        process.exitCode = 2;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function summarizeDiagnostics(diag: Diagnostics): Record<string, unknown> {
  return {
    viewport: diag.viewport,
    consoleErrors: diag.consoleErrors,
    consoleEvents: diag.consoleEvents,
    pageErrors: diag.pageErrors,
    failedRequests: diag.failedRequests,
  };
}

function parseViewport(spec: string): { width: number; height: number } {
  const preset = VIEWPORT_PRESETS[spec.toLowerCase()];
  if (preset) return preset;
  const match = /^(\d+)x(\d+)$/.exec(spec.trim());
  if (!match) {
    throw new Error(
      `--viewport must be a preset (mobile|tablet|desktop|hd) or 'WxH' (got: ${spec})`,
    );
  }
  return { width: Number.parseInt(match[1]!, 10), height: Number.parseInt(match[2]!, 10) };
}

/**
 * Pick the trio prefix. Precedence:
 *   1. Explicit --out <prefix>.
 *   2. ~/.cache/harnery/browse/last fallback.
 */
function resolveOutPrefix(explicit: string | undefined): string {
  if (explicit) return isAbsolute(explicit) ? explicit : resolve(explicit);
  return FALLBACK_OUT_PREFIX;
}

// Suppress unused-import warning in build modes that strip dead imports.
void statSync;

// Capture Next.js dev-overlay issues (React errors + warnings) that don't
// route through console.error and therefore don't surface via Playwright's
// standard `page.on("console")` listener.
//
// Background: in Next.js 16 + React 19, hydration errors and most React
// dev warnings fire through React DOM's `onCaughtError` / `onUncaughtError`
// callbacks → next-devtools' `handleClientError` → a module-scoped
// `errorQueue`. They never hit `console.error`, so neither Playwright's
// CDP-backed listener nor an early init-script wrapper can see them. The
// only externally-observable surface is the dev overlay UI inside the
// `<nextjs-portal>` shadow root.
//
// Strategy: detect the shadow host, click the "Open issues overlay" badge
// when present, iterate the dialog's error pages via the prev/next buttons,
// scrape each error's kind + code + message + call-stack, then close the
// overlay. Returns `{ detected, issuesCount, errors }`.

import type { Page } from "playwright";

export interface DevOverlayError {
  index: number;
  kind: string; // "Console Error" / "Recoverable Error" / "Runtime Error" / etc.
  code: string | null;
  message: string;
  callStack: string[];
}

export interface DevOverlayResult {
  detected: boolean; // <nextjs-portal> present
  issuesCount: number;
  errors: DevOverlayError[];
}

interface RawError {
  index: string;
  kind: string;
  code: string | null;
  headerText: string;
  bodyText: string;
  framesText: string[];
}

/**
 * Detect a Next.js dev overlay on the current page and, if present, capture
 * every queued issue. Idempotent, safe to call multiple times. The function
 * closes the overlay on exit; if it crashes partway, the overlay may be left
 * open (subsequent calls will recover).
 */
export async function captureDevOverlay(
  page: Page,
  opts: { stepDelayMs?: number } = {},
): Promise<DevOverlayResult> {
  const stepDelay = opts.stepDelayMs ?? 400;

  const detected = await page.evaluate(() => !!document.querySelector("nextjs-portal"));
  if (!detected) return { detected: false, issuesCount: 0, errors: [] };

  // next-devtools dispatches errors to the overlay via queueMicrotask, so an
  // error fired in the immediately-preceding evaluate() may not yet have
  // propagated. Wait briefly for the badge to materialize before declaring
  // "no issues", capped so the no-error path doesn't pay much.
  await page
    .waitForFunction(
      () => {
        const portal = document.querySelector("nextjs-portal") as
          | (Element & { shadowRoot?: ShadowRoot })
          | null;
        return !!portal?.shadowRoot?.querySelector("[data-issues-open]");
      },
      null,
      { timeout: 1_500 },
    )
    .catch(() => {});

  // Click the issues-open badge if present. Its mere existence signals issues > 0;
  // the badge's own text ("12 Issues" = index "1" + count "2 Issues" rendered side-
  // by-side) isn't a reliable count. Authoritative total comes from the dialog's
  // [data-nextjs-dialog-header-total-count] span after open.
  const opened = await page.evaluate(() => {
    const portal = document.querySelector("nextjs-portal") as
      | (Element & { shadowRoot?: ShadowRoot })
      | null;
    const shadow = portal?.shadowRoot;
    if (!shadow) return false;
    const btn = shadow.querySelector("[data-issues-open]") as HTMLButtonElement | null;
    if (!btn) return false;
    btn.click();
    return true;
  });

  if (!opened) {
    return { detected: true, issuesCount: 0, errors: [] };
  }

  // Wait for the dialog to render
  await page.waitForFunction(
    () => {
      const portal = document.querySelector("nextjs-portal") as
        | (Element & { shadowRoot?: ShadowRoot })
        | null;
      const shadow = portal?.shadowRoot;
      return !!shadow?.querySelector("[data-nextjs-dialog]");
    },
    null,
    { timeout: 4_000 },
  );

  // Read the canonical total from the dialog
  const total = await page.evaluate(() => {
    const portal = document.querySelector("nextjs-portal") as
      | (Element & { shadowRoot?: ShadowRoot })
      | null;
    const shadow = portal?.shadowRoot;
    const el = shadow?.querySelector("[data-nextjs-dialog-header-total-count]");
    const n = Number((el?.textContent || "").trim());
    return Number.isFinite(n) && n > 0 ? n : 1;
  });

  const raw: RawError[] = [];
  const expected = total;
  for (let i = 0; i < expected; i++) {
    const error = await readCurrent(page);
    if (error) raw.push(error);
    if (i < expected - 1) {
      const advanced = await advance(page);
      if (!advanced) break;
      await new Promise((r) => setTimeout(r, stepDelay));
    }
  }

  // Close the overlay (click the collapse button or fall back to Esc)
  await page.evaluate(() => {
    const portal = document.querySelector("nextjs-portal") as
      | (Element & { shadowRoot?: ShadowRoot })
      | null;
    const shadow = portal?.shadowRoot;
    const close = shadow?.querySelector("[data-issues-collapse]") as HTMLButtonElement | null;
    if (close) close.click();
  });
  await page.keyboard.press("Escape").catch(() => {});

  const errors: DevOverlayError[] = raw.map((r, idx) => {
    const message = stripPrefix(r.headerText, r.kind).trim();
    return {
      index: Number(r.index.replace(/[^0-9]/g, "")) || idx + 1,
      kind: r.kind,
      code: r.code,
      message,
      callStack: r.framesText,
    };
  });

  return { detected: true, issuesCount: total, errors };
}

async function readCurrent(page: Page): Promise<RawError | null> {
  return page.evaluate(() => {
    const portal = document.querySelector("nextjs-portal") as
      | (Element & { shadowRoot?: ShadowRoot })
      | null;
    const shadow = portal?.shadowRoot;
    if (!shadow) return null;
    const dialog = shadow.querySelector("[data-nextjs-dialog]");
    if (!dialog) return null;
    const text = (el: Element | null) => (el?.textContent || "").replace(/\s+/g, " ").trim();
    const indexSpan = shadow.querySelector("[data-nextjs-dialog-error-index]");
    const label = shadow.querySelector("[data-nextjs-error-label-group]");
    const codeEl = shadow.querySelector("[data-nextjs-error-code]");
    const header = shadow.querySelector("[data-nextjs-dialog-header]");
    const body = shadow.querySelector("[data-nextjs-dialog-body]");
    const frameEls = shadow.querySelectorAll("[data-nextjs-call-stack-frame]");
    const frames: string[] = [];
    for (const f of Array.from(frameEls)) {
      const t = text(f);
      if (t) frames.push(t);
    }
    return {
      index: text(indexSpan) || "1",
      kind: text(label) || "Issue",
      code: codeEl?.getAttribute("data-nextjs-error-code") ?? null,
      headerText: text(header),
      bodyText: text(body),
      framesText: frames,
    };
  });
}

async function advance(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const portal = document.querySelector("nextjs-portal") as
      | (Element & { shadowRoot?: ShadowRoot })
      | null;
    const shadow = portal?.shadowRoot;
    const next = shadow?.querySelector(
      "[data-nextjs-dialog-error-next]",
    ) as HTMLButtonElement | null;
    if (!next || next.disabled) return false;
    next.click();
    return true;
  });
}

function stripPrefix(s: string, prefix: string): string {
  if (!prefix) return s;
  if (s.startsWith(prefix)) return s.slice(prefix.length);
  return s;
}

import { homedir } from "node:os";
import { resolve } from "node:path";
import type { Command } from "commander";
import type { EmitContext } from "../commander.ts";
import { AgentBrowser, type ExecResult } from "../lib/agent-browser/index.ts";
import { CookieJar } from "../lib/cookies/index.ts";

// Module-scoped emit assigned by registerBrowseAiCommand. Same pattern as
// cookies/read/browse: helper functions close over `emit` so action
// callbacks stay concise.
let emit: EmitContext;

/**
 * `harn browse-ai <url>`: wraps Vercel Labs' agent-browser Rust CLI.
 *
 * Sister command to `harn browse` (which uses Playwright). Differences:
 *
 *   - **Output shape.** `agent-browser` returns an accessibility-tree
 *     snapshot with element refs (`@e1`, `@e2`), purpose-built for LLM
 *     consumption. `harn browse` returns DOM/HTML/innerText.
 *   - **Process model.** `agent-browser` runs as a daemon: successive
 *     calls reuse the same Chrome instance until something explicitly
 *     closes it. `harn browse` opens + closes per call.
 *   - **Auth model.** `harn browse-ai` doesn't have a `--login` flow; use
 *     `harn browse --login` for one-time auth, then both tools share the
 *     same cookie jar.
 *
 * Mirrors the agent-side `browse` wrapper (sandbox side) so a script written for one
 * works on the other modulo path differences.
 */

const DEFAULT_STORE = resolve(homedir(), ".cache", "harnery", "cookies.json");

interface BrowseAiOpts {
  snapshot?: boolean;
  interactive?: boolean;
  screenshot?: string;
  fullPage?: boolean;
  annotate?: string;
  click?: string;
  fill?: string;
  press?: string;
  waitFor?: string;
  evaluate?: string;
  batch?: string;
  networkHar?: string;
  store?: string;
  cookies?: boolean;
  json?: boolean;
  timeout: string;
}

export function registerBrowseAiCommand(program: Command, emitParam: EmitContext): void {
  emit = emitParam;
  program
    .command("browse-ai <url>")
    .description(
      "agent-browser (Vercel Labs) wrapper: accessibility-tree snapshots with element refs (@e1, @e2) for LLM consumption. " +
        "Daemon-mode: successive calls reuse the same browser instance. Sister to harn browse (Playwright).",
    )
    .option("--snapshot", "Print accessibility tree (default action when no other output flag)")
    .option("-i, --interactive", "Snapshot interactive elements only (with --snapshot)")
    .option("--screenshot <path>", "Save a screenshot to the given path")
    .option("--no-full-page", "Capture only the viewport (with --screenshot)")
    .option(
      "--annotate <path>",
      "Save an annotated screenshot with numbered labels (vision-model friendly)",
    )
    .option("--click <ref>", "Click an element ref (@e5) or CSS selector after open")
    .option(
      "--fill <ref=>value>",
      "Fill input: '@e3=>hello' (separator is `=>` so attribute selectors don't collide)",
    )
    .option("--press <key>", "Press a key after open/fill (Enter, Tab, etc.)")
    .option("--wait-for <selector|ms>", "Wait for selector OR a number of ms before output")
    .option("--evaluate <js>", "Run JS in the page context (escape-hatch for power users)")
    .option(
      "--batch <commands>",
      "Run multiple agent-browser steps in one session, semicolon-separated. " +
        'E.g., --batch "click @e5; wait 1000; snapshot"',
    )
    .option("--network-har <path>", "Record a HAR file from open() through end of run")
    .option("--no-cookies", "Skip cookie-jar attach and persist")
    .option("--store <path>", `Cookie store path (default ${DEFAULT_STORE})`)
    .option("--json", "Emit a JSON envelope (snapshot, screenshot path, step results)")
    .option("--timeout <ms>", "Per-step timeout in ms", "60000")
    .action((url: string, opts: BrowseAiOpts) => {
      try {
        runBrowseAi(url, opts);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        emit.error({ code: "browse_ai_error", message: msg });
        process.exit(1);
      }
    });
}

function runBrowseAi(url: string, opts: BrowseAiOpts): void {
  const jar =
    opts.cookies === false
      ? null
      : new CookieJar({ path: opts.store ?? DEFAULT_STORE, source: "harn-browse-ai" });
  const ab = new AgentBrowser({
    jar,
    timeoutMs: Number.parseInt(opts.timeout, 10),
  });

  const stepLog: { step: string; ok: boolean; output: string }[] = [];

  // 1. Open + optional HAR start.
  if (opts.networkHar) ab.harStart(opts.networkHar);
  ab.open(url);
  stepLog.push({ step: `open ${url}`, ok: true, output: "" });

  // 2. Pre-output actions, in the order they make sense for typical flows.
  if (opts.fill) {
    const sep = opts.fill.indexOf("=>");
    if (sep < 0) {
      throw new Error(
        `--fill expects 'ref=>value' (got: ${opts.fill}). Separator is '=>' (not '=').`,
      );
    }
    const ref = opts.fill.slice(0, sep);
    const value = opts.fill.slice(sep + 2);
    const r = ab.fill(ref, value);
    stepLog.push({ step: `fill ${ref}`, ok: r.ok, output: r.stdout.trim() });
  }
  if (opts.click) {
    const r = ab.click(opts.click);
    stepLog.push({ step: `click ${opts.click}`, ok: r.ok, output: r.stdout.trim() });
  }
  if (opts.press) {
    const r = ab.press(opts.press);
    stepLog.push({ step: `press ${opts.press}`, ok: r.ok, output: r.stdout.trim() });
  }
  if (opts.waitFor) {
    const r = ab.wait(opts.waitFor);
    stepLog.push({ step: `wait ${opts.waitFor}`, ok: r.ok, output: r.stdout.trim() });
  }
  if (opts.batch) {
    const steps = opts.batch
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean);
    const results = ab.batch(steps);
    steps.forEach((step, i) => {
      const r = results[i] as ExecResult | undefined;
      stepLog.push({ step, ok: r?.ok ?? false, output: r?.stdout.trim() ?? "" });
    });
  }
  if (opts.evaluate) {
    const out = ab.evaluate(opts.evaluate);
    stepLog.push({ step: "eval", ok: true, output: out });
  }

  // 3. Output capture.
  let snapshot: string | null = null;
  if (opts.snapshot || (!opts.screenshot && !opts.annotate && !opts.evaluate)) {
    snapshot = ab.snapshot({ interactive: opts.interactive });
  }

  if (opts.screenshot) {
    ab.screenshot(opts.screenshot, { full: opts.fullPage !== false });
  }
  if (opts.annotate) {
    ab.screenshot(opts.annotate, { annotate: true });
  }

  if (opts.networkHar) ab.harStop(opts.networkHar);

  // 4. Cookie sync back to jar.
  const cookieStats = ab.syncCookiesToJar();

  // 5. Output.
  if (opts.json) {
    const envelope: Record<string, unknown> = {
      url,
      steps: stepLog,
      cookiesSaved: cookieStats.saved,
    };
    if (snapshot !== null) envelope.snapshot = snapshot;
    if (opts.screenshot) envelope.screenshot = opts.screenshot;
    if (opts.annotate) envelope.annotated = opts.annotate;
    if (opts.networkHar) envelope.har = opts.networkHar;
    emit.data(envelope);
    return;
  }

  if (snapshot !== null) emit.text(snapshot);
  if (opts.screenshot) emit.log(`screenshot: ${opts.screenshot}`, "info");
  if (opts.annotate) emit.log(`annotated: ${opts.annotate}`, "info");
  if (cookieStats.saved > 0) {
    emit.log(
      `saved ${cookieStats.saved} cookie${cookieStats.saved === 1 ? "" : "s"} to ${jar?.path}`,
      "info",
    );
  }
}

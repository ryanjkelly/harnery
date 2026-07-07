import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { Command } from "commander";
import type { EmitContext, HarneryProgramContext } from "../commander.ts";
import { CookieJar } from "../lib/cookies/index.ts";
import { fetchWithJar } from "../lib/http/index.ts";

/**
 * `harn fetch`: HTTP request with cookie-jar attach + persist.
 *
 * Default jar is the same one `harn cookies` reads/writes
 * (`~/.cache/harnery/cookies.json`), so cookies set during a `harn browse`
 * session flow naturally to subsequent `harn fetch` calls.
 */

const DEFAULT_STORE = resolve(homedir(), ".cache", "harnery", "cookies.json");

interface FetchOpts {
  method: string;
  header?: string[];
  data?: string;
  output?: string;
  store?: string;
  cookies?: boolean;
  redirect: string;
  timeout: string;
  status?: boolean;
  headers?: boolean;
  json?: boolean;
}

export function registerFetchCommand(
  program: Command,
  emit: EmitContext,
  context?: HarneryProgramContext,
): void {
  program
    .command("fetch <url>")
    .description(
      "HTTP GET (or --method) with cookie-jar attach + persist. " +
        "Default jar is ~/.cache/harnery/cookies.json (shared with harn cookies / harn browse).",
    )
    .option("-X, --method <method>", "HTTP method", "GET")
    .option("-H, --header <header...>", "Extra request header (repeatable, format: 'Name: value')")
    .option("-d, --data <body>", "Request body")
    .option("-o, --output <file>", "Write response body to file (default: stdout)")
    .option("--store <path>", `Cookie store path (default ${DEFAULT_STORE})`)
    .option("--no-cookies", "Skip cookie-jar attach + persist")
    .option("--redirect <mode>", "Redirect handling: follow | error | manual", "follow")
    .option("--timeout <ms>", "Request timeout in milliseconds", "30000")
    .option("--status", "Print status to stderr")
    .option("--headers", "Print response headers to stderr")
    .option("--json", "Output the full FetchResult (status, headers, body) as JSON")
    .action(async (url: string, opts: FetchOpts) => {
      try {
        await runFetch(url, opts, emit, context);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        emit.error({ code: "fetch_error", message: msg });
        process.exit(1);
      }
    });
}

async function runFetch(
  url: string,
  opts: FetchOpts,
  emit: EmitContext,
  context: HarneryProgramContext | undefined,
): Promise<void> {
  const headers: Record<string, string> = {};
  for (const h of opts.header ?? []) {
    const idx = h.indexOf(":");
    if (idx < 0) {
      throw new Error(`Bad header (expected 'Name: value'): ${h}`);
    }
    headers[h.slice(0, idx).trim()] = h.slice(idx + 1).trim();
  }

  const jar =
    opts.cookies !== false
      ? new CookieJar({ path: opts.store ?? DEFAULT_STORE, source: "harn-fetch" })
      : null;

  const timeoutMs = Number.parseInt(opts.timeout, 10);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let result: Awaited<ReturnType<typeof fetchWithJar>>;
  try {
    result = await fetchWithJar(url, {
      method: opts.method,
      headers,
      body: opts.data,
      jar,
      redirect: opts.redirect as RequestRedirect,
      signal: ac.signal,
      extraHeaders: context?.extraHeaders,
    });
  } finally {
    clearTimeout(timer);
  }

  if (opts.json) {
    emit.data(result as unknown as Record<string, unknown>);
    return;
  }
  if (opts.status) {
    emit.log(`${result.status} ${result.statusText}  ${result.url}`, "info");
  }
  if (opts.headers) {
    for (const [k, v] of Object.entries(result.headers)) {
      emit.log(`${k}: ${v}`, "info");
    }
  }

  if (opts.output) {
    writeFileSync(opts.output, result.body);
    emit.file(opts.output, {
      bytes: result.body.length,
      status: result.status,
      status_text: result.statusText,
    });
  } else {
    // Body is potentially binary; route as text since most fetch responses
    // are text/HTML/JSON. Binary callers should use --output.
    emit.text(result.body);
  }

  if (jar && result.cookiesSaved > 0) {
    emit.log(
      `saved ${result.cookiesSaved} cookie${result.cookiesSaved === 1 ? "" : "s"} to ${jar.path}`,
      "info",
    );
  }
}

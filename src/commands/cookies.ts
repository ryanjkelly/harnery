import { homedir } from "node:os";
import { resolve } from "node:path";
import type { Command } from "commander";
import type { EmitContext } from "../commander.ts";
import { type Cookie, CookieJar } from "../lib/cookies/index.ts";

/**
 * `cookies`: manage the local browser cookie store.
 *
 * Default store path: `~/.cache/harnery/cookies.json`. Override with
 * `--store <path>` if you need a separate jar (e.g., one per environment).
 * Format is CDP-native (compatible with Playwright/agent-browser).
 */

const DEFAULT_STORE = resolve(homedir(), ".cache", "harnery", "cookies.json");

interface CommonOpts {
  store?: string;
  json?: boolean;
}

function jarFrom(opts: CommonOpts): CookieJar {
  return new CookieJar({
    path: opts.store ?? DEFAULT_STORE,
    source: "harn-cookies",
  });
}

// Module-scoped emit assigned by registerCookiesCommand; the module-level
// helpers below close over this so the Commander .action callbacks stay
// concise. Safe because the command tree is registered once at startup.
let emit: EmitContext;

export function registerCookiesCommand(program: Command, emitParam: EmitContext): void {
  emit = emitParam;
  const cmd = program
    .command("cookies")
    .description(
      `Manage the shared browser cookie store (default: ${DEFAULT_STORE}). Format is CDP-native (compatible with Playwright/agent-browser).`,
    )
    .option("--store <path>", "Override store path");

  cmd.action((opts: CommonOpts) => safe(() => runList(jarFrom(opts), {})));

  cmd
    .command("list")
    .description("List cookies in the store, grouped by domain")
    .option("--domain <domain>", "Filter by domain")
    .option("--json", "Output as JSON")
    .action((opts: CommonOpts & { domain?: string }) =>
      safe(() => runList(jarFrom({ ...cmd.opts(), ...opts }), opts)),
    );

  cmd
    .command("set <name> <value>")
    .description("Set a cookie in the store (creates the file if missing)")
    .requiredOption("--domain <domain>", "Cookie domain (e.g., .example.com)")
    .option("--path <path>", "Cookie path", "/")
    .option("--secure", "HTTPS only")
    .option("--httpOnly", "Prevent JavaScript access")
    .option("--sameSite <policy>", "SameSite policy: Strict | Lax | None")
    .option("--expires <unix-seconds>", "Unix timestamp; omit for session cookie")
    .action(
      (
        name: string,
        value: string,
        opts: CommonOpts & {
          domain: string;
          path: string;
          secure?: boolean;
          httpOnly?: boolean;
          sameSite?: string;
          expires?: string;
        },
      ) => safe(() => runSet(jarFrom({ ...cmd.opts(), ...opts }), name, value, opts)),
    );

  cmd
    .command("clear")
    .description("Remove cookies from the store")
    .option("--domain <domain>", "Drop cookies matching a single domain")
    .option("--all", "Wipe everything (cookies + origins)")
    .action((opts: CommonOpts & { domain?: string; all?: boolean }) =>
      safe(() => runClear(jarFrom({ ...cmd.opts(), ...opts }), opts)),
    );

  cmd
    .command("header <url>")
    .description("Print a Cookie: header value for the given URL (empty if no match)")
    .action((url: string, opts: CommonOpts) =>
      safe(() => {
        const jar = jarFrom({ ...cmd.opts(), ...opts });
        const out = jar.header(url);
        if (out) emit.text(`${out}\n`);
      }),
    );

  cmd
    .command("import <file>")
    .description("Merge cookies from a JSON file (CDP/agent-browser shape)")
    .option("--replace", "Replace the entire store instead of merging")
    .action((file: string, opts: CommonOpts & { replace?: boolean }) =>
      safe(() => {
        const jar = jarFrom({ ...cmd.opts(), ...opts });
        const { count } = jar.import(file, opts);
        emit.data({ ok: true, action: "import", count, file });
      }),
    );

  cmd
    .command("export <file>")
    .description("Write the store to a file (for sharing with another tool)")
    .action((file: string, opts: CommonOpts) =>
      safe(() => {
        const jar = jarFrom({ ...cmd.opts(), ...opts });
        const { count } = jar.export(file);
        emit.file(file, { cookies: count });
      }),
    );

  cmd
    .command("info")
    .description("Show store path, size, cookie counts, and exporting tool")
    .option("--json", "Output as JSON")
    .action((opts: CommonOpts) => safe(() => runInfo(jarFrom({ ...cmd.opts(), ...opts }), opts)));
}

// ---------------------------------------------------------------------------
// Subcommand handlers
// ---------------------------------------------------------------------------

function runList(jar: CookieJar, opts: { domain?: string; json?: boolean }): void {
  if (opts.json) emit.config({ format: "json" });
  const cookies = jar.list({ domain: opts.domain });
  emit.rows(cookies as unknown as Record<string, unknown>[]);
}

function runSet(
  jar: CookieJar,
  name: string,
  value: string,
  opts: {
    domain: string;
    path: string;
    secure?: boolean;
    httpOnly?: boolean;
    sameSite?: string;
    expires?: string;
  },
): void {
  const cookie: Cookie = {
    name,
    value,
    domain: opts.domain,
    path: opts.path,
    expires: opts.expires ? Number.parseFloat(opts.expires) : -1,
    httpOnly: opts.httpOnly ?? false,
    secure: opts.secure ?? false,
    session: !opts.expires,
    size: name.length + value.length,
  };
  if (opts.sameSite) cookie.sameSite = opts.sameSite;
  jar.set(cookie);
  emit.data({ ok: true, action: "set", name, domain: opts.domain });
}

function runClear(jar: CookieJar, opts: { domain?: string; all?: boolean }): void {
  if (!opts.domain && !opts.all) {
    throw new Error("Specify --domain <domain> or --all");
  }
  const { before, after } = jar.clear(opts);
  const removed = before - after;
  emit.data({
    ok: true,
    action: "clear",
    removed,
    before,
    after,
    domain: opts.domain ?? null,
    all: opts.all ?? false,
  });
}

function runInfo(jar: CookieJar, opts: { json?: boolean }): void {
  if (opts.json) emit.config({ format: "json" });
  const i = jar.info();
  emit.data(i);
}

function safe(fn: () => void): void {
  try {
    fn();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    emit.error({ code: "cookies_error", message: msg });
    process.exit(1);
  }
}

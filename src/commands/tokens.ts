import { readFileSync } from "node:fs";
import type { Command } from "commander";
import { countTokens } from "gpt-tokenizer/model/gpt-4o";
import type { EmitContext } from "../commander.ts";

/**
 * `tokens`: count tokens in text/markdown files.
 *
 * Uses OpenAI's `o200k_base` BPE tokenizer (via `gpt-tokenizer`) as a proxy
 * for Claude's tokenizer. Claude doesn't publish a local tokenizer, but for
 * English markdown the two agree to within ~3-5%. Calls
 * `emit.config()/data()/setExitCode()` via the injected EmitContext so the
 * same code path serves both standalone and composed consumers.
 */

interface TokenResult {
  path: string;
  chars: number;
  tokens: number;
  error: string | null;
}

interface TokensOpts {
  limit?: number;
  format: string;
}

export function registerTokensCommand(program: Command, emit: EmitContext): void {
  program
    .command("tokens")
    .description("Count tokens in text/markdown files (offline, uses o200k_base as Claude proxy)")
    .argument("<files...>", "One or more file paths (globs are shell-expanded)")
    .option("--limit <n>", "Flag files exceeding N tokens; exit non-zero if any exceed", (v) =>
      Number.parseInt(v, 10),
    )
    .option("--format <type>", "Output format: table, json, plain", "table")
    .action((files: string[], opts: TokensOpts) => {
      if (opts.format === "json") emit.config({ format: "json" });

      const results = files.map(countFile);
      const over =
        opts.limit !== undefined
          ? results.filter((r) => !r.error && r.tokens > (opts.limit as number))
          : [];

      const enriched = results.map((r) => ({
        path: r.path,
        chars: r.chars,
        tokens: r.tokens,
        error: r.error,
        over_limit: opts.limit !== undefined && !r.error ? r.tokens > opts.limit : null,
        pct_of_limit:
          opts.limit !== undefined && !r.error
            ? Math.round((r.tokens / (opts.limit as number)) * 100)
            : null,
      }));

      emit.data({
        ok: true,
        tokenizer: "o200k_base",
        limit: opts.limit ?? null,
        count: enriched.length,
        over_count: over.length,
        results: enriched,
      });

      if (over.length > 0) emit.setExitCode(1);
    });
}

function countFile(path: string): TokenResult {
  try {
    const content = readFileSync(path, "utf8");
    return { path, chars: content.length, tokens: countTokens(content), error: null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { path, chars: 0, tokens: 0, error: msg };
  }
}

import { readFileSync, writeFileSync } from "node:fs";
import type { Command } from "commander";
import type { EmitContext } from "../commander.ts";
import { resolveBinName } from "../core/config.ts";
import { htmlToMarkdown } from "../lib/readability/index.ts";

// Module-scoped emit assigned by registerReadCommand. Same pattern as cookies.ts:
// the runRead helper closes over this so the .action callback stays concise.
let emit: EmitContext;

/**
 * `harn read`: extract clean readable markdown from HTML.
 */
export function registerReadCommand(program: Command, emitParam: EmitContext): void {
  emit = emitParam;
  program
    .command("read [html-file]")
    .description(
      `Extract clean readable markdown from HTML. Reads from file or stdin (use '-'). Pair with \`${resolveBinName()} fetch\` or \`${resolveBinName()} browse\` for scrape-to-markdown.`,
    )
    .option("-o, --output <file>", "Write markdown to file instead of stdout")
    .option("--url <url>", "Base URL: used to resolve relative links")
    .option(
      "--selector <css>",
      "Use this CSS selector instead of Readability (fallback when extraction misses content)",
    )
    .option("--raw", "Output cleaned HTML instead of markdown (debugging)")
    .option("--max-chars <n>", "Truncate output to N characters (0 = disable)", "100000")
    .action((htmlFile: string | undefined, opts: ReadOpts) => {
      try {
        runRead(htmlFile, opts);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        emit.error({ code: "read_error", message: msg });
        process.exit(1);
      }
    });
}

interface ReadOpts {
  output?: string;
  url?: string;
  selector?: string;
  raw?: boolean;
  maxChars: string;
}

function runRead(htmlFile: string | undefined, opts: ReadOpts): void {
  const input =
    htmlFile && htmlFile !== "-" ? readFileSync(htmlFile, "utf-8") : readFileSync(0, "utf-8");
  const result = htmlToMarkdown(input, {
    url: opts.url,
    selector: opts.selector,
    raw: opts.raw,
    maxChars: Number.parseInt(opts.maxChars, 10),
  });

  if (opts.output) {
    writeFileSync(opts.output, result.output);
    emit.file(opts.output, { chars: result.output.length });
  } else {
    emit.text(result.output);
  }
}

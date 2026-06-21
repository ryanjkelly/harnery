/**
 * Example: route harnery's output through your own EmitContext.
 *
 * The default emit writes JSON to stdout. Consumer CLIs often want
 * something richer: pretty-print tables in a TTY, route structured
 * events to a log aggregator, mirror to .session.log, etc.
 *
 * Pass an `emit` object to createHarneryProgram() implementing the
 * EmitContext interface; harnery commands will call its methods instead
 * of the default. The interface is intentionally small (~9 methods) so
 * full custom adapters are <100 lines.
 *
 * Run:
 *   bun run examples/custom-emit.ts agents list
 */

import { createHarneryProgram, type EmitContext } from "../src/commander.ts";

const customEmit: EmitContext = {
  config({ format }) {
    if (format === "csv") {
      // Tell rows() to render CSV instead of JSON
      Object.assign(customEmit, { __format: "csv" });
    }
  },
  data(payload) {
    console.log("[data]", JSON.stringify(payload, null, 2));
  },
  rows(rows) {
    if (rows.length === 0) {
      console.log("(no rows)");
      return;
    }
    const cols = Object.keys(rows[0]);
    console.log(`[${rows.length} rows]`);
    console.log(cols.join("\t"));
    console.log("─".repeat(80));
    for (const r of rows) {
      console.log(cols.map((c) => String(r[c] ?? "")).join("\t"));
    }
  },
  text(s) {
    console.log(s);
  },
  file(path, summary) {
    console.log(`[file] ${path}`);
    console.log("  ", summary);
  },
  error(err) {
    const payload =
      err instanceof Error
        ? { code: err.name || "error", message: err.message }
        : err;
    console.error("[error]", payload);
    process.exitCode = 1;
  },
  log(msg, level = "info") {
    const tag = { debug: "··", info: "ℹ", warn: "⚠", error: "✗" }[level] ?? "·";
    console.error(`${tag} ${msg}`);
  },
  setExitCode(n) {
    process.exitCode = n;
  },
};

const program = createHarneryProgram({
  binName: "custom-emit-example",
  emit: customEmit,
  context: { projectName: "example" },
});

await program.parseAsync(process.argv);

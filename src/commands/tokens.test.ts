import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import type { EmitContext } from "../commander.ts";
import { registerTokensCommand } from "./tokens.ts";

const dir = mkdtempSync(join(tmpdir(), "harn-tokens-"));
const small = join(dir, "small.md");
const large = join(dir, "large.md");
writeFileSync(small, "hello world");
writeFileSync(large, "word ".repeat(200));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function run(...args: string[]) {
  const out = { text: [] as string[], data: [] as unknown[], exitCode: 0 };
  const emit: EmitContext = {
    config() {},
    data: (payload) => out.data.push(payload),
    rows: (rows) => out.data.push(rows),
    text: (s) => out.text.push(s),
    file() {},
    error() {},
    log() {},
    setExitCode: (n) => {
      out.exitCode = n;
    },
  };
  const program = new Command().exitOverride().configureOutput({ writeErr: () => {} });
  registerTokensCommand(program, emit);
  await program.parseAsync(["node", "harn", "tokens", ...args]);
  return out;
}

describe("tokens --format", () => {
  test("plain prints one count and path per line", async () => {
    const out = await run("--format", "plain", small, join(dir, "missing.md"));
    expect(out.data).toEqual([]);
    const lines = out.text.join("\n").split("\n");
    // Escape the path: a Windows separator would otherwise read as a regex escape.
    const smallPattern = small.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    expect(lines[0]).toMatch(new RegExp(`^\\d+\\t${smallPattern}$`));
    expect(lines[1]).toStartWith(`error\t${join(dir, "missing.md")}\t`);
  });

  test("plain marks files over the limit and exits non-zero", async () => {
    const out = await run("--format", "plain", "--limit", "10", small, large);
    expect(out.text.join("\n")).toContain(`${large}\tover limit`);
    expect(out.text.join("\n")).not.toContain(`${small}\tover limit`);
    expect(out.exitCode).toBe(1);
  });

  test("the default still emits the structured envelope", async () => {
    const out = await run(small);
    expect(out.text).toEqual([]);
    expect(out.data[0]).toMatchObject({ ok: true, count: 1 });
  });

  test("an unknown format is refused", async () => {
    await expect(run("--format", "csv", small)).rejects.toThrow(
      "expected one of table, json, plain",
    );
  });
});

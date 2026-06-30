/**
 * Tests for the runtime completion resolver (src/lib/completion/resolve.ts):
 * the in-process answer behind the dynamic shell shim. Builds a small Commander
 * program and asserts candidates + directive at each cursor position
 * (subcommand / option name / enum value / dynamic-provider value / positional /
 * file fallback), plus the wire encoding.
 */

import { describe, expect, test } from "bun:test";
import { Command, Option } from "commander";
import type { CompletionContextLookup } from "../../src/lib/completion/walk.ts";
import {
  DIRECTIVE_PREFIX,
  Directive,
  encodeResult,
  resolveCompletions,
} from "../../src/lib/completion/resolve.ts";

/** Build a representative program: subcommands, an enum option, a dynamic
 * option value, and a positional with a dynamic provider. */
function buildProgram(): Command {
  const program = new Command("mycli");
  const widget = program.command("widget").description("Manage widgets");
  const create = widget.command("create").description("Create a widget");
  create.addOption(new Option("--format <fmt>", "Output format").choices(["json", "csv"]));
  create.option("--env <name>", "Target environment"); // dynamic via lookup
  widget.command("list").description("List widgets");
  const deploy = program.command("deploy <target>").description("Deploy a target"); // positional → dynamic
  void deploy;
  return program;
}

/** Lookup: --env on `widget create` and the `deploy` positional are dynamic. */
const lookup: CompletionContextLookup = (key) => {
  if (key.commandPath === "widget create" && key.option === "--env") return "envs";
  if (key.commandPath === "deploy" && key.positional === 0) return "targets";
  return undefined;
};

const runProvider = async (provider: string): Promise<string[]> => {
  if (provider === "envs") return ["staging", "prod"];
  if (provider === "targets") return ["api", "web"];
  return [];
};

const resolve = (words: string[], cword: number) =>
  resolveCompletions(buildProgram(), words, cword, lookup, runProvider);

describe("resolveCompletions", () => {
  test("top-level subcommands at root", async () => {
    const r = await resolve(["mycli", ""], 1);
    const names = r.candidates.map((c) => c.value);
    expect(names).toContain("widget");
    expect(names).toContain("deploy");
    expect(r.directive).toBe(Directive.Default);
    // descriptions ride along for zsh/fish
    expect(r.candidates.find((c) => c.value === "widget")?.description).toBe("Manage widgets");
  });

  test("nested subcommands under a path", async () => {
    const r = await resolve(["mycli", "widget", ""], 2);
    const names = r.candidates.map((c) => c.value);
    expect(names.sort()).toEqual(["create", "list"]);
  });

  test("option names when cur starts with -", async () => {
    const r = await resolve(["mycli", "widget", "create", "-"], 3);
    const names = r.candidates.map((c) => c.value);
    expect(names).toContain("--format");
    expect(names).toContain("--env");
    expect(names).toContain("--help");
  });

  test("enum option value after --format", async () => {
    const r = await resolve(["mycli", "widget", "create", "--format", ""], 4);
    expect(r.candidates.map((c) => c.value).sort()).toEqual(["csv", "json"]);
    expect(r.directive).toBe(Directive.Default);
  });

  test("dynamic option value invokes the provider", async () => {
    const r = await resolve(["mycli", "widget", "create", "--env", ""], 4);
    expect(r.candidates.map((c) => c.value).sort()).toEqual(["prod", "staging"]);
  });

  test("dynamic positional invokes the provider", async () => {
    const r = await resolve(["mycli", "deploy", ""], 2);
    expect(r.candidates.map((c) => c.value).sort()).toEqual(["api", "web"]);
  });

  test("path resolution skips an option and its value", async () => {
    // `mycli widget create --format json <cursor>` → no positional/subcommand → file fallback
    const r = await resolve(["mycli", "widget", "create", "--format", "json", ""], 5);
    expect(r.candidates).toHaveLength(0);
    expect(r.directive).toBe(Directive.File);
  });

  test("unknown leading token keeps path at root (re-suggests root subcommands)", async () => {
    const r = await resolve(["mycli", "bogus", ""], 2);
    // 'bogus' isn't a known subcommand, so path stays root; root still has
    // subcommands, so we re-suggest them (mirrors the static bash driver).
    const names = r.candidates.map((c) => c.value);
    expect(names).toContain("widget");
    expect(r.directive).toBe(Directive.Default);
  });
});

describe("encodeResult", () => {
  test("emits value\\tdescription lines + trailing directive", () => {
    const out = encodeResult({
      candidates: [{ value: "get", description: "read" }, { value: "set" }],
      directive: Directive.Default,
    });
    const lines = out.trimEnd().split("\n");
    expect(lines[0]).toBe("get\tread");
    expect(lines[1]).toBe("set");
    expect(lines[2]).toBe(`${DIRECTIVE_PREFIX}0`);
  });

  test("file directive encodes as 1", () => {
    const out = encodeResult({ candidates: [], directive: Directive.File });
    expect(out.trimEnd()).toBe(`${DIRECTIVE_PREFIX}1`);
  });
});

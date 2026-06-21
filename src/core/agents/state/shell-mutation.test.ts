import { describe, expect, test } from "bun:test";
import { shellMutationPaths } from "./shell-mutation.ts";

describe("shellMutationPaths", () => {
  test("empty command returns empty array", () => {
    expect(shellMutationPaths("")).toEqual([]);
  });

  test("simple output redirection > path", () => {
    expect(shellMutationPaths("echo hi > docs/out.txt")).toEqual(["docs/out.txt"]);
  });

  test("append redirection >> path", () => {
    expect(shellMutationPaths("echo hi >> log.txt")).toEqual(["log.txt"]);
  });

  test("multiple redirections in one command", () => {
    expect(shellMutationPaths("echo a > a.txt; echo b >> b.txt")).toEqual(["a.txt", "b.txt"]);
  });

  test("touch picks up the path", () => {
    expect(shellMutationPaths("touch /tmp/x.txt")).toEqual(["/tmp/x.txt"]);
  });

  test("cp picks up the source (heuristic single-arg behavior, matches bash)", () => {
    // The bash version's grep+awk pair captures only up to the first whitespace
    // after the command name, so `cp src dest` yields `src`. Port preserves
    // that behavior, purely a heuristic warn-only signal.
    expect(shellMutationPaths("cp foo.ts bar.ts")).toEqual(["foo.ts"]);
  });

  test("strips ./ prefix", () => {
    expect(shellMutationPaths("touch ./docs/x.md")).toEqual(["docs/x.md"]);
  });

  test("strips coordRoot prefix from absolute paths", () => {
    expect(shellMutationPaths("echo hi > /repo/docs/out.txt", "/repo")).toEqual(["docs/out.txt"]);
  });

  test("leaves non-root absolute paths intact", () => {
    expect(shellMutationPaths("touch /etc/hosts", "/repo")).toEqual(["/etc/hosts"]);
  });

  test("redirection does not match inside quotes if path has quote chars", () => {
    // Regex excludes ", ', `
    expect(shellMutationPaths('echo hi > "out path.txt"')).toEqual([]);
  });

  test("ignores commands not in the mutator list", () => {
    expect(shellMutationPaths("cat foo.txt; ls -la /tmp")).toEqual([]);
  });

  test("sed -i.bak still matches via \\S* suffix", () => {
    // The bash version matches `sed -i\S*` so `sed -i.bak` is still detected.
    // Output is the captured next token, which is the sed expression itself
    // (intentional heuristic, matches bash behavior).
    const out = shellMutationPaths("sed -i.bak s/a/b/ docs/file.md");
    expect(out.length).toBeGreaterThan(0);
  });

  test("redirection stops at semicolon", () => {
    expect(shellMutationPaths("echo hi > a.txt; rm b.txt")).toEqual(["a.txt"]);
  });
});

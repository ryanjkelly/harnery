import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { removeDir } from "../helpers/remove-dir.ts";

const root = resolve(import.meta.dir, "../..");
const scratch: string[] = [];

afterEach(() => {
  for (const path of scratch.splice(0)) removeDir(path);
});

// Run the real orchestration with child processes stubbed out. No partition's
// tests or dashboard build execute in these runner regressions.
function runRunner(
  args: string[] = [],
  options: { dependencies?: boolean; failWeb?: boolean } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "test-runner-"));
  scratch.push(dir);
  const preload = join(dir, "preload.mjs");
  writeFileSync(
    preload,
    `import cp from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const exists = fs.existsSync;
fs.existsSync = (path) => String(path) === ${JSON.stringify(join(root, "web/node_modules"))}
  ? ${options.dependencies ?? true} : exists(path);
cp.spawnSync = (command, args, options) => {
  if (command === "pgrep") return { status: 1, stdout: "" };
  process.stdout.write("child: " + JSON.stringify({ args, cwd: options.cwd }) + "\\n");
  return { status: ${options.failWeb ?? false} && options.cwd === ${JSON.stringify(join(root, "web"))} ? 7 : 0 };
};
syncBuiltinESMExports();
`,
  );
  // Node takes a URL for --import; a bare Windows path reads as an unknown "c:" scheme.
  const result = spawnSync(
    "node",
    ["--import", pathToFileURL(preload).href, "scripts/test.mjs", ...args],
    {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  if (result.error) throw result.error;
  const children = result.stdout
    .split("\n")
    .filter((line) => line.startsWith("child: "))
    .map((line) => JSON.parse(line.slice(7)) as { args: string[]; cwd: string });
  return { status: result.status, output: result.stdout, stderr: result.stderr, children };
}

describe("full test runner dashboard partition", () => {
  test("lists the whole dashboard partition without running children", () => {
    const result = runRunner(["--list"]);
    expect(result.status).toBe(0);
    expect(result.children).toHaveLength(0);
    expect(result.output).toMatch(/dashboard test partition: \d+ files/);
    expect(result.output).not.toContain("dashboard reader test partition");
  });

  test("runs dashboard discovery from web in one process and reports its timing", () => {
    const result = runRunner();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.children.filter((child) => child.cwd === join(root, "web"))).toEqual([
      { cwd: join(root, "web"), args: ["test", "--timeout", "15000"] },
    ]);
    expect(
      result.children.every((child) => !child.args.some((arg) => arg.startsWith("web/"))),
    ).toBe(true);
    expect(result.output).toMatch(/- dashboard test partition: \S+ \(\d+ files\)/);
    expect(result.children.flatMap((child) => child.args)).not.toContain("build");
  });

  test("skips missing dashboard dependencies and keeps running", () => {
    const result = runRunner([], { dependencies: false });
    expect(result.status).toBe(0);
    expect(result.children.every((child) => child.cwd === root)).toBe(true);
    expect(result.children.length).toBeGreaterThan(0);
    expect(result.output).toContain(
      "dashboard test partition skipped: web/node_modules is missing; run `cd web && bun install` to enable it.",
    );
    expect(result.output).toMatch(/- dashboard test partition: skipped \(\d+ files\)/);
  });

  test("fails immediately when dashboard tests fail", () => {
    const result = runRunner([], { failWeb: true });
    expect(result.status).toBe(7);
    expect(result.children).toHaveLength(1);
    expect(result.output).toContain("dashboard test partition failed");
  });

  test("keep-going includes dashboard failure in the final report", () => {
    const result = runRunner(["--keep-going"], { failWeb: true });
    expect(result.status).toBe(1);
    expect(result.children.some((child) => child.cwd === root)).toBe(true);
    expect(result.output).toContain("=== Test partition timings (slowest first) ===");
    expect(result.output).toContain("=== Failed partitions ===\n- dashboard test partition");
  });
});

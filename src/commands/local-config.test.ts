import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeDir } from "../../tests/helpers/remove-dir.ts";
import { localConfigChecks } from "./doctor.ts";
import { ensureLocalConfigIgnored } from "./init.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) removeDir(d);
});

function root(): string {
  const r = mkdtempSync(join(tmpdir(), "harnery-localcfg-"));
  dirs.push(r);
  mkdirSync(join(r, ".harnery"), { recursive: true });
  return r;
}

function gitRoot(): string {
  const r = root();
  spawnSync("git", ["init", "-q", r]);
  return r;
}

describe("doctor local config line", () => {
  test("silent when no local file exists", () => {
    expect(localConfigChecks(root())).toEqual([]);
  });

  test("names the top-level keys the local file sets", () => {
    const r = root();
    writeFileSync(
      join(r, ".harnery", "config.local.jsonc"),
      `{ "presence": { "remote_detail": "summary" }, "admission": {} }`,
    );
    const [check] = localConfigChecks(r);
    expect(check?.severity).toBe("ok");
    expect(check?.detail).toContain("admission, presence");
  });

  test("warns when the local file is present but unusable", () => {
    const r = root();
    writeFileSync(join(r, ".harnery", "config.local.jsonc"), "{ nope");
    expect(localConfigChecks(r)[0]?.severity).toBe("warn");
  });
});

describe("init keeps the local config out of git", () => {
  test("adds the entry when the host commits parts of .harnery/", () => {
    const r = gitRoot();
    writeFileSync(join(r, ".harnery", ".gitignore"), "!config.jsonc");
    expect(ensureLocalConfigIgnored(r, true)).toContain("would add");
    expect(ensureLocalConfigIgnored(r, false)).toContain("added");
    expect(readFileSync(join(r, ".harnery", ".gitignore"), "utf8")).toBe(
      "!config.jsonc\nconfig.local.jsonc\n",
    );
    // Now ignored, so a second run changes nothing.
    expect(ensureLocalConfigIgnored(r, false)).toBeNull();
  });

  test("leaves a host that already ignores .harnery/* alone", () => {
    const r = gitRoot();
    writeFileSync(join(r, ".harnery", ".gitignore"), "*\n!.gitignore\n");
    expect(ensureLocalConfigIgnored(r, false)).toBeNull();
    expect(readFileSync(join(r, ".harnery", ".gitignore"), "utf8")).toBe("*\n!.gitignore\n");
  });

  test("does nothing outside a git checkout", () => {
    expect(ensureLocalConfigIgnored(root(), false)).toBeNull();
  });
});

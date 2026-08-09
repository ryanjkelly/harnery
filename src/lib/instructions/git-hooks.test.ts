import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyGitHooks,
  checkGitHooks,
  GIT_HOOK_EVENTS,
  removeGitHooks,
  renderGitHookBody,
  resolveHooksDir,
} from "./git-hooks.ts";

let repo: string;

function sh(args: string[], cwd: string): void {
  const r = spawnSync(args[0]!, args.slice(1), { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${args.join(" ")}: ${r.stderr}`);
}

beforeEach(() => {
  repo = join(
    tmpdir(),
    `git-hooks-lifecycle-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(repo, { recursive: true });
  sh(["git", "init", "--quiet", "-b", "main"], repo);
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("resolveHooksDir", () => {
  test("default layout resolves to .git/hooks", () => {
    expect(resolveHooksDir(repo)).toBe(join(repo, ".git", "hooks"));
  });

  test("honors a relative core.hooksPath", () => {
    sh(["git", "config", "core.hooksPath", "scripts/hooks"], repo);
    expect(resolveHooksDir(repo)).toBe(join(repo, "scripts", "hooks"));
  });

  test("non-repo yields null", () => {
    const dir = join(tmpdir(), `no-repo-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    try {
      expect(resolveHooksDir(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("lifecycle: apply → check → remove", () => {
  test("virgin repo: init creates owned executable hooks, check is fresh, deinit deletes them", () => {
    const applied = applyGitHooks(repo, {});
    expect(applied.actions.filter((a) => a.startsWith("+ created")).length).toBe(3);

    for (const event of GIT_HOOK_EVENTS) {
      const file = join(repo, ".git", "hooks", event);
      expect(existsSync(file)).toBe(true);
      expect(statSync(file).mode & 0o111).toBeGreaterThan(0); // executable
      const content = readFileSync(file, "utf8");
      expect(content.startsWith("#!/bin/sh\n")).toBe(true);
      expect(content).toContain(`git-hook ${event}`);
    }

    expect(checkGitHooks(repo).status).toBe("fresh");

    const removed = removeGitHooks(repo, {});
    expect(removed.actions.filter((a) => a.startsWith("+ removed")).length).toBe(3);
    for (const event of GIT_HOOK_EVENTS) {
      expect(existsSync(join(repo, ".git", "hooks", event))).toBe(false);
    }
  });

  test("host-authored hook: region inserted after shebang, host content preserved through remove", () => {
    const hooksDir = join(repo, ".git", "hooks");
    mkdirSync(hooksDir, { recursive: true });
    const hostContent = '#!/bin/bash\nset -uo pipefail\n\necho "host typecheck"\n';
    writeFileSync(join(hooksDir, "pre-commit"), hostContent);

    applyGitHooks(repo, {});
    const withRegion = readFileSync(join(hooksDir, "pre-commit"), "utf8");
    expect(withRegion).toContain("# harnery:begin git-hook-pre-commit");
    expect(withRegion).toContain('echo "host typecheck"');
    // region sits above the host content (after shebang)
    expect(withRegion.indexOf("harnery:begin")).toBeLessThan(withRegion.indexOf("host typecheck"));

    removeGitHooks(repo, {});
    const after = readFileSync(join(hooksDir, "pre-commit"), "utf8");
    expect(after).toContain('echo "host typecheck"');
    expect(after).not.toContain("harnery:begin");
    expect(existsSync(join(hooksDir, "pre-commit"))).toBe(true); // host file kept
  });

  test("stale region is reported by check and refreshed by apply", () => {
    applyGitHooks(repo, {});
    const file = join(repo, ".git", "hooks", "pre-commit");
    // simulate an older harnery's region: mangle the body inside the markers
    const original = readFileSync(file, "utf8");
    const mangled = original.replace("git-hook pre-commit", "old-subcommand pre-commit");
    expect(mangled).not.toBe(original); // the mangle must actually land
    writeFileSync(file, mangled);

    const check = checkGitHooks(repo);
    expect(check.status).toBe("stale");
    expect(check.issues.some((i) => i.includes("pre-commit"))).toBe(true);

    applyGitHooks(repo, {});
    expect(checkGitHooks(repo).status).toBe("fresh");
    expect(readFileSync(file, "utf8")).toContain("git-hook pre-commit");
  });

  test("missing hook file is drift", () => {
    applyGitHooks(repo, {});
    rmSync(join(repo, ".git", "hooks", "post-commit"));
    const check = checkGitHooks(repo);
    expect(check.status).toBe("missing");
    expect(check.issues.some((i) => i.includes("post-commit"))).toBe(true);
  });

  test("dry-run writes nothing", () => {
    const r = applyGitHooks(repo, { dryRun: true });
    expect(r.actions.every((a) => a.includes("would"))).toBe(true);
    for (const event of GIT_HOOK_EVENTS) {
      expect(existsSync(join(repo, ".git", "hooks", event))).toBe(false);
    }
  });
});

describe("renderGitHookBody", () => {
  test("pre-commit propagates exit codes; post hooks swallow them", () => {
    expect(renderGitHookBody("pre-commit")).toContain("exit ");
    expect(renderGitHookBody("post-commit")).toContain("|| true");
    expect(renderGitHookBody("post-checkout")).toContain("|| true");
  });

  test("covers both consumer layouts", () => {
    const body = renderGitHookBody("pre-commit");
    expect(body).toContain("/harnery/bin/agent-coord");
    expect(body).toContain("/node_modules/harnery/bin/agent-coord");
  });
});

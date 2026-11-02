import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyGitHooks,
  checkGitHooks,
  GIT_HOOK_EVENTS,
  hookTargets,
  removeGitHooks,
  renderGitHookBody,
  resolveHooksDir,
} from "./git-hooks.ts";

let repo: string;

function sh(args: string[], cwd: string): void {
  const r = spawnSync(args[0]!, args.slice(1), { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${args.join(" ")}: ${r.stderr}`);
}

/**
 * The shell Git runs hooks with. On Windows that is Git's own `sh.exe`, which
 * is often not on PATH; it sits three levels above `git --exec-path`.
 */
function hookShell(): string {
  if (process.platform !== "win32") return "sh";
  const execPath = spawnSync("git", ["--exec-path"], { encoding: "utf8" }).stdout.trim();
  const gitSh = join(execPath, "..", "..", "..", "bin", "sh.exe");
  return existsSync(gitSh) ? gitSh : "sh";
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
      if (process.platform !== "win32") expect(statSync(file).mode & 0o111).toBeGreaterThan(0);
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

  test("is identical on every platform, so a shared checkout never flips", () => {
    const real = process.platform;
    const bodies = ["win32", "linux", "darwin"].map((platform) => {
      Object.defineProperty(process, "platform", { value: platform });
      try {
        return renderGitHookBody("pre-commit");
      } finally {
        Object.defineProperty(process, "platform", { value: real });
      }
    });
    expect(new Set(bodies).size).toBe(1);
    expect(bodies[0]).toContain('node "$harnery_hook_bin.mjs"');
  });

  test("the region runs the guard through sh with node or the POSIX launcher", () => {
    // Execute the rendered region against a fake project whose agent-coord
    // launchers record how they were called.
    const project = join(repo, "project");
    const bin = join(project, "harnery", "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(
      join(bin, "agent-coord.mjs"),
      'import { writeFileSync } from "node:fs"; writeFileSync(process.env.HOOK_OUT, "mjs " + process.argv.slice(2).join(" "));\n',
    );
    sh(["git", "init", "--quiet", "-b", "main"], project);
    const script = join(project, "hook.sh");
    writeFileSync(script, `#!/bin/sh\n${renderGitHookBody("post-commit")}\n`);
    const out = join(repo, "hook-out.txt");
    const r = spawnSync(hookShell(), [script], {
      cwd: project,
      env: { ...process.env, HOOK_OUT: out },
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    expect(readFileSync(out, "utf8")).toBe("mjs git-hook post-commit");
  });
});

describe("adoption-aware check (upgrade safety)", () => {
  test("a project that never installed git hooks reports fresh, not drift", () => {
    // No hook files at all — the upgraded-but-not-adopted consumer.
    expect(checkGitHooks(repo).status).toBe("fresh");
    expect(checkGitHooks(repo).issues).toEqual([]);
  });

  test("host-authored hooks without regions still report fresh", () => {
    const hooksDir = join(repo, ".git", "hooks");
    mkdirSync(hooksDir, { recursive: true });
    writeFileSync(join(hooksDir, "pre-commit"), "#!/bin/sh\necho host only\n");
    expect(checkGitHooks(repo).status).toBe("fresh");
  });

  test("partial adoption is drift: one region present, others missing", () => {
    applyGitHooks(repo, {});
    rmSync(join(repo, ".git", "hooks", "post-commit"));
    rmSync(join(repo, ".git", "hooks", "post-checkout"));
    const check = checkGitHooks(repo);
    expect(check.status).toBe("missing");
    expect(check.issues.length).toBe(2);
  });
});

describe("submodules", () => {
  // A parent with one checked-out submodule at sub/, built from a local repo.
  function addSubmodule(): string {
    const source = `${repo}-source`;
    mkdirSync(source, { recursive: true });
    sh(["git", "init", "--quiet", "-b", "main"], source);
    sh(
      [
        "git",
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@t",
        "commit",
        "--quiet",
        "--allow-empty",
        "-m",
        "init",
      ],
      source,
    );
    sh(
      ["git", "-c", "protocol.file.allow=always", "submodule", "--quiet", "add", source, "sub"],
      repo,
    );
    return join(repo, "sub");
  }

  afterEach(() => {
    rmSync(`${repo}-source`, { recursive: true, force: true });
  });

  test("init installs the regions in the submodule's own hooks dir; check and deinit cover it", () => {
    const sub = addSubmodule();
    const subHooks = resolveHooksDir(sub)!;
    expect(hookTargets(repo)).toHaveLength(2);

    applyGitHooks(repo, {});
    for (const event of GIT_HOOK_EVENTS) {
      expect(readFileSync(join(subHooks, event), "utf8")).toContain(
        `harnery:begin git-hook-${event}`,
      );
    }
    expect(checkGitHooks(repo).status).toBe("fresh");

    rmSync(join(subHooks, "pre-commit"));
    const check = checkGitHooks(repo);
    expect(check.status).toBe("missing");
    expect(check.issues.join("\n")).toContain("modules");

    applyGitHooks(repo, {});
    removeGitHooks(repo, {});
    for (const event of GIT_HOOK_EVENTS) expect(existsSync(join(subHooks, event))).toBe(false);
  });

  test("a submodule sharing the project's hooks dir is one target", () => {
    const sub = addSubmodule();
    sh(["git", "config", "core.hooksPath", resolveHooksDir(repo)!.replaceAll("\\", "/")], sub);
    expect(hookTargets(repo)).toHaveLength(1);
  });

  test("an uninitialized submodule is skipped", () => {
    addSubmodule();
    sh(
      ["git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", "add sub"],
      repo,
    );
    sh(["git", "submodule", "--quiet", "deinit", "-f", "sub"], repo);
    expect(hookTargets(repo)).toHaveLength(1);
  });
});

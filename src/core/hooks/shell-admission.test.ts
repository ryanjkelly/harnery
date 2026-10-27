import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  admissionHookOutput,
  admissionRewriteForTool,
  BASH_TIMEOUT_MAX_MS,
  rewriteHeavyCommand,
} from "./shell-admission.ts";

const wrapped = (command: string): string | null => rewriteHeavyCommand(command, "HS");

const HEAVY = [
  "npx tsc --noEmit -p .",
  "tsc --noEmit",
  "tsc -b",
  "./node_modules/.bin/tsc --noEmit",
  "node node_modules/typescript/bin/tsc -p .",
  "bunx tsc --noEmit",
  "bun x tsc",
  "pnpm exec tsc --noEmit",
  "yarn tsc",
  "npm exec -- tsc -p .",
  "npx -p typescript tsc",
  "timeout 590 npx tsc --noEmit -p .",
  "timeout -s KILL 600 npx tsc --noEmit",
  "nice -n 10 npx tsc",
  "CI=1 NODE_OPTIONS=--max-old-space-size=4096 npx tsc --noEmit",
  "cd app && npx tsc --noEmit -p . 2>&1 | tail -20",
  "bun test",
  "bun test --bail",
  "bun test --timeout 30000",
  "bun run test",
  "bun run --cwd pkg test",
  "bun run build",
  "bun run typecheck",
  "bun typecheck",
  "npm test",
  "npm run build",
  "pnpm build",
  "yarn test",
  "next build",
  "npx next build",
  "bash -lc 'cd app && npx tsc --noEmit'",
  "if npx tsc --noEmit; then echo ok; fi",
  "time npx tsc --noEmit",
  "echo start; npx tsc --noEmit\necho done",
  "x=1; (cd app && bun run build)",
  "echo $(npx tsc --noEmit | wc -l)",
  // A path that merely contains a wrapper's name is not a wrapper.
  "cd /tmp/heavy-slot-demo && npx tsc --noEmit -p . ; echo tsc-exit=$?",
  "cat docs/admission-run.md; bun test",
];

const LIGHT = [
  "npx tsc --version",
  "tsc -v",
  "tsc --help",
  "npx tsc --init",
  "tsc -w",
  "npx tsc --watch",
  "bun test src/foo.test.ts",
  "bun test lib/",
  "bun test --watch",
  "bun run test src/x.test.ts",
  "bun run --cwd pkg test src/x.test.ts",
  "bun run dev",
  "bun build ./src/index.ts --outdir dist",
  "bun install",
  "bun run src/script.ts",
  "npm install",
  "npm run dev",
  "npx prettier --check .",
  "next dev",
  "npx next lint",
  'echo "npx tsc --noEmit"',
  "grep -rn tsc .",
  "which tsc",
  "command -v tsc",
  "type tsc",
  "ls tsc",
  "git commit -m 'run npx tsc'",
  "cat <<'EOF' > notes.md\nnpx tsc --noEmit\nEOF",
  "# npx tsc\nls",
  "heavy-slot -- npx tsc --noEmit -p .",
  "/home/x/bin/heavy-slot --label t -- bun test",
  "harn admission run --resource build -- npx tsc --noEmit",
  "cd app && CI=1 harn admission run --resource build -- bun test",
  "HARNERY_ADMISSION_SKIP=1 npx tsc --noEmit",
  "cat package.json | grep build",
  "for f in a b; do bun test $f; done",
];

describe("heavy command detection", () => {
  for (const command of HEAVY) {
    test(`wraps ${JSON.stringify(command)}`, () => {
      expect(wrapped(command)).not.toBeNull();
    });
  }
  for (const command of LIGHT) {
    test(`passes ${JSON.stringify(command)}`, () => {
      expect(wrapped(command)).toBeNull();
    });
  }
});

describe("rewrite", () => {
  test("bare typecheck", () => {
    expect(wrapped("npx tsc --noEmit -p .")).toBe(
      "HS --label 'agent: npx tsc --noEmit -p .' -- npx tsc --noEmit -p .",
    );
  });

  test("only the heavy segment is wrapped", () => {
    expect(wrapped("cd app && timeout 590 npx tsc --noEmit -p . 2>&1 | tail -20")).toBe(
      "cd app && HS --label 'agent: timeout 590 npx tsc --noEmit -p .' -- " +
        "timeout 590 npx tsc --noEmit -p . 2>&1 | tail -20",
    );
  });

  test("assignments stay in front", () => {
    expect(wrapped("CI=1 bun test")).toBe("CI=1 HS --label 'agent: bun test' -- bun test");
  });

  test("a shell keyword stays in front", () => {
    expect(wrapped("time npx tsc")).toBe("time HS --label 'agent: time npx tsc' -- npx tsc");
  });

  test("each heavy segment gets its own slot", () => {
    expect(wrapped("npx tsc -p a && npx tsc -p b")).toBe(
      "HS --label 'agent: npx tsc -p a' -- npx tsc -p a && " +
        "HS --label 'agent: npx tsc -p b' -- npx tsc -p b",
    );
  });

  test("shell -c wraps the shell", () => {
    const out = wrapped("bash -lc 'npx tsc'") ?? "";
    expect(out.startsWith("HS --label ")).toBe(true);
    expect(out.endsWith(" -- bash -lc 'npx tsc'")).toBe(true);
  });

  test("a heredoc body is left alone", () => {
    expect(wrapped("cat <<'EOF' > a.md\nnpx tsc\nEOF\nnpx tsc --noEmit")).toBe(
      "cat <<'EOF' > a.md\nnpx tsc\nEOF\nHS --label 'agent: npx tsc --noEmit' -- npx tsc --noEmit",
    );
  });

  test("a long label is trimmed", () => {
    const out = wrapped(`npx tsc --noEmit -p ${"x".repeat(120)}`) ?? "";
    const label = out.split("'")[1] ?? "";
    expect(label.length).toBeLessThanOrEqual(80);
    expect(label.endsWith("~")).toBe(true);
  });
});

describe("tool input shapes", () => {
  test("string cmd keeps other fields", () => {
    const out = admissionRewriteForTool("exec_command", { cmd: "npx tsc", workdir: "/w" }, "HS");
    expect(out?.updatedInput.workdir).toBe("/w");
    expect(String(out?.updatedInput.cmd)).toStartWith("HS --label ");
  });

  test("argv with a shell -c script rewrites only the script", () => {
    const out = admissionRewriteForTool(
      "functions.shell",
      JSON.stringify({ command: ["bash", "-lc", "bun run build"] }),
      "HS",
    );
    const argv = out?.updatedInput.command as string[];
    expect(argv.slice(0, 2)).toEqual(["bash", "-lc"]);
    expect(argv[2]?.endsWith(" -- bun run build")).toBe(true);
  });

  test("a plain argv becomes a bash -c script", () => {
    const out = admissionRewriteForTool("shell", { command: ["npx", "tsc", "-p", "."] }, "HS");
    expect(out?.updatedInput.command).toEqual([
      "bash",
      "-c",
      "HS --label 'agent: npx tsc -p .' -- npx tsc -p .",
    ]);
  });

  test("non-shell tools and light commands are untouched", () => {
    expect(admissionRewriteForTool("Edit", { command: "npx tsc" }, "HS")).toBeNull();
    expect(admissionRewriteForTool("Bash", { command: "ls" }, "HS")).toBeNull();
    expect(admissionRewriteForTool("Bash", "not json", "HS")).toBeNull();
  });
});

describe("hook output", () => {
  const base = { resource: "build", bin: "harn", platform: "linux", projectRoot: "/repo" };

  test("Claude Code: updatedInput, no decision, raised timeout, context note", () => {
    const out = admissionHookOutput({
      ...base,
      adapter: "claude-code",
      toolName: "Bash",
      toolInput: { command: "npx tsc --noEmit -p .", description: "d" },
    });
    const hso = out?.hookSpecificOutput as Record<string, unknown>;
    const updated = hso.updatedInput as Record<string, unknown>;
    expect(hso.hookEventName).toBe("PreToolUse");
    expect(hso.permissionDecision).toBeUndefined();
    expect(updated.command).toBe(
      "harn admission run --resource build --project-root /repo --label 'agent: npx tsc --noEmit -p .' -- npx tsc --noEmit -p .",
    );
    expect(updated.description).toBe("d");
    expect(updated.timeout).toBe(BASH_TIMEOUT_MAX_MS);
    expect(String(hso.additionalContext)).toContain("harn admission status --resource build");
  });

  test("Claude Code keeps a background run's timeout untouched", () => {
    const out = admissionHookOutput({
      ...base,
      adapter: "claude-code",
      toolName: "Bash",
      toolInput: { command: "bun test", run_in_background: true },
    });
    const hso = out?.hookSpecificOutput as Record<string, unknown>;
    expect((hso.updatedInput as Record<string, unknown>).timeout).toBeUndefined();
  });

  test("Codex: allow beside updatedInput, no timeout or context", () => {
    const out = admissionHookOutput({
      ...base,
      adapter: "codex",
      toolName: "exec_command",
      toolInput: { cmd: "npx tsc", workdir: "/w" },
    });
    const hso = out?.hookSpecificOutput as Record<string, unknown>;
    const updated = hso.updatedInput as Record<string, unknown>;
    expect(hso.permissionDecision).toBe("allow");
    expect(updated.workdir).toBe("/w");
    expect(updated.timeout).toBeUndefined();
    expect(hso.additionalContext).toBeUndefined();
  });

  test("passes through when skipped, on other adapters, or on Windows", () => {
    const heavy = { toolName: "Bash", toolInput: { command: "npx tsc --noEmit" } };
    expect(
      admissionHookOutput({ ...base, ...heavy, adapter: "claude-code", skip: true }),
    ).toBeNull();
    expect(admissionHookOutput({ ...base, ...heavy, adapter: "cursor" })).toBeNull();
    expect(admissionHookOutput({ ...base, ...heavy, adapter: "opencode" })).toBeNull();
    expect(
      admissionHookOutput({ ...base, ...heavy, adapter: "codex", platform: "win32" }),
    ).toBeNull();
    expect(
      admissionHookOutput({ ...base, ...heavy, adapter: "codex", cwd: "\\\\wsl.localhost\\x" }),
    ).toBeNull();
    expect(
      admissionHookOutput({ ...base, ...heavy, adapter: "codex", cwd: "C:\\repo" }),
    ).toBeNull();
  });

  test("a bin name that needs quoting is quoted", () => {
    const out = admissionHookOutput({
      ...base,
      bin: "my cli",
      adapter: "codex",
      toolName: "exec_command",
      toolInput: { cmd: "bun test" },
    });
    const hso = out?.hookSpecificOutput as Record<string, unknown>;
    expect(String((hso.updatedInput as Record<string, unknown>).cmd)).toStartWith(
      "'my cli' admission run --resource build ",
    );
  });
});

describe("rewritten command execution", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  test("a stub wrapper keeps cd, pipes, and the exit code", () => {
    const root = mkdtempSync(join(tmpdir(), "shell-admission-"));
    roots.push(root);
    const bin = join(root, "fakebin");
    mkdirSync(bin);
    mkdirSync(join(root, "sub"));
    const log = join(root, "slot.log");
    const stub = join(bin, "slot");
    writeFileSync(
      stub,
      '#!/usr/bin/env bash\nprintf "%s\\n" "$*" >> "$SLOT_LOG"\n' +
        'while [ "$1" != "--" ]; do shift; done; shift\nHELD=1 exec "$@"\n',
    );
    chmodSync(stub, 0o755);
    writeFileSync(join(bin, "npx"), '#!/usr/bin/env bash\necho "ran $* held=$HELD"; exit 3\n');
    chmodSync(join(bin, "npx"), 0o755);
    const command = rewriteHeavyCommand(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion
      "cd sub && npx tsc --noEmit -p . | tr a-z A-Z; echo rc=${PIPESTATUS[0]} dir=${PWD##*/}",
      stub,
    );
    expect(command).not.toBeNull();
    const out = spawnSync("bash", ["-c", command as string], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, SLOT_LOG: log },
    });
    expect(out.stdout).toBe("RAN TSC --NOEMIT -P . HELD=1\nrc=3 dir=sub\n");
    expect(readFileSync(log, "utf8")).toBe(
      "--label agent: npx tsc --noEmit -p . -- npx tsc --noEmit -p .\n",
    );
  });
});

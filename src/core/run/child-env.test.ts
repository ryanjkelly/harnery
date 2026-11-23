import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { plantFakeCli } from "../../../tests/helpers/fake-cli.ts";
import { removeDir } from "../../../tests/helpers/remove-dir.ts";
import { buildAllowListedChildEnv, buildChildEnv, type ChildEnvOpts } from "./child-env.ts";
import { codexSpawner } from "./spawn-codex.ts";

const PARENT_VARS: Record<string, string> = {
  HARNERY_CHILD_ENV_TEST_PLAIN: "plain",
  CLAUDE_CHILD_ENV_TEST: "session",
  CODEX_CHILD_ENV_TEST: "session",
  CODEX_HOME: "/codex-home",
  OPENAI_API_KEY: "sk-test",
  ANTHROPIC_API_KEY: "sk-ant-test",
  CURSOR_API_KEY: "cursor-test",
  AWS_SECRET_ACCESS_KEY: "aws-secret",
};

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const [k, v] of Object.entries(PARENT_VARS)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/** The rules buildChildEnv followed before the allow-list option existed. */
function previousRules(
  runId: string | undefined,
  opts: { subscriptionOnly?: boolean; agentId?: string },
): Record<string, string> {
  const keyVars = new Set(["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "CURSOR_API_KEY"]);
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (opts.subscriptionOnly && keyVars.has(k)) continue;
    if (
      ["CLAUDE", "CODEX", "CURSOR"].some((p) => k.startsWith(p)) &&
      !keyVars.has(k) &&
      k !== "CODEX_HOME"
    )
      continue;
    env[k] = v;
  }
  env.HARNERY_WORKFLOW_CHILD = "1";
  if (runId) env.HARNERY_WORKFLOW_RUN_ID = runId;
  if (opts.agentId) env.HARNERY_WORKFLOW_AGENT_ID = opts.agentId;
  return env;
}

describe("buildChildEnv without an allow-list is unchanged", () => {
  const cases: [string, string | undefined, ChildEnvOpts][] = [
    ["defaults", undefined, {}],
    ["run and agent ids", "run-1", { agentId: "a1" }],
    ["subscription only", "run-2", { subscriptionOnly: true }],
    ["explicit undefined allow-list", undefined, { allowList: undefined }],
  ];
  for (const [label, runId, opts] of cases) {
    test(label, () => {
      expect(buildChildEnv(runId, opts)).toEqual(previousRules(runId, opts));
    });
  }
});

describe("buildChildEnv with an allow-list", () => {
  test("copies only the named variables, the codex home and the set values", () => {
    const env = buildChildEnv("run-1", {
      subscriptionOnly: true,
      agentId: "a1",
      allowList: {
        names: ["HARNERY_CHILD_ENV_TEST_PLAIN", "MISSING_NAME"],
        set: { HARNERY_SCHEDULE_CHILD: "1" },
      },
    });
    expect(env).toEqual({
      HARNERY_CHILD_ENV_TEST_PLAIN: "plain",
      CODEX_HOME: "/codex-home",
      HARNERY_SCHEDULE_CHILD: "1",
    });
  });

  test("never passes an API-key variable, even when named or set", () => {
    const env = buildAllowListedChildEnv({
      names: ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "CURSOR_API_KEY"],
      set: { OPENAI_API_KEY: "sk-other" },
    });
    expect(env).toEqual({ CODEX_HOME: "/codex-home" });
  });

  test("reads from an injected source instead of the process", () => {
    const env = buildAllowListedChildEnv({
      names: ["PATH", "HOME"],
      source: { PATH: "/bin", HOME: "/h", AWS_SECRET_ACCESS_KEY: "x" },
    });
    expect(env).toEqual({ PATH: "/bin", HOME: "/h" });
  });
});

describe("codex spawner child environment", () => {
  let binDir: string;
  let savedPath: string | undefined;

  beforeEach(() => {
    binDir = mkdtempSync(join(tmpdir(), "child-env-codex-"));
    // The fake writes its own environment as the final message.
    plantFakeCli(
      binDir,
      "codex",
      [
        `import { writeFileSync } from "node:fs";`,
        `const argv = process.argv;`,
        `const out = argv[argv.indexOf("--output-last-message") + 1];`,
        `writeFileSync(out, JSON.stringify({ env: process.env, argv: argv.slice(2) }));`,
      ].join("\n"),
    );
    savedPath = process.env.PATH;
    process.env.PATH = `${binDir}${delimiter}${savedPath ?? ""}`;
  });

  afterEach(() => {
    process.env.PATH = savedPath;
    removeDir(binDir);
  });

  test("an allow-listed request gives the child only the listed names", async () => {
    const result = await codexSpawner({
      prompt: "hi",
      timeoutMs: 20_000,
      maxTurns: 1,
      cwd: tmpdir(),
      subscriptionOnly: true,
      filesystemPolicy: { mode: "read-only" },
      childEnv: {
        names: ["PATH", "HARNERY_CHILD_ENV_TEST_PLAIN"],
        set: { HARNERY_SCHEDULE_CHILD: "1" },
      },
    });
    expect(result.ok).toBe(true);
    const seen = JSON.parse(result.text) as { env: Record<string, string>; argv: string[] };
    expect(seen.env.HARNERY_CHILD_ENV_TEST_PLAIN).toBe("plain");
    expect(seen.env.HARNERY_SCHEDULE_CHILD).toBe("1");
    expect(seen.env.CODEX_HOME).toBe("/codex-home");
    expect(seen.env.OPENAI_API_KEY).toBeUndefined();
    expect(seen.env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(seen.env.HARNERY_WORKFLOW_CHILD).toBeUndefined();
    expect(seen.argv).toContain("read-only");
  }, 30_000);

  test("a request without an allow-list keeps the ordinary environment", async () => {
    const result = await codexSpawner({
      prompt: "hi",
      timeoutMs: 20_000,
      maxTurns: 1,
      cwd: tmpdir(),
    });
    expect(result.ok).toBe(true);
    const seen = JSON.parse(result.text) as { env: Record<string, string> };
    expect(seen.env.AWS_SECRET_ACCESS_KEY).toBe("aws-secret");
    expect(seen.env.OPENAI_API_KEY).toBe("sk-test");
    expect(seen.env.HARNERY_WORKFLOW_CHILD).toBe("1");
    expect(seen.env.CODEX_CHILD_ENV_TEST).toBeUndefined();
  }, 30_000);
});

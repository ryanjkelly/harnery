import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeDir } from "../../../tests/helpers/remove-dir.ts";
import { builtinAdapterProfile } from "../adapters/profiles.ts";
import type { BillingProbe } from "../run/billing.ts";
import type { SpawnRequest, SpawnResult } from "../run/types.ts";
import type { runScheduleGather } from "./gather.ts";
import {
  type ScheduleAgentOutcome,
  type ScheduleClaim,
  type ScheduleEnrollment,
  type ScheduleGatherResult,
  type ScheduleJob,
  type ScheduleLauncher,
  type ScheduleLaunchRequest,
  type ScheduleRunResult,
  validateScheduleRunRecord,
} from "./job-types.ts";
import {
  buildScheduleAgentPrompt,
  launchScheduledJob,
  SCHEDULE_AGENT_MAX_TURNS,
  SCHEDULE_EVIDENCE_PER_OUTPUT_BYTES,
  SCHEDULE_EVIDENCE_PREAMBLE,
  SCHEDULE_EVIDENCE_TOTAL_BYTES,
  type ScheduleLaunchDeps,
} from "./launch.ts";
import { scheduleRunsDir } from "./paths.ts";

const T0 = Date.parse("2026-01-01T06:00:00.000Z");

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "schedule-launch-"));
});

afterEach(() => removeDir(root));

function job(overrides: Partial<ScheduleJob> = {}): ScheduleJob {
  return {
    id: "nightly-check",
    title: "Nightly check",
    host: "box",
    trigger: { type: "every", minutes: 60 },
    timeout_minutes: 10,
    max_launches_per_day: 4,
    ...overrides,
  };
}

function request(j: ScheduleJob, deadlineMs = T0 + 600_000): ScheduleLaunchRequest {
  const enrollment: ScheduleEnrollment = {
    schema_version: 1,
    job_id: j.id,
    job_hash: "0".repeat(64),
    machine: "box",
    checkout: root,
    enrolled_at: "2025-12-01T00:00:00.000Z",
  };
  const claim: ScheduleClaim = {
    schema_version: 1,
    job_id: j.id,
    scheduled_for: "2026-01-01T06:00:00.000Z",
    kind: "scheduled",
    state: "started",
    claimed_at: "2026-01-01T06:00:00.000Z",
    started_at: "2026-01-01T06:00:00.000Z",
    run_id: "run-abc",
  };
  return {
    job: j,
    enrollment,
    claim,
    coordRoot: root,
    deadline_at: new Date(deadlineMs).toISOString(),
  };
}

/** A clock the fakes can advance. */
function clock(start = T0) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

type GatherSpec = { name: string; state: ScheduleGatherResult["state"]; output?: string };

function fakeGather(specs: GatherSpec[], onRun?: () => void): typeof runScheduleGather {
  return async (opts) => {
    onRun?.();
    return specs.map((s) => {
      const output_file = `gather/${s.name}.txt`;
      mkdirSync(join(opts.runDir, "gather"), { recursive: true });
      writeFileSync(join(opts.runDir, output_file), s.output ?? `${s.name} output\n`);
      return {
        name: s.name,
        state: s.state,
        exit_code: s.state === "ok" ? 0 : s.state === "finding" ? 1 : 9,
        duration_ms: 5,
        truncated: false,
        ...(s.state === "error" ? { error: "unexpected exit code 9" } : {}),
        output_file,
      };
    });
  };
}

const subscription: BillingProbe = {
  adapter: "codex",
  apiKeySource: null,
  apiKeyPresent: false,
  login: "present",
  mode: "subscription",
};

function deps(
  spawn: (req: SpawnRequest) => Promise<SpawnResult>,
  extra: Partial<ScheduleLaunchDeps> = {},
): ScheduleLaunchDeps & { calls: SpawnRequest[] } {
  const calls: SpawnRequest[] = [];
  const c = clock();
  return {
    calls,
    now: c.now,
    env: { PATH: "/bin", HOME: "/h", AWS_SECRET_ACCESS_KEY: "x", OPENAI_API_KEY: "sk" },
    probeBilling: () => subscription,
    spawnerFor: () => async (req) => {
      calls.push(req);
      return spawn(req);
    },
    ...extra,
  };
}

const reply =
  (text: string, ok = true, error?: string) =>
  async (): Promise<SpawnResult> => ({
    ok,
    text,
    durationMs: 1,
    ...(error ? { error } : {}),
  });

const agent = { adapter: "codex", model: "gpt-x", effort: "high", prompt: "Judge the checks." };

function readRun(record: { started_at: string }) {
  const stamp = record.started_at.replace(/[-:.]/g, "");
  const dir = join(scheduleRunsDir(root, "nightly-check"), stamp);
  return {
    dir,
    json: JSON.parse(readFileSync(join(dir, "run.json"), "utf8")) as unknown,
    report: readFileSync(join(dir, "report.md"), "utf8"),
  };
}

test("launchScheduledJob satisfies the tick's launcher type", () => {
  const launcher: ScheduleLauncher = launchScheduledJob;
  expect(typeof launcher).toBe("function");
});

describe("gather-only jobs", () => {
  for (const [state, result] of [
    ["ok", "ok"],
    ["finding", "attention"],
    ["error", "failed"],
  ] as const) {
    test(`a gather ${state} makes the run ${result}`, async () => {
      const d = deps(reply("never"));
      const { record } = await launchScheduledJob(
        request(job({ gather: [{ name: "check", argv: ["true"] }] })),
        { ...d, runGather: fakeGather([{ name: "check", state }]) },
      );
      expect(record.result).toBe(result);
      expect(record.agent).toBeNull();
      expect(d.calls).toHaveLength(0);
      const run = readRun(record);
      expect(validateScheduleRunRecord(run.json).ok).toBe(true);
      expect(run.json).toEqual(record);
      expect(run.report).toContain(`# Nightly check: ${result}`);
      expect(run.report).toContain("No agent ran.");
      expect(run.report).toContain(`| check | ${state}`);
    });
  }

  test("a real gather command runs and is reported", async () => {
    const { record } = await launchScheduledJob(
      request(
        job({ gather: [{ name: "real", argv: [process.execPath, "-e", "1"] }] }),
        Date.now() + 30_000,
      ),
      { env: process.env },
    );
    expect(record.gather[0]?.state).toBe("ok");
    expect(record.result).toBe("ok");
  }, 30_000);
});

describe("jobs with an agent", () => {
  const cases: [
    string,
    () => Promise<SpawnResult>,
    ScheduleAgentOutcome["status_line"],
    boolean,
    ScheduleRunResult,
  ][] = [
    ["ok", reply("STATUS: ok\nAll fine."), "ok", true, "ok"],
    ["attention", reply("STATUS: attention\nDisk is full."), "attention", true, "attention"],
    ["garbage", reply("Looks fine to me."), "missing", true, "attention"],
    ["failure", reply("", false, "codex exited 1: boom\nmore"), "missing", false, "failed"],
    [
      "timeout",
      reply("", false, "codex timed out after 600000ms and was killed"),
      "missing",
      false,
      "failed",
    ],
  ];
  for (const [label, spawn, status, ok, result] of cases) {
    test(`a spawner reply of ${label}`, async () => {
      const d = deps(spawn);
      const { record } = await launchScheduledJob(
        request(job({ gather: [{ name: "check", argv: ["true"] }], agent })),
        { ...d, runGather: fakeGather([{ name: "check", state: "ok" }]) },
      );
      expect(record.agent).toMatchObject({ adapter: "codex", ok, status_line: status });
      expect(record.result).toBe(result);
      if (!ok) expect(record.agent?.error).not.toContain("\n");
      const run = readRun(record);
      expect(validateScheduleRunRecord(run.json).ok).toBe(true);
      if (label === "attention") expect(run.report).toContain("STATUS: attention\nDisk is full.");
    });
  }

  test("the spawner gets a read-only, subscription-only, closed-environment request", async () => {
    const d = deps(reply("STATUS: ok"));
    await launchScheduledJob(request(job({ gather: [{ name: "check", argv: ["true"] }], agent })), {
      ...d,
      runGather: fakeGather([{ name: "check", state: "ok", output: "disk 40%\n" }]),
    });
    const req = d.calls[0] as SpawnRequest;
    expect(req.filesystemPolicy).toEqual({ mode: "read-only" });
    expect(req.subscriptionOnly).toBe(true);
    expect(req.cwd).toBe(root);
    expect(req.model).toBe("gpt-x");
    expect(req.effort).toBe("high");
    expect(req.maxTurns).toBe(SCHEDULE_AGENT_MAX_TURNS);
    expect(req.timeoutMs).toBe(600_000);
    expect(req.access).toBeUndefined();
    expect(req.childEnv?.set).toEqual({ HARNERY_SCHEDULE_CHILD: "1" });
    expect(req.childEnv?.names).not.toContain("AWS_SECRET_ACCESS_KEY");
    expect(req.childEnv?.names).not.toContain("OPENAI_API_KEY");
    expect(req.prompt.startsWith("Judge the checks.")).toBe(true);
    expect(req.prompt).toContain(SCHEDULE_EVIDENCE_PREAMBLE);
    expect(req.prompt).toContain("disk 40%");
    expect(req.prompt).toContain("--- gather check");
  });

  test("an agent-only job runs with no gather", async () => {
    const d = deps(reply("STATUS: ok"));
    const { record } = await launchScheduledJob(request(job({ agent })), d);
    expect(record.gather).toEqual([]);
    expect(record.result).toBe("ok");
    expect(d.calls[0]?.prompt).toContain("This job has no gather commands.");
  });

  test("the agent can never clear a finding or an error", async () => {
    for (const [state, result] of [
      ["finding", "attention"],
      ["error", "failed"],
    ] as const) {
      const d = deps(reply("STATUS: ok\nNothing to see."));
      const { record } = await launchScheduledJob(
        request(job({ gather: [{ name: "check", argv: ["true"] }], agent })),
        {
          ...d,
          now: clock(T0 + (state === "error" ? 1 : 0)).now,
          runGather: fakeGather([{ name: "check", state }]),
        },
      );
      expect(record.agent?.status_line).toBe("ok");
      expect(record.result).toBe(result);
    }
  });
});

describe("refusals launch nothing and fail the run", () => {
  async function refusedWith(extra: Partial<ScheduleLaunchDeps>, deadlineMs?: number) {
    const d = deps(reply("STATUS: ok"), extra);
    const { record } = await launchScheduledJob(request(job({ agent }), deadlineMs), d);
    expect(d.calls).toHaveLength(0);
    expect(record.result).toBe("failed");
    expect(record.agent).toMatchObject({ ok: false, status_line: "missing" });
    expect(validateScheduleRunRecord(readRun(record).json).ok).toBe(true);
    return record.agent?.error ?? "";
  }

  test("an adapter with no profile", async () => {
    expect(await refusedWith({ profileFor: () => undefined })).toContain(
      "adapter cannot enforce read-only",
    );
  });

  test("an adapter whose read-only mode is null", async () => {
    const codex = builtinAdapterProfile("codex");
    if (!codex?.sandboxProjection) throw new Error("codex profile changed");
    const profile = {
      ...codex,
      sandboxProjection: {
        ...codex.sandboxProjection,
        modes: { ...codex.sandboxProjection.modes, "read-only": null },
      },
    };
    expect(await refusedWith({ profileFor: () => profile })).toContain(
      "adapter cannot enforce read-only",
    );
  });

  test("the built-in claude-code profile is refused", async () => {
    const d = deps(reply("STATUS: ok"));
    const { record } = await launchScheduledJob(
      request(job({ agent: { adapter: "claude-code", prompt: "x" } })),
      d,
    );
    const projection = builtinAdapterProfile("claude-code")?.sandboxProjection;
    if (!projection?.modes["read-only"]) {
      expect(d.calls).toHaveLength(0);
      expect(record.agent?.error).toContain("adapter cannot enforce read-only");
    }
  });

  test("a billing probe that shows an API key and no stored sign-in", async () => {
    const error = await refusedWith({
      probeBilling: () => ({
        adapter: "codex",
        apiKeySource: "OPENAI_API_KEY",
        apiKeyPresent: true,
        login: "absent",
        mode: "api-key",
      }),
    });
    expect(error).toContain("billing refused");
    expect(error).toContain("API key");
  });

  test("a key stored in place of the sign-in", async () => {
    const error = await refusedWith({
      probeBilling: () => ({
        adapter: "codex",
        apiKeySource: "/c/auth.json (stored key)",
        apiKeyPresent: true,
        login: "absent",
        mode: "api-key",
      }),
    });
    expect(error).toContain("billing refused");
  });

  test("the deadline has already passed", async () => {
    expect(await refusedWith({}, T0 - 1)).toContain("deadline passed");
  });

  test("a key beside a stored sign-in, when the probe can see it", async () => {
    const error = await refusedWith({
      probeBilling: () => ({
        adapter: "codex",
        apiKeySource: "OPENAI_API_KEY",
        apiKeyPresent: true,
        login: "present",
        mode: "api-key-override",
      }),
    });
    expect(error).toContain("would bill an API key");
  });

  test("a sign-in that cannot be read", async () => {
    const error = await refusedWith({
      probeBilling: () => ({ ...subscription, login: "unknown" }),
    });
    expect(error).toContain("could not be confirmed");
  });

  test("a billing probe that throws", async () => {
    const error = await refusedWith({
      probeBilling: () => {
        throw new Error("probe broke");
      },
    });
    expect(error).toContain("billing probe failed: probe broke");
  });

  test("no spawner for the adapter", async () => {
    expect(await refusedWith({ spawnerFor: () => undefined })).toContain("no spawner registered");
  });
});

describe("the default billing probe reads the child's closed environment", () => {
  function codexHome(auth: unknown): string {
    const home = join(root, "codex-home");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "auth.json"), JSON.stringify(auth));
    return home;
  }

  function withoutProbe(
    env: Record<string, string>,
  ): ScheduleLaunchDeps & { calls: SpawnRequest[] } {
    const d = deps(reply("STATUS: ok"), { env });
    delete d.probeBilling;
    return d;
  }

  test("an exported key the child never receives does not refuse a subscription run", async () => {
    const d = withoutProbe({
      PATH: "/bin",
      HOME: "/h",
      OPENAI_API_KEY: "sk-exported",
      CODEX_HOME: codexHome({ tokens: { id_token: "t" } }),
    });
    const { record } = await launchScheduledJob(request(job({ agent })), d);
    expect(d.calls).toHaveLength(1);
    expect(record.result).toBe("ok");
    expect(d.calls[0]?.childEnv?.names).not.toContain("OPENAI_API_KEY");
  });

  test("a key stored in the sign-in file refuses the run", async () => {
    const d = withoutProbe({
      PATH: "/bin",
      HOME: "/h",
      CODEX_HOME: codexHome({ OPENAI_API_KEY: "sk-stored" }),
    });
    const { record } = await launchScheduledJob(request(job({ agent })), d);
    expect(d.calls).toHaveLength(0);
    expect(record.result).toBe("failed");
    expect(record.agent?.error).toContain("would bill an API key");
  });
});

describe("run folders", () => {
  test("two runs of one job in the same millisecond get separate folders", async () => {
    const d = { now: () => T0, runGather: fakeGather([{ name: "check", state: "ok" }]) };
    const r = request(job({ gather: [{ name: "check", argv: ["true"] }] }));
    const one = await launchScheduledJob(r, d);
    const two = await launchScheduledJob(r, d);
    expect(one.record.started_at).toBe("2026-01-01T06:00:00.000Z");
    expect(two.record.started_at).toBe("2026-01-01T06:00:00.001Z");
    expect(Date.parse(two.record.finished_at)).toBeGreaterThanOrEqual(
      Date.parse(two.record.started_at),
    );
    expect(readRun(one.record).json).toEqual(one.record);
    expect(readRun(two.record).json).toEqual(two.record);
  });
});

test("gather and agent share one deadline", async () => {
  const c = clock();
  const d = deps(reply("STATUS: ok"), { now: c.now });
  await launchScheduledJob(
    request(job({ gather: [{ name: "check", argv: ["true"] }], agent }), T0 + 600_000),
    { ...d, runGather: fakeGather([{ name: "check", state: "ok" }], () => c.advance(450_000)) },
  );
  expect(d.calls[0]?.timeoutMs).toBe(150_000);

  const c2 = clock();
  const d2 = deps(reply("STATUS: ok"), { now: c2.now });
  const { record } = await launchScheduledJob(
    request(job({ gather: [{ name: "check", argv: ["true"] }], agent }), T0 + 600_000),
    { ...d2, runGather: fakeGather([{ name: "check", state: "ok" }], () => c2.advance(600_000)) },
  );
  expect(d2.calls).toHaveLength(0);
  expect(record.agent?.error).toContain("deadline passed");
  expect(record.result).toBe("failed");
});

test("an invalid deadline is a caller bug", async () => {
  const r = request(job({ agent }));
  await expect(launchScheduledJob({ ...r, deadline_at: "soon" }, deps(reply("")))).rejects.toThrow(
    "deadline_at",
  );
});

describe("evidence caps", () => {
  const gather = (names: string[]): ScheduleGatherResult[] =>
    names.map((name) => ({
      name,
      state: "ok",
      exit_code: 0,
      duration_ms: 1,
      truncated: false,
      output_file: `gather/${name}.txt`,
    }));

  test("each output is capped at 32 KiB and the section at 96 KiB", () => {
    const sizes: Record<string, number> = { a: 40_000, b: 33_000, c: 33_000, d: 33_000, e: 10 };
    const runDir = join(
      root,
      ".harnery",
      "private",
      "schedule",
      "runs",
      "j",
      "20260101T060000000Z",
    );
    const prompt = buildScheduleAgentPrompt({
      prompt: "P",
      gather: gather(Object.keys(sizes)),
      runDir,
      coordRoot: root,
      marker: "m",
      readOutput: (path) => {
        const name = path.slice(-5, -4);
        return Buffer.from("x".repeat(sizes[name] ?? 0));
      },
    });
    const longestRun = Math.max(...(prompt.match(/x+/g) ?? []).map((m) => m.length));
    expect(longestRun).toBe(SCHEDULE_EVIDENCE_PER_OUTPUT_BYTES);
    const shown = (prompt.match(/x{6,}/g) ?? []).reduce((n, m) => n + m.length, 0);
    expect(shown).toBe(SCHEDULE_EVIDENCE_TOTAL_BYTES);
    expect(prompt).toContain(
      "output cut: showing the first 32768 of 40000 bytes; read .harnery/private/schedule/runs/j/20260101T060000000Z/gather/a.txt for the rest",
    );
    expect(prompt).toContain("output: omitted, the evidence section reached its 98304-byte limit");
    expect(prompt).toContain("===== BEGIN HARNERY EVIDENCE m =====");
    expect(prompt.trimEnd().endsWith("===== END HARNERY EVIDENCE m =====")).toBe(true);
  });

  test("the markers carry a random token so output cannot close the section", () => {
    const one = buildScheduleAgentPrompt({
      prompt: "P",
      gather: [],
      runDir: root,
      coordRoot: root,
    });
    const two = buildScheduleAgentPrompt({
      prompt: "P",
      gather: [],
      runDir: root,
      coordRoot: root,
    });
    expect(one).not.toBe(two);
  });

  test("the preamble states the rules", () => {
    expect(SCHEDULE_EVIDENCE_PREAMBLE).toContain("untrusted");
    expect(SCHEDULE_EVIDENCE_PREAMBLE).toContain("no network");
    expect(SCHEDULE_EVIDENCE_PREAMBLE).toContain("`STATUS: ok` or `STATUS: attention`");
  });
});

test("runs are pruned to the newest twenty after each launch", async () => {
  const c = clock();
  for (let i = 0; i < 22; i++) {
    c.advance(1000);
    await launchScheduledJob(
      request(job({ gather: [{ name: "check", argv: ["true"] }] }), T0 + 10_000_000),
      { now: c.now, runGather: fakeGather([{ name: "check", state: "ok" }]) },
    );
  }
  const { readdirSync } = await import("node:fs");
  const names = readdirSync(scheduleRunsDir(root, "nightly-check")).sort();
  expect(names).toHaveLength(20);
  expect(names[0]).toBe("20260101T060003000Z");
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import type { EmitContext } from "../commander.ts";
import { registerAdmissionCommand } from "./admission.ts";

interface CapturedEmit {
  emit: EmitContext;
  data: unknown[];
  logs: string[];
  errors: unknown[];
}

function captureEmit(): CapturedEmit {
  const data: unknown[] = [];
  const logs: string[] = [];
  const errors: unknown[] = [];
  const emit: EmitContext = {
    config() {},
    data(payload) {
      data.push(payload);
    },
    rows() {},
    text(s) {
      logs.push(s);
    },
    file() {},
    error(err) {
      errors.push(err);
    },
    log(msg) {
      logs.push(msg);
    },
    setExitCode(n) {
      process.exitCode = n;
    },
  };
  return { emit, data, logs, errors };
}

function buildProgram(emit: EmitContext): Command {
  const program = new Command();
  registerAdmissionCommand(program, emit);
  return program;
}

const roots: string[] = [];
let savedAdmissionDir: string | undefined;
let savedExitCode: typeof process.exitCode;

beforeEach(() => {
  savedAdmissionDir = process.env.HARNERY_ADMISSION_DIR;
  savedExitCode = process.exitCode;
});

afterEach(() => {
  if (savedAdmissionDir === undefined) delete process.env.HARNERY_ADMISSION_DIR;
  else process.env.HARNERY_ADMISSION_DIR = savedAdmissionDir;
  process.exitCode = savedExitCode;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixtureBaseDir(): string {
  const base = mkdtempSync(join(tmpdir(), "harnery-admission-cmd-"));
  roots.push(base);
  process.env.HARNERY_ADMISSION_DIR = base;
  return base;
}

describe("admission status", () => {
  test("--json lists a seeded holder", async () => {
    const base = fixtureBaseDir();
    mkdirSync(join(base, "browser-qa", "held"), { recursive: true });
    mkdirSync(join(base, "browser-qa", "tickets"), { recursive: true });
    const name = `${String(Date.now()).padStart(13, "0")}-${process.pid}-abcd1234.json`;
    writeFileSync(
      join(base, "browser-qa", "held", name),
      JSON.stringify({
        pid: process.pid,
        label: "seeded holder",
        created_at: new Date().toISOString(),
      }),
    );

    const { emit, data } = captureEmit();
    await buildProgram(emit).parseAsync(["admission", "status", "--json"], { from: "user" });

    expect(data).toHaveLength(1);
    const payload = data[0] as {
      resources: { resource: string; holders: { label: string }[]; waiters: unknown[] }[];
    };
    expect(payload.resources).toHaveLength(1);
    expect(payload.resources[0]?.resource).toBe("browser-qa");
    expect(payload.resources[0]?.holders.map((holder) => holder.label)).toEqual(["seeded holder"]);
    expect(payload.resources[0]?.waiters).toEqual([]);
  });
});

describe("admission run", () => {
  test("propagates exit 0 from /bin/true", async () => {
    fixtureBaseDir();
    const { emit, errors } = captureEmit();
    process.exitCode = undefined;
    await buildProgram(emit).parseAsync(
      ["admission", "run", "--resource", "cmd-test", "--", "/bin/true"],
      { from: "user" },
    );
    expect(errors).toEqual([]);
    expect(process.exitCode ?? 0).toBe(0);
  });

  test("propagates exit 1 from /bin/false", async () => {
    fixtureBaseDir();
    const { emit } = captureEmit();
    process.exitCode = undefined;
    await buildProgram(emit).parseAsync(
      ["admission", "run", "--resource", "cmd-test", "--", "/bin/false"],
      { from: "user" },
    );
    expect(process.exitCode ?? 0).toBe(1);
  });
});

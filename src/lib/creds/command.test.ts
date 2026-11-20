import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import { type CredsCommandIO, registerCredsCommand } from "./command.ts";
import { type CredsEngine, CredsTargetError, OpMissingError } from "./engine.ts";

function harness(
  engine: Partial<CredsEngine>,
  healExtras?: () => Record<string, unknown>,
  store?: { name: string; missing: string; installHint?: string },
) {
  const out = {
    data: [] as unknown[],
    errors: [] as Array<{ code: string; hint?: string }>,
    rows: 0,
    exit: 0,
    progress: [] as string[],
  };
  const io: CredsCommandIO = {
    data: (p) => out.data.push(p),
    error: (e) => out.errors.push(e),
    setExitCode: (n) => {
      out.exit = n;
    },
    rows: () => {
      out.rows++;
    },
    progress: (m) => out.progress.push(m),
  };
  const full = { config: { binName: "harn", store }, ...engine } as unknown as CredsEngine;
  let program = new Command();
  const run = async (...args: string[]) => {
    program = new Command().exitOverride();
    registerCredsCommand(program, { engine: full, io, healExtras });
    await program.parseAsync(["node", "test", "creds", ...args]);
  };
  return { out, run, program: () => program };
}

describe("registerCredsCommand", () => {
  test("an unknown pull target lists the known keys and exits 1", async () => {
    const h = harness({
      pull: async () => {
        throw new CredsTargetError("nope", ["a", "b"]);
      },
    });
    await h.run("pull", "nope");
    expect(h.out.errors).toEqual([
      {
        code: "no_scripts",
        message: 'No credential scripts found for "nope".',
        hint: "Known keys: a, b.",
      } as never,
    ]);
    expect(h.out.exit).toBe(1);
  });

  test("a missing op CLI reports the install hint", async () => {
    const h = harness({
      verify: async () => {
        throw new OpMissingError();
      },
    });
    await h.run("verify");
    expect(h.out.errors[0]?.code).toBe("op_cli_missing");
    expect(h.out.exit).toBe(1);
  });

  test("a fully local pull reports reuse and prints no table", async () => {
    const h = harness({
      pull: async () =>
        ({
          ok: true,
          target: null,
          refresh: false,
          contacted: false,
          counts: { ok: 0, fail: 0, local: 2 },
          results: [],
        }) as never,
    });
    await h.run("pull");
    expect(h.out.progress[0]).toContain("1Password was not contacted");
    expect(h.out.rows).toBe(0);
    expect(h.out.exit).toBe(0);
  });

  test("heal fails open and merges host extras", async () => {
    const h = harness(
      {
        heal: async () => {
          throw new Error("boom");
        },
      },
      () => ({ helper: { installed: false } }),
    );
    await h.run("heal");
    expect(h.out.data).toEqual([{ ok: false, healed: 0, failed: 0, error: "boom" }]);
    expect(h.out.exit).toBe(0);
    const ok = harness(
      { heal: async () => ({ ok: true, healed: 0, failed: 0, rows: [] }) as never },
      () => ({ helper: { installed: true } }),
    );
    await ok.run("heal");
    expect(ok.out.data[0]).toMatchObject({ ok: true, helper: { installed: true } });
  });

  test("verify problems print a table and exit 1", async () => {
    const h = harness({
      verify: async () =>
        ({
          ok: false,
          account: "a",
          counts: { items: 1, fields: 1, ok: 0, pending: 0, problems: 1 },
          problems: [{ vault: "V", item: "I", field: "f", status: "missing", scripts: "s" }],
        }) as never,
    });
    await h.run("verify");
    expect(h.out.rows).toBe(1);
    expect(h.out.exit).toBe(1);
  });

  test("help and the missing-tool hint name the host's store", async () => {
    const h = harness(
      {
        verify: async () => {
          throw new OpMissingError("example-store tool not found.");
        },
      },
      undefined,
      {
        name: "Example Store",
        missing: "example-store tool not found.",
        installHint: "Install it.",
      },
    );
    await h.run("verify");
    expect(h.out.errors[0]).toEqual({
      code: "op_cli_missing",
      message: "example-store tool not found.",
      hint: "Install it.",
    } as never);
    const creds = h.program().commands.find((c) => c.name() === "creds");
    expect(creds?.description()).toBe("Credential management (Example Store)");
    expect(creds?.commands.find((c) => c.name() === "pull")?.description()).toContain(
      "from Example Store",
    );
  });
});

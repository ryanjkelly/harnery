import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { removeDir } from "../../../tests/helpers/remove-dir.ts";
import { createOpClient } from "./client.ts";
import { type OpCommandIO, parseSetManyPayload, registerOpCommand } from "./command.ts";
import { createLocalCredentials } from "./local-credentials.ts";
import type { OpHostConfig } from "./types.ts";

const posix = process.platform !== "win32";
let work = "";
const saved: Record<string, string | undefined> = {};

function mockOp(item: unknown): () => string[] {
  const log = join(work, "calls.log");
  writeFileSync(join(work, "item.json"), JSON.stringify(item));
  const bin = join(work, "op.sh");
  writeFileSync(
    bin,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "${log}"
case "$1 $2" in
  "item get") cat "${work}/item.json" ;;
  "vault list") echo '[{"id":"v1","name":"Dev"}]' ;;
  "read op://Dev/Item/token") printf 'tok-value\\n' ;;
  *) exit 90 ;;
esac
`,
  );
  chmodSync(bin, 0o700);
  process.env.OP_BIN = bin;
  return () =>
    existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : [];
}

function harness(
  config: Partial<OpHostConfig> = {},
  extra: { masked?: boolean; local?: boolean } = {},
) {
  const out: {
    data: unknown[];
    errors: Array<{ code: string; message: string }>;
    exit: number;
    stdout: string;
  } = {
    data: [],
    errors: [],
    exit: 0,
    stdout: "",
  };
  const io: OpCommandIO = {
    data: (p) => out.data.push(p),
    error: (e) => out.errors.push(e),
    setExitCode: (n) => {
      out.exit = n;
    },
  };
  const client = createOpClient({
    binName: "harn",
    repoRoot: work,
    writes: "allowed",
    editDirPrefix: "harn-cmd-test-",
    defaultAccount: "team.example.com",
    ...config,
  });
  const local = extra.local
    ? createLocalCredentials({
        binName: "harn",
        repoRoot: work,
        sources: [
          {
            account: "team.example.com",
            vault: "Dev",
            item: "Mirrored",
            path: ".credentials/mirrored.json",
            pullKey: "mirrored",
            fields: ["user"],
            description: "test",
          },
        ],
      })
    : undefined;
  const build = () => {
    const program = new Command().exitOverride();
    const op = registerOpCommand(program, {
      client,
      io,
      local,
      accountEnv: ["HARN_TEST_OP_ACCOUNT"],
      secretOutput: extra.masked ? "masked" : "raw",
    });
    return { program, op };
  };
  const { op } = build();
  const run = async (...args: string[]) => {
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      out.stdout += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
      return true;
    }) as typeof process.stdout.write;
    try {
      await build().program.parseAsync(["node", "test", "op", ...args]);
    } finally {
      process.stdout.write = write;
    }
  };
  return { out, op, run };
}

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "harn-op-cmd-"));
  for (const k of ["OP_BIN", "HARN_TEST_OP_ACCOUNT"]) saved[k] = process.env[k];
  delete process.env.HARN_TEST_OP_ACCOUNT;
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  removeDir(work);
});

describe("parseSetManyPayload", () => {
  test("accepts shorthand values and typed specifications", () => {
    const payload = {
      fields: { account_id: "acct-1", api_secret: { value: "s", type: "concealed", create: true } },
      title: "Updated",
    };
    expect(parseSetManyPayload(JSON.stringify(payload))).toEqual(payload);
  });

  test("rejects misspelled options before any 1Password call", () => {
    expect(() =>
      parseSetManyPayload(JSON.stringify({ fields: { a: { value: "s", concealed: true } } })),
    ).toThrow("unknown key(s): concealed");
  });
});

describe.if(posix)("registerOpCommand", () => {
  test("raw output prints a single field verbatim and several as data", async () => {
    mockOp({
      fields: [
        { label: "a", value: "one" },
        { label: "b", value: "two" },
      ],
    });
    const h = harness();
    await h.run("get", "--item", "X", "--field", "a");
    expect(h.out.stdout).toBe("one");
    await h.run("get", "--item", "X", "--field", "a", "--field", "b");
    expect(h.out.data.at(-1)).toEqual({ a: "one", b: "two" });
  });

  test("masked output hides values unless revealed, and --out needs an ignored path", async () => {
    mockOp({ fields: [{ label: "a", value: "secret" }] });
    execFileSync("git", ["init", "-q"], { cwd: work });
    writeFileSync(join(work, ".gitignore"), ".credentials/\n");
    const h = harness({}, { masked: true });
    await h.run("get", "--item", "X", "--field", "a");
    expect(h.out.data.at(-1)).toEqual({ ok: true, value: "•••••• (6 characters)" });
    await h.run("get", "--item", "X", "--field", "a", "--reveal");
    expect(h.out.data.at(-1)).toEqual({ ok: true, value: "secret" });
    await h.run("get", "--item", "X", "--field", "a", "--out", join(work, "tracked.txt"));
    expect(h.out.errors.at(-1)?.message).toContain("tracked or not ignored");
    const out = join(work, ".credentials", "a.txt");
    await h.run("get", "--item", "X", "--field", "a", "--out", out);
    expect(readFileSync(out, "utf8")).toBe("secret\n");
    expect(h.out.stdout).toBe("");
  });

  test("masked read strips op's trailing newline before masking", async () => {
    mockOp({});
    const h = harness({}, { masked: true });
    await h.run("read", "op://Dev/Item/token", "--reveal");
    expect(h.out.data.at(-1)).toEqual({ ok: true, value: "tok-value" });
  });

  test("a read-only host registers no write subcommands", () => {
    const h = harness({ writes: "refused" });
    const names = h.op.commands.map((c) => c.name());
    for (const w of ["set", "set-many", "create", "rename", "move", "delete-field", "share"]) {
      expect(names).not.toContain(w);
    }
    expect(names).toEqual(
      expect.arrayContaining(["get", "item", "read", "otp", "document", "items", "whoami"]),
    );
    const doc = h.op.commands.find((c) => c.name() === "document");
    expect(doc?.commands.map((c) => c.name())).toEqual(["get"]);
  });

  test("account comes from --account, then the host's environment variable, then the default", async () => {
    const calls = mockOp({});
    const h = harness();
    await h.run("vaults");
    process.env.HARN_TEST_OP_ACCOUNT = "env.example.com";
    await h.run("vaults");
    await h.run("vaults", "--account", "flag.example.com");
    expect(calls()).toEqual([
      "vault list --format json --account team.example.com",
      "vault list --format json --account env.example.com",
      "vault list --format json --account flag.example.com",
    ]);
  });

  test("get prefers a registered local mirror and makes no live call", async () => {
    const calls = mockOp({});
    mkdirSync(join(work, ".credentials"));
    writeFileSync(
      join(work, ".credentials", "mirrored.json"),
      JSON.stringify({
        version: 1,
        account: "team.example.com",
        vault: "Dev",
        item: "Mirrored",
        fields: { user: "local-user" },
        concealed_fields: [],
      }),
    );
    const h = harness({}, { local: true });
    await h.run("get", "--vault", "Dev", "--item", "Mirrored", "--field", "user");
    expect(h.out.stdout).toBe("local-user");
    expect(calls()).toEqual([]);
  });

  test("delete-field requires --yes unless previewing, and errors set a nonzero exit", async () => {
    const calls = mockOp({ fields: [{ label: "f", value: "v" }] });
    const h = harness();
    await h.run("delete-field", "--item", "X", "--field", "f");
    expect(h.out.errors.at(-1)?.code).toBe("confirmation_required");
    expect(h.out.exit).toBe(1);
    expect(calls()).toEqual([]);
  });
});

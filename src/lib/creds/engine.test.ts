import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { OpClient } from "../op/client.ts";
import { CredsTargetError, createCredsEngine, OpMissingError } from "./engine.ts";
import { loadHealBackoff, loadRevisions } from "./state.ts";
import type { CredentialSource, CredsHostConfig } from "./types.ts";

const posix = process.platform !== "win32";
let root = "";
let sub = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "harn-creds-engine-"));
  sub = join(root, "sub");
  mkdirSync(join(root, "scripts"), { recursive: true });
  mkdirSync(join(sub, "scripts"), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** Write a pull script that logs its run and writes `files` with `content`. */
function script(
  base: string,
  name: string,
  files: Record<string, string>,
  opts: { exit?: number; stderr?: string } = {},
) {
  const lines = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    `echo "${name}" >> "${root}/runs.log"`,
  ];
  if (opts.exit) {
    lines.push(`echo "${opts.stderr ?? "pull failed"}" >&2`, `exit ${opts.exit}`);
  } else {
    for (const [path, content] of Object.entries(files)) {
      lines.push(`mkdir -p "$(dirname "${path}")"`, `printf '%s' '${content}' > "${path}"`);
    }
  }
  const abs = join(base, "scripts", `pull-${name}.sh`);
  writeFileSync(abs, `${lines.join("\n")}\n`);
  chmodSync(abs, 0o700);
  return `scripts/pull-${name}.sh`;
}

function runs(): string[] {
  const log = join(root, "runs.log");
  return existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
}

function writeFile(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function op(overrides: Partial<OpClient> = {}): OpClient {
  return {
    detectOp: () => "op",
    getItemFields: async () => ({ fields: {}, duplicate_fields: {} }),
    ...overrides,
  } as unknown as OpClient;
}

function engine(sources: CredentialSource[], extra: Partial<CredsHostConfig> = {}, client = op()) {
  return createCredsEngine(
    {
      binName: "harn",
      repoRoot: root,
      repoName: "host",
      repoPaths: { sub },
      sources,
      manifest: [],
      revisionStatePath: join(root, ".cache/creds/revisions.json"),
      backoffStatePath: join(root, ".cache/creds/heal-failures.json"),
      backoffHoursEnv: "HARN_TEST_BACKOFF_HOURS",
      ...extra,
    },
    { op: client },
  );
}

describe("fileReady", () => {
  test("requires usable effective values for required keys", () => {
    const e = engine([]);
    const spec = (path: string, requiredKeys?: string[]) => ({ path, requiredKeys });
    writeFile(join(root, "a.env"), "TOKEN=abc\n");
    expect(e.fileReady(spec("a.env", ["TOKEN"]))).toBe(true);
    writeFile(join(root, "b.env"), "TOKEN=abc\nTOKEN=\n");
    expect(e.fileReady(spec("b.env", ["TOKEN"]))).toBe(false);
    writeFile(join(root, "c.env"), "TOKEN=<REDACTED:token>\n");
    expect(e.fileReady(spec("c.env", ["TOKEN"]))).toBe(false);
    writeFile(join(root, "d.yaml"), "token: abc\n");
    expect(e.fileReady(spec("d.yaml", ["token"]))).toBe(true);
    writeFile(join(root, "e.yaml"), "token: abc\ntoken: def\n");
    expect(e.fileReady(spec("e.yaml"))).toBe(false);
    writeFile(join(root, "f.json"), '{"key":"v"}');
    expect(e.fileReady(spec("f.json", ["key"]))).toBe(true);
    writeFile(join(root, "g.json"), "{}");
    expect(e.fileReady(spec("g.json"))).toBe(false);
    writeFile(join(root, "h.password"), "");
    expect(e.fileReady(spec("h.password"))).toBe(false);
    expect(e.fileReady(spec("absent.env"))).toBe(false);
    writeFile(join(root, "i.env"), "# only a comment\n");
    expect(e.fileReady(spec("i.env"))).toBe(false);
    writeFile(join(root, "oauth.json"), '{"web":{"client_id":"x"}}');
    expect(e.fileReady({ path: "oauth.json", anyOfKeys: ["installed", "web"] })).toBe(true);
    writeFile(join(root, "oauth2.json"), '{"other":1}');
    expect(e.fileReady({ path: "oauth2.json", anyOfKeys: ["installed", "web"] })).toBe(false);
    writeFile(join(root, "key.password"), "s3cret\n");
    expect(e.fileReady(spec("key.password"))).toBe(true);
  });

  test("resolves repository and home-relative paths", () => {
    const e = engine([]);
    expect(e.filePath({ path: "x.env", repo: "sub" })).toBe(join(sub, "x.env"));
    expect(e.filePath({ path: "~/.ssh/key" })).toBe(join(homedir(), ".ssh", "key"));
    expect(() => e.filePath({ path: "x", repo: "nope" })).toThrow('unknown repository "nope"');
  });
});

describe.if(posix)("pull", () => {
  test("reuses complete local files without resolving 1Password", async () => {
    writeFile(join(root, ".credentials/a.env"), "A=1\n");
    let detected = 0;
    const e = engine(
      [
        {
          key: "a",
          script: script(root, "a", {}),
          description: "A",
          files: [{ path: ".credentials/a.env" }],
        },
      ],
      {},
      op({
        detectOp: () => {
          detected++;
          return null;
        },
      }),
    );
    const report = await e.pull();
    expect(report).toMatchObject({
      ok: true,
      contacted: false,
      counts: { ok: 0, fail: 0, local: 1 },
    });
    expect(detected).toBe(0);
    expect(runs()).toEqual([]);
  });

  test("runs only missing sources, records revisions, and calls afterPull", async () => {
    writeFile(join(root, ".credentials/a.env"), "A=1\n");
    const pulled: string[][] = [];
    const e = engine(
      [
        {
          key: "a",
          script: script(root, "a", {}),
          description: "A",
          files: [{ path: ".credentials/a.env" }],
        },
        {
          key: "b",
          script: script(root, "b", { [join(root, ".credentials/b.env")]: "B=2" }),
          description: "B",
          revision: 3,
          files: [{ path: ".credentials/b.env", requiredKeys: ["B"] }],
        },
      ],
      { hooks: { afterPull: async (keys) => void pulled.push(keys) } },
    );
    const report = await e.pull();
    expect(report.counts).toEqual({ ok: 1, fail: 0, local: 1 });
    expect(runs()).toEqual(["b"]);
    expect(loadRevisions(join(root, ".cache/creds/revisions.json"))).toEqual({
      "host:.credentials/b.env": 3,
    });
    expect(pulled).toEqual([["b"]]);
    await e.pull(undefined, { refresh: true });
    expect(runs()).toEqual(["b", "a", "b"]);
  });

  test("a failed refresh restores the usable files it started with", async () => {
    writeFile(join(root, "a.env"), "A=good\n");
    writeFile(join(root, "b.env"), "B=good\n");
    const abs = join(root, "scripts", "pull-ab.sh");
    writeFileSync(
      abs,
      `#!/usr/bin/env bash\nprintf 'A=' > "${join(root, "a.env")}"\necho broke >&2\nexit 4\n`,
    );
    chmodSync(abs, 0o700);
    const e = engine([
      {
        key: "ab",
        script: "scripts/pull-ab.sh",
        description: "AB",
        files: [{ path: "a.env", requiredKeys: ["A"] }, { path: "b.env" }],
      },
    ]);
    const report = await e.pull("ab", { refresh: true });
    expect(report.ok).toBe(false);
    expect(readFileSync(join(root, "a.env"), "utf8")).toBe("A=good\n");
    expect(readFileSync(join(root, "b.env"), "utf8")).toBe("B=good\n");
  });

  test("a pull that exits 0 but leaves files unusable fails", async () => {
    const e = engine([
      {
        key: "a",
        script: script(root, "a", {}),
        description: "A",
        files: [{ path: ".credentials/a.env", requiredKeys: ["A"] }],
      },
    ]);
    const report = await e.pull("a");
    expect(report.ok).toBe(false);
    expect(report.results[0]?.stderr).toContain("remain unusable");
  });

  test("targets a key or a repository, skips pending sources in bulk, and rejects unknown targets", async () => {
    const e = engine([
      { key: "root-one", script: "scripts/x.sh", description: "", files: [{ path: "r.env" }] },
      {
        key: "sub-one",
        repo: "sub",
        script: "scripts/y.sh",
        description: "",
        files: [{ path: "s.env", repo: "sub" }],
      },
      {
        key: "later",
        script: "scripts/z.sh",
        description: "",
        files: [{ path: "z.env" }],
        pending: true,
      },
    ]);
    expect(e.sourcesForTarget("sub").map((s) => s.key)).toEqual(["sub-one"]);
    expect(e.sourcesForTarget("host").map((s) => s.key)).toEqual(["root-one"]);
    expect(e.sourcesForTarget().map((s) => s.key)).toEqual(["root-one", "sub-one"]);
    expect(e.sourcesForTarget("later").map((s) => s.key)).toEqual(["later"]);
    await expect(e.pull("nope")).rejects.toBeInstanceOf(CredsTargetError);
  });

  test("needs 1Password only when something must be pulled", async () => {
    const e = engine(
      [{ key: "a", script: script(root, "a", {}), description: "A", files: [{ path: "a.env" }] }],
      {},
      op({ detectOp: () => null }),
    );
    await expect(e.pull()).rejects.toBeInstanceOf(OpMissingError);
  });
});

describe.if(posix)("heal", () => {
  test("restores a missing file and reports an unrecoverable standalone file", async () => {
    const e = engine(
      [
        {
          key: "a",
          script: script(root, "a", { [join(root, "a.env")]: "A=1" }),
          description: "A",
          files: [{ path: "a.env" }],
        },
      ],
      { standaloneFiles: [{ path: "setup-only.key", description: "written by setup" }] },
    );
    expect((await e.heal({ dryRun: true })).would_heal).toEqual([
      { path: "a.env", pull_key: "a", reason: "missing" },
    ]);
    const report = await e.heal();
    expect(report).toMatchObject({
      ok: true,
      healed: 1,
      failed: 0,
      unrecoverable: ["setup-only.key"],
    });
    expect(runs()).toEqual(["a"]);
  });

  test("refreshes a present file whose registry revision moved", async () => {
    writeFile(join(root, "a.env"), "A=old\n");
    const e = engine([
      {
        key: "a",
        script: script(root, "a", { [join(root, "a.env")]: "A=new" }),
        description: "A",
        files: [{ path: "a.env", revision: 2 }],
      },
    ]);
    expect((await e.heal()).rows).toEqual([{ pull_key: "a", status: "refreshed" }]);
    expect((await e.heal()).rows).toEqual([]);
  });

  test("backs off a failing key, retries after a script change or with force", async () => {
    const path = script(root, "a", {}, { exit: 3, stderr: "item not found" });
    const e = engine([{ key: "a", script: path, description: "A", files: [{ path: "a.env" }] }]);
    expect((await e.heal()).rows).toEqual([
      { pull_key: "a", status: "failed", detail: "item not found" },
    ]);
    expect(loadHealBackoff(join(root, ".cache/creds/heal-failures.json")).a?.detail).toBe(
      "item not found",
    );
    const second = await e.heal();
    expect(second.rows).toEqual([]);
    expect(second.backed_off[0]?.pull_key).toBe("a");
    expect((await e.heal({ force: true })).rows[0]?.status).toBe("failed");
    const later = new Date(Date.now() + 5000);
    utimesSync(join(root, path), later, later);
    expect((await e.heal()).rows[0]?.status).toBe("failed");
    expect(runs()).toEqual(["a", "a", "a"]);
  });

  test("a transport failure is retried next time instead of backing off", async () => {
    const e = engine([
      {
        key: "a",
        script: script(root, "a", {}, { exit: 1, stderr: "UtilAcceptVsock: accept4 failed" }),
        description: "A",
        files: [{ path: "a.env" }],
      },
    ]);
    await e.heal();
    expect(loadHealBackoff(join(root, ".cache/creds/heal-failures.json"))).toEqual({});
    expect((await e.heal()).rows[0]?.status).toBe("failed");
  });
});

describe("check", () => {
  test("reports mtime freshness and runs one probe per key", async () => {
    writeFile(join(root, "a.env"), "A=1\n");
    writeFile(join(root, "a2.env"), "A2=1\n");
    writeFile(join(root, "b.env"), "B=1\n");
    let probeCalls = 0;
    const e = engine(
      [
        { key: "a", script: "s", description: "A", files: [{ path: "a.env" }, { path: "a2.env" }] },
        { key: "b", script: "s", description: "B", files: [{ path: "b.env" }] },
        { key: "c", script: "s", description: "C", files: [{ path: "c.env" }] },
      ],
      {
        hooks: {
          probes: {
            a: async () => {
              probeCalls++;
              return { status: "live", detail: "ok" };
            },
            b: async () => ({ status: "dead", detail: "revoked" }),
          },
        },
      },
    );
    const mtime = await e.check({ live: false });
    expect(mtime.ok).toBe(false);
    expect(mtime.rows.map((r) => r.status)).toEqual(["ok", "ok", "ok", "missing"]);
    writeFile(join(root, "c.env"), "");
    expect((await e.check({ live: false })).rows.at(-1)?.status).toBe("unusable");
    rmSync(join(root, "c.env"));
    const live = await e.check();
    expect(probeCalls).toBe(1);
    expect(live.rows.map((r) => r.live)).toEqual(["live", "live", "dead", "skipped"]);
    expect(live).toMatchObject({ ok: false, counts: { live: 2, dead: 1, skipped: 1, files: 4 } });
  });
});

describe("verify pending documents", () => {
  test("an absent document that every entry marks pending is pending, not a problem", async () => {
    const client = op({
      getItemFields: (async () => {
        throw new Error('"Future doc" isn\'t an item');
      }) as unknown as OpClient["getItemFields"],
    });
    const e = engine(
      [],
      {
        manifest: [
          {
            vault: "V",
            item: "Future doc",
            fields: [],
            scripts: ["a"],
            kind: "document",
            pending: true,
          },
        ],
      },
      client,
    );
    const report = await e.verify();
    expect(report.ok).toBe(true);
    expect(report.counts).toMatchObject({ pending: 1, problems: 0 });
  });
});

describe("verify", () => {
  test("reports missing items, missing and pending fields, and unreadable items", async () => {
    const client = op({
      getItemFields: (async (t: { item: string }) => {
        if (t.item === "Gone") throw new Error('"Gone" isn\'t an item');
        if (t.item === "Flaky") throw new Error("connection reset");
        return { fields: { key: "••••••" }, duplicate_fields: {} };
      }) as unknown as OpClient["getItemFields"],
    });
    const e = engine(
      [],
      {
        defaultAccount: "team.example.com",
        manifest: [
          { vault: "V", item: "Live", fields: ["key", "absent"], scripts: ["a"] },
          { vault: "V", item: "Live", fields: ["future"], scripts: ["b"], pending: true },
          { vault: "V", item: "Gone", fields: ["x"], scripts: ["c"] },
          { vault: "V", item: "Flaky", fields: [], scripts: ["d"], kind: "document" },
        ],
      },
      client,
    );
    const report = await e.verify();
    expect(report.account).toBe("team.example.com");
    expect(report.counts).toEqual({ items: 3, fields: 5, ok: 1, pending: 1, problems: 3 });
    expect(report.problems.map((p) => `${p.item}:${p.field}:${p.status}`)).toEqual([
      "Live:absent:missing",
      "Gone:x:item_missing",
      "Flaky:(item exists):unreadable",
    ]);
  });
});

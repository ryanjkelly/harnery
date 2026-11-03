import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOpClient, OpWriteRefusedError, PASSWORD_PLACEHOLDER } from "./client.ts";
import { isWslRuntime } from "./detect.ts";
import type { OpHostConfig } from "./types.ts";

const posix = process.platform !== "win32";

let work = "";
let originalOpBin: string | undefined;

/**
 * A fake `op` that logs each call's argv to calls.log and serves item.json.
 * `item edit` copies the template file back to item.json; `item create` saves
 * stdin to created.json; `document get --out-file` writes doc.txt's content.
 * MOCK_OP_STDERR makes every call fail with that message.
 */
function installMockOp(item: unknown): { calls: () => string[]; itemPath: string } {
  const itemPath = join(work, "item.json");
  const logPath = join(work, "calls.log");
  writeFileSync(itemPath, JSON.stringify(item));
  writeFileSync(join(work, "doc.txt"), "document-body");
  const opPath = join(work, "mock-op.sh");
  writeFileSync(
    opPath,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "${logPath}"
if [[ -n "\${MOCK_OP_STDERR:-}" ]]; then echo "$MOCK_OP_STDERR" >&2; exit 1; fi
case "$1 $2" in
  "item get") cat "${itemPath}" ;;
  "item edit")
    template=""
    for arg in "$@"; do case "$arg" in --template=*) template="\${arg#--template=}" ;; esac; done
    cp "$template" "${itemPath}"; cat "${itemPath}" ;;
  "item create") cat > "${work}/created.json"; echo '{"id":"new-1","title":"created"}' ;;
  "document get")
    out=""; prev=""
    for arg in "$@"; do [[ "$prev" == "--out-file" ]] && out="$arg"; prev="$arg"; done
    cp "${work}/doc.txt" "$out" ;;
  "vault list") echo '[{"id":"v1","name":"Dev"}]' ;;
  *) exit 90 ;;
esac
`,
  );
  chmodSync(opPath, 0o700);
  process.env.OP_BIN = opPath;
  return {
    itemPath,
    calls: () =>
      existsSync(logPath) ? readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean) : [],
  };
}

function client(overrides: Partial<OpHostConfig> = {}) {
  return createOpClient({
    binName: "harn",
    repoRoot: work,
    writes: "allowed",
    editDirPrefix: "harn-op-test-",
    onLabelDrift: () => {},
    ...overrides,
  });
}

beforeEach(() => {
  originalOpBin = process.env.OP_BIN;
  work = mkdtempSync(join(tmpdir(), "harn-op-client-"));
  delete process.env.MOCK_OP_STDERR;
});

afterEach(() => {
  if (originalOpBin === undefined) delete process.env.OP_BIN;
  else process.env.OP_BIN = originalOpBin;
  delete process.env.MOCK_OP_STDERR;
  rmSync(work, { recursive: true, force: true });
});

describe.if(posix)("createOpClient against a fake op", () => {
  test("setFields performs one get and one edit and preserves unrelated content", async () => {
    const mock = installMockOp({
      id: "item-1",
      title: "Original item",
      category: "LOGIN",
      fields: [
        { id: "username", label: "username", type: "STRING", value: "before" },
        { id: "keep", label: "keep_me", type: "STRING", value: "untouched" },
      ],
      sections: [{ id: "api", label: "API" }],
      files: [{ id: "document-1", name: "certificate.pem" }],
    });

    const result = await client().setFields(
      { item: "Example", vault: "Dev" },
      [
        { field: "username", value: "after" },
        {
          field: "api_secret",
          value: "sensitive-value",
          create: true,
          type: "concealed",
          section: "API",
        },
        { field: "json_config", value: '{ "enabled": true }', create: true, minify: true },
      ],
      { title: "Updated item" },
    );

    expect(mock.calls().map((c) => c.split(" ").slice(0, 2).join(" "))).toEqual([
      "item get",
      "item edit",
    ]);
    expect(JSON.stringify(result)).not.toContain("sensitive-value");
    expect(result).toEqual({
      fields: [
        { field: "username", created: false, changed: true, concealed: false },
        { field: "api_secret", created: true, changed: true, concealed: true },
        { field: "json_config", created: true, changed: true, concealed: false },
      ],
      titleChanged: true,
    });
    const edited = JSON.parse(readFileSync(mock.itemPath, "utf8")) as {
      title: string;
      fields: Array<{ label: string; value: string; type: string; section?: { id?: string } }>;
      files: Array<{ id: string; name: string }>;
    };
    expect(edited.title).toBe("Updated item");
    expect(edited.fields.find((f) => f.label === "keep_me")?.value).toBe("untouched");
    expect(edited.fields.find((f) => f.label === "api_secret")).toMatchObject({
      value: "sensitive-value",
      type: "CONCEALED",
      section: { id: "api" },
    });
    expect(edited.fields.find((f) => f.label === "json_config")?.value).toBe('{"enabled":true}');
    expect(edited.files).toEqual([{ id: "document-1", name: "certificate.pem" }]);
  });

  test("reports duplicate labels, names the host CLI, and repairs only with dedupe", async () => {
    installMockOp({
      id: "item-1",
      fields: [
        { id: "a", label: "api_secret", type: "CONCEALED", value: "old-a" },
        { id: "b", label: "api_secret", type: "CONCEALED", value: "old-b" },
      ],
    });
    const op = client();
    expect((await op.getItemFields({ item: "Example" })).duplicate_fields).toEqual({
      api_secret: 2,
    });
    await expect(op.getField({ item: "Example" }, "api_secret")).rejects.toThrow(
      "use harn op set --dedupe",
    );
    await expect(op.setField({ item: "Example" }, "api_secret", "new")).rejects.toThrow(
      "pass --dedupe",
    );
    const result = await op.setField({ item: "Example" }, "api_secret", "new", { dedupe: true });
    expect(result.deduplicated).toBe(1);
    expect(await op.getField({ item: "Example" }, "api_secret")).toBe("new");
  });

  test("masks concealed values unless revealed", async () => {
    installMockOp({
      fields: [
        { label: "user", type: "STRING", value: "alice" },
        { label: "token", type: "CONCEALED", value: "s3cret" },
        { label: "seed", type: "STRING", value: "otpauth://totp/x?secret=ABC" },
      ],
    });
    const op = client();
    expect((await op.getItemFields({ item: "Example" })).fields).toEqual({
      user: "alice",
      token: "••••••",
      seed: "••••••",
    });
    expect((await op.getItemFields({ item: "Example" }, { reveal: true })).fields.token).toBe(
      "s3cret",
    );
  });

  test("a read-only host refuses every write before starting a process", async () => {
    const mock = installMockOp({ fields: [{ label: "f", value: "v" }] });
    const op = client({ writes: "refused" });
    const t = { item: "Example", vault: "Dev" };
    const attempts = [
      () => op.setField(t, "f", "x"),
      () => op.setFields(t, [{ field: "f", value: "x" }]),
      () => op.setTitle(t, "x"),
      () => op.moveItem(t, "Other"),
      () => op.deleteField(t, "f"),
      () => op.createItem(t, { title: "x" }),
      () => op.createDocument(t, "/tmp/x"),
      () => op.shareItem(t),
    ];
    for (const attempt of attempts)
      await expect(attempt()).rejects.toBeInstanceOf(OpWriteRefusedError);
    expect(mock.calls()).toEqual([]);
    expect(await op.getField(t, "f")).toBe("v");
  });

  test("sends an aliased account's ID and applies the default account", async () => {
    const mock = installMockOp({ fields: [] });
    const op = client({
      defaultAccount: "team.example.com",
      accountIds: { "Team.Example.com": "ACCT123" },
    });
    await op.listVaults();
    await op.listVaults("other.example.com");
    expect(mock.calls()).toEqual([
      "vault list --format json --account ACCT123",
      "vault list --format json --account other.example.com",
    ]);
  });

  test("explains an ambiguous account with the host's command", async () => {
    installMockOp({});
    process.env.MOCK_OP_STDERR = '[ERROR] found multiple accounts for filter "a@example.com"';
    await expect(client().listVaults()).rejects.toThrow("account_uuid from harn op accounts");
  });

  test("creates an item from a stdin template and fills a Password item's password", async () => {
    installMockOp({});
    const created = await client().createItem(
      { vault: "Dev" },
      { title: "New", category: "password" },
    );
    expect(created).toEqual({ id: "new-1", title: "created" });
    const template = JSON.parse(readFileSync(join(work, "created.json"), "utf8")) as {
      category: string;
      fields: Array<{ purpose?: string; value?: string }>;
    };
    expect(template.category).toBe("PASSWORD");
    expect(template.fields.find((f) => f.purpose === "PASSWORD")?.value).toBe(PASSWORD_PLACEHOLDER);
  });

  test("writes a document only to a path Git ignores inside the repository", async () => {
    const mock = installMockOp({});
    execFileSync("git", ["init", "-q"], { cwd: work });
    writeFileSync(join(work, ".gitignore"), ".credentials/\n");
    const op = client();
    await expect(op.getDocument({ item: "Doc" }, join(work, "tracked.txt"))).rejects.toThrow(
      "tracked or not ignored",
    );
    expect(mock.calls()).toEqual([]);
    const out = join(work, ".credentials", "doc.txt");
    execFileSync("mkdir", ["-p", join(work, ".credentials")]);
    expect(await op.getDocument({ item: "Doc" }, out)).toEqual({ path: out });
    expect(readFileSync(out, "utf8")).toBe("document-body");
    const outside = join(tmpdir(), `harn-op-outside-${process.pid}.txt`);
    try {
      expect(await op.getDocument({ item: "Doc" }, outside)).toEqual({ path: outside });
    } finally {
      rmSync(outside, { force: true });
    }
  });

  test("refuses a tracked file even when an ignore rule matches it, and a '..'-named file inside", async () => {
    const mock = installMockOp({});
    const git = (...args: string[]) => execFileSync("git", args, { cwd: work, stdio: "ignore" });
    git("init", "-q");
    writeFileSync(join(work, ".gitignore"), "secrets/\n..secrets.env\n");
    execFileSync("mkdir", ["-p", join(work, "secrets")]);
    writeFileSync(join(work, "secrets", "tracked.env"), "x");
    git("add", "-f", "secrets/tracked.env");
    const op = client();
    await expect(
      op.getDocument({ item: "Doc" }, join(work, "secrets", "tracked.env")),
    ).rejects.toThrow("tracked or not ignored");
    writeFileSync(join(work, ".gitignore"), "secrets/\n");
    await expect(op.getDocument({ item: "Doc" }, join(work, "..secrets.env"))).rejects.toThrow(
      "tracked or not ignored",
    );
    expect(mock.calls()).toEqual([]);
  });

  test("a host may opt out of the ignored-output check", async () => {
    installMockOp({});
    execFileSync("git", ["init", "-q"], { cwd: work });
    const out = join(work, "tracked.txt");
    expect(await client({ requireIgnoredOutput: false }).getDocument({ item: "Doc" }, out)).toEqual(
      { path: out },
    );
  });

  test("uses the host helper resolver only through detectOp's platform rules", () => {
    delete process.env.OP_BIN;
    const op = client({ bridge: () => "/helper/op-helper.exe" });
    const detected = op.detectOp();
    if (process.platform === "darwin" || isWslRuntime())
      expect(detected).toBe("/helper/op-helper.exe");
    else expect(detected).not.toBe("/helper/op-helper.exe");
  });
});

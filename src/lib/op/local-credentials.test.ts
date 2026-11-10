import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { removeDir } from "../../../tests/helpers/remove-dir.ts";
import { createLocalCredentials } from "./local-credentials.ts";
import type { LocalCredentialSource } from "./types.ts";

const login: LocalCredentialSource = {
  account: "team.example.com",
  vault: "Shared",
  item: "Storage box",
  path: ".credentials/storage.json",
  pullKey: "storage",
  fields: ["username", "password"],
  description: "Storage login",
};
const token: LocalCredentialSource = {
  account: "team.example.com",
  vault: "Shared",
  item: "API token",
  path: ".credentials/token.json",
  pullKey: "token",
  fields: ["credential"],
  description: "API token",
};
const key: LocalCredentialSource = {
  account: "team.example.com",
  vault: "Shared",
  item: "App key",
  path: ".credentials/app-key.json",
  pullKey: "app-key",
  fields: ["private_key"],
  privateKeyFields: ["private_key"],
  description: "App private key",
};
const target = { account: login.account, vault: login.vault, item: login.item };

let root = "";
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "harn-op-local-"));
});
afterEach(() => removeDir(root));

function local() {
  return createLocalCredentials({ binName: "harn", repoRoot: root, sources: [login, token, key] });
}

function writeMirror(content: unknown, path = login.path): void {
  const abs = join(root, path);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, typeof content === "string" ? content : JSON.stringify(content));
}

const valid = {
  version: 1,
  account: login.account,
  vault: login.vault,
  item: login.item,
  category: "LOGIN",
  fields: { username: "local-user", password: "local-password" },
  concealed_fields: ["password"],
};

describe("local-first reads", () => {
  test("returns registered fields without a live call", () => {
    writeMirror(valid);
    expect(local().getLocalOpFields(target, ["username", "password"])).toEqual({
      username: "local-user",
      password: "local-password",
    });
  });

  test("returns null for an item with no local mapping", () => {
    expect(local().getLocalOpItem({ ...target, item: "Unmapped" })).toBeNull();
  });

  test("a missing registered mirror fails closed with the host's repair command", () => {
    expect(() => local().getLocalOpFields(target, ["password"])).toThrow("harn creds pull storage");
  });

  test("an absent field, a mismatched source, or a redaction placeholder fails closed", () => {
    writeMirror(valid);
    expect(() => local().getLocalOpFields(target, ["missing"])).toThrow(
      "does not contain a non-empty missing field",
    );
    writeMirror({ ...valid, vault: "Other" });
    expect(() => local().getLocalOpItem(target)).toThrow(
      "does not match its registered 1Password source",
    );
    writeMirror({ ...valid, fields: { password: "<REDACTED:token>" } });
    expect(() => local().getLocalOpItem(target)).toThrow("redaction placeholder");
    writeMirror("not json");
    expect(() => local().getLocalOpItem(target)).toThrow("is not valid JSON");
  });
});

describe("mirror writes", () => {
  test("validate first and write mode 600", () => {
    const creds = local();
    expect(() => creds.writeLocalOpCredential(login, { username: "u" })).toThrow(
      "has no non-empty password field",
    );
    creds.writeLocalOpCredential(login, { username: "u", password: "p" });
    const abs = join(root, login.path);
    expect(JSON.parse(readFileSync(abs, "utf8")).fields).toEqual({ username: "u", password: "p" });
    if (process.platform !== "win32") expect(statSync(abs).mode & 0o777).toBe(0o600);
  });

  test("a private-key field must hold an RSA key", () => {
    const creds = local();
    expect(() => creds.writeLocalOpCredential(key, { private_key: "nope" })).toThrow(
      "invalid RSA private key",
    );
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    creds.writeLocalOpCredential(key, { private_key: pem });
    expect(
      creds.getLocalOpFields({ account: key.account, item: key.item }, ["private_key"]),
    ).toEqual({
      private_key: pem,
    });
  });

  test("cacheFromStdin writes a single-field mirror and refuses a multi-field source", async () => {
    const creds = local();
    expect(await creds.cacheFromStdin("token", Readable.from(["tok-123"]))).toBe(token.path);
    expect(
      creds.getLocalOpFields({ account: token.account, item: token.item }, ["credential"]),
    ).toEqual({
      credential: "tok-123",
    });
    await expect(creds.cacheFromStdin("storage", Readable.from(["x"]))).rejects.toThrow(
      "single-field",
    );
    await expect(creds.cacheFromStdin("unknown", Readable.from(["x"]))).rejects.toThrow(
      "single-field",
    );
  });
});

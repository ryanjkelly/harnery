import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalizeDiagnosticIdentity } from "./path-identity.ts";

const MODULE = join(import.meta.dir, "path-identity.ts");

/** Canonicalize in a fresh process whose per-install state lives under `stateHome`. */
function canonicalizeIn(stateHome: string, value: string): string {
  const script = `const { canonicalizeDiagnosticIdentity } = await import(${JSON.stringify(MODULE)}); process.stdout.write(canonicalizeDiagnosticIdentity(${JSON.stringify(value)}));`;
  const result = Bun.spawnSync([process.execPath, "-e", script], {
    env: { ...process.env, XDG_STATE_HOME: stateHome },
  });
  expect(result.exitCode).toBe(0);
  return result.stdout.toString();
}

describe("private path identity", () => {
  test.each([
    ["Linux", "/home/owner-one/worker", "/home/owner-two/worker"],
    ["macOS", "/Users/owner-one/worker", "/Users/owner-two/worker"],
    ["Windows", String.raw`C:\Users\owner-one\worker`, String.raw`C:\Users\owner-two\worker`],
    ["Windows forward slashes", "C:/Users/owner-one/worker", "C:/Users/owner-two/worker"],
    [
      "Windows spaced home",
      String.raw`C:\Users\Jane Doe\worker`,
      String.raw`C:\Users\John Doe\worker`,
    ],
  ])("%s paths remain distinct, stable, and private", (_platform, first, second) => {
    const canonical = canonicalizeDiagnosticIdentity(first);
    expect(canonical).not.toBe(canonicalizeDiagnosticIdentity(second));
    expect(canonicalizeDiagnosticIdentity(first)).toBe(canonical);
    expect(canonicalizeDiagnosticIdentity(canonical)).toBe(canonical);
    expect(canonical).not.toContain("owner-one");
    expect(canonical).not.toContain("Jane");
    expect(canonical).not.toContain("Doe");
    expect(canonical).toContain("[REDACTED:home:");
    expect(canonicalizeDiagnosticIdentity(`kind\0${first}\0source`)).toBe(
      `kind\0${canonical}\0source`,
    );
  });

  test("ordinary identifiers and protocol boundaries remain exact", () => {
    for (const value of [
      "worker-a",
      "schema_version",
      "max_attempts",
      "/srv/worker",
      "kind\0scope",
    ])
      expect(canonicalizeDiagnosticIdentity(value)).toBe(value);
  });

  test("pseudonyms are keyed per install, so a guessed home cannot be confirmed", () => {
    const home = "/home/owner-one";
    const first = mkdtempSync(join(tmpdir(), "identity-a-"));
    const second = mkdtempSync(join(tmpdir(), "identity-b-"));
    const token = canonicalizeIn(first, `${home}/worker`);
    expect(token).toMatch(/^\[REDACTED:home:[0-9a-f]{64}\]\/worker$/);
    // Stable within one install across processes.
    expect(canonicalizeIn(first, `${home}/worker`)).toBe(token);
    // A different install yields an unrelated pseudonym for the same home.
    expect(canonicalizeIn(second, `${home}/worker`)).not.toBe(token);
    // Hashing the guess with only public inputs does not reproduce it.
    for (const unkeyed of [
      createHash("sha256").update(home).digest("hex"),
      createHash("sha256").update("harnery-diagnostic-home-v1\0").update(home).digest("hex"),
    ])
      expect(token).not.toContain(unkeyed);
    const keyFile = join(first, "harnery", "diagnostic-identity.key");
    expect(readFileSync(keyFile, "utf8").trim()).toMatch(/^[0-9a-f]{64}$/);
    if (process.platform !== "win32") expect(statSync(keyFile).mode & 0o777).toBe(0o600);
  });
});

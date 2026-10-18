import { describe, expect, test } from "bun:test";
import { canonicalizeDiagnosticIdentity } from "./path-identity.ts";

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
});

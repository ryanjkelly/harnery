import { describe, expect, test } from "bun:test";
import { sanitizeDiagnosticValue } from "./sanitize.ts";

describe("diagnostic identity and authority sanitization", () => {
  test("preserves protocol keys, retry ceilings, and ordinary owner identity", () => {
    const raw = {
      schema_version: 1,
      workflow_id: "workflow-a",
      iteration: 3,
      worker_id: "worker-a",
      owner_id: "worker-a",
      charged_attempts: 2,
      max_attempts: 3,
      retry_allowed: false,
      terminal_at: null,
      message: "Bearer diagnostic-private-token",
      api_key: "diagnostic-private-key",
      prompt: "diagnostic-private-prompt",
    };
    const before = JSON.stringify(raw);
    const sanitized = JSON.parse(JSON.stringify(sanitizeDiagnosticValue(raw).value));
    expect(Object.keys(sanitized)).toEqual(Object.keys(raw));
    expect(sanitized).toMatchObject({
      schema_version: 1,
      workflow_id: "workflow-a",
      iteration: 3,
      worker_id: "worker-a",
      owner_id: "worker-a",
      charged_attempts: 2,
      max_attempts: 3,
      retry_allowed: false,
      terminal_at: null,
    });
    expect(JSON.stringify(sanitized)).not.toContain("diagnostic-private");
    expect(JSON.stringify(raw)).toBe(before);
  });

  test("keeps path owner identities distinct and consistent while removing private text", () => {
    const first = "/home/owner-one/worker";
    const second = "/home/owner-two/worker";
    const raw = {
      owners: [{ owner_id: first }, { owner_id: second }],
      worker_id: first,
      message: `Run ${first} with Bearer diagnostic-private-token`,
    };
    const before = JSON.stringify(raw);
    const sanitized = sanitizeDiagnosticValue(raw).value as typeof raw;
    expect(sanitized.owners[0]!.owner_id).not.toBe(sanitized.owners[1]!.owner_id);
    expect(sanitized.worker_id).toBe(sanitized.owners[0]!.owner_id);
    expect(sanitizeDiagnosticValue({ owner_id: first }).value).toEqual({
      owner_id: sanitized.worker_id,
    });
    expect(JSON.stringify(sanitized)).not.toContain("/home/owner-");
    expect(sanitized.message).not.toContain("diagnostic-private-token");
    expect(JSON.stringify(raw)).toBe(before);
  });

  test("canonicalizes token-shaped home identities before lossy secret redaction", () => {
    const owners = ["a", "b"].map((letter) => `/home/sk-${letter.repeat(24)}/worker`);
    const raw = { owners, message: "Bearer diagnostic-private-token", max_attempts: 3 };
    const before = JSON.stringify(raw);
    const sanitized = sanitizeDiagnosticValue(raw).value as typeof raw;
    expect(sanitized.owners[0]).not.toBe(sanitized.owners[1]);
    expect(sanitizeDiagnosticValue(sanitized).value).toEqual(sanitized);
    expect(JSON.stringify(sanitized)).not.toContain("sk-");
    expect(JSON.stringify(sanitized)).not.toContain("diagnostic-private-token");
    expect(sanitized.max_attempts).toBe(3);
    expect(JSON.stringify(raw)).toBe(before);
  });
});

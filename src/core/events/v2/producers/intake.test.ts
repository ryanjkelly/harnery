import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeProducerDiagnosticV2 } from "./intake.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("V2 producer diagnostics", () => {
  test("retains bounded metadata without raw prompt, tool, or output bodies", () => {
    const root = mkdtempSync(join(tmpdir(), "harnery-v2-diagnostic-"));
    roots.push(root);
    const secret = "PRIVATE_DIAGNOSTIC_BODY_123";

    const path = writeProducerDiagnosticV2(root, "producer/failure", {
      adapter: "codex",
      signal: "post-tool-use",
      reason: "invalid_state",
      prompt: secret,
      tool_input: { token: secret },
      output: `response:${secret}`,
    });

    expect(path).toBeDefined();
    const durable = readFileSync(path!, "utf8");
    expect(durable).not.toContain(secret);
    expect(JSON.parse(durable)).toMatchObject({
      category: "producer_failure",
      adapter: "codex",
      signal: "post-tool-use",
      reason: "invalid_state",
      content_fingerprint: { bytes: expect.any(Number), sha256: expect.any(String) },
    });
  });
});

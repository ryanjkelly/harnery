import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { FINGERPRINT_KEY_STORE_RELATIVE_PATH } from "../../events/v3/fingerprint-keys.ts";
import { runPromptContext } from "./runner.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("prompt-context provider runner", () => {
  test("does not start a disabled provider", async () => {
    const fixture = createFixture({ enabled: false });
    const marker = join(fixture.workspace, "started");
    writeProvider(
      fixture.root,
      `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "yes");`,
    );

    const result = await runFixture(fixture);

    expect(result.context).toBeNull();
    expect(result.audit.status).toBe("disabled");
    expect(result.audit.delivery).toBe("direct");
    expect(existsSync(marker)).toBeFalse();
  });

  test("does not start a provider for an empty prompt", async () => {
    const fixture = createFixture();
    const marker = join(fixture.workspace, "started");
    writeProvider(
      fixture.root,
      `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "yes");`,
    );

    const result = await runFixture(fixture, { prompt: "  \n " });

    expect(result.context).toBeNull();
    expect(result.audit.status).toBe("no_prompt");
    expect(existsSync(marker)).toBeFalse();
  });

  test("fails open when the fixed host extension is missing", async () => {
    const fixture = createFixture();

    const result = await runFixture(fixture);

    expect(result).toMatchObject({
      context: null,
      delivery: "direct",
      audit: { status: "missing_extension", delivery: "direct" },
    });
  });

  test("passes a normalized v1 request, workspace cwd, and an allowlisted environment", async () => {
    const fixture = createFixture();
    writeProvider(
      fixture.root,
      providerFromStdin(`
        require("node:fs").writeFileSync("capture.json", JSON.stringify({
          cwd: process.cwd(), request, env: process.env
        }));
        process.stdout.write(JSON.stringify(${JSON.stringify(successResult("<record>safe</record>"))}));
      `),
    );

    const result = await runFixture(fixture, {
      sourceEnv: {
        ...process.env,
        HARNERY_PRIVATE_TEST: "must-not-cross-boundary",
        SERVICE_TOKEN: "must-not-cross-boundary",
      },
    });
    const capture = JSON.parse(readFileSync(join(fixture.workspace, "capture.json"), "utf8")) as {
      cwd: string;
      request: Record<string, unknown>;
      env: Record<string, string>;
    };

    expect(result.context).toBe("<record>safe</record>");
    expect(result.audit.status).toBe("delivered");
    expect(capture.cwd).toBe(realpathSync(fixture.workspace));
    expect(capture.request).toEqual({
      schema: "harnery.prompt-context-request/v1",
      event: "user_prompt_submit",
      adapter: "codex",
      session_id: "session-fixture",
      turn_id: "turn-fixture",
      cwd: realpathSync(fixture.workspace),
      prompt: "find order fixture",
    });
    expect(capture.env.HARNERY_PRIVATE_TEST).toBeUndefined();
    expect(capture.env.SERVICE_TOKEN).toBeUndefined();
    expect(capture.env.PATH).toBeDefined();
    expect(capture.env.PATH).toBe(process.env.PATH!);
  });

  test("translates a Codex WSL UNC cwd before starting the provider", async () => {
    const fixture = createFixture();
    writeProvider(
      fixture.root,
      providerFromStdin(`
        process.stdout.write(JSON.stringify(${JSON.stringify(successResult("<record>safe</record>"))}));
      `),
    );
    const uncCwd = `\\\\wsl.localhost\\Ubuntu-22.04${fixture.workspace.replaceAll("/", "\\\\")}`;

    const result = await runFixture(fixture, { cwd: uncCwd });

    expect(result.context).toBe("<record>safe</record>");
    expect(result.audit.status).toBe("delivered");
  });

  test("returns no context for a valid no-match result", async () => {
    const fixture = createFixture();
    writeProvider(
      fixture.root,
      `process.stdout.write(JSON.stringify(${JSON.stringify({
        schema: "harnery.prompt-context-result/v1",
        provider_id: "fixture-provider",
        context: "",
        matched: 0,
        succeeded: 0,
        failed: 0,
        reason_codes: [],
      })}));`,
    );

    const result = await runFixture(fixture);

    expect(result.context).toBeNull();
    expect(result.audit).toMatchObject({
      status: "empty",
      provider_id: "fixture-provider",
      matched: 0,
      succeeded: 0,
      failed: 0,
      reason_codes: [],
    });
    expect(result.audit.context_fingerprint).toBeUndefined();
  });

  test("preserves partial-success metadata for direct Cursor delivery", async () => {
    const fixture = createFixture();
    const providerResult = {
      schema: "harnery.prompt-context-result/v1",
      provider_id: "fixture-provider",
      context: "<order>available record</order>",
      matched: 2,
      succeeded: 1,
      failed: 1,
      reason_codes: ["order_id", "customer_lookup_failed"],
    };
    writeProvider(
      fixture.root,
      `process.stdout.write(JSON.stringify(${JSON.stringify(providerResult)}));`,
    );

    const result = await runFixture(fixture, { adapter: "cursor" });

    expect(result.context).toBe(providerResult.context);
    expect(result.delivery).toBe("direct");
    expect(result.audit).toMatchObject({
      status: "delivered",
      delivery: "direct",
      provider_id: "fixture-provider",
      matched: 2,
      succeeded: 1,
      failed: 1,
      reason_codes: ["order_id", "customer_lookup_failed"],
    });
  });

  test("rejects malformed and structurally extended results", async () => {
    const malformed = createFixture();
    writeProvider(malformed.root, `process.stdout.write("not json");`);
    const malformedResult = await runFixture(malformed);
    expect(malformedResult.context).toBeNull();
    expect(malformedResult.audit.status).toBe("invalid_result");

    const extended = createFixture();
    writeProvider(
      extended.root,
      `process.stdout.write(JSON.stringify(${JSON.stringify({
        ...successResult("context"),
        private_payload: "must not be accepted",
      })}));`,
    );
    const extendedResult = await runFixture(extended);
    expect(extendedResult.context).toBeNull();
    expect(extendedResult.audit.status).toBe("invalid_result");
    expect(JSON.stringify(extendedResult.audit)).not.toContain("private_payload");
  });

  test("kills and rejects output beyond the configured byte limit", async () => {
    const fixture = createFixture({ maxOutputBytes: 128 });
    writeProvider(fixture.root, `process.stdout.write("x".repeat(129));`);

    const result = await runFixture(fixture);

    expect(result.context).toBeNull();
    expect(result.audit.status).toBe("oversized_result");
    expect(result.audit.output_bytes).toBeUndefined();
  });

  test("discards stderr and fails open on a nonzero exit", async () => {
    const fixture = createFixture();
    writeProvider(
      fixture.root,
      `process.stderr.write("customer@example.test ORDER-PRIVATE"); process.exit(7);`,
    );

    const result = await runFixture(fixture);

    expect(result.context).toBeNull();
    expect(result.audit.status).toBe("nonzero_exit");
    expect(JSON.stringify(result)).not.toContain("customer@example.test");
    expect(JSON.stringify(result)).not.toContain("ORDER-PRIVATE");
  });

  test.skipIf(process.platform === "win32")(
    "fails open when the provider exits by signal",
    async () => {
      const fixture = createFixture();
      writeProvider(fixture.root, `process.kill(process.pid, "SIGTERM");`);

      const result = await runFixture(fixture);

      expect(result.context).toBeNull();
      expect(result.audit.status).toBe("signal");
    },
  );

  test("kills a provider at the configured timeout", async () => {
    const fixture = createFixture({ timeoutMs: 40 });
    writeProvider(fixture.root, `setTimeout(() => {}, 10_000);`);

    const startedAt = Date.now();
    const result = await runFixture(fixture);

    expect(result.context).toBeNull();
    expect(result.audit.status).toBe("timeout");
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  test("returns only redacted audit metadata and a keyed stable fingerprint", async () => {
    const fixture = createFixture();
    const privateContext = "customer@example.test ORDER-SECRET-RECORD";
    writeProvider(
      fixture.root,
      `process.stdout.write(JSON.stringify(${JSON.stringify(successResult(privateContext))}));`,
    );

    const first = await runFixture(fixture, { prompt: "customer@example.test" });
    const second = await runFixture(fixture, { prompt: "customer@example.test" });
    const auditText = JSON.stringify(first.audit);
    const rawDigest = createHash("sha256").update(privateContext).digest("hex");
    const keyPath = join(fixture.root, FINGERPRINT_KEY_STORE_RELATIVE_PATH);

    expect(first.context).toBe(privateContext);
    expect(auditText).not.toContain("customer@example.test");
    expect(auditText).not.toContain("ORDER-SECRET-RECORD");
    expect(first.audit.context_fingerprint).toMatch(/^hmac-sha256:[a-f0-9]{64}$/);
    expect(first.audit.context_fingerprint).toBe(second.audit.context_fingerprint);
    expect(first.audit.context_fingerprint).not.toContain(rawDigest);
    expect(existsSync(keyPath)).toBeTrue();
    if (process.platform !== "win32") expect(statSync(keyPath).mode & 0o777).toBe(0o600);
  });
});

interface Fixture {
  root: string;
  workspace: string;
}

function createFixture(
  config: { enabled?: boolean; timeoutMs?: number; maxOutputBytes?: number } = {},
): Fixture {
  const root = mkdtempSync(join(tmpdir(), "harnery-prompt-context-"));
  roots.push(root);
  const workspace = join(root, "workspace", "nested");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(join(root, ".harnery"), { recursive: true });
  writeFileSync(
    join(root, ".harnery", "config.jsonc"),
    JSON.stringify({
      hooks: {
        promptContext: {
          enabled: config.enabled ?? true,
          timeoutMs: config.timeoutMs ?? 2_000,
          maxOutputBytes: config.maxOutputBytes ?? 65_536,
        },
      },
    }),
  );
  return { root, workspace };
}

function writeProvider(root: string, body: string): void {
  const path = join(root, "scripts", "hooks", "harness", "extensions", "prompt-context");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `#!/usr/bin/env node\n${body}\n`, { mode: 0o700 });
  chmodSync(path, 0o700);
}

function providerFromStdin(onEnd: string): string {
  return `
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => {
      const request = JSON.parse(input);
      ${onEnd}
    });
  `;
}

function successResult(context: string): Record<string, unknown> {
  return {
    schema: "harnery.prompt-context-result/v1",
    provider_id: "fixture-provider",
    context,
    matched: 1,
    succeeded: 1,
    failed: 0,
    reason_codes: ["fixture_match"],
  };
}

function runFixture(
  fixture: Fixture,
  overrides: Partial<Parameters<typeof runPromptContext>[0]> = {},
) {
  return runPromptContext({
    coordRoot: fixture.root,
    adapter: "codex",
    sessionId: "session-fixture",
    turnId: "turn-fixture",
    cwd: join(fixture.workspace, "..", "nested"),
    prompt: "find order fixture",
    ...overrides,
  });
}

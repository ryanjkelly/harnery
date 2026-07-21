import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  evaluatePolicy,
  loadPolicyFile,
  normalizePolicy,
  policyDigest,
  summarizePolicyRequest,
} from "./index.ts";

const baseRequest = {
  phase: "dispatch" as const,
  action: "spawn agent",
  path: "/workspace/repo",
  harness: "codex",
  model: "gpt-5",
  isolation: "worktree" as const,
  network_access: "disabled" as const,
  current_cost_usd: 0.25,
  projected_cost_usd: 0.1,
};

describe("host policy", () => {
  test("normalizes deterministically and freezes the host contract", () => {
    const a = normalizePolicy({
      name: "release",
      network: "allow",
      allowed_harnesses: ["codex", "claude-code", "codex"],
    });
    const b = normalizePolicy({
      name: "release",
      network: "allow",
      allowed_harnesses: ["claude-code", "codex"],
    });
    expect(a.allowed_harnesses).toEqual(["claude-code", "codex"]);
    expect(a.external_actions).toBe("deny");
    expect(a.unknown_cost).toBe("deny");
    expect(Object.isFrozen(a)).toBe(true);
    expect(Object.isFrozen(a.allowed_harnesses)).toBe(true);
    expect(policyDigest(a)).toBe(policyDigest(b));
  });

  test("composes independent restrictions with deny stronger than ask", () => {
    const policy = normalizePolicy({
      allowed_harnesses: ["claude-code"],
      allowed_models: ["claude-sonnet"],
      allowed_paths: ["/workspace/safe"],
      allowed_isolation: ["sandbox"],
      network: "ask",
    });
    const result = evaluatePolicy(policy, { ...baseRequest, network_access: "enabled" });
    expect(result.verdict).toBe("deny");
    expect(result.rules.map((rule) => rule.code)).toEqual([
      "harness_not_allowed",
      "model_not_allowed",
      "path_not_allowed",
      "isolation_not_allowed",
      "network_restricted",
    ]);
  });

  test("allowed path containment rejects prefix lookalikes", () => {
    const policy = normalizePolicy({ allowed_paths: ["/workspace/repo"], network: "allow" });
    expect(evaluatePolicy(policy, baseRequest).verdict).toBe("allow");
    expect(evaluatePolicy(policy, { ...baseRequest, path: "/workspace/repository" }).verdict).toBe(
      "deny",
    );
  });

  test("unknown dispatch pricing never silently allows under a ceiling", () => {
    const ask = normalizePolicy({ max_cost_usd: 1, unknown_cost: "ask", network: "allow" });
    const deny = normalizePolicy({ max_cost_usd: 1, network: "allow" });
    const request = { ...baseRequest, projected_cost_usd: null };
    expect(evaluatePolicy(ask, request).verdict).toBe("ask");
    expect(evaluatePolicy(deny, request).verdict).toBe("deny");
  });

  test("known projection is checked against accumulated run cost", () => {
    const policy = normalizePolicy({ max_cost_usd: 1, network: "allow" });
    expect(
      evaluatePolicy(policy, {
        ...baseRequest,
        current_cost_usd: 0.8,
        projected_cost_usd: 0.21,
      }).rules[0]?.code,
    ).toBe("cost_budget_exceeded");
    expect(
      evaluatePolicy(policy, {
        ...baseRequest,
        current_cost_usd: 0.8,
        projected_cost_usd: 0.2,
      }).verdict,
    ).toBe("allow");
  });

  test("external mutations require the external and network rules independently", () => {
    const policy = normalizePolicy({ external_actions: "allow", network: "deny" });
    expect(
      evaluatePolicy(policy, {
        phase: "external_mutation",
        action: "publish release",
        isolation: "shared",
        network_access: "enabled",
        service: "registry",
      }).verdict,
    ).toBe("deny");
  });

  test("receipt summaries strip URL credentials, query strings, fragments, and controls", () => {
    const request = summarizePolicyRequest({
      phase: "external_mutation",
      action: "publish\nrelease",
      isolation: "shared",
      network_access: "enabled",
      target: "https://user:secret@example.com/path?token=secret#fragment",
    });
    expect(request.action).toBe("publish release");
    expect(request.target).toBe("https://example.com/path");
  });

  test("policy files accept JSONC and resolve paths relative to the file", () => {
    const root = join(tmpdir(), `policy-file-${process.pid}-${Date.now()}`);
    mkdirSync(root, { recursive: true });
    const path = join(root, "policy.jsonc");
    writeFileSync(
      path,
      `{
        // repository root
        "allowed_paths": ["./repo"],
        "network": "allow"
      }`,
    );
    try {
      const policy = loadPolicyFile(path);
      expect(policy.allowed_paths).toEqual([join(root, "repo")]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects invalid and empty rule values", () => {
    expect(() => normalizePolicy({ max_cost_usd: -1 })).toThrow(/non-negative/);
    expect(() => normalizePolicy({ allowed_models: [] })).toThrow(/non-empty array/);
    expect(() => normalizePolicy({ network: "sometimes" as "allow" })).toThrow(/allow, ask, deny/);
    expect(() => normalizePolicy({ netwrok: "allow" } as never)).toThrow(/unknown field.*netwrok/);
  });
});

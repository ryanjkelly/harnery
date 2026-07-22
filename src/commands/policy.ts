import type { Command } from "commander";
import type { EmitContext } from "../commander.ts";
import type { NormalizedPolicy } from "../core/policy/index.ts";
import { loadPolicyFile, policyDigest } from "../core/policy/index.ts";

interface PolicyCheckOpts {
  json?: boolean;
}

export function registerPolicyCommand(program: Command, emit: EmitContext): void {
  const command = program
    .command("policy")
    .description("Inspect host-enforced workflow policy documents.");

  command
    .command("check <file>")
    .description("Validate and print a normalized policy without running a workflow.")
    .option("--json", "Emit the normalized policy and digest as JSON")
    .action((file: string, opts: PolicyCheckOpts) => {
      try {
        const policy = loadPolicyFile(file);
        const result = { policy, sha256: policyDigest(policy) };
        if (opts.json) {
          emit.config({ format: "json" });
          emit.data(result);
        } else {
          emit.text(renderPolicy(policy, result.sha256));
        }
      } catch (error) {
        emit.error({ code: "policy_invalid", message: (error as Error).message });
        emit.setExitCode(1);
      }
    });
}

export function renderPolicy(policy: Readonly<NormalizedPolicy>, digest: string): string {
  const lines = [
    `${policy.name} (schema ${policy.schema_version})`,
    `sha256: ${digest}`,
    `cost ceiling: ${policy.max_cost_usd === undefined ? "none" : `$${policy.max_cost_usd.toFixed(4)}`}`,
    `unknown cost: ${policy.unknown_cost}`,
    `network: ${policy.network}`,
    `external actions: ${policy.external_actions}`,
    `harnesses: ${policy.allowed_harnesses?.join(", ") ?? "any"}`,
    `models: ${policy.allowed_models?.join(", ") ?? "any"}`,
    `paths: ${policy.allowed_paths?.join(", ") ?? "any"}`,
    `isolation: ${policy.allowed_isolation?.join(", ") ?? "any"}`,
  ];
  return `${lines.join("\n")}\n`;
}

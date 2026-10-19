import { readFileSync, writeFileSync } from "node:fs";
import { readWorkspaceEvents } from "../../workflow/workspaces/state.ts";
import type { WorkspaceBinding } from "../../workflow/workspaces/types.ts";
import { applyTurnRollback, type TurnRollbackPlan } from "../index.ts";

const input = JSON.parse(readFileSync(process.argv[2]!, "utf8")) as {
  coord: string;
  binding: WorkspaceBinding;
  plan: TurnRollbackPlan;
  marker: string;
};
await applyTurnRollback(input.coord, {
  binding: input.binding,
  plan: input.plan,
  yes: true,
  actor: "crash fixture",
  reason: "verify interrupted restore evidence",
  onStep(step) {
    if (step === "started") {
      const event = readWorkspaceEvents(
        input.coord,
        input.binding.provider.id,
        input.binding.binding_id,
      ).at(-1);
      if (
        event?.event !== "turn_rollback.apply_requested" ||
        event.data.plan_sha256 !== input.plan.plan_sha256 ||
        event.data.actor !== "crash fixture" ||
        event.data.reason !== "verify interrupted restore evidence" ||
        JSON.stringify(event.data.paths) !==
          JSON.stringify(input.plan.paths.map((entry) => entry.path))
      ) {
        throw new Error("durable exact-path audit was not present before effects");
      }
    }
    if (step !== "worktree_published") return;
    writeFileSync(input.marker, step);
    process.kill(process.pid, "SIGKILL");
  },
});
throw new Error("crash boundary was not reached");

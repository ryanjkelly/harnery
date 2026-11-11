import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeDir } from "../../../tests/helpers/remove-dir.ts";
import { writeLegacyIsolatedRun } from "./__fixtures__/legacy-isolated-run.ts";
import { readWorkflowProof, renderWorkflowProof } from "./proof.ts";
import { assertWorkflowRunResumable, readWorkflowRunManifest } from "./run-state.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) removeDir(root);
});

function coordRoot(): string {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "harn-legacy-run-"));
  roots.push(root);
  return root;
}

describe("records written before isolated workspaces were removed", () => {
  test("a proof with workspace and admission evidence still loads as history", () => {
    const root = coordRoot();
    const runId = writeLegacyIsolatedRun(root);

    const proof = readWorkflowProof(root, runId);
    expect(proof.run).toMatchObject({ id: runId, name: "legacy-isolated", status: "succeeded" });
    // The retired fields stay in the parsed packet as inert history.
    expect(proof).toHaveProperty("execution");
    expect(proof).toHaveProperty("diagnostic_admission");

    const rendered = renderWorkflowProof(proof);
    expect(rendered).toContain(`run ${runId} (legacy-isolated): succeeded`);
    expect(rendered).not.toContain("admission");
  });

  test("its manifest loads, but the run cannot be resumed", () => {
    const root = coordRoot();
    const runId = writeLegacyIsolatedRun(root);

    expect(readWorkflowRunManifest(root, runId).name).toBe("legacy-isolated");
    expect(() => assertWorkflowRunResumable(root, runId)).toThrow(
      `workflow run ${runId} ran with worktree isolation, which this version no longer supports`,
    );
  });
});

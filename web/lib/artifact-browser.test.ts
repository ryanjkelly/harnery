import { describe, expect, test } from "bun:test";
import { agentArtifactDirectories } from "./artifact-browser";

describe("agentArtifactDirectories", () => {
  test("returns the requested agent's workspaces newest first", () => {
    expect(
      agentArtifactDirectories(
        [
          {
            owner_instance_id: "inst-a",
            relative_path: ".harnery/artifacts/older",
            created_at: "2026-08-20T10:00:00.000Z",
          },
          {
            owner_instance_id: "inst-b",
            relative_path: ".harnery/artifacts/other",
            created_at: "2026-08-22T10:00:00.000Z",
          },
          {
            owner_instance_id: "inst-a",
            relative_path: ".harnery/artifacts/newer",
            created_at: "2026-08-21T10:00:00.000Z",
          },
        ],
        "inst-a",
      ),
    ).toEqual([".harnery/artifacts/newer", ".harnery/artifacts/older"]);
  });

  test("returns an empty list when the agent has no managed workspace", () => {
    expect(agentArtifactDirectories([], "inst-missing")).toEqual([]);
  });
});

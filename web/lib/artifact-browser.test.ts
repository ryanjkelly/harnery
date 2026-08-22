import { describe, expect, test } from "bun:test";
import { latestAgentArtifactDirectory } from "./artifact-browser";

describe("latestAgentArtifactDirectory", () => {
  test("selects the newest managed workspace owned by the requested agent", () => {
    expect(
      latestAgentArtifactDirectory(
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
    ).toBe(".harnery/artifacts/newer");
  });

  test("returns null when the agent has no managed workspace", () => {
    expect(latestAgentArtifactDirectory([], "inst-missing")).toBeNull();
  });
});

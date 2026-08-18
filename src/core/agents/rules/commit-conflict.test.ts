import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeV2Fixture, seedV2Session } from "../../../../tests/helpers/event-v2.ts";
import { evaluateCommit } from "./commit-conflict.ts";

let root: string;

beforeEach(() => {
  root = join(tmpdir(), `harnery-commit-v2-${process.pid}-${crypto.randomUUID()}`);
  initializeV2Fixture(root);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("evaluateCommit on canonical V2 authority", () => {
  test("an empty staged set passes without coordination state", () => {
    expect(
      evaluateCommit(root, { instance_id: "self", session_id: "self", staged_paths: [] }),
    ).toMatchObject({ allow: true, rule: "commit.pass" });
  });

  test("a staged path with no peer claim passes", () => {
    seedV2Session(root, "self", { name: "Maya" });
    expect(commitVerdict(["docs/x.md"])).toMatchObject({ allow: true });
  });

  test("a peer claim on a staged path blocks the commit", () => {
    seedV2Session(root, "self", { name: "Maya" });
    seedV2Session(root, "peer", {
      name: "Adelaide",
      claims: ["docs/shared.md", "docs/peer-only.md"],
    });
    const result = commitVerdict(["docs/shared.md"]);
    expect(result.allow).toBe(false);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]?.short_name).toContain("Adelaide");
  });

  test("the self-attribution suppression remains explicit", () => {
    seedV2Session(root, "self", { name: "Maya" });
    seedV2Session(root, "peer", { name: "Adelaide", claims: ["docs/shared.md"] });
    expect(commitVerdict(["docs/shared.md"])).toMatchObject({
      allow: true,
      rule: "commit.suppressed",
      suppressed_self_attribution: true,
    });
  });
});

function commitVerdict(stagedPaths: string[]) {
  return evaluateCommit(root, {
    instance_id: "self",
    session_id: "self",
    staged_paths: stagedPaths,
  });
}

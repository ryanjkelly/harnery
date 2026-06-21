/**
 * advanceCouncil pending-member detection across contribution-filename
 * generations: v1 councils wrote `round-N/<agent-Name>.md`; schema_version 2
 * (manifests carrying `member_ids`) writes `round-N/<member-uuid>.md`. The
 * 2026-06-10 regression: the lifecycle check only looked for name-based files,
 * so a fully-collected v2 round could never advance without --force.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";

import { advanceCouncil } from "../../src/core/agents/state/council";

const COUNCIL_ID = "test-council-advance";

let coordRoot: string;

function writeManifest(extra: Record<string, unknown> = {}): void {
  const manifest = {
    council_id: COUNCIL_ID,
    status: "active",
    current_round: 1,
    round_status: "open",
    members: ["agent-Alpha", "agent-Beta"],
    ...extra,
  };
  writeFileSync(
    join(coordRoot, ".harnery", "councils", `${COUNCIL_ID}.json`),
    JSON.stringify(manifest, null, 2),
  );
}

function writeContribution(filename: string): void {
  const roundDir = join(coordRoot, ".harnery", "councils", COUNCIL_ID, "round-1");
  mkdirSync(roundDir, { recursive: true });
  writeFileSync(join(roundDir, filename), "take\n\n<substantive>\n");
}

function manifestOnDisk(): { current_round: number; round_status: string } {
  return JSON.parse(
    readFileSync(
      join(coordRoot, ".harnery", "councils", `${COUNCIL_ID}.json`),
      "utf8",
    ),
  );
}

beforeEach(() => {
  coordRoot = mkdtempSync(join(os.tmpdir(), "council-advance-"));
  mkdirSync(join(coordRoot, ".harnery", "councils"), { recursive: true });
});

afterEach(() => {
  rmSync(coordRoot, { recursive: true, force: true });
});

describe("advanceCouncil contribution detection", () => {
  test("v1: name-based contribution files satisfy the pending check", () => {
    writeManifest();
    writeContribution("agent-Alpha.md");
    writeContribution("agent-Beta.md");

    const result = advanceCouncil(coordRoot, COUNCIL_ID);
    expect(result.ok).toBe(true);
    expect(manifestOnDisk().current_round).toBe(2);
  });

  test("v2: uuid contribution files satisfy the pending check via member_ids", () => {
    writeManifest({ member_ids: ["uuid-alpha", "uuid-beta"] });
    writeContribution("uuid-alpha.md");
    writeContribution("uuid-beta.md");

    const result = advanceCouncil(coordRoot, COUNCIL_ID);
    expect(result.ok).toBe(true);
    expect(manifestOnDisk().current_round).toBe(2);
    expect(manifestOnDisk().round_status).toBe("open");
  });

  test("mixed generations: one name file + one uuid file both count", () => {
    writeManifest({ member_ids: ["uuid-alpha", "uuid-beta"] });
    writeContribution("agent-Alpha.md");
    writeContribution("uuid-beta.md");

    expect(advanceCouncil(coordRoot, COUNCIL_ID).ok).toBe(true);
  });

  test("missing member blocks advance and names the pending member", () => {
    writeManifest({ member_ids: ["uuid-alpha", "uuid-beta"] });
    writeContribution("uuid-alpha.md");

    const result = advanceCouncil(coordRoot, COUNCIL_ID);
    expect(result.ok).toBe(false);
    expect(result.pendingMember).toBe("agent-Beta");
    expect(manifestOnDisk().current_round).toBe(1);
  });

  test("--force skips the pending check", () => {
    writeManifest({ member_ids: ["uuid-alpha", "uuid-beta"] });

    const result = advanceCouncil(coordRoot, COUNCIL_ID, { force: true });
    expect(result.ok).toBe(true);
    expect(manifestOnDisk().current_round).toBe(2);
  });
});

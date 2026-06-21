/**
 * Council Phase 0 helpers: unit tests.
 *
 * Pure-function tests (slug, name normalization, id format) don't need a
 * monorepo root. Manifest read/write/list/archive tests use a tempdir +
 * HARNERY_COORD_ROOT_OVERRIDE so they don't touch the real .harnery/ state.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import {
  COUNCIL_SCHEMA_VERSION,
  buildCouncilId,
  buildInviteMarkdown,
  contributionPath,
  contributorsInRound,
  councilBodyDir,
  councilsArchiveDir,
  councilsDir,
  deriveSlug,
  deterministicCouncilId,
  findManifestByPartialId,
  listManifests,
  moveToArchive,
  normalizeAgentName,
  pendingCouncilsForMember,
  readManifest,
  roundDir,
  writeContribution,
  writeManifest,
  type CouncilManifest,
} from "../src/lib/council/index.ts";

describe("deriveSlug", () => {
  it("kebab-cases the first 5 words", () => {
    expect(deriveSlug("Review the coord shortlist tranche plan")).toBe(
      "review-the-coord-shortlist-tranche",
    );
  });
  it("strips non-alphanumeric chars", () => {
    expect(deriveSlug("Coord/UI: ship Phase 2b done?")).toBe(
      "coord-ui-ship-phase-2b",
    );
  });
  it("falls back to 'council' when the input has nothing usable", () => {
    expect(deriveSlug("!!! ???")).toBe("council");
    expect(deriveSlug("")).toBe("council");
  });
});

describe("normalizeAgentName", () => {
  it("adds agent- prefix when missing", () => {
    expect(normalizeAgentName("Juno")).toBe("agent-Juno");
    expect(normalizeAgentName("  Dahlia  ")).toBe("agent-Dahlia");
  });
  it("leaves agent- prefix intact when present", () => {
    expect(normalizeAgentName("agent-Beau")).toBe("agent-Beau");
    expect(normalizeAgentName("  agent-Margot  ")).toBe("agent-Margot");
  });
  it("returns empty for empty input", () => {
    expect(normalizeAgentName("")).toBe("");
    expect(normalizeAgentName("   ")).toBe("");
  });
});

describe("buildCouncilId", () => {
  it("produces a slug-date-hash id matching the schema regex", () => {
    const id = buildCouncilId("Review coord shortlist", new Date("2026-05-22T10:00:00Z"));
    // <slug>-<YYYY-MM-DD>-<4hex>
    expect(id).toMatch(/^review-coord-shortlist-2026-05-22-[0-9a-f]{4}$/);
  });
  it("emits different hashes on consecutive calls", () => {
    const a = buildCouncilId("Same objective");
    const b = buildCouncilId("Same objective");
    expect(a).not.toBe(b);
  });
});

describe("deterministicCouncilId", () => {
  it("is stable for the same input + date", () => {
    const date = new Date("2026-05-22T10:00:00Z");
    const id1 = deterministicCouncilId("Stable input", date);
    const id2 = deterministicCouncilId("Stable input", date);
    expect(id1).toBe(id2);
  });
});

describe("buildInviteMarkdown", () => {
  const sample: CouncilManifest = {
    schema_version: COUNCIL_SCHEMA_VERSION,
    council_id: "test-2026-05-22-aaaa",
    created_at: "2026-05-22T10:00:00Z",
    created_by: "agent-Juno",
    created_by_id: "00000000-0000-0000-0000-000000000001",
    objective: "Test objective",
    target_doc: "docs/some-plan.md",
    members: ["agent-Juno", "agent-Beau"],
    member_ids: [
      "00000000-0000-0000-0000-000000000001",
      "00000000-0000-0000-0000-000000000002",
    ],
    current_round: 1,
    round_status: "open",
    status: "active",
    auto_advance: false,
    round_visibility: "next_round",
  };

  it("includes the council_id, objective, members, target_doc", () => {
    const md = buildInviteMarkdown(sample);
    expect(md).toContain("test-2026-05-22-aaaa");
    expect(md).toContain("Test objective");
    expect(md).toContain("agent-Juno, agent-Beau");
    expect(md).toContain("`docs/some-plan.md`");
  });
  it("renders the auto-advance and visibility hints", () => {
    const md = buildInviteMarkdown(sample);
    expect(md).toContain("convener advances each round manually");
    expect(md).toContain("Round visibility");
    expect(md).toContain("next_round");
  });
});

// ──────── filesystem-touching tests (use HARNERY_COORD_ROOT_OVERRIDE) ────────

let sandboxRoot: string;
let originalRoot: string | undefined;

beforeAll(() => {
  originalRoot = process.env.HARNERY_COORD_ROOT_OVERRIDE;
  sandboxRoot = mkdtempSync(resolve(tmpdir(), "bp-council-test-"));
  process.env.HARNERY_COORD_ROOT_OVERRIDE = sandboxRoot;
  mkdirSync(resolve(sandboxRoot, ".harnery", "councils"), { recursive: true });
});

afterAll(() => {
  rmSync(sandboxRoot, { recursive: true, force: true });
  if (originalRoot === undefined) {
    delete process.env.HARNERY_COORD_ROOT_OVERRIDE;
  } else {
    process.env.HARNERY_COORD_ROOT_OVERRIDE = originalRoot;
  }
});

afterEach(() => {
  // Clean .harnery/councils/ between tests so list isolation holds
  const dir = councilsDir();
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
  }
});

function sampleManifest(overrides: Partial<CouncilManifest> = {}): CouncilManifest {
  return {
    schema_version: COUNCIL_SCHEMA_VERSION,
    council_id: "sample-2026-05-22-aaaa",
    created_at: "2026-05-22T10:00:00Z",
    created_by: "agent-Juno",
    created_by_id: "00000000-0000-0000-0000-000000000001",
    objective: "Sample",
    target_doc: null,
    members: ["agent-Juno", "agent-Beau"],
    member_ids: [
      "00000000-0000-0000-0000-000000000001",
      "00000000-0000-0000-0000-000000000002",
    ],
    current_round: 1,
    round_status: "open",
    status: "active",
    auto_advance: false,
    round_visibility: "next_round",
    ...overrides,
  };
}

describe("councilsDir / councilBodyDir under override", () => {
  it("resolves to the override root's .harnery/councils/", () => {
    expect(councilsDir()).toBe(resolve(sandboxRoot, ".harnery", "councils"));
    expect(councilBodyDir("foo-2026-05-22-aaaa")).toBe(
      resolve(sandboxRoot, ".harnery", "councils", "foo-2026-05-22-aaaa"),
    );
  });
});

describe("writeManifest + readManifest", () => {
  it("round-trips a manifest faithfully", () => {
    const m = sampleManifest();
    writeManifest(m);
    const got = readManifest(m.council_id);
    expect(got).toEqual(m);
  });

  it("returns null for a missing council", () => {
    expect(readManifest("does-not-exist-2026-01-01-zzzz")).toBeNull();
  });

  it("rejects a manifest with the wrong schema_version", () => {
    const m = sampleManifest({ council_id: "badver-2026-05-22-bbbb" });
    writeManifest(m);
    // Hand-tamper the file. Regex matches whatever the current schema
    // version is so the test doesn't rot every time COUNCIL_SCHEMA_VERSION
    // bumps (was hardcoded "schema_version": 1 → silently stopped catching
    // anything after the v1→v2 migration).
    const cd = councilsDir();
    if (!cd) throw new Error("no councils dir");
    const tampered = readFileSync(resolve(cd, `${m.council_id}.json`), "utf8").replace(
      /"schema_version":\s*\d+/,
      '"schema_version": 99',
    );
    require("node:fs").writeFileSync(resolve(cd, `${m.council_id}.json`), tampered);
    expect(() => readManifest(m.council_id)).toThrow(/unsupported schema_version/);
  });
});

describe("listManifests", () => {
  it("returns every manifest in active dir, excluding archive", () => {
    const a = sampleManifest({ council_id: "alpha-2026-05-22-aaaa", created_at: "2026-05-22T09:00:00Z" });
    const b = sampleManifest({ council_id: "bravo-2026-05-22-bbbb", created_at: "2026-05-22T10:00:00Z" });
    writeManifest(a);
    writeManifest(b);
    // Move one to archive
    moveToArchive(a.council_id);
    const got = listManifests();
    expect(got.map((m) => m.council_id)).toEqual(["bravo-2026-05-22-bbbb"]);
  });

  it("returns empty when no councils exist", () => {
    expect(listManifests()).toEqual([]);
  });
});

describe("findManifestByPartialId", () => {
  it("resolves a partial prefix to the full manifest", () => {
    const m = sampleManifest({ council_id: "review-plan-2026-05-22-9999" });
    writeManifest(m);
    const got = findManifestByPartialId("review-plan");
    expect(got?.council_id).toBe(m.council_id);
  });
  it("returns null when no manifest matches", () => {
    expect(findManifestByPartialId("nothing")).toBeNull();
  });
});

describe("contributionPath", () => {
  // Contribution filenames use the agent's durable persona UUID
  // (`<agent_id>.md`) rather than `agent-Name.md` so a future rename
  // doesn't break the link between manifest and on-disk contribution.
  it("returns round-N/<uuid>.md under the council body dir", () => {
    const p = contributionPath("foo-2026-05-22-aaaa", 2, "agent-Juno");
    const expectedRoundDir = resolve(
      sandboxRoot,
      ".harnery",
      "councils",
      "foo-2026-05-22-aaaa",
      "round-2",
    );
    expect(p?.startsWith(`${expectedRoundDir}/`)).toBe(true);
    // Filename is `<uuid>.md`, the UUID is whatever ensureIdentity minted
    // for this agent. Assert shape, not content.
    expect(p?.match(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.md$/)).not.toBeNull();
  });
  it("resolves a bare name through the identity registry the same way", () => {
    // Bare "Juno" and "agent-Juno" should mint/find the SAME identity, so
    // contributionPath returns identical paths for both inputs.
    const a = contributionPath("foo-2026-05-22-aaaa", 1, "Juno");
    const b = contributionPath("foo-2026-05-22-aaaa", 1, "agent-Juno");
    expect(a).toBe(b);
    expect(a?.endsWith(".md")).toBe(true);
  });
});

describe("writeContribution + contributorsInRound", () => {
  it("creates the round dir + writes the file + lists the contributor", () => {
    const m = sampleManifest({ council_id: "contrib-2026-05-22-aaaa" });
    writeManifest(m);
    expect(contributorsInRound(m.council_id, 1)).toEqual([]);
    writeContribution(m.council_id, 1, "agent-Juno", "Juno take on round 1");
    writeContribution(m.council_id, 1, "agent-Beau", "Beau take on round 1");
    const got = contributorsInRound(m.council_id, 1);
    expect(got).toEqual(["agent-Beau", "agent-Juno"]); // sorted alphabetically
  });

  it("creates a separate dir per round", () => {
    const m = sampleManifest({ council_id: "rounds-2026-05-22-aaaa" });
    writeManifest(m);
    writeContribution(m.council_id, 1, "agent-Juno", "round 1");
    writeContribution(m.council_id, 2, "agent-Juno", "round 2");
    expect(contributorsInRound(m.council_id, 1)).toEqual(["agent-Juno"]);
    expect(contributorsInRound(m.council_id, 2)).toEqual(["agent-Juno"]);
    expect(contributorsInRound(m.council_id, 3)).toEqual([]);
  });

  it("contributorsInRound returns [] for a non-existent round dir", () => {
    expect(contributorsInRound("ghost-2026-05-22-zzzz", 1)).toEqual([]);
  });
});

describe("roundDir", () => {
  it("resolves to <body>/round-N/", () => {
    const rd = roundDir("foo-2026-05-22-aaaa", 3);
    expect(rd).toBe(
      resolve(sandboxRoot, ".harnery", "councils", "foo-2026-05-22-aaaa", "round-3"),
    );
  });
});

describe("pendingCouncilsForMember", () => {
  it("returns councils where the member hasn't contributed to the open round", () => {
    const a = sampleManifest({
      council_id: "needs-action-2026-05-22-aaaa",
      members: ["agent-Juno", "agent-Beau"],
    });
    const b = sampleManifest({
      council_id: "not-mine-2026-05-22-bbbb",
      members: ["agent-Dahlia"],
    });
    writeManifest(a);
    writeManifest(b);
    expect(pendingCouncilsForMember("agent-Juno")).toEqual([
      "needs-action-2026-05-22-aaaa",
    ]);
  });

  it("excludes councils once the member has contributed to the current round", () => {
    const m = sampleManifest({
      council_id: "already-done-2026-05-22-aaaa",
      members: ["agent-Juno"],
    });
    writeManifest(m);
    expect(pendingCouncilsForMember("agent-Juno")).toEqual([
      "already-done-2026-05-22-aaaa",
    ]);
    writeContribution(m.council_id, 1, "agent-Juno", "done");
    expect(pendingCouncilsForMember("agent-Juno")).toEqual([]);
  });

  it("excludes closed and archived councils", () => {
    const closed = sampleManifest({
      council_id: "closed-2026-05-22-aaaa",
      members: ["agent-Juno"],
      status: "closed",
    });
    const archived = sampleManifest({
      council_id: "archived-2026-05-22-bbbb",
      members: ["agent-Juno"],
      status: "archived",
    });
    writeManifest(closed);
    writeManifest(archived);
    expect(pendingCouncilsForMember("agent-Juno")).toEqual([]);
  });

  it("normalizes bare names (Juno → agent-Juno)", () => {
    const m = sampleManifest({
      council_id: "bare-name-2026-05-22-aaaa",
      members: ["agent-Juno"],
    });
    writeManifest(m);
    expect(pendingCouncilsForMember("Juno")).toEqual([
      "bare-name-2026-05-22-aaaa",
    ]);
  });
});

describe("moveToArchive", () => {
  it("moves manifest + body dir into .harnery/councils/archive/", () => {
    const m = sampleManifest({ council_id: "movable-2026-05-22-aaaa" });
    writeManifest(m);
    const body = councilBodyDir(m.council_id);
    if (!body) throw new Error("no body dir");
    mkdirSync(body, { recursive: true });
    require("node:fs").writeFileSync(
      resolve(body, "invite.md"),
      "test invite\n",
      "utf8",
    );
    moveToArchive(m.council_id);

    const archive = councilsArchiveDir();
    if (!archive) throw new Error("no archive dir");
    const archived = resolve(archive, `${m.council_id}.json`);
    const archivedBody = resolve(archive, m.council_id);
    expect(require("node:fs").existsSync(archived)).toBe(true);
    expect(require("node:fs").existsSync(archivedBody)).toBe(true);
    expect(
      require("node:fs").existsSync(
        resolve(archive, m.council_id, "invite.md"),
      ),
    ).toBe(true);

    // Original locations should be gone
    expect(listManifests().length).toBe(0);
  });

  it("is idempotent (calling twice is a no-op)", () => {
    const m = sampleManifest({ council_id: "twice-2026-05-22-aaaa" });
    writeManifest(m);
    moveToArchive(m.council_id);
    expect(() => moveToArchive(m.council_id)).not.toThrow();
  });
});

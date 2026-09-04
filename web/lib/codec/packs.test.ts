import { beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { COORD_NAMES } from "../../../src/core/agents/state/names";

import {
  allocateCharacters,
  defaultPacksDir,
  EXPRESSION_FALLBACK,
  EXTENDED_EXPRESSIONS,
  listPacks,
  REQUIRED_EXPRESSIONS,
  ROSTER_EXPRESSIONS,
  resolvePackAsset,
  summarizePackRoster,
  validatePackDir,
} from "./packs";

const NOW = "2026-08-16T12:00:00.000Z";
const LATER = "2026-08-16T12:30:00.000Z";

let root: string;

function makePack(
  id: string,
  opts: { missing?: string[]; version?: string; metadata?: Record<string, string> } = {},
  baseRoot = root,
): string {
  const dir = path.join(baseRoot, "codec", "packs", id);
  mkdirSync(dir, { recursive: true });
  const expressions: Record<string, string> = {};
  for (const expr of REQUIRED_EXPRESSIONS) {
    expressions[expr] = `${expr}.webp`;
    if (!opts.missing?.includes(expr)) writeFileSync(path.join(dir, `${expr}.webp`), "img");
  }
  writeFileSync(
    path.join(dir, "pack.json"),
    JSON.stringify({
      schema_version: 1,
      pack_id: id,
      pack_version: opts.version ?? "1",
      expressions,
      ...opts.metadata,
    }),
  );
  return dir;
}

const target = (instance_id: string, display_name?: string) => ({ instance_id, display_name });

function rosterSlotId(ordinal: number): string {
  let remainder = ordinal;
  let label = "";
  while (remainder > 0) {
    remainder -= 1;
    label = String.fromCharCode(97 + (remainder % 26)) + label;
    remainder = Math.floor(remainder / 26);
  }
  return `${ordinal % 2 === 1 ? "f" : "m"}${String(ordinal).padStart(2, "0")}-${label}`;
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "codec-packs-"));
});

describe("validatePackDir / listPacks", () => {
  test("a complete pack validates; an incomplete one is excluded from the roster", () => {
    makePack("aurora");
    makePack("basalt", { missing: ["alert"] });
    const packs = listPacks(root);
    expect(packs.map((p) => p.pack_id)).toEqual(["aurora"]);
    const bad = validatePackDir(path.join(root, "codec", "packs", "basalt"));
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.problems.join(" ")).toContain("alert");
  });

  test("sorts gender-prefixed packs by their encoded character sequence", () => {
    makePack("m04-d");
    makePack("f03-c");
    makePack("m02-b");
    makePack("f01-a");
    expect(listPacks(root).map((pack) => pack.pack_id)).toEqual([
      "f01-a",
      "m02-b",
      "f03-c",
      "m04-d",
    ]);
  });

  test("an empty roster yields no packs, not an error", () => {
    expect(listPacks(root)).toEqual([]);
  });

  test("merges bundled defaults with host packs and lets valid host packs override by id", () => {
    const bundledRoot = path.join(root, "bundled-root");
    const runtimeRoot = path.join(root, "runtime-root");
    makePack("f01-a", { version: "1", metadata: { character: "bundled" } }, bundledRoot);
    makePack("f01-a", { version: "2", metadata: { character: "host" } }, runtimeRoot);
    makePack("m02-b", { version: "1", metadata: { character: "host-only" } }, runtimeRoot);

    const packs = listPacks(runtimeRoot, path.join(bundledRoot, "codec", "packs"));
    expect(packs.map((pack) => [pack.pack_id, pack.pack_version, pack.character])).toEqual([
      ["f01-a", "2", "host"],
      ["m02-b", "1", "host-only"],
    ]);
  });

  test("falls back to a valid bundled pack when a host override is incomplete", () => {
    const bundledRoot = path.join(root, "bundled-root");
    const runtimeRoot = path.join(root, "runtime-root");
    makePack("f01-a", { version: "1" }, bundledRoot);
    makePack("f01-a", { version: "2", missing: ["alert"] }, runtimeRoot);
    const bundledDir = path.join(bundledRoot, "codec", "packs");

    expect(listPacks(runtimeRoot, bundledDir)).toMatchObject([
      { pack_id: "f01-a", pack_version: "1" },
    ]);
    const asset = resolvePackAsset("f01-a", "alert", runtimeRoot, bundledDir);
    expect(asset?.packVersion).toBe("1");
    expect(asset?.filePath.startsWith(bundledDir)).toBe(true);
  });

  test("exposes optional art-direction metadata for roster previews", () => {
    makePack("aurora", {
      metadata: {
        style: "manga-signal-v2",
        character: "silver-haired strategist",
        palette: "cyan, coral, violet",
        generated_with: "gpt-image-1-mini",
        quality: "low",
      },
    });
    expect(listPacks(root)[0]).toMatchObject({
      style: "manga-signal-v2",
      character: "silver-haired strategist",
      palette: "cyan, coral, violet",
      generated_with: "gpt-image-1-mini",
      quality: "low",
    });
  });
});

describe("tracked default roster", () => {
  test("ships 52 complete packs with all 21 roster expressions", () => {
    const packs = listPacks(root, defaultPacksDir());
    expect(packs).toHaveLength(52);
    for (const pack of packs) {
      expect(Object.keys(pack.expressions).sort()).toEqual([...ROSTER_EXPRESSIONS].sort());
    }
  });
});

describe("allocateCharacters", () => {
  test("unique assignment, stability, deterministic overflow, release and reuse", () => {
    makePack("aurora");
    makePack("basalt");

    // Two instances, two packs: unique assignment.
    const first = allocateCharacters([target("i-1"), target("i-2")], NOW, root);
    const assigned = [first.get("i-1")?.pack_id, first.get("i-2")?.pack_id];
    expect(new Set(assigned).size).toBe(2);

    // A third visible instance exceeds the roster: it still gets a stable
    // portrait, even though preserving uniqueness is impossible at capacity.
    const shortage = allocateCharacters([target("i-1"), target("i-2"), target("i-3")], NOW, root);
    expect(shortage.get("i-1")?.pack_id).toBe(first.get("i-1")?.pack_id); // stable
    expect(shortage.get("i-3")?.pack_id).not.toBe("fallback-neutral");
    expect(
      allocateCharacters([target("i-1"), target("i-2"), target("i-3")], NOW, root).get("i-3"),
    ).toEqual(shortage.get("i-3"));

    // i-1 ends; its pack returns to the pool and i-3 picks it up next build,
    // while the historical binding for i-1 is retained, not rewritten.
    const after = allocateCharacters([target("i-2"), target("i-3")], LATER, root);
    expect(after.get("i-3")?.pack_id).toBe(first.get("i-1")?.pack_id);
    const registry = JSON.parse(readFileSync(path.join(root, "codec", "registry.json"), "utf8"));
    const i1 = registry.bindings.filter((b: { instance_id: string }) => b.instance_id === "i-1");
    expect(i1).toHaveLength(1);
    expect(i1[0].released_at).toBe(LATER);
    expect(i1[0].pack_id).toBe(first.get("i-1")?.pack_id);
  });

  test("binds canonical names permanently by first letter and gender", () => {
    makePack("f01-a");
    makePack("m02-b");
    makePack("f27-aa");
    makePack("m28-ab");
    mkdirSync(path.join(root, "codec"), { recursive: true });
    writeFileSync(
      path.join(root, "codec", "registry.json"),
      JSON.stringify({
        schema_version: 1,
        bindings: [{ instance_id: "amelia", pack_id: "f27-aa", pack_version: "1", bound_at: NOW }],
      }),
    );

    const assigned = allocateCharacters(
      [
        target("anna", "Anna"),
        target("amelia", "Amelia"),
        target("alex", "Alex"),
        target("atticus", "Atticus"),
        target("bob", "Bob"),
        target("barnaby", "Barnaby"),
        target("bertha", "Bertha"),
        target("brenda", "Brenda"),
      ],
      LATER,
      root,
    );
    expect(assigned.get("anna")?.pack_id).toBe("f01-a");
    expect(assigned.get("amelia")?.pack_id).toBe("f01-a");
    expect(assigned.get("alex")?.pack_id).toBe("m28-ab");
    expect(assigned.get("atticus")?.pack_id).toBe("m28-ab");
    expect(assigned.get("bob")?.pack_id).toBe("m02-b");
    expect(assigned.get("barnaby")?.pack_id).toBe("m02-b");
    expect(assigned.get("bertha")?.pack_id).toBe("f27-aa");
    expect(assigned.get("brenda")?.pack_id).toBe("f27-aa");

    const registry = JSON.parse(readFileSync(path.join(root, "codec", "registry.json"), "utf8"));
    const amelia = registry.bindings.filter(
      (binding: { instance_id: string }) => binding.instance_id === "amelia",
    );
    expect(amelia).toHaveLength(2);
    expect(amelia[0]).toMatchObject({ pack_id: "f27-aa", released_at: LATER });
    expect(amelia[1]).toMatchObject({ pack_id: "f01-a" });
    expect(amelia[1].released_at).toBeUndefined();
  });

  test("covers all 260 canonical names with exactly 52 letter-gender portraits", () => {
    for (let ordinal = 1; ordinal <= 52; ordinal += 1) makePack(rosterSlotId(ordinal));
    const targets = COORD_NAMES.map((name, index) => target(`instance-${index}`, name));

    const assigned = allocateCharacters(targets, NOW, root);
    const groupPacks = new Map<string, string>();
    for (const [index, name] of COORD_NAMES.entries()) {
      const packId = assigned.get(`instance-${index}`)?.pack_id;
      expect(packId).toBeDefined();
      const expectedGender = Math.floor(index / 26) % 2 === (index % 26) % 2 ? "f" : "m";
      expect(packId?.startsWith(expectedGender)).toBe(true);
      const group = `${name[0]}:${expectedGender}`;
      const prior = groupPacks.get(group);
      if (prior) expect(packId).toBe(prior);
      else groupPacks.set(group, packId!);
    }

    expect(groupPacks).toHaveLength(52);
    expect(new Set(groupPacks.values())).toHaveLength(52);
  });

  test("a pack upgrade preserves history and refreshes the live cache version", () => {
    const dir = makePack("aurora");
    expect(allocateCharacters([target("i-1")], NOW, root).get("i-1")).toEqual({
      pack_id: "aurora",
      pack_version: "1",
    });

    const manifestPath = path.join(dir, "pack.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, pack_version: "2" }));

    expect(allocateCharacters([target("i-1")], LATER, root).get("i-1")).toEqual({
      pack_id: "aurora",
      pack_version: "2",
    });
    const registry = JSON.parse(readFileSync(path.join(root, "codec", "registry.json"), "utf8"));
    const bindings = registry.bindings.filter(
      (binding: { instance_id: string }) => binding.instance_id === "i-1",
    );
    expect(bindings).toHaveLength(2);
    expect(bindings[0]).toMatchObject({ pack_version: "1", released_at: LATER });
    expect(bindings[1]).toMatchObject({ pack_version: "2" });
    expect(bindings[1].released_at).toBeUndefined();
  });
});

describe("summarizePackRoster", () => {
  test("reports active assignments, reserve capacity, history, and orphaned bindings", () => {
    makePack("aurora");
    makePack("basalt");
    const packs = listPacks(root);
    const summary = summarizePackRoster(packs, {
      schema_version: 1,
      bindings: [
        { instance_id: "active", pack_id: "aurora", pack_version: "1", bound_at: NOW },
        {
          instance_id: "past",
          pack_id: "aurora",
          pack_version: "1",
          bound_at: NOW,
          released_at: LATER,
        },
        { instance_id: "lost", pack_id: "missing", pack_version: "1", bound_at: NOW },
      ],
    });

    expect(summary.active_bindings.map((binding) => binding.instance_id)).toEqual([
      "active",
      "lost",
    ]);
    expect(summary.released_bindings).toHaveLength(1);
    expect(summary.reserve_pack_ids).toEqual(["basalt"]);
    expect(summary.orphaned_bindings.map((binding) => binding.instance_id)).toEqual(["lost"]);
    expect(summary.historical_uses_by_pack).toEqual({ aurora: 2, missing: 1 });
    expect(summary.coverage).toBe("attention");
  });

  test("distinguishes reserve capacity from an entirely assigned roster", () => {
    makePack("aurora");
    makePack("basalt");
    const packs = listPacks(root);
    expect(summarizePackRoster(packs, { schema_version: 1, bindings: [] }).coverage).toBe("ready");
    expect(
      summarizePackRoster(packs, {
        schema_version: 1,
        bindings: [
          { instance_id: "one", pack_id: "aurora", pack_version: "1", bound_at: NOW },
          { instance_id: "two", pack_id: "basalt", pack_version: "1", bound_at: NOW },
        ],
      }).coverage,
    ).toBe("at-capacity");
  });
});

describe("resolvePackAsset", () => {
  test("serves declared files only, falls back to neutral, rejects bad slugs", () => {
    makePack("aurora");
    const ok = resolvePackAsset("aurora", "alert", root);
    expect(ok?.contentType).toBe("image/webp");
    expect(ok?.filePath.endsWith(`${path.sep}alert.webp`)).toBe(true);

    // Unknown-but-slug-valid expression falls back to neutral.
    const fallback = resolvePackAsset("aurora", "smug", root);
    expect(fallback?.filePath.endsWith(`${path.sep}neutral.webp`)).toBe(true);

    expect(resolvePackAsset("../etc", "neutral", root)).toBeNull();
    expect(resolvePackAsset("aurora", "..%2f..", root)).toBeNull();
    expect(resolvePackAsset("missing", "neutral", root)).toBeNull();
  });
});

describe("extended-tier expressions in packs", () => {
  test("declared extended art validates and resolves directly", () => {
    const dir = makePack("aurora");
    writeFileSync(path.join(dir, "observing.webp"), "img");
    const manifest = JSON.parse(readFileSync(path.join(dir, "pack.json"), "utf8"));
    manifest.expressions.observing = "observing.webp";
    writeFileSync(path.join(dir, "pack.json"), JSON.stringify(manifest));
    const result = validatePackDir(dir);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.pack.expressions.observing).toBe("observing.webp");
    const asset = resolvePackAsset("aurora", "observing", root);
    expect(asset?.filePath.endsWith("observing.webp")).toBe(true);
  });

  test("a pack without extended art still validates, and the expression falls back to its parent", () => {
    makePack("aurora");
    const result = validatePackDir(path.join(root, "codec", "packs", "aurora"));
    expect(result.ok).toBe(true);
    const observing = resolvePackAsset("aurora", "observing", root);
    expect(observing?.filePath.endsWith("investigating.webp")).toBe(true);
    const dormant = resolvePackAsset("aurora", "dormant", root);
    expect(dormant?.filePath.endsWith("waiting.webp")).toBe(true);
    const wrappingUp = resolvePackAsset("aurora", "wrapping-up", root);
    expect(wrappingUp?.filePath.endsWith("celebrating.webp")).toBe(true);
  });

  test("extended art declared but missing on disk fails validation loudly", () => {
    const dir = makePack("aurora");
    const manifest = JSON.parse(readFileSync(path.join(dir, "pack.json"), "utf8"));
    manifest.expressions.compacting = "compacting.webp"; // never written
    writeFileSync(path.join(dir, "pack.json"), JSON.stringify(manifest));
    const result = validatePackDir(dir);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems.join(" ")).toContain("compacting");
  });

  test("every extended expression has a required fallback parent", () => {
    for (const expr of EXTENDED_EXPRESSIONS) {
      const parent = EXPRESSION_FALLBACK[expr];
      if (!parent) throw new Error(`no fallback parent for extended expression ${expr}`);
      expect(REQUIRED_EXPRESSIONS).toContain(parent);
    }
  });
});

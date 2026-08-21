import { beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  allocateCharacters,
  listPacks,
  REQUIRED_EXPRESSIONS,
  resolvePackAsset,
  validatePackDir,
} from "./packs";

const NOW = "2026-08-16T12:00:00.000Z";
const LATER = "2026-08-16T12:30:00.000Z";

let root: string;

function makePack(
  id: string,
  opts: { missing?: string[]; version?: string; metadata?: Record<string, string> } = {},
): string {
  const dir = path.join(root, "codec", "packs", id);
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

  test("an empty roster yields no packs, not an error", () => {
    expect(listPacks(root)).toEqual([]);
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

describe("allocateCharacters", () => {
  test("unique assignment, stability, fallback on shortage, release and reuse", () => {
    makePack("aurora");
    makePack("basalt");

    // Two instances, two packs: unique assignment.
    const first = allocateCharacters(["i-1", "i-2"], NOW, root);
    const assigned = [first.get("i-1")?.pack_id, first.get("i-2")?.pack_id];
    expect(new Set(assigned).size).toBe(2);

    // A third live instance exceeds the roster: fallback, never a shared pack.
    const shortage = allocateCharacters(["i-1", "i-2", "i-3"], NOW, root);
    expect(shortage.get("i-1")?.pack_id).toBe(first.get("i-1")?.pack_id); // stable
    expect(shortage.get("i-3")?.pack_id).toBe("fallback-neutral");

    // i-1 ends; its pack returns to the pool and i-3 picks it up next build,
    // while the historical binding for i-1 is retained, not rewritten.
    const after = allocateCharacters(["i-2", "i-3"], LATER, root);
    expect(after.get("i-3")?.pack_id).toBe(first.get("i-1")?.pack_id);
    const registry = JSON.parse(readFileSync(path.join(root, "codec", "registry.json"), "utf8"));
    const i1 = registry.bindings.filter((b: { instance_id: string }) => b.instance_id === "i-1");
    expect(i1).toHaveLength(1);
    expect(i1[0].released_at).toBe(LATER);
    expect(i1[0].pack_id).toBe(first.get("i-1")?.pack_id);
  });

  test("a pack upgrade preserves history and refreshes the live cache version", () => {
    const dir = makePack("aurora");
    expect(allocateCharacters(["i-1"], NOW, root).get("i-1")).toEqual({
      pack_id: "aurora",
      pack_version: "1",
    });

    const manifestPath = path.join(dir, "pack.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, pack_version: "2" }));

    expect(allocateCharacters(["i-1"], LATER, root).get("i-1")).toEqual({
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

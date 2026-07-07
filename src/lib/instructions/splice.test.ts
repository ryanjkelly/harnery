import { describe, expect, test } from "bun:test";

import {
  buildOwnedSkill,
  checkOwnedSkill,
  checkRegion,
  isOwnedFile,
  regionBlock,
  removeRegion,
  shortHash,
  spliceRegion,
} from "./splice.ts";

const REGION = "instructions";

describe("spliceRegion", () => {
  test("first-time inject into empty content is just the block", () => {
    const r = spliceRegion("", REGION, "hello");
    expect(r.had).toBe(false);
    expect(r.changed).toBe(true);
    expect(r.text).toBe(`${regionBlock(REGION, "hello")}\n`);
  });

  test("appends after existing content, blank-line separated", () => {
    const r = spliceRegion("# Title\n\nbody text\n", REGION, "hello");
    expect(r.had).toBe(false);
    expect(r.text).toBe(`# Title\n\nbody text\n\n${regionBlock(REGION, "hello")}\n`);
  });

  test("is idempotent — splicing twice yields identical bytes", () => {
    const once = spliceRegion("# Title\n\nbody\n", REGION, "hello").text;
    const twice = spliceRegion(once, REGION, "hello").text;
    expect(twice).toBe(once);
  });

  test("re-splice replaces the body and preserves content outside the markers", () => {
    const first = `${spliceRegion("before\n", REGION, "old body").text}\nafter-tail\n`;
    const r = spliceRegion(first, REGION, "new body");
    expect(r.had).toBe(true);
    expect(r.stale).toBe(true);
    expect(r.text).toContain("new body");
    expect(r.text).not.toContain("old body");
    expect(r.text).toContain("before");
    expect(r.text).toContain("after-tail");
  });

  test("re-splicing identical body reports had + not-stale + not-changed", () => {
    const first = spliceRegion("x\n", REGION, "same").text;
    const r = spliceRegion(first, REGION, "same");
    expect(r.had).toBe(true);
    expect(r.stale).toBe(false);
    expect(r.changed).toBe(false);
  });

  test("a body containing `$` capture-like sequences round-trips verbatim", () => {
    const body = "cost is $1 and $$ and $& and $1x";
    const spliced = spliceRegion("", REGION, body).text;
    expect(spliced).toContain(body);
    expect(checkRegion(spliced, REGION, body)).toBe("fresh");
  });

  test("relocated block is replaced in place, not duplicated", () => {
    const injected = spliceRegion("head\n", REGION, "v1").text;
    // consumer moves the block to the top of the file
    const block = regionBlock(REGION, "v1");
    const moved = `${block}\n\nhead\n`;
    const r = spliceRegion(moved, REGION, "v2");
    expect((r.text.match(/harnery:begin/g) ?? []).length).toBe(1);
    expect(r.text).toContain("v2");
    expect(r.text).toContain("head");
    void injected;
  });
});

describe("removeRegion", () => {
  test("removed=false and content untouched when region absent", () => {
    const r = removeRegion("no markers here\n", REGION);
    expect(r.removed).toBe(false);
    expect(r.text).toBe("no markers here\n");
  });

  test("removes the block and collapses the blank lines it leaves", () => {
    const withBlock = spliceRegion("# Doc\n\nkeep me\n", REGION, "drop me").text;
    const r = removeRegion(withBlock, REGION);
    expect(r.removed).toBe(true);
    expect(r.text).toBe("# Doc\n\nkeep me\n");
  });

  test("region as the only content yields empty string (caller deletes file)", () => {
    const only = spliceRegion("", REGION, "solo").text;
    const r = removeRegion(only, REGION);
    expect(r.removed).toBe(true);
    expect(r.text).toBe("");
  });
});

describe("checkRegion", () => {
  test("missing when no marker", () => {
    expect(checkRegion("plain\n", REGION, "body")).toBe("missing");
  });

  test("fresh right after a splice", () => {
    const t = spliceRegion("x\n", REGION, "body").text;
    expect(checkRegion(t, REGION, "body")).toBe("fresh");
  });

  test("stale when the expected body changed (upgrade drift)", () => {
    const t = spliceRegion("x\n", REGION, "old body").text;
    expect(checkRegion(t, REGION, "new body")).toBe("stale");
  });

  test("stale when a hand-edit changed the body under an unchanged hash", () => {
    const t = spliceRegion("x\n", REGION, "body").text;
    const tampered = t.replace("body", "body EDITED BY HAND");
    expect(checkRegion(tampered, REGION, "body")).toBe("stale");
  });
});

describe("owned skill files", () => {
  const built = buildOwnedSkill({
    name: "harn-decide",
    description: "desc",
    argumentHint: "[x]",
    binName: "acme",
    body: "skill body line 1\nline 2",
  });

  test("carries frontmatter, ownership marker, and body", () => {
    expect(built.startsWith("---\nname: harn-decide\n")).toBe(true);
    expect(built).toContain('argument-hint: "[x]"');
    expect(built).toContain("harnery:generated harn-decide v=");
    expect(built).toContain("skill body line 1");
  });

  test("renders the regenerate/remove hint in the host bin", () => {
    expect(built).toContain("`acme init`");
    expect(built).toContain("`acme deinit`");
  });

  test("isOwnedFile detects the marker, rejects a plain file", () => {
    expect(isOwnedFile(built)).toBe(true);
    expect(isOwnedFile("---\nname: hand-written\n---\nbody")).toBe(false);
  });

  test("checkOwnedSkill: fresh / stale / missing", () => {
    expect(checkOwnedSkill(built, "skill body line 1\nline 2")).toBe("fresh");
    expect(checkOwnedSkill(built, "different body")).toBe("stale");
    expect(
      checkOwnedSkill(built.replace("line 2", "line 2 HAND-EDIT"), "skill body line 1\nline 2"),
    ).toBe("stale");
    expect(checkOwnedSkill("no marker", "body")).toBe("missing");
  });
});

describe("shortHash", () => {
  test("is 8 hex chars and stable", () => {
    const h = shortHash("abc");
    expect(h).toMatch(/^[0-9a-f]{8}$/);
    expect(shortHash("abc")).toBe(h);
  });
});

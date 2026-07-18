import { describe, expect, test } from "bun:test";

import { SCRATCH_CATEGORIES } from "../../core/scratch/index.ts";
import { checkOwnedSkill, isOwnedFile } from "./splice.ts";
import { INSTRUCTIONS_REGION, renderInstructionsBlock, SKILLS } from "./templates.ts";

describe("renderInstructionsBlock", () => {
  test("substitutes the host bin into every command string", () => {
    const block = renderInstructionsBlock("acme");
    expect(block).toContain("acme agents whoami");
    expect(block).toContain("acme decision file");
    expect(block).toContain("acme council create");
    // no un-substituted `harn <verb>` command leaked through
    expect(block).not.toMatch(/\bharn (agents|decision|council|scratch|web) /);
  });

  test("defaults cleanly to `harn` when that's the bin", () => {
    const block = renderInstructionsBlock("harn");
    expect(block).toContain("harn agents whoami");
  });

  test("keeps skill names literal (harn-*) regardless of bin", () => {
    const block = renderInstructionsBlock("acme");
    expect(block).toContain("harn-decide");
    expect(block).toContain("harn-council");
  });

  test("stays within the ~80-line orientation budget", () => {
    const lines = renderInstructionsBlock("harn").split("\n").length;
    expect(lines).toBeLessThanOrEqual(80);
  });

  test("names all five surfaces so an agent knows they exist", () => {
    const block = renderInstructionsBlock("harn").toLowerCase();
    for (const surface of ["identity", "intent", "scratch", "decision docket", "council"]) {
      expect(block).toContain(surface);
    }
  });

  test("lists every scratch category (locks the block to the canonical enum)", () => {
    const block = renderInstructionsBlock("harn");
    for (const cat of SCRATCH_CATEGORIES) {
      expect(block).toContain(cat);
    }
  });

  test("region name is stable", () => {
    expect(INSTRUCTIONS_REGION).toBe("instructions");
  });

  test("with both skills excluded, points at --help instead of dangling skill refs", () => {
    const block = renderInstructionsBlock("acme", { decide: false, council: false });
    expect(block).not.toContain("`harn-decide` skill");
    expect(block).not.toContain("`harn-council` skill");
    expect(block).toContain("acme decision --help");
    expect(block).toContain("acme council --help");
  });

  test("mixed availability names only the present skill", () => {
    const block = renderInstructionsBlock("acme", { decide: false, council: true });
    // intro + council pointer reference harn-council; decide falls back to --help
    expect(block).toContain("`harn-council`");
    expect(block).toContain("acme decision --help");
    expect(block).not.toContain("`harn-decide` skill");
    // intro lists only the present skill (singular "skill", no "harn-decide and")
    expect(block).not.toContain("`harn-decide` and");
  });

  test("default (no arg) still references both skills — bare-consumer case", () => {
    const block = renderInstructionsBlock("harn");
    expect(block).toContain("`harn-decide` skill");
    expect(block).toContain("`harn-council` skill");
  });
});

describe("SKILLS", () => {
  test("ships harn-decide and harn-council, engine-mechanics only", () => {
    expect(SKILLS.map((s) => s.id).sort()).toEqual(["harn-council", "harn-decide"]);
  });

  test("every skill renders an owned, fresh, correctly-pathed file", () => {
    for (const skill of SKILLS) {
      const content = skill.render("acme");
      expect(skill.relPath).toBe(`${skill.id}/SKILL.md`);
      expect(content).toContain(`name: ${skill.id}`);
      expect(isOwnedFile(content)).toBe(true);
      // the body the check compares against is everything after the marker
      const body = content.slice(content.indexOf("-->") + 3).trim();
      expect(checkOwnedSkill(content, body)).toBe("fresh");
      // bin substitution reached the body; no un-substituted `harn <verb>` leaked
      expect(content).toMatch(/\bacme (agents|decision|council) /);
      expect(content).not.toMatch(/\bharn (agents|decision|council|web) /);
    }
  });

  test("re-rendering a skill is deterministic (idempotent init)", () => {
    for (const skill of SKILLS) {
      expect(skill.render("acme")).toBe(skill.render("acme"));
    }
  });
});

import { describe, expect, test } from "bun:test";

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

  test("region name is stable", () => {
    expect(INSTRUCTIONS_REGION).toBe("instructions");
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

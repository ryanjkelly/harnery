import { describe, expect, test } from "bun:test";

import { JOURNAL_CATEGORIES } from "../../core/journal/index.ts";
import { checkOwnedSkill, isOwnedFile } from "./splice.ts";
import { INSTRUCTIONS_REGION, renderInstructionsBlock, SKILLS } from "./templates.ts";

describe("renderInstructionsBlock", () => {
  test("substitutes the host bin into every command string", () => {
    const block = renderInstructionsBlock("acme");
    expect(block).toContain("acme agents whoami");
    expect(block).toContain("acme agents identity assume <name>");
    expect(block).toContain("acme decision file");
    expect(block).toContain("acme council create");
    // no un-substituted `harn <verb>` command leaked through
    expect(block).not.toMatch(/\bharn (agents|decision|council|journal|web) /);
  });

  test("defaults cleanly to `harn` when that's the bin", () => {
    const block = renderInstructionsBlock("harn");
    expect(block).toContain("harn agents whoami");
  });

  test("routes durable role handoffs through the native identity command", () => {
    const block = renderInstructionsBlock("harn");
    expect(block).toContain("harn agents identity assume <name>");
    expect(block).toContain("reclaims an abandoned namesake");
    expect(block).toContain("never hand-edit Harnery's history");
  });

  test("keeps skill names literal (harn-*) regardless of bin", () => {
    const block = renderInstructionsBlock("acme");
    expect(block).toContain("harn-decide");
    expect(block).toContain("harn-council");
    expect(block).toContain("harn-end");
  });

  test("stays within the ~80-line orientation budget", () => {
    const lines = renderInstructionsBlock("harn").split("\n").length;
    expect(lines).toBeLessThanOrEqual(80);
  });

  test("names all six surfaces so an agent knows they exist", () => {
    const block = renderInstructionsBlock("harn").toLowerCase();
    for (const surface of [
      "identity",
      "lifecycle",
      "intent",
      "journal",
      "decision docket",
      "council",
    ]) {
      expect(block).toContain(surface);
    }
  });

  test("teaches lifecycle declarations with host-bin commands", () => {
    const block = renderInstructionsBlock("acme");
    expect(block).toContain('acme agents lifecycle blocked --reason "<why>"');
    expect(block).toContain("acme agents lifecycle done");
    expect(block).toContain("acme agents lifecycle active");
    // the done gate is stated, and set-task neutrality is preserved
    expect(block).toContain("Git finalization check");
    expect(block).toContain("`set-task` calls never change lifecycle");
  });

  test("lists every journal category (locks the block to the canonical enum)", () => {
    const block = renderInstructionsBlock("harn");
    for (const cat of JOURNAL_CATEGORIES) {
      expect(block).toContain(cat);
    }
  });

  test("region name is stable", () => {
    expect(INSTRUCTIONS_REGION).toBe("instructions");
  });

  test("with every skill excluded, points at CLI commands instead of dangling refs", () => {
    const block = renderInstructionsBlock("acme", {
      decide: false,
      council: false,
      end: false,
    });
    expect(block).not.toContain("`harn-decide` skill");
    expect(block).not.toContain("`harn-council` skill");
    expect(block).toContain("acme decision --help");
    expect(block).toContain("acme agents council --help");
    expect(block).toContain("acme agents status --end-turn --end-session");
  });

  test("mixed availability names only the present skill", () => {
    const block = renderInstructionsBlock("acme", { decide: false, council: true, end: false });
    // intro + council pointer reference harn-council; decide falls back to --help
    expect(block).toContain("`harn-council`");
    expect(block).toContain("acme decision --help");
    expect(block).not.toContain("`harn-decide` skill");
    // intro lists only the present skill (singular "skill", no "harn-decide and")
    expect(block).not.toContain("`harn-decide` and");
  });

  test("default (no arg) references all three skills", () => {
    const block = renderInstructionsBlock("harn");
    expect(block).toContain("`harn-decide` skill");
    expect(block).toContain("`harn-council` skill");
    expect(block).toContain("`harn-end` skill");
  });
});

describe("SKILLS", () => {
  test("ships the three harn-prefixed engine skills", () => {
    expect(SKILLS.map((s) => s.id).sort()).toEqual(["harn-council", "harn-decide", "harn-end"]);
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

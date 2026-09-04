import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { applyInstructions, checkInstructions, removeInstructions } from "./apply.ts";

const BIN = "acme";
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "harnery-instr-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const read = (rel: string) => readFileSync(join(root, rel), "utf8");
const has = (rel: string) => existsSync(join(root, rel));

describe("applyInstructions (claude-code)", () => {
  test("creates AGENTS.md block, CLAUDE.md shim, and all three skills", () => {
    const r = applyInstructions(root, { binName: BIN, adapter: "claude-code", dryRun: false });
    expect(has("AGENTS.md")).toBe(true);
    expect(read("AGENTS.md")).toContain("harnery:begin instructions");
    expect(read("AGENTS.md")).toContain("acme agents whoami");
    expect(has("CLAUDE.md")).toBe(true);
    expect(read("CLAUDE.md")).toContain("@AGENTS.md");
    expect(has(".claude/skills/harn-decide/SKILL.md")).toBe(true);
    expect(has(".claude/skills/harn-council/SKILL.md")).toBe(true);
    expect(has(".claude/skills/harn-end/SKILL.md")).toBe(true);
    expect(r.warnings).toHaveLength(0);
  });

  test("is idempotent — a second apply writes nothing", () => {
    applyInstructions(root, { binName: BIN, adapter: "claude-code", dryRun: false });
    const r2 = applyInstructions(root, { binName: BIN, adapter: "claude-code", dryRun: false });
    expect(r2.actions.every((a) => a.startsWith("·"))).toBe(true);
  });

  test("dry-run reports without touching the fs", () => {
    const r = applyInstructions(root, { binName: BIN, adapter: "claude-code", dryRun: true });
    expect(r.actions.some((a) => a.includes("would"))).toBe(true);
    expect(has("AGENTS.md")).toBe(false);
    expect(has(".claude/skills/harn-decide/SKILL.md")).toBe(false);
  });

  test("appends the block to an existing AGENTS.md, preserving prior content", () => {
    writeFileSync(join(root, "AGENTS.md"), "# House rules\n\nkeep this line\n");
    applyInstructions(root, { binName: BIN, adapter: "claude-code", dryRun: false });
    const md = read("AGENTS.md");
    expect(md).toContain("# House rules");
    expect(md).toContain("keep this line");
    expect(md).toContain("harnery:begin instructions");
  });

  test("leaves a CLAUDE.md that already imports @AGENTS.md untouched", () => {
    writeFileSync(join(root, "CLAUDE.md"), "# mine\n@AGENTS.md\n");
    const r = applyInstructions(root, { binName: BIN, adapter: "claude-code", dryRun: false });
    expect(read("CLAUDE.md")).toBe("# mine\n@AGENTS.md\n");
    expect(r.actions.some((a) => a.includes("CLAUDE.md already reaches"))).toBe(true);
  });

  test("warns (no write) on a CLAUDE.md that neither imports AGENTS.md nor carries the block", () => {
    writeFileSync(join(root, "CLAUDE.md"), "# standalone claude instructions\n");
    const r = applyInstructions(root, { binName: BIN, adapter: "claude-code", dryRun: false });
    expect(read("CLAUDE.md")).toBe("# standalone claude instructions\n");
    expect(r.warnings.some((w) => w.includes("CLAUDE.md exists"))).toBe(true);
  });

  test("skills.exclude suppresses just that skill", () => {
    mkdirSync(join(root, ".harnery"), { recursive: true });
    writeFileSync(
      join(root, ".harnery/config.jsonc"),
      '{ "skills": { "exclude": ["harn-decide"] } }',
    );
    applyInstructions(root, { binName: BIN, adapter: "claude-code", dryRun: false });
    expect(has(".claude/skills/harn-decide/SKILL.md")).toBe(false);
    expect(has(".claude/skills/harn-council/SKILL.md")).toBe(true);
  });

  test("excluding every skill renders a block with CLI fallbacks, not dangling skills", () => {
    mkdirSync(join(root, ".harnery"), { recursive: true });
    writeFileSync(
      join(root, ".harnery/config.jsonc"),
      '{ "skills": { "exclude": ["harn-decide", "harn-council", "harn-end"] } }',
    );
    applyInstructions(root, { binName: BIN, adapter: "claude-code", dryRun: false });
    const md = read("AGENTS.md");
    expect(md).not.toContain("`harn-decide` skill");
    expect(md).not.toContain("`harn-council` skill");
    expect(md).not.toContain("`harn-end` skill");
    expect(md).toContain("acme decision --help");
    expect(md).toContain("acme agents status --end-turn --end-session");
    // and re-check stays fresh (the check renders the same exclusion-aware block)
    expect(checkInstructions(root, { binName: BIN, adapter: "claude-code" }).status).toBe("fresh");
  });
});

describe("applyInstructions (cursor)", () => {
  test("writes AGENTS.md and all three shared skills, but no Claude files", () => {
    applyInstructions(root, { binName: BIN, adapter: "cursor", dryRun: false });
    expect(has("AGENTS.md")).toBe(true);
    expect(has("CLAUDE.md")).toBe(false);
    expect(has(".claude/skills/harn-decide/SKILL.md")).toBe(false);
    expect(has(".agents/skills/harn-decide/SKILL.md")).toBe(true);
    expect(has(".agents/skills/harn-council/SKILL.md")).toBe(true);
    expect(has(".agents/skills/harn-end/SKILL.md")).toBe(true);
    expect(has(".cursor/rules/harnery-turn-ritual.mdc")).toBe(true);
    expect(read(".cursor/rules/harnery-turn-ritual.mdc")).toContain("alwaysApply: true");
    expect(read(".cursor/rules/harnery-turn-ritual.mdc")).toContain(
      "Append that command's stdout verbatim in a fenced code block",
    );
    expect(read(".cursor/rules/harnery-turn-ritual.mdc")).not.toContain("prompt-context consume");
  });

  test("cursor block points at its installed skills", () => {
    applyInstructions(root, { binName: BIN, adapter: "cursor", dryRun: false });
    const md = read("AGENTS.md");
    expect(md).toContain("`harn-decide` skill");
    expect(md).toContain("`harn-council` skill");
    expect(md).toContain("`harn-end` skill");
    expect(checkInstructions(root, { binName: BIN, adapter: "cursor" }).status).toBe("fresh");
  });

  test("cursor rule does not depend on prompt-context provider configuration", () => {
    mkdirSync(join(root, ".harnery"), { recursive: true });
    writeFileSync(
      join(root, ".harnery/config.jsonc"),
      '{ "hooks": { "promptContext": { "enabled": true } } }',
    );
    applyInstructions(root, { binName: BIN, adapter: "cursor", dryRun: false });
    const rule = read(".cursor/rules/harnery-turn-ritual.mdc");
    expect(rule).not.toContain("prompt-context consume");
    expect(checkInstructions(root, { binName: BIN, adapter: "cursor" }).status).toBe("fresh");

    writeFileSync(join(root, ".harnery/config.jsonc"), "{}");
    expect(checkInstructions(root, { binName: BIN, adapter: "cursor" }).status).toBe("fresh");
  });

  test("cursor rule drift is checked and deinit removes the owned file", () => {
    applyInstructions(root, { binName: BIN, adapter: "cursor", dryRun: false });
    const rule = ".cursor/rules/harnery-turn-ritual.mdc";
    writeFileSync(join(root, rule), `${read(rule)}\nHAND EDIT\n`);
    expect(checkInstructions(root, { binName: BIN, adapter: "cursor" }).status).toBe("drift");
    applyInstructions(root, { binName: BIN, adapter: "cursor", dryRun: false });
    removeInstructions(root, { adapter: "cursor", dryRun: false });
    expect(has(rule)).toBe(false);
  });
});

describe("applyInstructions (codex)", () => {
  test("writes the same three shared skills as Cursor", () => {
    applyInstructions(root, { binName: BIN, adapter: "codex", dryRun: false });
    expect(has("AGENTS.md")).toBe(true);
    expect(has("CLAUDE.md")).toBe(false);
    for (const skill of ["harn-decide", "harn-council", "harn-end"]) {
      expect(has(`.agents/skills/${skill}/SKILL.md`)).toBe(true);
    }
    expect(checkInstructions(root, { binName: BIN, adapter: "codex" }).status).toBe("fresh");
  });

  test("does not create an unprefixed end alias", () => {
    applyInstructions(root, { binName: BIN, adapter: "codex", dryRun: false });
    expect(has(".agents/skills/end/SKILL.md")).toBe(false);
  });
});

describe("checkInstructions", () => {
  test("fresh right after apply", () => {
    applyInstructions(root, { binName: BIN, adapter: "claude-code", dryRun: false });
    expect(checkInstructions(root, { binName: BIN, adapter: "claude-code" }).status).toBe("fresh");
  });

  test("drift when nothing is installed", () => {
    const r = checkInstructions(root, { binName: BIN, adapter: "claude-code" });
    expect(r.status).toBe("drift");
    expect(r.issues.some((i) => i.includes("missing"))).toBe(true);
  });

  test("drift when the block was rendered for a different bin (upgrade/rename)", () => {
    applyInstructions(root, { binName: BIN, adapter: "claude-code", dryRun: false });
    const r = checkInstructions(root, { binName: "other", adapter: "claude-code" });
    expect(r.status).toBe("drift");
  });

  test("drift when a skill is hand-edited", () => {
    applyInstructions(root, { binName: BIN, adapter: "claude-code", dryRun: false });
    const p = join(root, ".claude/skills/harn-council/SKILL.md");
    writeFileSync(p, `${read(".claude/skills/harn-council/SKILL.md")}\nHAND EDIT\n`);
    const r = checkInstructions(root, { binName: BIN, adapter: "claude-code" });
    expect(r.status).toBe("drift");
    expect(r.issues.some((i) => i.includes("harn-council"))).toBe(true);
  });

  test("excluded skill isn't required by --check", () => {
    mkdirSync(join(root, ".harnery"), { recursive: true });
    writeFileSync(
      join(root, ".harnery/config.jsonc"),
      '{ "skills": { "exclude": ["harn-decide"] } }',
    );
    applyInstructions(root, { binName: BIN, adapter: "claude-code", dryRun: false });
    expect(checkInstructions(root, { binName: BIN, adapter: "claude-code" }).status).toBe("fresh");
  });
});

describe("removeInstructions", () => {
  test("round-trips: apply then remove leaves no harnery artifacts", () => {
    applyInstructions(root, { binName: BIN, adapter: "claude-code", dryRun: false });
    removeInstructions(root, { adapter: "claude-code", dryRun: false });
    // AGENTS.md was block-only → deleted; CLAUDE.md was shim-only → deleted
    expect(has("AGENTS.md")).toBe(false);
    expect(has("CLAUDE.md")).toBe(false);
    expect(has(".claude/skills/harn-decide/SKILL.md")).toBe(false);
    expect(has(".claude/skills/harn-council")).toBe(false);
    expect(has(".claude/skills/harn-end")).toBe(false);
  });

  test("removes shared Cursor/Codex skills from their native root", () => {
    applyInstructions(root, { binName: BIN, adapter: "codex", dryRun: false });
    removeInstructions(root, { adapter: "codex", dryRun: false });
    for (const skill of ["harn-decide", "harn-council", "harn-end"]) {
      expect(has(`.agents/skills/${skill}/SKILL.md`)).toBe(false);
    }
  });

  test("preserves an AGENTS.md that had content outside the block", () => {
    writeFileSync(join(root, "AGENTS.md"), "# House rules\n\nkeep me\n");
    applyInstructions(root, { binName: BIN, adapter: "claude-code", dryRun: false });
    removeInstructions(root, { adapter: "claude-code", dryRun: false });
    expect(has("AGENTS.md")).toBe(true);
    expect(read("AGENTS.md")).toBe("# House rules\n\nkeep me\n");
    expect(read("AGENTS.md")).not.toContain("harnery:begin");
  });

  test("leaves a hand-edited (unowned) skill file with a warning", () => {
    mkdirSync(join(root, ".claude/skills/harn-decide"), { recursive: true });
    writeFileSync(join(root, ".claude/skills/harn-decide/SKILL.md"), "hand-written, no marker\n");
    const r = removeInstructions(root, { adapter: "claude-code", dryRun: false });
    expect(has(".claude/skills/harn-decide/SKILL.md")).toBe(true);
    expect(r.warnings.some((w) => w.includes("hand-edited"))).toBe(true);
  });

  test("dry-run removes nothing", () => {
    applyInstructions(root, { binName: BIN, adapter: "claude-code", dryRun: false });
    removeInstructions(root, { adapter: "claude-code", dryRun: true });
    expect(has("AGENTS.md")).toBe(true);
    expect(has(".claude/skills/harn-decide/SKILL.md")).toBe(true);
  });
});

/**
 * The host addendum: policy the host owns, spliced by harnery.
 *
 * Harnery's own block is deliberately generic, so a consumer with real
 * coordination policy of its own had nowhere machine-managed to put it and
 * hand-maintained it beside the block instead. Pointing `.harnery/config.jsonc`
 * at a file gives that content the same lifecycle as the block: applied,
 * refreshed, drift-checked, and removed, with harnery never reading what it
 * says.
 */
describe("host addendum", () => {
  const config = (value: unknown) => {
    mkdirSync(join(root, ".harnery"), { recursive: true });
    writeFileSync(
      join(root, ".harnery", "config.jsonc"),
      JSON.stringify({ instructions: { hostAddendumFile: value } }),
    );
  };
  const source = (rel: string, body: string) => {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), body);
  };
  const apply = (dryRun = false) =>
    applyInstructions(root, { binName: BIN, adapter: "claude-code", dryRun });

  test("splices the configured file verbatim into its own region", () => {
    source(".agents/host.md", "## House rules\n\nCommit by pathspec.\n");
    config(".agents/host.md");
    apply();

    const agents = read("AGENTS.md");
    expect(agents).toContain("harnery:begin host-addendum");
    expect(agents).toContain("Commit by pathspec.");
    // Its own region, so refreshing one never disturbs the other.
    expect(agents).toContain("harnery:begin instructions");
  });

  test("refreshes the region when the source file changes", () => {
    // Distinctive sentinels, not ordinary words: the negative assertion below
    // scans the WHOLE rendered file, so a fixture like "first" also matches any
    // prose the instructions block happens to contain, and the test fails for a
    // reason that has nothing to do with region refresh.
    source(".agents/host.md", "ADDENDUM_REV_ONE\n");
    config(".agents/host.md");
    apply();
    source(".agents/host.md", "ADDENDUM_REV_TWO\n");
    const r = apply();

    expect(read("AGENTS.md")).toContain("ADDENDUM_REV_TWO");
    expect(read("AGENTS.md")).not.toContain("ADDENDUM_REV_ONE");
    expect(r.actions.some((a) => a.includes("host addendum"))).toBe(true);
  });

  test("is idempotent, like the block", () => {
    source(".agents/host.md", "stable\n");
    config(".agents/host.md");
    apply();
    expect(apply().actions.every((a) => a.startsWith("·"))).toBe(true);
  });

  test("removes the region when the config entry goes away", () => {
    source(".agents/host.md", "temporary policy\n");
    config(".agents/host.md");
    apply();
    writeFileSync(join(root, ".harnery", "config.jsonc"), "{}");
    apply();

    expect(read("AGENTS.md")).not.toContain("host-addendum");
    expect(read("AGENTS.md")).not.toContain("temporary policy");
    // The block itself is untouched by the addendum's departure.
    expect(read("AGENTS.md")).toContain("harnery:begin instructions");
  });

  test("deinit takes the addendum with it", () => {
    source(".agents/host.md", "policy\n");
    config(".agents/host.md");
    apply();
    removeInstructions(root, { adapter: "claude-code", dryRun: false });
    expect(has("AGENTS.md")).toBe(false);
  });

  test("--check calls a stale, missing, or unconfigured region drift", () => {
    source(".agents/host.md", "policy\n");
    config(".agents/host.md");
    apply();
    const opts = { binName: BIN, adapter: "claude-code" };
    expect(checkInstructions(root, opts).status).toBe("fresh");

    source(".agents/host.md", "policy, revised\n");
    expect(checkInstructions(root, opts).status).toBe("drift");

    apply();
    // Region still in the file, config entry gone: also drift, since init would
    // remove it.
    writeFileSync(join(root, ".harnery", "config.jsonc"), "{}");
    const orphan = checkInstructions(root, opts);
    expect(orphan.status).toBe("drift");
    expect(orphan.issues.join(" ")).toContain("no longer configured");
  });

  test("refuses a source outside the repo, before writing anything", () => {
    config("../escape.md");
    expect(() => apply()).toThrow(/outside the project/);
    // Nothing half-written: the validation runs before the first write.
    expect(has("AGENTS.md")).toBe(false);
  });

  test("refuses an absolute path, which would not survive a fresh clone", () => {
    config("/etc/hosts");
    expect(() => apply()).toThrow(/repo-relative/);
  });

  test("refuses a missing source rather than silently skipping it", () => {
    config(".agents/nope.md");
    expect(() => apply()).toThrow(/not found/);
    expect(has("AGENTS.md")).toBe(false);
  });

  test("refuses an empty source, which is always a mistake", () => {
    source(".agents/host.md", "   \n");
    config(".agents/host.md");
    expect(() => apply()).toThrow(/empty/);
  });

  test("dry-run validates too, and still writes nothing", () => {
    config(".agents/nope.md");
    expect(() => apply(true)).toThrow(/not found/);
  });

  test("--check reports a bad configuration as an error, not drift", () => {
    config("../escape.md");
    const r = checkInstructions(root, { binName: BIN, adapter: "claude-code" });
    expect(r.status).toBe("error");
  });
});

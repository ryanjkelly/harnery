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
  test("creates AGENTS.md block, CLAUDE.md shim, and both skills", () => {
    const r = applyInstructions(root, { binName: BIN, harness: "claude-code", dryRun: false });
    expect(has("AGENTS.md")).toBe(true);
    expect(read("AGENTS.md")).toContain("harnery:begin instructions");
    expect(read("AGENTS.md")).toContain("acme agents whoami");
    expect(has("CLAUDE.md")).toBe(true);
    expect(read("CLAUDE.md")).toContain("@AGENTS.md");
    expect(has(".claude/skills/harn-decide/SKILL.md")).toBe(true);
    expect(has(".claude/skills/harn-council/SKILL.md")).toBe(true);
    expect(r.warnings).toHaveLength(0);
  });

  test("is idempotent — a second apply writes nothing", () => {
    applyInstructions(root, { binName: BIN, harness: "claude-code", dryRun: false });
    const r2 = applyInstructions(root, { binName: BIN, harness: "claude-code", dryRun: false });
    expect(r2.actions.every((a) => a.startsWith("·"))).toBe(true);
  });

  test("dry-run reports without touching the fs", () => {
    const r = applyInstructions(root, { binName: BIN, harness: "claude-code", dryRun: true });
    expect(r.actions.some((a) => a.includes("would"))).toBe(true);
    expect(has("AGENTS.md")).toBe(false);
    expect(has(".claude/skills/harn-decide/SKILL.md")).toBe(false);
  });

  test("appends the block to an existing AGENTS.md, preserving prior content", () => {
    writeFileSync(join(root, "AGENTS.md"), "# House rules\n\nkeep this line\n");
    applyInstructions(root, { binName: BIN, harness: "claude-code", dryRun: false });
    const md = read("AGENTS.md");
    expect(md).toContain("# House rules");
    expect(md).toContain("keep this line");
    expect(md).toContain("harnery:begin instructions");
  });

  test("leaves a CLAUDE.md that already imports @AGENTS.md untouched", () => {
    writeFileSync(join(root, "CLAUDE.md"), "# mine\n@AGENTS.md\n");
    const r = applyInstructions(root, { binName: BIN, harness: "claude-code", dryRun: false });
    expect(read("CLAUDE.md")).toBe("# mine\n@AGENTS.md\n");
    expect(r.actions.some((a) => a.includes("CLAUDE.md already reaches"))).toBe(true);
  });

  test("warns (no write) on a CLAUDE.md that neither imports AGENTS.md nor carries the block", () => {
    writeFileSync(join(root, "CLAUDE.md"), "# standalone claude instructions\n");
    const r = applyInstructions(root, { binName: BIN, harness: "claude-code", dryRun: false });
    expect(read("CLAUDE.md")).toBe("# standalone claude instructions\n");
    expect(r.warnings.some((w) => w.includes("CLAUDE.md exists"))).toBe(true);
  });

  test("skills.exclude suppresses just that skill", () => {
    mkdirSync(join(root, ".harnery"), { recursive: true });
    writeFileSync(
      join(root, ".harnery/config.jsonc"),
      '{ "skills": { "exclude": ["harn-decide"] } }',
    );
    applyInstructions(root, { binName: BIN, harness: "claude-code", dryRun: false });
    expect(has(".claude/skills/harn-decide/SKILL.md")).toBe(false);
    expect(has(".claude/skills/harn-council/SKILL.md")).toBe(true);
  });
});

describe("applyInstructions (cursor)", () => {
  test("writes only the AGENTS.md block — no CLAUDE.md, no skills", () => {
    applyInstructions(root, { binName: BIN, harness: "cursor", dryRun: false });
    expect(has("AGENTS.md")).toBe(true);
    expect(has("CLAUDE.md")).toBe(false);
    expect(has(".claude/skills/harn-decide/SKILL.md")).toBe(false);
  });
});

describe("checkInstructions", () => {
  test("fresh right after apply", () => {
    applyInstructions(root, { binName: BIN, harness: "claude-code", dryRun: false });
    expect(checkInstructions(root, { binName: BIN, harness: "claude-code" }).status).toBe("fresh");
  });

  test("drift when nothing is installed", () => {
    const r = checkInstructions(root, { binName: BIN, harness: "claude-code" });
    expect(r.status).toBe("drift");
    expect(r.issues.some((i) => i.includes("missing"))).toBe(true);
  });

  test("drift when the block was rendered for a different bin (upgrade/rename)", () => {
    applyInstructions(root, { binName: BIN, harness: "claude-code", dryRun: false });
    const r = checkInstructions(root, { binName: "other", harness: "claude-code" });
    expect(r.status).toBe("drift");
  });

  test("drift when a skill is hand-edited", () => {
    applyInstructions(root, { binName: BIN, harness: "claude-code", dryRun: false });
    const p = join(root, ".claude/skills/harn-council/SKILL.md");
    writeFileSync(p, `${read(".claude/skills/harn-council/SKILL.md")}\nHAND EDIT\n`);
    const r = checkInstructions(root, { binName: BIN, harness: "claude-code" });
    expect(r.status).toBe("drift");
    expect(r.issues.some((i) => i.includes("harn-council"))).toBe(true);
  });

  test("excluded skill isn't required by --check", () => {
    mkdirSync(join(root, ".harnery"), { recursive: true });
    writeFileSync(
      join(root, ".harnery/config.jsonc"),
      '{ "skills": { "exclude": ["harn-decide"] } }',
    );
    applyInstructions(root, { binName: BIN, harness: "claude-code", dryRun: false });
    expect(checkInstructions(root, { binName: BIN, harness: "claude-code" }).status).toBe("fresh");
  });
});

describe("removeInstructions", () => {
  test("round-trips: apply then remove leaves no harnery artifacts", () => {
    applyInstructions(root, { binName: BIN, harness: "claude-code", dryRun: false });
    removeInstructions(root, { harness: "claude-code", dryRun: false });
    // AGENTS.md was block-only → deleted; CLAUDE.md was shim-only → deleted
    expect(has("AGENTS.md")).toBe(false);
    expect(has("CLAUDE.md")).toBe(false);
    expect(has(".claude/skills/harn-decide/SKILL.md")).toBe(false);
    expect(has(".claude/skills/harn-council")).toBe(false);
  });

  test("preserves an AGENTS.md that had content outside the block", () => {
    writeFileSync(join(root, "AGENTS.md"), "# House rules\n\nkeep me\n");
    applyInstructions(root, { binName: BIN, harness: "claude-code", dryRun: false });
    removeInstructions(root, { harness: "claude-code", dryRun: false });
    expect(has("AGENTS.md")).toBe(true);
    expect(read("AGENTS.md")).toBe("# House rules\n\nkeep me\n");
    expect(read("AGENTS.md")).not.toContain("harnery:begin");
  });

  test("leaves a hand-edited (unowned) skill file with a warning", () => {
    mkdirSync(join(root, ".claude/skills/harn-decide"), { recursive: true });
    writeFileSync(join(root, ".claude/skills/harn-decide/SKILL.md"), "hand-written, no marker\n");
    const r = removeInstructions(root, { harness: "claude-code", dryRun: false });
    expect(has(".claude/skills/harn-decide/SKILL.md")).toBe(true);
    expect(r.warnings.some((w) => w.includes("hand-edited"))).toBe(true);
  });

  test("dry-run removes nothing", () => {
    applyInstructions(root, { binName: BIN, harness: "claude-code", dryRun: false });
    removeInstructions(root, { harness: "claude-code", dryRun: true });
    expect(has("AGENTS.md")).toBe(true);
    expect(has(".claude/skills/harn-decide/SKILL.md")).toBe(true);
  });
});

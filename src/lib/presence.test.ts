import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeDir } from "../../tests/helpers/remove-dir.ts";
import {
  applyDetection,
  clearPresence,
  detectFromPrompt,
  preprocessForDetection,
  presenceFilePath,
  readPresence,
  unpinPresence,
  writePresence,
} from "./presence.js";

// Curly quote chars used throughout the tests.
const LSQUO = "‘"; // '
const RSQUO = "’"; // '
const LDQUO = "“"; // "
const RDQUO = "”"; // "

describe("preprocessForDetection", () => {
  test("strips fenced code blocks (triple backtick)", () => {
    const input = `before\n\`\`\`\ncode with ${RSQUO} curly\n\`\`\`\nafter`;
    const cleaned = preprocessForDetection(input);
    expect(cleaned).not.toContain(RSQUO);
    expect(cleaned).toContain("before");
    expect(cleaned).toContain("after");
  });

  test("strips fenced code blocks (triple tilde)", () => {
    const input = `before\n~~~\ncode with ${RSQUO}\n~~~\nafter`;
    const cleaned = preprocessForDetection(input);
    expect(cleaned).not.toContain(RSQUO);
  });

  test("strips block-quoted lines", () => {
    const input = `before\n> quoted ${RSQUO} line\nafter`;
    const cleaned = preprocessForDetection(input);
    expect(cleaned).not.toContain(RSQUO);
    expect(cleaned).toContain("before");
    expect(cleaned).toContain("after");
  });

  test("leaves inline code spans alone", () => {
    const input = `use \`foo${RSQUO}bar\` here`;
    const cleaned = preprocessForDetection(input);
    expect(cleaned).toContain(RSQUO);
  });

  test("preserves regular prose", () => {
    const input = "the quick brown fox";
    expect(preprocessForDetection(input)).toBe(input);
  });
});

describe("detectFromPrompt", () => {
  // Rule 1: mixed -> null
  test("mixed curly + straight -> null", () => {
    expect(detectFromPrompt(`I${RSQUO}m sure it's ok`)).toBeNull();
  });

  // Rule 2: curly only -> mobile
  test("single curly apostrophe -> mobile", () => {
    expect(detectFromPrompt(`Let${RSQUO}s go`)).toBe("mobile");
  });
  test("curly double quote -> mobile", () => {
    expect(detectFromPrompt(`he said ${LDQUO}hi${RDQUO}`)).toBe("mobile");
  });
  test("left single quote -> mobile", () => {
    expect(detectFromPrompt(`${LSQUO}hello${RSQUO}`)).toBe("mobile");
  });
  test("curly-only paragraph at 400 characters -> mobile", () => {
    expect(detectFromPrompt(`${RSQUO}${"a".repeat(399)}`)).toBe("mobile");
  });
  test("curly-only paragraph over 400 characters -> null", () => {
    expect(detectFromPrompt(`${RSQUO}${"a".repeat(400)}`)).toBeNull();
  });
  test("short curly-only text with a blank line -> null, even with trailing space", () => {
    expect(detectFromPrompt(`I${RSQUO}m here\n\nPlease continue `)).toBeNull();
    expect(detectFromPrompt(`I${RSQUO}m here\r\n \t\r\nPlease continue`)).toBeNull();
  });
  test("a wrapped single paragraph with curly quotes -> mobile", () => {
    expect(detectFromPrompt(`I${RSQUO}m here\nPlease continue`)).toBe("mobile");
  });

  // Rule 3: straight only -> office
  test("straight apostrophe -> office", () => {
    expect(detectFromPrompt("Let's go")).toBe("office");
  });
  test("straight double quote -> office", () => {
    expect(detectFromPrompt('he said "hi"')).toBe("office");
  });
  test("straight-only text remains office at any length or paragraph count", () => {
    expect(detectFromPrompt(`It's ready.\n\n${"Please review. ".repeat(100)}`)).toBe("office");
  });
  test("long mixed quotes remain ambiguous", () => {
    expect(
      detectFromPrompt(`I${RSQUO}m sure it's ready. ${"More detail. ".repeat(100)}`),
    ).toBeNull();
  });

  // Rule 4: short trailing-space -> mobile
  test("short message ending in space -> mobile", () => {
    expect(detectFromPrompt("hey ")).toBe("mobile");
  });
  test("short message NOT ending in space -> null", () => {
    expect(detectFromPrompt("hey")).toBeNull();
  });
  test("long message ending in space -> null", () => {
    const long = `${"a".repeat(150)} `;
    expect(detectFromPrompt(long)).toBeNull();
  });
  test("trailing-space rule excludes messages at 100 characters", () => {
    expect(detectFromPrompt(`${"a".repeat(98)} `)).toBe("mobile");
    expect(detectFromPrompt(`${"a".repeat(99)} `)).toBeNull();
  });

  // Rule 5 (default): no signal -> null
  test("plain prose with no quotes, no trailing space -> null", () => {
    expect(detectFromPrompt("the quick brown fox jumped over the lazy dog")).toBeNull();
  });

  // First-match-wins: straight quote in short trailing-space message -> office
  test("straight quote trumps trailing-space rule", () => {
    expect(detectFromPrompt("Let's go ")).toBe("office");
  });
  test("curly quote trumps trailing-space rule", () => {
    expect(detectFromPrompt(`Let${RSQUO}s go `)).toBe("mobile");
  });

  // Preprocessing interactions
  test("curly inside fenced block + plain outside -> null (no signal)", () => {
    const input = `see this:\n\`\`\`\nLet${RSQUO}s try\n\`\`\``;
    expect(detectFromPrompt(input)).toBeNull();
  });
  test("curly outside, straight inside fenced block -> mobile (curly wins, straight stripped)", () => {
    const input = `Let${RSQUO}s try\n\`\`\`\nfoo = "bar"\n\`\`\``;
    expect(detectFromPrompt(input)).toBe("mobile");
  });
  test("curly inside block-quoted line is ignored", () => {
    const input = `quoting:\n> they said ${LDQUO}hi${RDQUO}`;
    expect(detectFromPrompt(input)).toBeNull();
  });
  test("paste guard measures the prompt after fenced and quoted content is removed", () => {
    const input = `\nI${RSQUO}m here\n\n\`\`\`\n${"pasted text ".repeat(100)}\n\`\`\`\n> quoted\n`;
    expect(detectFromPrompt(input)).toBe("mobile");
  });
});

// File I/O round-trip tests use a temp HOME so we don't trample the real file.
describe("file I/O", () => {
  let originalHome: string | undefined;
  let tmpHome: string;

  beforeAll(() => {
    originalHome = process.env.HOME;
    tmpHome = mkdtempSync(join(tmpdir(), "presence-test-"));
    process.env.HOME = tmpHome;
  });

  afterAll(() => {
    if (originalHome !== undefined) process.env.HOME = originalHome;
    // Assigning undefined stores the text "undefined"; remove the key instead.
    else delete process.env.HOME;
    removeDir(tmpHome);
  });

  test("readPresence returns office default when file missing", () => {
    clearPresence();
    const r = readPresence();
    expect(r.state).toBe("office");
    expect(r.is_default).toBe(true);
    expect(r.source).toBeNull();
    expect(r.pinned).toBe(false);
  });

  test("writePresence + readPresence round-trip", () => {
    writePresence("mobile", "cli");
    const r = readPresence();
    expect(r.state).toBe("mobile");
    expect(r.source).toBe("cli");
    expect(r.is_default).toBe(false);
    expect(r.pinned).toBe(false);
    expect(r.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("clearPresence deletes the file", () => {
    writePresence("mobile", "cli");
    expect(existsSync(presenceFilePath())).toBe(true);
    expect(clearPresence()).toBe(true);
    expect(existsSync(presenceFilePath())).toBe(false);
    expect(clearPresence()).toBe(false); // idempotent
  });

  test("applyDetection: hook overwrites cli-set state", () => {
    writePresence("mobile", "cli");
    const result = applyDetection("Let's go"); // straight quote -> office
    expect(result.changed).toBe(true);
    expect(result.before).toBe("mobile");
    expect(result.after).toBe("office");
    const r = readPresence();
    expect(r.state).toBe("office");
    expect(r.source).toBe("hook");
  });

  test("applyDetection: pasted email with curly apostrophes preserves office", () => {
    writePresence("office", "cli");
    const email = `Hello,\n\nI${RSQUO}m sending the document for review. ${"Please check the attached details. ".repeat(20)}\n\nThank you.`;
    const before = readFileSync(presenceFilePath(), "utf8");
    expect(applyDetection(email)).toEqual({
      changed: false,
      before: "office",
      after: "office",
      detected: null,
    });
    expect(readFileSync(presenceFilePath(), "utf8")).toBe(before);
  });

  test("applyDetection: short phone message changes unpinned office to mobile", () => {
    writePresence("office", "cli");
    expect(applyDetection(`I${RSQUO}m on my way`)).toEqual({
      changed: true,
      before: "office",
      after: "mobile",
      detected: "mobile",
    });
    expect(readPresence()).toMatchObject({ state: "mobile", source: "hook", pinned: false });
  });

  test("pinned office ignores short curly prompts without changing the record", () => {
    writePresence("office", "cli", true);
    const before = readFileSync(presenceFilePath(), "utf8");
    expect(applyDetection(`I${RSQUO}m on my way`)).toEqual({
      changed: false,
      before: "office",
      after: "office",
      detected: "mobile",
    });
    expect(readFileSync(presenceFilePath(), "utf8")).toBe(before);
    expect(readPresence().pinned).toBe(true);
  });

  test("pinned mobile ignores straight quotes and unpin resumes detection", () => {
    writePresence("mobile", "cli", true);
    expect(applyDetection("I'm at my desk").changed).toBe(false);
    unpinPresence();
    expect(readPresence()).toMatchObject({ state: "mobile", source: "cli", pinned: false });
    expect(applyDetection("I'm at my desk").after).toBe("office");
  });

  test("one-shot writes remove an existing pin", () => {
    writePresence("office", "cli", true);
    writePresence("mobile", "cli");
    expect(readPresence().pinned).toBe(false);
    expect(applyDetection("I'm at my desk").changed).toBe(true);
  });

  test("unpin is a no-op when no pin or file exists", () => {
    clearPresence();
    unpinPresence();
    expect(existsSync(presenceFilePath())).toBe(false);
    writePresence("office", "hook");
    const before = readFileSync(presenceFilePath(), "utf8");
    unpinPresence();
    expect(readFileSync(presenceFilePath(), "utf8")).toBe(before);
  });

  test("records without a pin field remain unpinned", () => {
    writeFileSync(presenceFilePath(), JSON.stringify({ state: "office", source: "cli" }));
    expect(readPresence().pinned).toBe(false);
    expect(applyDetection(`Let${RSQUO}s go`).changed).toBe(true);
  });

  test("only a boolean true pins a record", () => {
    writeFileSync(presenceFilePath(), JSON.stringify({ state: "office", pinned: "true" }));
    expect(readPresence().pinned).toBe(false);
  });

  test("applyDetection: no-op when detection returns null", () => {
    writePresence("mobile", "cli");
    const result = applyDetection("plain prose with no signal");
    expect(result.changed).toBe(false);
    expect(readPresence().source).toBe("cli"); // unchanged
  });

  test("applyDetection: no-op when detected matches current state", () => {
    writePresence("office", "cli");
    const result = applyDetection("Let's go"); // straight -> office, same as current
    expect(result.changed).toBe(false);
    expect(readPresence().source).toBe("cli"); // unchanged, NOT overwritten
  });

  test("readPresence is robust to corrupt JSON", () => {
    const path = presenceFilePath();
    writeFileSync(path, "{not valid json");
    const r = readPresence();
    expect(r.state).toBe("office"); // falls back to default
    expect(r.is_default).toBe(true);
    expect(r.pinned).toBe(false);
    clearPresence();
  });
});

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyDetection,
  clearPresence,
  detectFromPrompt,
  preprocessForDetection,
  presenceFilePath,
  readPresence,
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

  // Rule 3: straight only -> office
  test("straight apostrophe -> office", () => {
    expect(detectFromPrompt("Let's go")).toBe("office");
  });
  test("straight double quote -> office", () => {
    expect(detectFromPrompt('he said "hi"')).toBe("office");
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
    else process.env.HOME = undefined;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  test("readPresence returns office default when file missing", () => {
    clearPresence();
    const r = readPresence();
    expect(r.state).toBe("office");
    expect(r.is_default).toBe(true);
    expect(r.source).toBeNull();
  });

  test("writePresence + readPresence round-trip", () => {
    writePresence("mobile", "cli");
    const r = readPresence();
    expect(r.state).toBe("mobile");
    expect(r.source).toBe("cli");
    expect(r.is_default).toBe(false);
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
    require("node:fs").writeFileSync(path, "{not valid json");
    const r = readPresence();
    expect(r.state).toBe("office"); // falls back to default
    expect(r.is_default).toBe(true);
    clearPresence();
  });
});

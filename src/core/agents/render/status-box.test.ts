import { describe, expect, test } from "bun:test";
import {
  formatBox,
  sanitizeStatusLabel,
  sanitizeStatusText,
  statusDisplayWidth,
  statusGraphemes,
  wrapStatusText,
} from "./status-box.ts";

function framed(box: string): string[] {
  const lines = box.split("\n");
  expect(lines[0]).toStartWith("┌─");
  expect(lines.at(-1)).toStartWith("└");
  for (const line of lines.slice(1, -1)) {
    expect(line).toStartWith("│");
    expect(line).toEndWith("│");
  }
  expect(new Set(lines.map(statusDisplayWidth)).size).toBe(1);
  return lines;
}

describe("status box text", () => {
  test("neutralizes terminal instructions and directional controls", () => {
    expect(
      sanitizeStatusText("\u001B[31mred\u001B[0m\u0007\u009B32mgreen\u009B0m\u202E\u2066"),
    ).toBe("redgreen");
    expect(sanitizeStatusText("\u001B]8;;https://example.test\u0007link\u001B]8;;\u0007")).toBe(
      "link",
    );
    expect(sanitizeStatusText("a\r\nb\rc\td")).toBe("a\nb\nc    d");
  });

  test("single-line task and external labels collapse line breaks and tabs", () => {
    expect(sanitizeStatusLabel("  Fix\r\n the\ttable  ")).toBe("Fix the table");
    expect(sanitizeStatusLabel("\n\t\u001B[31m\u001B[0m")).toBe("");
    const remote = sanitizeStatusLabel("remote\n└──fake\u001B[2J");
    const file = sanitizeStatusLabel("file\n┌─ agent-fake\u001B[31m.ts");
    expect(remote).toBe("remote └──fake");
    expect(file).toBe("file ┌─ agent-fake.ts");
    expect(
      framed(
        formatBox("agent-A", [
          ["peers", remote],
          ["files", file],
        ]),
      ),
    ).toHaveLength(4);
  });

  test("preserves emoji joiners, removes unrelated invisible formatting", () => {
    expect(sanitizeStatusText("👩‍💻\u200B text\u200D")).toBe("👩‍💻 text");
    expect(statusGraphemes("👩‍💻e\u0301")).toEqual(["👩‍💻", "e\u0301"]);
    expect(statusGraphemes("😀", false)).toEqual(["😀"]);
  });
});

describe("status display width", () => {
  test("counts combining marks, CJK and emoji as terminal cells", () => {
    expect(statusDisplayWidth("ASCII")).toBe(5);
    expect(statusDisplayWidth("e\u0301")).toBe(1);
    expect(statusDisplayWidth("\u0301")).toBe(0);
    expect(statusDisplayWidth("审查状态")).toBe(8);
    expect(statusDisplayWidth("😀👩‍💻🇨🇦1️⃣")).toBe(8);
    expect(statusDisplayWidth("©")).toBe(1);
    expect(statusDisplayWidth("©️")).toBe(2);
  });
});

describe("formatBox", () => {
  test("keeps the ordinary ASCII layout", () => {
    expect(formatBox("agent-A", [["task", "Fix"]])).toBe(
      ["┌─ agent-A ───┐", "│ task  Fix   │", "└─────────────┘"].join("\n"),
    );
  });

  test("frames short multiline values and explicit empty lines", () => {
    const lines = framed(formatBox("agent-A", [["task", "first\r\n\r\nsecond"]]));
    expect(lines).toHaveLength(5);
    expect(lines[1]).toContain("task  first");
    expect(lines[2]).toMatch(/^│ +│$/);
    expect(lines[3]).toContain("second");
  });

  test("wraps long multiline values without splitting graphemes", () => {
    const value = `${"审查👩‍💻e\u0301".repeat(40)}\n${"😀".repeat(80)}`;
    const lines = framed(formatBox("agent-A", [["task", value]]));
    expect(lines.length).toBeGreaterThan(5);
    expect(lines.every((line) => statusDisplayWidth(line) <= 102)).toBe(true);
    expect(lines.some((line) => line.includes("\uFFFD"))).toBe(false);
    const chunks = wrapStatusText("👩‍💻e\u0301😀", 2);
    expect(chunks).toEqual(["👩‍💻", "e\u0301", "😀"]);
  });

  test("sanitizes keys and titles and bounds long labels", () => {
    const box = formatBox("agent-A\n\u001B[2J", [["key\nname", "审查"]]);
    expect(framed(box)).toHaveLength(3);
    expect(box).toContain("agent-A");
    expect(box).toContain("key name");
    expect(box).not.toContain("\u001B");
    expect(
      framed(formatBox("界".repeat(100), [["界".repeat(100), "value"]])).every(
        (line) => statusDisplayWidth(line) <= 102,
      ),
    ).toBe(true);
  });

  test("keeps empty values, whitespace and tab continuations inside the frame", () => {
    framed(
      formatBox("council status", [
        ["empty", ""],
        ["tabs", "a\tb"],
      ]),
    );
    expect(wrapStatusText("one two three", 7)).toEqual(["one two", "three"]);
    expect(wrapStatusText("abc\n\n", 7)).toEqual(["abc", "", ""]);
  });
});

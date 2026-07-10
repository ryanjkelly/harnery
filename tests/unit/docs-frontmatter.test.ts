import { describe, expect, test } from "bun:test";
import {
  hasAnyStatus,
  normalizeStatus,
  parseFrontmatter,
  readDocStatusFromText,
} from "../../src/lib/docs-frontmatter.ts";

describe("parseFrontmatter", () => {
  test("splits leading YAML block from body", () => {
    const text = "---\nstatus: proposed\ndate: 2026-07-08\n---\n# Title\n\nBody.";
    const { data, body, raw } = parseFrontmatter(text);
    expect(data.status).toBe("proposed");
    expect(data.date).toBe("2026-07-08");
    expect(body.startsWith("# Title")).toBe(true);
    expect(raw).toContain("status: proposed");
  });

  test("no frontmatter -> empty data, whole text as body", () => {
    const text = "# Title\n\nNo frontmatter here.";
    const { data, body, raw } = parseFrontmatter(text);
    expect(data).toEqual({});
    expect(body).toBe(text);
    expect(raw).toBeNull();
  });

  test("tolerates CRLF and a leading BOM", () => {
    const text = "﻿---\r\nstatus: shipped\r\n---\r\n# Title\r\n";
    const { data, body } = parseFrontmatter(text);
    expect(data.status).toBe("shipped");
    expect(body.startsWith("# Title")).toBe(true);
  });

  test("malformed YAML -> empty data, block still stripped, never throws", () => {
    const text = "---\nstatus: : : bad\n  - nope\n---\nBody.";
    const { data, body } = parseFrontmatter(text);
    expect(data).toEqual({});
    expect(body).toBe("Body.");
  });

  test("parses list values (tags, viewers)", () => {
    const text = "---\ntags:\n  - a\n  - b\nviewers: alice@x.com, bob@y.com\n---\n";
    const { data } = parseFrontmatter(text);
    expect(data.tags).toEqual(["a", "b"]);
    expect(data.viewers).toBe("alice@x.com, bob@y.com");
  });
});

describe("normalizeStatus", () => {
  test("collapses spacing/underscore variants of in-progress", () => {
    expect(normalizeStatus("in_progress")).toBe("in-progress");
    expect(normalizeStatus("In Progress")).toBe("in-progress");
    expect(normalizeStatus("WIP")).toBe("in-progress");
  });

  test("done-family collapses per kind", () => {
    expect(normalizeStatus("done", "plan")).toBe("shipped");
    expect(normalizeStatus("completed", "plan")).toBe("shipped");
    expect(normalizeStatus("done", "issue")).toBe("resolved");
    expect(normalizeStatus("complete", "handoff")).toBe("resolved");
    // unknown kind defaults to shipped
    expect(normalizeStatus("done")).toBe("shipped");
  });

  test("wontfix variants normalize", () => {
    expect(normalizeStatus("wont-fix")).toBe("wontfix");
    expect(normalizeStatus("wontfix")).toBe("wontfix");
  });

  test("empty token -> null", () => {
    expect(normalizeStatus("   ")).toBeNull();
  });
});

describe("readDocStatusFromText (dual-read)", () => {
  test("prefers YAML status over a bold header", () => {
    const text = "---\nstatus: shipped\n---\n**Status:** in-progress\n";
    expect(readDocStatusFromText(text, "plan")).toBe("shipped");
  });

  test("falls back to bold header when no YAML status", () => {
    const text = "# Plan\n\n**Status:** in_progress - phase 1\n";
    expect(readDocStatusFromText(text, "plan")).toBe("in-progress");
  });

  test("bold done normalizes by kind on fallback", () => {
    expect(readDocStatusFromText("**Status:** done\n", "issue")).toBe("resolved");
  });

  test("neither shape -> null", () => {
    expect(readDocStatusFromText("# Just a title\n")).toBeNull();
  });
});

describe("hasAnyStatus", () => {
  test("true for YAML status", () => {
    expect(hasAnyStatus("---\nstatus: open\n---\n")).toBe(true);
  });
  test("true for bold header", () => {
    expect(hasAnyStatus("**Status:** open\n")).toBe(true);
  });
  test("false for neither", () => {
    expect(hasAnyStatus("# Title\nno status\n")).toBe(false);
  });
});

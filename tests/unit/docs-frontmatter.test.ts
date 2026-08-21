import { describe, expect, test } from "bun:test";
import {
  hasYamlStatus,
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

describe("readDocStatusFromText (v2-only)", () => {
  test("reads an exact canonical v2 status", () => {
    const text = "---\nschema: harnery-doc/v2\ntype: plan\nstatus: shipped\n---\n";
    expect(readDocStatusFromText(text, "plan")).toBe("shipped");
  });

  test("rejects aliases and unversioned YAML", () => {
    expect(readDocStatusFromText("---\nstatus: in_progress\n---\n", "plan")).toBeNull();
    expect(
      readDocStatusFromText(
        "---\nschema: harnery-doc/v2\ntype: plan\nstatus: in_progress\n---\n",
        "plan",
      ),
    ).toBeNull();
  });

  test("neither shape -> null", () => {
    expect(readDocStatusFromText("# Just a title\n")).toBeNull();
  });
});

describe("hasYamlStatus", () => {
  test("true for YAML status", () => {
    expect(hasYamlStatus("---\nstatus: open\n---\n")).toBe(true);
  });
  test("false for a legacy bold header", () => {
    expect(hasYamlStatus("**Status:** open\n")).toBe(false);
  });
  test("false for neither", () => {
    expect(hasYamlStatus("# Title\nno status\n")).toBe(false);
  });
});

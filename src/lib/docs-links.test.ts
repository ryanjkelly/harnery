import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkFile,
  collectAnchors,
  extractLinks,
  initDocsContext,
  maskCode,
  slugify,
} from "./docs-links.ts";

describe("maskCode", () => {
  test("blanks fenced blocks but preserves line numbering", () => {
    const input = ["before", "```bash", "[x](gone.md)", "```", "after"].join("\n");
    const masked = maskCode(input);
    expect(masked.split("\n")).toHaveLength(5);
    expect(masked).not.toContain("gone.md");
    expect(masked).toContain("before");
    expect(masked).toContain("after");
  });

  test("handles tilde fences and longer backtick runs", () => {
    const tilde = maskCode(["~~~", "[x](gone.md)", "~~~"].join("\n"));
    expect(tilde).not.toContain("gone.md");

    // A 3-backtick line inside a 4-backtick fence must not close it.
    const nested = maskCode(["````", "```", "[x](gone.md)", "```", "````"].join("\n"));
    expect(nested).not.toContain("gone.md");
  });

  test("blanks inline code spans without shifting columns", () => {
    const line = "run `[x](gone.md)` now";
    const masked = maskCode(line);
    expect(masked).not.toContain("gone.md");
    expect(masked).toHaveLength(line.length);
  });
});

describe("extractLinks", () => {
  test("finds inline links, images, and reference definitions", () => {
    const md = [
      "See [guide](docs/guide.md) and ![shot](img/a.png).",
      "",
      "[ref]: ../other/thing.md",
    ].join("\n");
    expect(extractLinks(md).map((l) => l.target)).toEqual([
      "docs/guide.md",
      "img/a.png",
      "../other/thing.md",
    ]);
  });

  test("finds both destinations in a nested image link", () => {
    const targets = extractLinks("[![alt](img.png)](page.md)").map((l) => l.target);
    expect(targets).toContain("img.png");
    expect(targets).toContain("page.md");
  });

  test("unwraps angle-bracketed destinations", () => {
    expect(extractLinks("[a](<my file.md>)")[0]?.target).toBe("my file.md");
  });

  test("balances parens inside a destination and drops a title", () => {
    expect(extractLinks('[a](foo_(bar).md "Title")')[0]?.target).toBe("foo_(bar).md");
  });

  test("reports the correct line number", () => {
    const md = ["one", "two", "[a](b.md)"].join("\n");
    expect(extractLinks(md)[0]?.line).toBe(3);
  });

  test("ignores footnote definitions", () => {
    // A footnote body is prose; its first word must not become a link target.
    const md = [
      "Claim.[^1]",
      "",
      "[^1]: The quick brown fox explains the claim.",
      "[ref]: real-target.md",
    ].join("\n");
    expect(extractLinks(md).map((l) => l.target)).toEqual(["real-target.md"]);
  });
});

describe("slugify / collectAnchors", () => {
  test("slugifies like GitHub", () => {
    expect(slugify("Hello, World!")).toBe("hello-world");
    expect(slugify("`harn docs` CLI")).toBe("harn-docs-cli");
    expect(slugify("Under_scores and-hyphens")).toBe("under_scores-and-hyphens");
  });

  test("keeps the gap left by dropped punctuation as a double hyphen", () => {
    // GitHub removes the em dash and then hyphenates both surrounding spaces.
    expect(slugify("Tool intent — belt and braces")).toBe("tool-intent--belt-and-braces");
    expect(slugify("Decision docket: file it")).toBe("decision-docket-file-it");
  });

  test("collects ATX and Setext headings", () => {
    const anchors = collectAnchors(["# Top Level", "", "Setext Heading", "---"].join("\n"));
    expect(anchors.has("top-level")).toBe(true);
    expect(anchors.has("setext-heading")).toBe(true);
  });

  test("suffixes duplicate headings in document order", () => {
    const anchors = collectAnchors(["## Notes", "## Notes", "## Notes"].join("\n"));
    expect(anchors.has("notes")).toBe(true);
    expect(anchors.has("notes-1")).toBe(true);
    expect(anchors.has("notes-2")).toBe(true);
  });

  test("strips inline markup and links from heading text", () => {
    const anchors = collectAnchors("## **Bold** and [a link](x.md)");
    expect(anchors.has("bold-and-a-link")).toBe(true);
  });

  test("keeps literal underscores while stripping emphasis underscores", () => {
    // GitHub anchors `not_in_channel` with its underscores intact; only
    // word-boundary underscores are emphasis markup.
    const anchors = collectAnchors(
      ["## Slack: `not_in_channel` vs missing scope", "## _emphasized_ title"].join("\n"),
    );
    expect(anchors.has("slack-not_in_channel-vs-missing-scope")).toBe(true);
    expect(anchors.has("emphasized-title")).toBe(true);
  });

  test("unescapes backslash escapes before slugging", () => {
    const anchors = collectAnchors("## Cloud Function (`snake\\_case`)");
    expect(anchors.has("cloud-function-snake_case")).toBe(true);
  });

  test("honors explicit {#custom-id} and HTML id/name anchors", () => {
    const anchors = collectAnchors(
      ["## Heading {#custom-id}", '<a name="legacy"></a>', '<h2 id="html-anchor">x</h2>'].join(
        "\n",
      ),
    );
    expect(anchors.has("custom-id")).toBe(true);
    expect(anchors.has("legacy")).toBe(true);
    expect(anchors.has("html-anchor")).toBe(true);
  });

  test("ignores headings inside fenced code", () => {
    const anchors = collectAnchors(["```", "# Not A Heading", "```"].join("\n"));
    expect(anchors.has("not-a-heading")).toBe(false);
  });

  test("keeps a heading that is entirely inline code", () => {
    // Masking the code span here would erase the heading and lose a real anchor.
    const anchors = collectAnchors("### `harn query`\n");
    expect(anchors.has("harn-query")).toBe(true);
  });
});

describe("checkFile", () => {
  let root: string;

  const write = (rel: string, content: string): void => {
    const abs = join(root, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content, "utf8");
  };

  const check = (
    rel: string,
    content: string,
    opts: Partial<Parameters<typeof checkFile>[0]> = {},
  ) =>
    checkFile({
      repoName: "(root)",
      repoPath: root,
      rel,
      content,
      noFragments: false,
      strict: false,
      checkEscapes: false,
      anchorCache: new Map(),
      ...opts,
    });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "harnery-links-"));
    initDocsContext({ repoRoot: root, submodules: [] });
    write("docs/target.md", "# Real Heading\n\n## Second Section\n");
    write("docs/assets/pic.png", "");
    mkdirSync(join(root, "docs/sub"), { recursive: true });
    write("docs/sub/README.md", "# Sub\n");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("passes a link that resolves", () => {
    const r = check("docs/index.md", "[t](target.md)");
    expect(r.findings).toEqual([]);
    expect(r.checked).toBe(1);
  });

  test("flags a missing target", () => {
    const r = check("docs/index.md", "[t](nope.md)");
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]?.rule).toBe("missing-target");
    expect(r.findings[0]?.severity).toBe("error");
  });

  test("resolves a directory link and an extension-less doc link", () => {
    expect(check("docs/index.md", "[t](sub/)").findings).toEqual([]);
    expect(check("docs/index.md", "[t](target)").findings).toEqual([]);
  });

  test("decodes URL-encoded paths", () => {
    write("docs/with space.md", "# X\n");
    expect(check("docs/index.md", "[t](with%20space.md)").findings).toEqual([]);
  });

  test("reports a case-only mismatch with the on-disk name", () => {
    const r = check("docs/index.md", "[t](Target.md)");
    // On a case-insensitive filesystem the target simply resolves; the finding
    // only exists where it matters, so accept either outcome but pin the shape.
    if (r.findings.length > 0) {
      expect(r.findings[0]?.rule).toBe("case-mismatch");
      expect(r.findings[0]?.suggestion).toBe("docs/target.md");
    }
  });

  test("validates a fragment against the target's headings", () => {
    expect(check("docs/index.md", "[t](target.md#second-section)").findings).toEqual([]);
    const bad = check("docs/index.md", "[t](target.md#no-such-heading)");
    expect(bad.findings).toHaveLength(1);
    expect(bad.findings[0]?.rule).toBe("missing-fragment");
  });

  test("validates a same-document fragment", () => {
    const content = "# Alpha\n\n[go](#alpha) and [bad](#omega)\n";
    const r = check("docs/index.md", content);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]?.target).toBe("#omega");
  });

  test("--no-fragments checks existence only", () => {
    const r = check("docs/index.md", "[t](target.md#no-such-heading)", { noFragments: true });
    expect(r.findings).toEqual([]);
  });

  test("ignores #Lnn line references", () => {
    expect(check("docs/index.md", "[t](target.md#L42)").findings).toEqual([]);
  });

  test("resolves editor-style :line suffixes against the base file", () => {
    expect(check("docs/index.md", "[t](target.md:42)").findings).toEqual([]);
    expect(check("docs/index.md", "[t](nope.md:42)").findings).toHaveLength(1);
  });

  test("skips external, mail, protocol-relative, and root-absolute targets", () => {
    const r = check(
      "docs/index.md",
      [
        "[a](https://example.com/x.md)",
        "[b](mailto:x@example.com)",
        "[c](//cdn.example.com/x.md)",
        "[d](/site/route)",
      ].join("\n"),
    );
    expect(r.findings).toEqual([]);
    expect(r.checked).toBe(0);
    expect(r.skipped).toBe(4);
  });

  test("skips placeholder targets", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal ${DIR} is the input under test
    const shellVar = "[b](${DIR}/x.md)";
    const r = check("docs/index.md", `[a](docs/{{slug}}.md) ${shellVar} [c](<placeholder>)`);
    expect(r.findings).toEqual([]);
  });

  test("ignores links inside fenced code", () => {
    const r = check("docs/index.md", ["```md", "[t](nope.md)", "```"].join("\n"));
    expect(r.findings).toEqual([]);
  });

  test("honors a per-line links-allow comment", () => {
    const r = check("docs/index.md", "[t](nope.md) <!-- links-allow: documents a removed path -->");
    expect(r.findings).toEqual([]);
    expect(r.skipped).toBe(1);
  });

  test("honors a whole-file links-allow-file comment", () => {
    const r = check("docs/index.md", "<!-- links-allow-file: transcript -->\n\n[t](nope.md)");
    expect(r.findings).toEqual([]);
  });

  test("downgrades findings in immutable-history docs to warnings", () => {
    for (const rel of [
      "docs/audits/2026-01-01_x.md",
      "docs/plans/archive/old.md",
      "docs/changelogs/2026-01.md",
      "docs/handoffs/2026-01/x.md",
    ]) {
      expect(check(rel, "[t](nope.md)").findings[0]?.severity).toBe("warning");
    }
  });

  test("--strict promotes history findings back to errors", () => {
    const r = check("docs/audits/2026-01-01_x.md", "[t](nope.md)", { strict: true });
    expect(r.findings[0]?.severity).toBe("error");
  });

  test("downgrades findings in settled lifecycle docs; open ones stay errors", () => {
    const resolved = "---\nschema: harnery-doc/v2\ntype: issue\nstatus: resolved\n---\n\n[t](nope.md)\n";
    expect(check("docs/issues/2026-01-01_x.md", resolved).findings[0]?.severity).toBe("warning");

    const open = "---\nschema: harnery-doc/v2\ntype: issue\nstatus: open\n---\n\n[t](nope.md)\n";
    expect(check("docs/issues/2026-01-01_x.md", open).findings[0]?.severity).toBe("error");

    // No frontmatter status at all: treat as live.
    expect(check("docs/issues/2026-01-01_x.md", "[t](nope.md)").findings[0]?.severity).toBe(
      "error",
    );

    // Status only helps for lifecycle dirs; a topic doc stays live regardless.
    const topic = "---\nschema: harnery-doc/v2\ntype: topic\nstatus: resolved\n---\n\n[t](nope.md)\n";
    expect(check("docs/guides/topic.md", topic).findings[0]?.severity).toBe("error");

    // --strict overrides the downgrade here too.
    expect(
      check("docs/issues/2026-01-01_x.md", resolved, { strict: true }).findings[0]?.severity,
    ).toBe("error");
  });

  test("--check-escapes flags a resolving link that leaves the repo", () => {
    const nested = join(root, "sub-repo");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, "doc.md"), "[t](../docs/target.md)", "utf8");
    const quiet = checkFile({
      repoName: "sub-repo",
      repoPath: nested,
      rel: "doc.md",
      content: "[t](../docs/target.md)",
      noFragments: false,
      strict: false,
      checkEscapes: false,
      anchorCache: new Map(),
    });
    expect(quiet.findings).toEqual([]);

    const loud = checkFile({
      repoName: "sub-repo",
      repoPath: nested,
      rel: "doc.md",
      content: "[t](../docs/target.md)",
      noFragments: false,
      strict: false,
      checkEscapes: true,
      anchorCache: new Map(),
    });
    expect(loud.findings).toHaveLength(1);
    expect(loud.findings[0]?.rule).toBe("escapes-repo");
  });

  test("reports the line the broken link sits on", () => {
    const r = check("docs/index.md", ["# T", "", "ok", "", "[t](nope.md)"].join("\n"));
    expect(r.findings[0]?.line).toBe(5);
  });

  test("checks image targets", () => {
    expect(check("docs/index.md", "![p](assets/pic.png)").findings).toEqual([]);
    expect(check("docs/index.md", "![p](assets/missing.png)").findings).toHaveLength(1);
  });
});

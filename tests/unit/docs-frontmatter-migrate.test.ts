import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFrontmatter } from "../../src/lib/docs-frontmatter.ts";
import {
  convertLifecycleFrontmatter,
  initDocsMigrationContext,
  runFrontmatterMigration,
} from "../../src/lib/docs-frontmatter-migrate.ts";

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe("convertLifecycleFrontmatter", () => {
  test("moves plan metadata into YAML and preserves narrative labels", () => {
    const content = [
      "# Plan: cache redesign",
      "",
      "**Date:** 2026-07-13",
      "**Status:** in_progress - parser landed",
      "**Last updated:** 2026-07-13",
      "**Prerequisites:** none",
      "**Related prior work:** [old plan](old.md)",
      "",
      "## Problem",
      "",
      "**Status:** this body example must stay",
      "",
    ].join("\n");

    const result = convertLifecycleFrontmatter(content, "plan");
    expect(result.status).toBe("convert");
    const parsed = parseFrontmatter(result.content!);
    expect(parsed.data).toEqual({
      status: "in-progress",
      date: "2026-07-13",
      last_updated: "2026-07-13",
      status_note: "parser landed",
      prerequisites: [],
    });
    expect(parsed.body).toContain("**Related prior work:**");
    expect(parsed.body).toContain("**Status:** this body example must stay");
    expect(parsed.body).not.toContain("**Date:**");
  });

  test("normalizes done by lifecycle kind and keeps resolution detail", () => {
    const result = convertLifecycleFrontmatter(
      [
        "# Issue: fixed",
        "",
        "**Date:** 2026-07-01 (first observed)",
        "**Status:** DONE",
        "**Resolved:** 2026-07-13 (deployed and verified)",
        "**Severity:** high",
        "",
        "## Summary",
      ].join("\n"),
      "issue",
    );
    const data = parseFrontmatter(result.content!).data;
    expect(data.status).toBe("resolved");
    expect(data.date).toBe("2026-07-01");
    expect(data.resolved).toBe("2026-07-13");
    expect(data.status_note).toBe("date: first observed; resolved: deployed and verified");
  });

  test("normalizes markdown-wrapped legacy aliases", () => {
    const issue = convertLifecycleFrontmatter(
      "# Issue\n\n**Status:** **fixed 2026-05-11** (verified)\n",
      "issue",
    );
    const issueData = parseFrontmatter(issue.content!).data;
    expect(issueData.status).toBe("resolved");
    expect(issueData.status_note).toBe("2026-05-11 (verified)");

    const plan = convertLifecycleFrontmatter(
      "# Plan\n\n**Status:** Archived — implementation shipped\n",
      "plan",
    );
    const planData = parseFrontmatter(plan.content!).data;
    expect(planData.status).toBe("shipped");
    expect(planData.status_note).toBe("implementation shipped");
  });

  test("merges into existing YAML without dropping extra keys", () => {
    const result = convertLifecycleFrontmatter(
      [
        "---",
        "tags: [finance]",
        "viewers: accounting@example.com",
        "---",
        "# Issue: mixed",
        "",
        "**Status:** open (waiting on vendor)",
        "**Severity:** low",
      ].join("\n"),
      "issue",
    );
    const data = parseFrontmatter(result.content!).data;
    expect(data).toEqual({
      tags: ["finance"],
      viewers: "accounting@example.com",
      status: "open",
      status_note: "waiting on vendor",
      severity: "low",
    });
  });

  test("moves handoff pickup prose into synopsis", () => {
    const result = convertLifecycleFrontmatter(
      [
        "# Handoff: continue work",
        "",
        "**Date:** 2026-07-13",
        "**Status:** open",
        "**Continues:** ../prior.md",
        "**What you're picking up:** Resume at step 3.",
      ].join("\n"),
      "handoff",
    );
    const data = parseFrontmatter(result.content!).data;
    expect(data.continues).toBe("../prior.md");
    expect(data.synopsis).toBe("Resume at step 3.");
  });

  test("skips files that already have YAML status", () => {
    const result = convertLifecycleFrontmatter(
      "---\nstatus: proposed\n---\n# Plan\n\n**Status:** in-progress\n",
      "plan",
    );
    expect(result.status).toBe("skipped");
    expect(result.message).toBe("already has YAML status");
  });

  test("fails unsupported statuses and malformed bold shapes", () => {
    expect(convertLifecycleFrontmatter("# Plan\n\n**Status:** council-approved\n", "plan")).toEqual(
      expect.objectContaining({
        status: "error",
        message: "unsupported plan status 'council-approved'",
      }),
    );
    expect(convertLifecycleFrontmatter("# Plan\n\n**Status**: proposed\n", "plan")).toEqual(
      expect.objectContaining({
        status: "error",
        message: "unsupported bold status shape '**Status**: proposed'",
      }),
    );
  });
});

describe("runFrontmatterMigration", () => {
  test("is dry-run by default and writes only with apply", () => {
    const root = mkdtempSync(join(tmpdir(), "harn-frontmatter-migrate-"));
    roots.push(root);
    const plans = join(root, "docs", "plans");
    mkdirSync(plans, { recursive: true });
    const path = join(plans, "one.md");
    const original = "# Plan: one\n\n**Status:** proposed\n";
    writeFileSync(path, original);
    initDocsMigrationContext({ repoRoot: root, submodules: [] });

    const dryRun = runFrontmatterMigration({ repo: "." });
    expect(dryRun).toEqual([
      expect.objectContaining({ path: "docs/plans/one.md", status: "would-update" }),
    ]);
    expect(readFileSync(path, "utf8")).toBe(original);

    const applied = runFrontmatterMigration({ repo: ".", apply: true });
    expect(applied).toEqual([
      expect.objectContaining({ path: "docs/plans/one.md", status: "updated" }),
    ]);
    expect(parseFrontmatter(readFileSync(path, "utf8")).data.status).toBe("proposed");
  });

  test("aborts the whole apply when any file has an error", () => {
    const root = mkdtempSync(join(tmpdir(), "harn-frontmatter-abort-"));
    roots.push(root);
    const plans = join(root, "docs", "plans");
    mkdirSync(plans, { recursive: true });
    const goodPath = join(plans, "good.md");
    const good = "# Plan: good\n\n**Status:** proposed\n";
    writeFileSync(goodPath, good);
    writeFileSync(join(plans, "bad.md"), "# Plan: bad\n\n**Status:** unknown-state\n");
    initDocsMigrationContext({ repoRoot: root, submodules: [] });

    const rows = runFrontmatterMigration({ repo: ".", apply: true });

    expect(rows.some((row) => row.status === "error")).toBe(true);
    expect(rows.some((row) => row.status === "updated")).toBe(false);
    expect(readFileSync(goodPath, "utf8")).toBe(good);
  });
});

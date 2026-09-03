import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  pressureRecordFixture,
  resourceStatusFixture,
} from "../../../../tests/helpers/resource-status.ts";
import type { PressureAssessment } from "../../diagnostics/contract.ts";
import { supervisorPaths } from "../../supervisor/storage.ts";
import { resourceWarningIfChanged } from "./prompt-context.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "harn-prompt-resource-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const elevated: Partial<PressureAssessment> = {
  state: "elevated",
  limiting_resource: "memory",
  recommended_action: "limit-heavy-work",
  summary: "Memory stalls have been rising for two samples, so limit new heavy work.",
  guidance: [
    {
      workload_class: "lightweight",
      recommendation: "proceed",
      summary: "Reads and edits are unaffected.",
    },
    {
      workload_class: "cpu-heavy",
      recommendation: "limit-heavy-work",
      summary: "Let a running build finish before starting another.",
    },
    {
      workload_class: "memory-heavy",
      recommendation: "avoid-new-heavy-work",
      summary: "Hold off on a browser capture until the stalls clear.",
    },
    {
      workload_class: "storage-heavy",
      recommendation: "proceed",
      summary: "Disk space is not the constraint.",
    },
  ],
};

test("missing and normal resource caches add no prompt noise", () => {
  expect(resourceWarningIfChanged(root, "self")).toBe("");
  resourceStatusFixture(root);
  expect(resourceWarningIfChanged(root, "self")).toBe("");
  expect(resourceWarningIfChanged(root, "self")).toBe("");
});

test("invalid instance identifiers cannot create resource hash paths", () => {
  resourceStatusFixture(root);
  const before = readdirSync(join(root, ".harnery")).sort();
  for (const id of ["", "../outside", "session/child", "session\\child", ".", "a".repeat(129)]) {
    expect(resourceWarningIfChanged(root, id)).toBe("");
  }
  expect(readdirSync(join(root, ".harnery")).sort()).toEqual(before);
});

test("the notice deduplicates by scope, state, and recommended action", () => {
  resourceStatusFixture(root);
  pressureRecordFixture(root, { assessment: elevated });
  const first = resourceWarningIfChanged(root, "self");
  expect(first).toContain("Memory stalls have been rising");
  expect(first).toContain("Builds and test runs: Let a running build finish");
  expect(first).toContain("Browser captures and page QA: Hold off on a browser capture");
  expect(resourceWarningIfChanged(root, "self")).toBe("");

  // A numeric-only change keeps the same key and must not re-emit.
  pressureRecordFixture(root, {
    assessment: {
      ...elevated,
      sample_age_ms: 1_000,
      evidence: [
        {
          dimension: "memory_stall",
          state: "supported",
          observed_value: 44,
          unit: "percent",
          sample_count: 4,
        },
      ],
    },
  });
  expect(resourceWarningIfChanged(root, "self")).toBe("");

  // A contributor-only change also keeps the same key.
  pressureRecordFixture(root, {
    assessment: {
      ...elevated,
      contributors: [
        {
          finding_id: "finding:a",
          finding_kind: "process.memory-pressure",
          finding_class: "attribution",
          severity: "warning",
          summary: "One process holds 1.2 GiB.",
          scope_kind: "process",
          scope_id: "11",
          occurrence_count: 2,
          attribution_state: "attributed",
          attribution_confidence: "exact",
          owner_kind: "agent",
          owner_id: "agent-Named",
        },
      ],
    },
  });
  expect(resourceWarningIfChanged(root, "self")).toBe("");

  // Each session keeps its own key.
  expect(resourceWarningIfChanged(root, "other")).toContain("Resource update");
});

test("a changed recommended action re-emits and the recovery notice is sent once", () => {
  resourceStatusFixture(root);
  pressureRecordFixture(root, { assessment: elevated });
  expect(resourceWarningIfChanged(root, "self")).toContain("Resource update");
  pressureRecordFixture(root, {
    assessment: {
      ...elevated,
      state: "critical",
      recommended_action: "avoid-new-heavy-work",
      summary: "Memory is fully stalled, so do not start new heavy work.",
    },
  });
  expect(resourceWarningIfChanged(root, "self")).toContain(
    "Memory is fully stalled, so do not start new heavy work.",
  );
  pressureRecordFixture(root);
  expect(resourceWarningIfChanged(root, "self")).toContain("warning has cleared");
  expect(resourceWarningIfChanged(root, "self")).toBe("");
  expect(resourceWarningIfChanged(root, "self")).toBe("");
});

test("the notice never promises a safe agent count", () => {
  resourceStatusFixture(root);
  pressureRecordFixture(root, { assessment: elevated });
  const notice = resourceWarningIfChanged(root, "self");
  expect(notice).not.toMatch(/\b\d+\s+(more\s+)?(agents?|subagents?|parallel)\b/i);
});

test("names an owner only when the contributor attribution is exact", () => {
  resourceStatusFixture(root);
  pressureRecordFixture(root, {
    assessment: {
      ...elevated,
      contributors: [
        {
          finding_id: "finding:a",
          finding_kind: "process.memory-pressure",
          finding_class: "attribution",
          severity: "warning",
          summary: "One process holds 1.2 GiB.",
          scope_kind: "process",
          scope_id: "11",
          occurrence_count: 1,
          attribution_state: "attributed",
          attribution_confidence: "exact",
          owner_kind: "agent",
          owner_id: "agent-Named",
        },
        {
          finding_id: "finding:b",
          finding_kind: "group.memory-pressure",
          finding_class: "attribution",
          severity: "warning",
          summary: "An unowned group holds 2 GiB.",
          scope_kind: "group",
          scope_id: "22",
          occurrence_count: 1,
          attribution_state: "unattributed",
          attribution_confidence: "none",
          owner_kind: "agent",
          owner_id: "agent-Guessed",
        },
      ],
    },
  });
  const notice = resourceWarningIfChanged(root, "self");
  expect(notice).toContain("agent agent-Named");
  expect(notice).not.toContain("agent-Guessed");
});

test("a lost pressure record produces one advisory and never stops coordination", () => {
  resourceStatusFixture(root);
  pressureRecordFixture(root, { assessment: elevated });
  expect(resourceWarningIfChanged(root, "self")).toContain("Resource update");
  unlinkSync(supervisorPaths(root).pressure);
  const notice = resourceWarningIfChanged(root, "self");
  expect(notice).toContain("continue normal coordination");
  expect(notice).toContain("cannot be determined");
  expect(resourceWarningIfChanged(root, "self")).toBe("");
});

test("prompt guidance uses the configured command name", () => {
  resourceStatusFixture(root);
  writeFileSync(join(root, ".harnery", "config.jsonc"), JSON.stringify({ binName: "project" }));
  pressureRecordFixture(root, { assessment: elevated });
  expect(resourceWarningIfChanged(root, "self")).toContain("project resources status --json");
});

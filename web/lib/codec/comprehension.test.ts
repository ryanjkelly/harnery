import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  CODEC_COMPREHENSION_SCHEMA_VERSION,
  type CodecComprehensionCohort,
  codecComprehensionCohortPath,
  parseCodecComprehensionCohort,
  publicCodecComprehensionStudy,
  readCodecComprehensionCohort,
  resolveCodecComprehensionAsset,
  storeCodecComprehensionResult,
} from "./comprehension";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("Codec comprehension study", () => {
  test("parses a controlled-token cohort and exposes opaque image URLs", () => {
    const cohort = fixtureCohort();
    expect(parseCodecComprehensionCohort(cohort)).toEqual(cohort);
    const study = publicCodecComprehensionStudy(cohort);
    expect(study.trials[0]).toEqual({
      trial_id: "trial_1111111111111111",
      target_expression: "verifying",
      image_a_url: "/api/codec-evaluation/image/study_aaaaaaaaaaaaaaaa/trial_1111111111111111/a",
      image_b_url: "/api/codec-evaluation/image/study_aaaaaaaaaaaaaaaa/trial_1111111111111111/b",
    });
    expect(JSON.stringify(study)).not.toContain("focused");
    expect(JSON.stringify(study)).not.toContain("semantic_side");
  });

  test("rejects duplicate trials and non-controlled source fields", () => {
    const cohort = fixtureCohort();
    expect(() =>
      parseCodecComprehensionCohort({ ...cohort, trials: [cohort.trials[0], cohort.trials[0]] }),
    ).toThrow("duplicate comprehension trial");
    expect(() =>
      parseCodecComprehensionCohort({
        ...cohort,
        source: { ...cohort.source, privacy: "raw-model-text" },
      }),
    ).toThrow("invalid comprehension cohort source");
  });

  test("serves the hidden side through the validated pack manifest", () => {
    const root = fixtureRoot();
    writeCohort(root, fixtureCohort());
    const packDir = path.join(root, "codec", "packs", "f01-a");
    fs.mkdirSync(packDir, { recursive: true });
    fs.writeFileSync(path.join(packDir, "verifying.webp"), "semantic");
    fs.writeFileSync(path.join(packDir, "focused.webp"), "comparison");
    const expressions = Object.fromEntries(
      [
        "neutral",
        "focused",
        "curious",
        "deliberating",
        "investigating",
        "building",
        "coordinating",
        "waiting",
        "recovering",
        "celebrating",
        "alert",
      ].map((expression) => [expression, "focused.webp"]),
    );
    expressions.verifying = "verifying.webp";
    fs.writeFileSync(
      path.join(packDir, "pack.json"),
      JSON.stringify({
        schema_version: 1,
        pack_id: "f01-a",
        pack_version: "3",
        expressions,
      }),
    );

    expect(
      resolveCodecComprehensionAsset("study_aaaaaaaaaaaaaaaa", "trial_1111111111111111", "b", root)
        ?.filePath,
    ).toBe(path.join(packDir, "verifying.webp"));
    expect(
      resolveCodecComprehensionAsset("study_aaaaaaaaaaaaaaaa", "trial_1111111111111111", "a", root)
        ?.filePath,
    ).toBe(path.join(packDir, "focused.webp"));

    writeCohort(root, {
      ...fixtureCohort(),
      trials: fixtureCohort().trials.map((trial) => ({ ...trial, pack_version: "4" })),
    });
    expect(
      resolveCodecComprehensionAsset("study_aaaaaaaaaaaaaaaa", "trial_1111111111111111", "a", root),
    ).toBeNull();
  });

  test("stores one bounded receipt and scores the hidden semantic side", () => {
    const root = fixtureRoot();
    writeCohort(root, fixtureCohort());
    const receipt = storeCodecComprehensionResult(
      {
        schema_version: CODEC_COMPREHENSION_SCHEMA_VERSION,
        study_id: "study_aaaaaaaaaaaaaaaa",
        total_duration_ms: 12_000,
        responses: [
          {
            trial_id: "trial_1111111111111111",
            choice: "b",
            confidence: "high",
            response_ms: 5_000,
          },
          {
            trial_id: "trial_2222222222222222",
            choice: "same",
            confidence: "medium",
            response_ms: 7_000,
          },
        ],
      },
      root,
      new Date("2026-08-24T03:40:00.000Z"),
    );
    expect(receipt.summary).toMatchObject({
      trial_count: 2,
      semantic_preferred: 1,
      comparison_preferred: 0,
      same: 1,
      semantic_share_excluding_ties: 1,
    });
    const stored = path.join(
      root,
      "semantic",
      "evaluations",
      "results",
      `${receipt.receipt_id}.json`,
    );
    expect(fs.existsSync(stored)).toBe(true);
    expect(fs.readFileSync(stored, "utf8")).not.toContain("model reply");
  });

  test("rejects incomplete or repeated answers", () => {
    const root = fixtureRoot();
    writeCohort(root, fixtureCohort());
    expect(() =>
      storeCodecComprehensionResult(
        {
          schema_version: 1,
          study_id: "study_aaaaaaaaaaaaaaaa",
          total_duration_ms: 1_000,
          responses: [],
        },
        root,
      ),
    ).toThrow("incomplete comprehension submission");
  });
});

function fixtureRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codec-comprehension-"));
  roots.push(root);
  return root;
}

function fixtureCohort(): CodecComprehensionCohort {
  return {
    schema_version: CODEC_COMPREHENSION_SCHEMA_VERSION,
    study_id: "study_aaaaaaaaaaaaaaaa",
    created_at: "2026-08-24T03:30:00.000Z",
    source: {
      kind: "semantic-readings",
      accepted_readings: 14,
      privacy: "controlled-tokens-only",
    },
    trials: [
      {
        trial_id: "trial_1111111111111111",
        target_expression: "verifying",
        comparison_expression: "focused",
        pack_id: "f01-a",
        pack_version: "3",
        semantic_side: "b",
      },
      {
        trial_id: "trial_2222222222222222",
        target_expression: "wrapping-up",
        comparison_expression: "celebrating",
        pack_id: "m02-b",
        pack_version: "3",
        semantic_side: "a",
      },
    ],
  };
}

function writeCohort(root: string, cohort: CodecComprehensionCohort): void {
  const target = codecComprehensionCohortPath(root);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(cohort));
  expect(readCodecComprehensionCohort(root)).toEqual(cohort);
}

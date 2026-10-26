import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { CodecComprehensionPublicStudy } from "@/lib/codec/comprehension";

import { CodecComprehensionStudy } from "./CodecComprehensionStudy";

const study: CodecComprehensionPublicStudy = {
  schema_version: 1,
  study_id: "study_aaaaaaaaaaaaaaaa",
  created_at: "2026-08-24T03:30:00.000Z",
  accepted_readings: 14,
  trials: [
    {
      trial_id: "trial_1111111111111111",
      target_expression: "verifying",
      image_a_url: "/api/codec-evaluation/image/study_aaaaaaaaaaaaaaaa/trial_1111111111111111/a",
      image_b_url: "/api/codec-evaluation/image/study_aaaaaaaaaaaaaaaa/trial_1111111111111111/b",
    },
  ],
};

test("reconciles refreshed study data in the same session and remounts a replacement cohort", () => {
  const initial = CodecComprehensionStudy({ study });
  const refreshed = CodecComprehensionStudy({ study: { ...study } });
  const replacement = CodecComprehensionStudy({
    study: { ...study, study_id: "study_bbbbbbbbbbbbbbbb" },
  });

  expect(initial.type).toBe(refreshed.type);
  expect(initial.key).toBeTruthy();
  expect(refreshed.key).toBe(initial.key);
  expect(replacement.type).toBe(initial.type);
  expect(replacement.key).not.toBe(initial.key);
});

test("starts with instructions and defers blinded portrait requests until the participant begins", () => {
  const html = renderToStaticMarkup(<CodecComprehensionStudy study={study} />);

  expect(html).toContain("Begin blinded test");
  expect(html).toContain("1 comparisons");
  expect(html).toContain("14 accepted readings");
  expect(html).not.toContain("/api/codec-evaluation/image/");
  expect(html).not.toContain("Finish and save");
});

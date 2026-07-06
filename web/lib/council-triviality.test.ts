import { describe, expect, test } from "bun:test";

import {
  countConsecutiveAllTrivialRoundsFromTags,
  lastStatusMarker,
} from "./council-triviality";

describe("lastStatusMarker", () => {
  test("plain trailing tags", () => {
    expect(lastStatusMarker("Ratified.\n\n<trivial> GO, close")).toBe(
      "trivial",
    );
    expect(lastStatusMarker("Reworked §2.1.\n\n<substantive>")).toBe(
      "substantive",
    );
  });

  test("backticked tags match (substring, not markdown-aware)", () => {
    expect(lastStatusMarker("**GO, close.** `<trivial>`")).toBe("trivial");
  });

  test("case-insensitive", () => {
    expect(lastStatusMarker("<Trivial> done")).toBe("trivial");
  });

  test("last marker wins when prose mentions both (fold-record shape)", () => {
    const foldRecord =
      "Mis-transcriptions → `<substantive>`; clean → `<trivial>`.\n\n" +
      "`<substantive>`: folded round-2 corrections into binding plan text.";
    expect(lastStatusMarker(foldRecord)).toBe("substantive");

    const prompt =
      "End with `<substantive>` if a defect surfaces.\n\n<trivial> GO";
    expect(lastStatusMarker(prompt)).toBe("trivial");
  });

  test("untagged body → null", () => {
    expect(lastStatusMarker("GO, close. No tags here.")).toBeNull();
  });
});

describe("countConsecutiveAllTrivialRoundsFromTags", () => {
  const triv = "ratified <trivial>";
  const subst = "reworked <substantive>";

  test("counts the trailing all-trivial streak", () => {
    const n = countConsecutiveAllTrivialRoundsFromTags([
      { round: 3, bodies: [subst, triv, triv] },
      { round: 4, bodies: [triv, triv, triv] },
      { round: 5, bodies: [triv, triv, triv] },
    ]);
    expect(n).toBe(2);
  });

  test("a substantive round breaks the streak", () => {
    const n = countConsecutiveAllTrivialRoundsFromTags([
      { round: 4, bodies: [triv] },
      { round: 5, bodies: [triv, subst] },
    ]);
    expect(n).toBe(0);
  });

  test("an untagged contribution never counts as trivial", () => {
    const n = countConsecutiveAllTrivialRoundsFromTags([
      { round: 4, bodies: [triv] },
      { round: 5, bodies: [triv, "no marker at all"] },
    ]);
    expect(n).toBe(0);
  });

  test("trailing empty rounds (force-advanced) are skipped, not streak-breaking", () => {
    const n = countConsecutiveAllTrivialRoundsFromTags([
      { round: 4, bodies: [triv, triv] },
      { round: 5, bodies: [triv, triv] },
      { round: 6, bodies: [] },
    ]);
    expect(n).toBe(2);
  });

  test("unsorted input is handled; empty input → 0", () => {
    const n = countConsecutiveAllTrivialRoundsFromTags([
      { round: 5, bodies: [triv] },
      { round: 4, bodies: [triv] },
      { round: 3, bodies: [subst] },
    ]);
    expect(n).toBe(2);
    expect(countConsecutiveAllTrivialRoundsFromTags([])).toBe(0);
  });
});

describe("lastStatusMarker bare-word fallback", () => {
  test("plain trailing word", () => {
    expect(lastStatusMarker("Findings resolved.\n\ntrivial")).toBe("trivial");
  });
  test("classification-prefixed", () => {
    expect(lastStatusMarker("body\n\nclassification: substantive")).toBe("substantive");
  });
  test("bold Status form", () => {
    expect(lastStatusMarker("body\n\n**Status: trivial**")).toBe("trivial");
  });
  test("tag at end of a short closing sentence", () => {
    expect(lastStatusMarker("Verified.\n\nNo new issues. trivial")).toBe("trivial");
  });
  test("long closing prose paragraph mentioning the word does NOT fire", () => {
    expect(
      lastStatusMarker(
        "body\n\nOverall this felt like a fairly trivial set of changes to review, though the discussion around isolation boundaries was anything but simple.",
      ),
    ).toBeNull();
  });
  test("angle-bracket marker still wins over bare words", () => {
    expect(lastStatusMarker("<substantive>\n\ntrivial-sounding close")).toBe("substantive");
  });
  test("untagged body stays null", () => {
    expect(lastStatusMarker("no tags anywhere")).toBeNull();
  });
});

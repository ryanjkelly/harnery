import { describe, expect, test } from "bun:test";
import {
  decideHelperLimit,
  effectiveHelperLimit,
  formatHelperLimit,
  type HelperLadders,
  helperLadders,
  isNoHelperLimit,
  modelFamily,
  parseHelperLimitWords,
  parseStoredHelperLimit,
} from "./helper-limit.ts";

const LADDERS: HelperLadders = {
  models: ["haiku", "sonnet", "opus", "fable"],
  efforts: ["low", "medium", "high", "xhigh", "max"],
  effortlessModels: ["haiku"],
};

const OPUS_MEDIUM = { max_model: "opus", max_effort: "medium" };

describe("helperLadders", () => {
  test("reads the profile fields and defaults the optional ones to empty", () => {
    expect(
      helperLadders({ effortValues: ["low"], modelLadder: ["a", "b"], effortlessModels: ["a"] }),
    ).toEqual({ models: ["a", "b"], efforts: ["low"], effortlessModels: ["a"] });
    expect(helperLadders({ effortValues: [] })).toEqual({
      models: [],
      efforts: [],
      effortlessModels: [],
    });
  });
});

describe("modelFamily", () => {
  test("an exact ladder entry is its own family, case and spacing ignored", () => {
    expect(modelFamily("opus", LADDERS.models)).toBe("opus");
    expect(modelFamily("  Sonnet ", LADDERS.models)).toBe("sonnet");
  });

  test("a full model id ranks by its family token", () => {
    expect(modelFamily("claude-opus-5-5", LADDERS.models)).toBe("opus");
    expect(modelFamily("opus[1m]", LADDERS.models)).toBe("opus");
    expect(modelFamily("claude-haiku-5-5", LADDERS.models)).toBe("haiku");
  });

  test("a name matching two families or none is unrankable", () => {
    expect(modelFamily("opus-sonnet-blend", LADDERS.models)).toBeNull();
    expect(modelFamily("gpt-6", LADDERS.models)).toBeNull();
    expect(modelFamily("opusx", LADDERS.models)).toBeNull();
    expect(modelFamily("", LADDERS.models)).toBeNull();
  });
});

describe("decideHelperLimit", () => {
  test("a stated value above the limit is lowered", () => {
    const decision = decideHelperLimit({ model: "fable", effort: "max" }, OPUS_MEDIUM, LADDERS);
    expect(decision).toEqual({
      model: "opus",
      effort: "medium",
      loweredModel: true,
      loweredEffort: true,
      droppedEffort: false,
      changed: true,
    });
  });

  test("a value at or below the limit is untouched", () => {
    for (const request of [
      { model: "opus", effort: "medium" },
      { model: "sonnet", effort: "low" },
    ]) {
      const decision = decideHelperLimit(request, OPUS_MEDIUM, LADDERS);
      expect(decision.model).toBe(request.model);
      expect(decision.effort).toBe(request.effort);
      expect(decision.changed).toBe(false);
    }
  });

  test("an unstated value is untouched and never written", () => {
    const none = decideHelperLimit({}, OPUS_MEDIUM, LADDERS);
    expect(none).toEqual({
      model: undefined,
      effort: undefined,
      loweredModel: false,
      loweredEffort: false,
      droppedEffort: false,
      changed: false,
    });
    const modelOnly = decideHelperLimit({ model: "fable" }, OPUS_MEDIUM, LADDERS);
    expect(modelOnly.model).toBe("opus");
    expect(modelOnly.effort).toBeUndefined();
    expect(modelOnly.loweredEffort).toBe(false);
    const effortOnly = decideHelperLimit({ effort: "high" }, OPUS_MEDIUM, LADDERS);
    expect(effortOnly.model).toBeUndefined();
    expect(effortOnly.effort).toBe("medium");
    expect(effortOnly.loweredModel).toBe(false);
  });

  test("an unrankable model is untouched while a rankable effort beside it is lowered", () => {
    const decision = decideHelperLimit({ model: "gpt-6", effort: "max" }, OPUS_MEDIUM, LADDERS);
    expect(decision.model).toBe("gpt-6");
    expect(decision.loweredModel).toBe(false);
    expect(decision.effort).toBe("medium");
    expect(decision.loweredEffort).toBe(true);
    expect(decision.changed).toBe(true);
  });

  test("an unrankable effort is untouched", () => {
    const decision = decideHelperLimit({ model: "opus", effort: "turbo" }, OPUS_MEDIUM, LADDERS);
    expect(decision.effort).toBe("turbo");
    expect(decision.changed).toBe(false);
  });

  test("a full model id above the limit is lowered to the limit's name", () => {
    for (const model of ["claude-fable-5-2", "fable[1m]"]) {
      const decision = decideHelperLimit({ model }, OPUS_MEDIUM, LADDERS);
      expect(decision.model).toBe("opus");
      expect(decision.loweredModel).toBe(true);
    }
    const within = decideHelperLimit({ model: "claude-opus-5-5" }, OPUS_MEDIUM, LADDERS);
    expect(within.model).toBe("claude-opus-5-5");
    expect(within.changed).toBe(false);
  });

  test("lowering onto an effortless family drops a stated effort and never writes one", () => {
    const limit = { max_model: "haiku", max_effort: "low" };
    const stated = decideHelperLimit({ model: "opus", effort: "high" }, limit, LADDERS);
    expect(stated).toEqual({
      model: "haiku",
      effort: undefined,
      loweredModel: true,
      loweredEffort: false,
      droppedEffort: true,
      changed: true,
    });
    const unstated = decideHelperLimit({ model: "opus" }, limit, LADDERS);
    expect(unstated.model).toBe("haiku");
    expect(unstated.effort).toBeUndefined();
    expect(unstated.droppedEffort).toBe(false);
  });

  test("a request that already pairs an effortless model with an effort is left alone", () => {
    const decision = decideHelperLimit({ model: "haiku", effort: "max" }, OPUS_MEDIUM, LADDERS);
    expect(decision.model).toBe("haiku");
    expect(decision.effort).toBe("max");
    expect(decision.changed).toBe(false);
  });

  test("a model-only limit leaves every effort alone", () => {
    const decision = decideHelperLimit(
      { model: "fable", effort: "max" },
      { max_model: "sonnet" },
      LADDERS,
    );
    expect(decision.model).toBe("sonnet");
    expect(decision.effort).toBe("max");
    expect(decision.loweredEffort).toBe(false);
  });

  test("an effort-only limit leaves every model alone", () => {
    const decision = decideHelperLimit(
      { model: "fable", effort: "max" },
      { max_effort: "high" },
      LADDERS,
    );
    expect(decision.model).toBe("fable");
    expect(decision.effort).toBe("high");
    expect(decision.loweredModel).toBe(false);
  });

  test("a null, undefined or empty limit changes nothing", () => {
    for (const limit of [null, undefined, {}]) {
      const decision = decideHelperLimit({ model: "fable", effort: "max" }, limit, LADDERS);
      expect(decision.model).toBe("fable");
      expect(decision.effort).toBe("max");
      expect(decision.changed).toBe(false);
    }
  });

  test("a limit the ladder cannot rank lowers nothing on that side", () => {
    const decision = decideHelperLimit(
      { model: "fable", effort: "max" },
      { max_model: "gpt-6", max_effort: "medium" },
      LADDERS,
    );
    expect(decision.model).toBe("fable");
    expect(decision.effort).toBe("medium");
  });
});

describe("isNoHelperLimit", () => {
  test("only an object with neither side is the explicit no-limit choice", () => {
    expect(isNoHelperLimit({})).toBe(true);
    expect(isNoHelperLimit({ max_model: "opus" })).toBe(false);
    expect(isNoHelperLimit({ max_effort: "low" })).toBe(false);
  });
});

describe("effectiveHelperLimit", () => {
  test("the person's empty object beats a project default", () => {
    expect(effectiveHelperLimit({ user: {}, projectDefault: OPUS_MEDIUM })).toEqual({
      limit: null,
      source: "user",
    });
  });

  test("the person's choice beats a stricter and a looser project default", () => {
    const user = { max_model: "sonnet" };
    expect(effectiveHelperLimit({ user, projectDefault: { max_model: "haiku" } })).toEqual({
      limit: user,
      source: "user",
    });
    expect(effectiveHelperLimit({ user, projectDefault: { max_model: "fable" } })).toEqual({
      limit: user,
      source: "user",
    });
  });

  test("the project default applies when the person made no choice", () => {
    expect(effectiveHelperLimit({ projectDefault: OPUS_MEDIUM })).toEqual({
      limit: OPUS_MEDIUM,
      source: "project",
    });
  });

  test("no choice and no usable project default means no limit", () => {
    expect(effectiveHelperLimit({})).toEqual({ limit: null, source: "none" });
    expect(effectiveHelperLimit({ projectDefault: null })).toEqual({ limit: null, source: "none" });
    expect(effectiveHelperLimit({ projectDefault: {} })).toEqual({ limit: null, source: "none" });
  });
});

describe("parseStoredHelperLimit", () => {
  test("keeps trimmed, lowercased string fields and ignores everything else", () => {
    expect(parseStoredHelperLimit({ max_model: " Opus ", max_effort: "MEDIUM", extra: 1 })).toEqual(
      OPUS_MEDIUM,
    );
    expect(parseStoredHelperLimit({ max_model: 3, max_effort: "" })).toEqual({});
    expect(parseStoredHelperLimit({ max_model: "   " })).toEqual({});
    expect(parseStoredHelperLimit({})).toEqual({});
  });

  test("returns null for anything that is not an object", () => {
    for (const value of [null, undefined, "opus", 4, true, ["opus"]]) {
      expect(parseStoredHelperLimit(value)).toBeNull();
    }
  });
});

describe("parseHelperLimitWords", () => {
  test("model and effort words are order-free and case-insensitive", () => {
    expect(parseHelperLimitWords(["opus", "medium"], LADDERS)).toEqual({
      ok: true,
      limit: OPUS_MEDIUM,
    });
    expect(parseHelperLimitWords(["Medium", " OPUS "], LADDERS)).toEqual({
      ok: true,
      limit: OPUS_MEDIUM,
    });
    expect(parseHelperLimitWords(["sonnet"], LADDERS)).toEqual({
      ok: true,
      limit: { max_model: "sonnet" },
    });
    expect(parseHelperLimitWords(["low"], LADDERS)).toEqual({
      ok: true,
      limit: { max_effort: "low" },
    });
  });

  test("none alone is the explicit no-limit choice", () => {
    expect(parseHelperLimitWords(["none"], LADDERS)).toEqual({ ok: true, limit: {} });
    expect(parseHelperLimitWords([" NONE "], LADDERS)).toEqual({ ok: true, limit: {} });
  });

  test("no words is an error", () => {
    expect(parseHelperLimitWords([], LADDERS)).toEqual({
      ok: false,
      error: "name a model, an effort, both, or none",
    });
    expect(parseHelperLimitWords(["  "], LADDERS).ok).toBe(false);
  });

  test("a second model or a second effort is an error, even a duplicate", () => {
    for (const words of [
      ["opus", "opus"],
      ["opus", "sonnet"],
      ["low", "high"],
    ]) {
      const result = parseHelperLimitWords(words, LADDERS);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe(
          `name at most one model and one effort; "${words[1]}" is a second one`,
        );
      }
    }
  });

  test("an unknown word names both ladders", () => {
    expect(parseHelperLimitWords(["opus", "turbo"], LADDERS)).toEqual({
      ok: false,
      error:
        '"turbo" is not a model or an effort; models: haiku, sonnet, opus, fable; efforts: low, medium, high, xhigh, max',
    });
  });

  test("a ladder with no models says so, and rejects a model word", () => {
    const effortOnly: HelperLadders = {
      models: [],
      efforts: ["low", "high"],
      effortlessModels: [],
    };
    expect(parseHelperLimitWords(["high"], effortOnly)).toEqual({
      ok: true,
      limit: { max_effort: "high" },
    });
    expect(parseHelperLimitWords(["opus"], effortOnly)).toEqual({
      ok: false,
      error: '"opus" is not a model or an effort; models: none for this tool; efforts: low, high',
    });
    const empty: HelperLadders = { models: [], efforts: [], effortlessModels: [] };
    const result = parseHelperLimitWords(["low"], empty);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("efforts: none for this tool");
  });
});

describe("formatHelperLimit", () => {
  test("names each side that is set", () => {
    expect(formatHelperLimit(OPUS_MEDIUM)).toBe("Opus at Medium effort");
    expect(formatHelperLimit({ max_model: "sonnet" })).toBe("Sonnet");
    expect(formatHelperLimit({ max_effort: "xhigh" })).toBe("Xhigh effort");
  });

  test("an absent or empty limit reads as no limit", () => {
    expect(formatHelperLimit(null)).toBe("no limit");
    expect(formatHelperLimit(undefined)).toBe("no limit");
    expect(formatHelperLimit({})).toBe("no limit");
  });
});

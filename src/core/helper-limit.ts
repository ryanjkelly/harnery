/**
 * Helper limit: the most expensive model and the highest reasoning effort a
 * helper agent (a subagent, or a `run` worker) may use. A person sets it once;
 * every enforcement point asks `decideHelperLimit()` what to send instead.
 *
 * The rules are deliberately one-directional. A stated value above the limit is
 * lowered to the limit. Anything else is left exactly as it was: a value at or
 * below the limit, a value the request does not state, and a value that cannot
 * be ranked. The decision never raises a helper and never writes a value it
 * would have to guess.
 *
 * This module is pure and imports nothing, so an adapter plugin can bundle it.
 */

/** The pair a person chooses. An absent side is unlimited; an empty object is
 * an explicit "no limit" (which still wins over a lower-precedence layer). */
export interface HelperLimit {
  max_model?: string;
  max_effort?: string;
}

/** Which layer supplied the limit in effect. */
export type HelperLimitSource = "user" | "project" | "none";

/** One adapter's rankings, cheapest and lowest first. */
export interface HelperLadders {
  models: readonly string[];
  efforts: readonly string[];
}

/** What one helper request states. Either side may be absent. */
export interface HelperRequest {
  model?: string;
  effort?: string;
}

export interface HelperDecision {
  /** The model to send: the request's own, or the limit when it was lowered. */
  model?: string;
  /** The effort to send: the request's own, or the limit when it was lowered. */
  effort?: string;
  loweredModel: boolean;
  loweredEffort: boolean;
  /** True when anything about the request changed. */
  changed: boolean;
}

export interface EffectiveHelperLimit {
  /** The limit in effect, or null when helpers are unlimited. */
  limit: HelperLimit | null;
  source: HelperLimitSource;
}

/** Adapter profile fields the ladders are read from. */
interface LadderProfile {
  effortValues: readonly string[];
  modelLadder?: readonly string[];
}

export function helperLadders(profile: LadderProfile): HelperLadders {
  return {
    models: profile.modelLadder ?? [],
    efforts: profile.effortValues,
  };
}

/**
 * The family of a model name on a ladder: the ladder entry that equals the
 * name, or the single entry that appears as a whole token inside a full id
 * (`claude-opus-5-5` → `opus`). Null when no entry, or more than one, matches.
 */
export function modelFamily(model: string, ladder: readonly string[]): string | null {
  const name = model.trim().toLowerCase();
  if (!name) return null;
  if (ladder.includes(name)) return name;
  const tokens = new Set(name.split(/[^a-z0-9]+/).filter(Boolean));
  const matches = ladder.filter((family) => tokens.has(family));
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

function rankOf(value: string | undefined, ladder: readonly string[]): number | null {
  if (value === undefined) return null;
  const index = ladder.indexOf(value.trim().toLowerCase());
  return index === -1 ? null : index;
}

function modelRank(model: string | undefined, ladder: readonly string[]): number | null {
  if (model === undefined) return null;
  const family = modelFamily(model, ladder);
  return family === null ? null : ladder.indexOf(family);
}

/** Lower one helper request to the limit. See the module comment for the rules. */
export function decideHelperLimit(
  request: HelperRequest,
  limit: HelperLimit | null | undefined,
  ladders: HelperLadders,
): HelperDecision {
  let model = request.model;
  let effort = request.effort;
  let loweredModel = false;
  let loweredEffort = false;

  const modelCap = modelRank(limit?.max_model, ladders.models);
  const modelHave = modelRank(model, ladders.models);
  if (limit?.max_model && modelCap !== null && modelHave !== null && modelHave > modelCap) {
    model = limit.max_model;
    loweredModel = true;
  }

  const effortCap = rankOf(limit?.max_effort, ladders.efforts);
  const effortHave = rankOf(effort, ladders.efforts);
  if (limit?.max_effort && effortCap !== null && effortHave !== null && effortHave > effortCap) {
    effort = limit.max_effort;
    loweredEffort = true;
  }

  return {
    model,
    effort,
    loweredModel,
    loweredEffort,
    changed: loweredModel || loweredEffort,
  };
}

/** True for the explicit "no limit" choice. */
export function isNoHelperLimit(limit: HelperLimit): boolean {
  return limit.max_model === undefined && limit.max_effort === undefined;
}

/**
 * Pick the limit in effect. The person's choice wins over the project's default
 * in both directions, because this is a cost preference and not a safety
 * control: `user` undefined means "no choice", and an empty object means "no
 * limit" even when the project sets one.
 */
export function effectiveHelperLimit(input: {
  user?: HelperLimit;
  projectDefault?: HelperLimit | null;
}): EffectiveHelperLimit {
  if (input.user !== undefined) {
    return { limit: isNoHelperLimit(input.user) ? null : input.user, source: "user" };
  }
  if (input.projectDefault && !isNoHelperLimit(input.projectDefault)) {
    return { limit: input.projectDefault, source: "project" };
  }
  return { limit: null, source: "none" };
}

/**
 * Read a stored limit. Returns null when the value is not an object; unknown
 * and non-string fields are ignored. Ranking is not checked here, because a
 * name the ladder does not know simply never lowers anything.
 */
export function parseStoredHelperLimit(value: unknown): HelperLimit | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const out: HelperLimit = {};
  if (typeof record.max_model === "string" && record.max_model.trim()) {
    out.max_model = record.max_model.trim().toLowerCase();
  }
  if (typeof record.max_effort === "string" && record.max_effort.trim()) {
    out.max_effort = record.max_effort.trim().toLowerCase();
  }
  return out;
}

export type HelperLimitWords = { ok: true; limit: HelperLimit } | { ok: false; error: string };

/**
 * Turn what a person typed (`opus medium`, `medium`, `sonnet`, `none`) into a
 * limit. Model words and effort words never overlap, so order does not matter.
 * The whole pair is replaced: a side not named is unlimited.
 */
export function parseHelperLimitWords(
  words: readonly string[],
  ladders: HelperLadders,
): HelperLimitWords {
  const cleaned = words.map((word) => word.trim().toLowerCase()).filter(Boolean);
  if (cleaned.length === 0) return { ok: false, error: "name a model, an effort, both, or none" };
  if (cleaned.length === 1 && cleaned[0] === "none") return { ok: true, limit: {} };
  const limit: HelperLimit = {};
  for (const word of cleaned) {
    const isModel = ladders.models.includes(word);
    const isEffort = ladders.efforts.includes(word);
    if (isModel && limit.max_model === undefined) limit.max_model = word;
    else if (isEffort && limit.max_effort === undefined) limit.max_effort = word;
    else if (isModel || isEffort) {
      return {
        ok: false,
        error: `name at most one model and one effort; "${word}" is a second one`,
      };
    } else {
      const models = ladders.models.length ? ladders.models.join(", ") : "none for this tool";
      const efforts = ladders.efforts.length ? ladders.efforts.join(", ") : "none for this tool";
      return {
        ok: false,
        error: `"${word}" is not a model or an effort; models: ${models}; efforts: ${efforts}`,
      };
    }
  }
  return { ok: true, limit };
}

function capitalize(word: string): string {
  return word ? word.charAt(0).toUpperCase() + word.slice(1) : word;
}

/** "Opus at Medium effort", "Opus", "Medium effort", or "no limit". */
export function formatHelperLimit(limit: HelperLimit | null | undefined): string {
  if (!limit || isNoHelperLimit(limit)) return "no limit";
  const model = limit.max_model ? capitalize(limit.max_model) : null;
  const effort = limit.max_effort ? `${capitalize(limit.max_effort)} effort` : null;
  if (model && effort) return `${model} at ${effort}`;
  return model ?? effort ?? "no limit";
}

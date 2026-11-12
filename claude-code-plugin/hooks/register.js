// Harnery helper limit for Claude Code.
//
// Lowers each helper agent's model request to the person's helper limit, and
// records one usage line per helper turn. The main conversation is never
// touched, and neither are forks or teammates. Every hook fails open: when
// anything here goes wrong, the event goes on unchanged.
//
// A hooks module may import only relative paths, so the decision function and
// the rankings come from ./generated/harnery.js, generated from Harnery's own
// source by scripts/build-claude-code-plugin.ts.
import {
  CLAUDE_CODE_LADDERS,
  decideHelperLimit,
  effectiveHelperLimit,
  MIN_CLAUDE_VERSION,
  parseStoredHelperLimit,
  stripJsonComments,
} from "./generated/harnery.js";

const TOOL = "claude-code";
/** How long a read limit is trusted before the files are read again. */
export const LIMIT_TTL_MS = 3000;

/** Compare dotted release versions; null when either does not parse. */
export function compareVersions(a, b) {
  const pa = /^(\d+)\.(\d+)\.(\d+)/.exec(String(a ?? "").trim());
  const pb = /^(\d+)\.(\d+)\.(\d+)/.exec(String(b ?? "").trim());
  if (!pa || !pb) return null;
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** A session id made safe for a file name. */
export function writerName(sessionId) {
  const clean = String(sessionId ?? "")
    .replace(/[^A-Za-z0-9_-]/g, "_")
    .slice(0, 120);
  return clean || "session";
}

function trimSlash(path) {
  return path.length > 1 ? path.replace(/[\\/]+$/, "") : path;
}

/**
 * The user config and cache folders, resolved the way Harnery's installer and
 * preferences writer do: the XDG variables when set, otherwise `.config` and
 * `.cache` in the home folder. The home folder is `HOME`, or `USERPROFILE` on
 * Windows, where `HOME` is usually unset. Null parts when none is known.
 */
export function userFolders(env) {
  const home = nonEmpty(env.HOME) ?? nonEmpty(env.USERPROFILE);
  const join = (base, name) => {
    const trimmed = trimSlash(base);
    const sep = !trimmed.includes("/") && trimmed.includes("\\") ? "\\" : "/";
    return `${trimmed}${sep}${name}`;
  };
  const configBase = nonEmpty(env.XDG_CONFIG_HOME) ?? (home ? join(home, ".config") : null);
  const cacheBase = nonEmpty(env.XDG_CACHE_HOME) ?? (home ? join(home, ".cache") : null);
  return {
    configBase: configBase ? trimSlash(configBase) : null,
    cacheBase: cacheBase ? trimSlash(cacheBase) : null,
  };
}

function parentDir(path) {
  const trimmed = trimSlash(path);
  const index = trimmed.lastIndexOf("/");
  if (index <= 0) return index === 0 && trimmed !== "/" ? "/" : null;
  return trimmed.slice(0, index);
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function plainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function tokenCount(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Module state. One hooks module serves one session. */
const state = {
  /** null = not checked yet; then { enabled, configBase, cacheBase, cwd, sessionId }. */
  setup: null,
  setupPromise: null,
  /** { limit, readAt } */
  limit: null,
  limitPromise: null,
  /** agentId -> { type, skip } from agent.spawn. */
  helpers: new Map(),
  /** agentId -> the current turn's accumulating record. */
  turns: new Map(),
  /** UTC day -> lines written by this session that day. */
  days: new Map(),
  writes: Promise.resolve(),
};

/** Reset module state (tests). */
export function resetHelperLimitState() {
  state.setup = null;
  state.setupPromise = null;
  state.limit = null;
  state.limitPromise = null;
  state.helpers.clear();
  state.turns.clear();
  state.days.clear();
  state.writes = Promise.resolve();
}

async function readSetup($) {
  const skip = await $.env.get("HARNERY_HELPER_LIMIT_SKIP");
  if (skip === "1") return { enabled: false };
  const version = await $.session.version();
  const release = version?.base ?? version?.version;
  const cmp = compareVersions(release, MIN_CLAUDE_VERSION);
  if (cmp === null || cmp < 0) return { enabled: false };
  const folders = userFolders({
    HOME: await $.env.get("HOME"),
    USERPROFILE: await $.env.get("USERPROFILE"),
    XDG_CONFIG_HOME: await $.env.get("XDG_CONFIG_HOME"),
    XDG_CACHE_HOME: await $.env.get("XDG_CACHE_HOME"),
  });
  const { configBase, cacheBase } = folders;
  if (!configBase || !cacheBase) return { enabled: false };
  let cwd = null;
  try {
    cwd = await $.session.cwd();
  } catch {
    cwd = null;
  }
  let sessionId = null;
  try {
    sessionId = await $.session.id();
  } catch {
    sessionId = null;
  }
  return {
    enabled: true,
    configBase: trimSlash(configBase),
    cacheBase: trimSlash(cacheBase),
    cwd: nonEmpty(cwd) ? trimSlash(cwd) : null,
    sessionId: nonEmpty(sessionId) ?? null,
  };
}

/** Once per module: the version, the skip switch, the folders. Never throws. */
async function setupOf($) {
  if (state.setup) return state.setup;
  if (!state.setupPromise) {
    state.setupPromise = readSetup($)
      .catch(() => ({ enabled: false }))
      .then((setup) => {
        state.setup = setup;
        return setup;
      });
  }
  return state.setupPromise;
}

/**
 * Read a JSON file. `{ kind: "absent" }` when it does not exist, `{ kind: "ok",
 * value }` when it reads and parses to an object, and `{ kind: "error" }` for
 * anything else: unreadable, unparsable, or not an object.
 */
async function readJsonObject($, path, jsonc) {
  try {
    if (!(await $.fs.exists(path))) return { kind: "absent" };
    const text = await $.fs.read(path);
    if (typeof text !== "string") return { kind: "error" };
    const value = JSON.parse(jsonc ? stripJsonComments(text) : text);
    return plainObject(value) ? { kind: "ok", value } : { kind: "error" };
  } catch {
    return { kind: "error" };
  }
}

/** Thrown when a limit file cannot be read: the request then goes on unchanged. */
class LimitUnreadable extends Error {}

/** The person's own choice; undefined when they made none. Throws on error. */
async function readUserLimit($, setup) {
  const prefs = await readJsonObject($, `${setup.configBase}/harnery/preferences.json`, false);
  if (prefs.kind === "absent") return undefined;
  if (prefs.kind === "error") throw new LimitUnreadable("preferences");
  const helpers = prefs.value.helpers;
  if (helpers === undefined) return undefined;
  if (!plainObject(helpers)) throw new LimitUnreadable("preferences");
  if (helpers[TOOL] === undefined) return undefined;
  const parsed = parseStoredHelperLimit(helpers[TOOL]);
  if (parsed === null) throw new LimitUnreadable("preferences");
  return parsed;
}

/** The nearest project's default; null when there is none or it cannot be read. */
async function readProjectDefault($, setup) {
  let dir = setup.cwd;
  for (let depth = 0; dir && depth < 64; depth++) {
    const path = `${dir === "/" ? "" : dir}/.harnery/config.jsonc`;
    let found = false;
    try {
      found = await $.fs.exists(path);
    } catch {
      return null;
    }
    if (found) {
      const config = await readJsonObject($, path, true);
      if (config.kind !== "ok" || !plainObject(config.value.helpers)) return null;
      return parseStoredHelperLimit(config.value.helpers[TOOL]);
    }
    dir = parentDir(dir);
  }
  return null;
}

async function readLimit($, setup) {
  const user = await readUserLimit($, setup);
  const projectDefault = user === undefined ? await readProjectDefault($, setup) : null;
  return effectiveHelperLimit({ user, projectDefault }).limit;
}

/**
 * The limit in effect, re-read at most every LIMIT_TTL_MS. Null = no limit.
 * Rejects when the person's preferences cannot be read.
 */
async function limitOf($, setup) {
  const now = Date.now();
  if (state.limit && now - state.limit.readAt < LIMIT_TTL_MS) return state.limit.limit;
  if (!state.limitPromise) {
    state.limitPromise = readLimit($, setup).then(
      (limit) => {
        state.limit = { limit, readAt: Date.now() };
        state.limitPromise = null;
        return limit;
      },
      (err) => {
        // Forget any earlier read and let the caller forward the request.
        state.limit = null;
        state.limitPromise = null;
        throw err;
      },
    );
  }
  return state.limitPromise;
}

/** Work out what to send for one helper request. Throws on any failure. */
async function planStep($, e) {
  const known = state.helpers.get(e.agentId);
  if (known?.skip) return null;
  const setup = await setupOf($);
  if (!setup.enabled) return null;
  const limit = await limitOf($, setup);
  let turn = state.turns.get(e.agentId);
  if (!turn) {
    turn = {
      agentId: e.agentId,
      agentType: known?.type,
      askedModel: nonEmpty(e.model),
      askedEffort: nonEmpty(e.effort),
      lowered: false,
    };
    state.turns.set(e.agentId, turn);
  }
  let sent = e;
  if (limit) {
    const decision = decideHelperLimit(
      { model: e.model, effort: e.effort },
      limit,
      CLAUDE_CODE_LADDERS,
    );
    if (decision.changed) {
      sent = { ...e, model: decision.model ?? e.model, effort: decision.effort ?? e.effort };
      turn.lowered = true;
    }
  }
  turn.sentModel = nonEmpty(sent.model);
  turn.sentEffort = nonEmpty(sent.effort);
  return { sent, turn };
}

function noteUsage(turn, usage) {
  if (!plainObject(usage)) return;
  if (nonEmpty(usage.model)) turn.answeredModel = usage.model;
  const input = tokenCount(usage.input_tokens);
  const output = tokenCount(usage.output_tokens);
  if (input !== undefined) turn.stepInput = (turn.stepInput ?? 0) + input;
  if (output !== undefined) turn.stepOutput = (turn.stepOutput ?? 0) + output;
}

/** One usage line for a finished helper turn. */
export function usageLine(turn, setup, usage, ts) {
  const line = { ts, tool: TOOL, kind: "helper" };
  if (setup.sessionId) line.session_id = setup.sessionId;
  line.agent_id = turn.agentId;
  if (turn.agentType) line.agent_type = turn.agentType;
  if (turn.askedModel) line.asked_model = turn.askedModel;
  if (turn.askedEffort) line.asked_effort = turn.askedEffort;
  if (turn.sentModel) line.sent_model = turn.sentModel;
  if (turn.sentEffort) line.sent_effort = turn.sentEffort;
  const answered = plainObject(usage) && nonEmpty(usage.model) ? usage.model : turn.answeredModel;
  if (answered) line.answered_model = answered;
  const input = plainObject(usage) ? tokenCount(usage.input_tokens) : undefined;
  const output = plainObject(usage) ? tokenCount(usage.output_tokens) : undefined;
  const inputTokens = input ?? turn.stepInput;
  const outputTokens = output ?? turn.stepOutput;
  if (inputTokens !== undefined) line.input_tokens = inputTokens;
  if (outputTokens !== undefined) line.output_tokens = outputTokens;
  line.lowered = turn.lowered === true;
  return line;
}

/** Rewrite this session's file for the line's UTC day. Serialized; never rejects. */
function recordLine($, setup, line) {
  const day = line.ts.slice(0, 10);
  const path = `${setup.cacheBase}/harnery/helpers/usage-${day}.${writerName(setup.sessionId)}.jsonl`;
  state.writes = state.writes
    .then(async () => {
      let lines = state.days.get(day);
      if (!lines) {
        lines = [];
        // A reloaded module keeps what this session already wrote today.
        try {
          if (await $.fs.exists(path)) {
            const prior = await $.fs.read(path);
            if (typeof prior === "string") {
              for (const raw of prior.split("\n")) if (raw.trim()) lines.push(raw.trim());
            }
          }
        } catch {
          // Start fresh.
        }
        for (const other of [...state.days.keys()]) if (other !== day) state.days.delete(other);
        state.days.set(day, lines);
      }
      lines.push(JSON.stringify(line));
      await $.fs.write(path, `${lines.join("\n")}\n`);
    })
    .catch(() => {});
  return state.writes;
}

export function register(on) {
  on("agent.spawn", async (_$, e, next) => {
    const result = await next(e);
    try {
      const agentId = result?.agentId ?? e?.resume?.agentId;
      if (typeof agentId === "string" && agentId) {
        const prior = state.helpers.get(agentId);
        const skip = e.fork === true || e.isTeammate === true || e.subagentType === "fork";
        state.helpers.set(agentId, {
          type: nonEmpty(e.subagentType) ?? prior?.type,
          skip: skip || prior?.skip === true,
        });
      }
    } catch {
      // Remembering is best effort.
    }
    return result;
  });

  on("turn.step", async function* ($, e, next) {
    // The main conversation's requests carry no agentId and are never touched.
    if (!e?.agentId) return yield* next(e);
    let plan = null;
    try {
      plan = await planStep($, e);
    } catch {
      plan = null;
    }
    const result = yield* next(plan ? plan.sent : e);
    try {
      if (plan) noteUsage(plan.turn, result?.usage);
    } catch {
      // Never let recording affect a request.
    }
    return result;
  });

  on("turn.complete", async ($, e, next) => {
    const result = await next(e);
    try {
      const agentId = e?.agentId;
      if (typeof agentId === "string" && agentId) {
        const turn = state.turns.get(agentId);
        state.turns.delete(agentId);
        if (turn && !state.helpers.get(agentId)?.skip) {
          const setup = await setupOf($);
          if (setup.enabled) {
            await recordLine($, setup, usageLine(turn, setup, e.usage, new Date().toISOString()));
          }
        }
      }
    } catch {
      // Recording is best effort.
    }
    return result;
  });
}

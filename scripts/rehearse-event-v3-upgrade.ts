#!/usr/bin/env bun
/**
 * Event Ledger V3 upgrade rehearsal.
 *
 * Proves how a PUBLISHED Harnery release behaves against a ledger that a
 * CANDIDATE build wrote, and the reverse. Both builds run as shipped: the
 * baseline is `npm pack harnery@<version>` (cached per version), the candidate
 * is `bun run build` + `npm pack` of a checkout, and each is installed with
 * its dependencies into its own throwaway prefix. Their `harn` and
 * `agent-hook` bins, resolved through the installed package's `bin` field,
 * run with Node as an install would run them.
 *
 * Every case runs in its own temporary coordination root. Each step records
 * both builds' `ledger-v3 status`, the archive folder count, the genesis id
 * and the active file's size and sha256 before and after, so "appended
 * nothing" and "replaced nothing" are measured facts. Expectations are data
 * (CASES below): `must` cases fail the run, `record` cases only report.
 *
 *   bun scripts/rehearse-event-v3-upgrade.ts [--candidate <checkout>]
 *     [--baseline 0.53.1] [--case <name>] [--json] [--keep]
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";

export type BuildName = "baseline" | "candidate";
const ACTIONS = [
  "init",
  "hook",
  "command",
  "initialize",
  "delete-witness",
  "stage-late-rows",
] as const;
export type Action = (typeof ACTIONS)[number];

export interface Step {
  label: string;
  build?: BuildName;
  action: Action;
  event?: string; // hook event for `hook` steps
  rotate?: boolean; // set the rotation threshold to the active size, so this step rotates once
  from?: string[]; // `stage-late-rows`: steps whose last appended row is staged
}

/** `fenced` checks describe a baseline meeting a newer epoch; see `sameEpochContract`. */
type StepCheck = "appended" | "unchanged" | "genesis_changed" | "staged_absent";
export type Check = { fenced?: boolean } & (
  | { type: StepCheck; step: string }
  | { type: "archives"; from: string; to: string; equals: number }
  | { type: "genesis_same"; from: string; to: string }
  | { type: "status_in" | "status_not_in"; step: string; build: BuildName; states: string[] }
  | { type: "capability_digests_equal" }
);

export interface CaseDef {
  name: string;
  kind: "must" | "record";
  simulation?: string;
  steps: Step[];
  checks: Check[];
}

export interface FileFacts {
  active_bytes: number;
  active_sha256: string | null;
  prefix_sha256?: string | null; // sha256 of the bytes the prior measurement covered
  archives: number;
  genesis_id: string | null;
  spool_files: string[];
}

export type StatusFacts = { state: string; reason?: string; manifest_version?: number };

export interface StepRecord {
  label: string;
  build?: BuildName;
  action: Action;
  exit: number | null;
  stderr_tail?: string;
  before: FileFacts;
  after: FileFacts;
  status: Partial<Record<BuildName, StatusFacts>>;
  staged?: Record<string, string>; // staged late row -> `active`, a spool suffix, or `absent`
  note?: string;
}

export interface Fingerprint {
  version: string;
  manifest_version: number | null;
  schema_digest: string | null;
  capability_digests: string[];
}

export type Verdict = "pass" | "fail" | "vacuous";
export type CheckResult = { check: Check; verdict: Verdict; detail: string };

const BUILDS: BuildName[] = ["baseline", "candidate"];
const LEDGER = [".harnery", "ledgers", "v3"];
const ARCHIVES = [".harnery", "ledgers", "v3-archives"];
/** The control witness and the validation checkpoint it owns. */
const WITNESS_FILES = ["control-state-witness.json", "control-state-validation.json"];
const SESSION: Record<BuildName, string> = {
  baseline: "0b5e11e0-0000-4000-8000-000000000001",
  candidate: "0ca7d1da-0000-4000-8000-000000000002",
};

// ── case data ────────────────────────────────────────────────────────────────

/**
 * Step spec: `<label> <action> [hook event] [rotate] [from=<label>,...]`.
 * A `b-` label runs the baseline build, a `c-` label the candidate.
 */
export function parseStep(spec: string): Step {
  const [label, action, ...rest] = spec.trim().split(/\s+/);
  const known = (ACTIONS as readonly string[]).includes(action ?? "");
  if (!label || !action || !known) throw new Error(`bad step: ${spec}`);
  const step: Step = { label, action: action as Action };
  if (/^[bc]-/.test(label)) step.build = label.startsWith("b-") ? "baseline" : "candidate";
  for (const token of rest) {
    if (token === "rotate") step.rotate = true;
    else if (token.startsWith("from=")) step.from = token.slice(5).split(",");
    else step.event = token;
  }
  const runsBuild = ["init", "hook", "command", "initialize"].includes(action);
  if (runsBuild !== (step.build !== undefined) || (action === "hook") !== !!step.event) {
    throw new Error(`bad step: ${spec}`);
  }
  return step;
}

/**
 * Check spec, optionally ending in `fenced`:
 *   appended|unchanged|genesis-changed|staged-absent <step>
 *   archives <from>..<to> = <n>          (folders added from before <from> to after <to>)
 *   genesis-same <from>..<to>
 *   status <build>@<step> in|not-in <state,...>
 *   capability-digests-equal
 */
export function parseCheck(spec: string): Check {
  const words = spec.trim().split(/\s+/);
  const fenced = words.at(-1) === "fenced";
  if (fenced) words.pop();
  const [kind, target = "", op, value = ""] = words;
  const [from = "", to = ""] = target.split("..");
  const flag = fenced ? { fenced } : {};
  switch (kind) {
    case "appended":
    case "unchanged":
    case "genesis-changed":
    case "staged-absent":
      return { type: kind.replace("-", "_") as StepCheck, step: target, ...flag };
    case "archives":
      if (op !== "=" || !to || !/^\d+$/.test(value)) break;
      return { type: "archives", from, to, equals: Number(value), ...flag };
    case "genesis-same":
      if (!to) break;
      return { type: "genesis_same", from, to, ...flag };
    case "status": {
      const [build, step = ""] = target.split("@");
      if (!BUILDS.includes(build as BuildName) || (op !== "in" && op !== "not-in")) break;
      const type = op === "in" ? "status_in" : "status_not_in";
      return { type, build: build as BuildName, step, states: value.split(","), ...flag };
    }
    case "capability-digests-equal":
      return { type: "capability_digests_equal", ...flag };
  }
  throw new Error(`bad check: ${spec}`);
}

/** A case from `;`-separated step and check specs. */
const define = (name: string, kind: CaseDef["kind"], steps: string, checks: string): CaseDef => {
  const split = (text: string) => text.split(";").filter((part) => part.trim());
  return { name, kind, steps: split(steps).map(parseStep), checks: split(checks).map(parseCheck) };
};

const START = "hook session-start";
const PROMPT = "hook user-prompt-submit";
/** The baseline appended nothing, archived nothing, and reports a state that does not serve. */
const fenced = (...labels: string[]): string =>
  labels.map((label) => `unchanged ${label} fenced;`).join("") +
  `archives ${labels[0]}..${labels.at(-1)} = 0 fenced;` +
  `status baseline@${labels.at(-1)} not-in active,candidate fenced`;
const writtenEpoch = (wipe: string): string =>
  `b-init init; b-start ${START}; c-start ${START}; c-cmd command; ${wipe.replace("N", "1")};` +
  `b-prompt ${PROMPT}; ${wipe.replace("N", "2")}; b-cmd command`;
const alternation = Array.from(
  { length: 10 },
  (_, i) => `b-${i + 1} ${PROMPT}; c-${i + 1} ${PROMPT}`,
);

export const CASES: CaseDef[] = [
  define(
    "candidate-serves-baseline-epoch",
    "must",
    `b-init init; b-start ${START}; b-cmd command; c-start ${START}; c-prompt ${PROMPT}; c-cmd command`,
    "genesis-same b-init..c-cmd; archives c-start..c-cmd = 0; appended c-start;" +
      "appended c-prompt; appended c-cmd; status candidate@c-cmd in active",
  ),
  define(
    "baseline-meets-written-epoch-witness",
    "must",
    writtenEpoch(""),
    `appended c-cmd; ${fenced("b-prompt", "b-cmd")}`,
  ),
  define(
    "baseline-meets-written-epoch-full-read",
    "must",
    writtenEpoch("wipe-N delete-witness"),
    `appended c-cmd; ${fenced("b-prompt", "b-cmd")}`,
  ),
  define(
    "baseline-meets-candidate-epoch",
    "must",
    `c-init init; c-start ${START}; c-cmd command; b-start ${START}; b-cmd command;` +
      `b-rotate ${PROMPT} rotate`,
    fenced("b-start", "b-cmd", "b-rotate"),
  ),
  define(
    "rotation-with-both",
    "must",
    `b-init init; b-start ${START}; c-start ${START}; b-prompt ${PROMPT}; c-prompt ${PROMPT};` +
      `c-rotate ${PROMPT} rotate; b-after ${PROMPT}; c-after ${PROMPT}`,
    "archives b-start..c-prompt = 0; archives c-rotate..c-after = 1; genesis-changed c-rotate;" +
      `appended c-after; ${fenced("b-after")}`,
  ),
  define(
    "alternation",
    "must",
    `b-init init; b-start ${START}; c-start ${START}; ${alternation.join("; ")}`,
    "archives b-1..c-10 = 0; genesis-same c-start..c-10",
  ),
  define(
    "baseline-explicit-init",
    "record",
    `c-init init; c-start ${START}; b-init init`,
    "unchanged b-init",
  ),
  define(
    "baseline-explicit-initialize",
    "record",
    `c-init init; c-start ${START}; b-initialize initialize`,
    "unchanged b-initialize",
  ),
  {
    ...define(
      "baseline-late-writer",
      "record",
      `b-init init; b-start ${START}; b-cmd command; c-start ${START}; c-rotate ${PROMPT} rotate;` +
        `stage stage-late-rows from=b-start,b-cmd; c-drain ${PROMPT}`,
      "staged-absent c-drain",
    ),
    simulation:
      "A baseline process cannot be paused between its control read and its write without " +
      "modifying the package. Instead, the last row each listed baseline step appended in the " +
      "old epoch is staged into the spool after the candidate rotates to a new epoch (the first " +
      "tagged with the old genesis id, the second untagged), then a candidate hook drains it.",
  },
  define("capability-digests-equal", "must", "", "capability-digests-equal"),
];

// ── pure parts ───────────────────────────────────────────────────────────────

export type Options = {
  candidate: string;
  baseline: string;
  caseName?: string;
  json: boolean;
  keep: boolean;
};

export function parseArgs(argv: string[], defaultCandidate: string): Options {
  const options: Options = {
    candidate: defaultCandidate,
    baseline: "0.53.1",
    json: false,
    keep: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const value = (): string => {
      const next = argv[++i];
      if (next === undefined || next.startsWith("--")) throw new Error(`${arg} needs a value`);
      return next;
    };
    if (arg === "--candidate") options.candidate = resolve(value());
    else if (arg === "--baseline") options.baseline = value();
    else if (arg === "--case") options.caseName = value();
    else if (arg === "--json") options.json = true;
    else if (arg === "--keep") options.keep = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (options.caseName && !CASES.some((entry) => entry.name === options.caseName)) {
    throw new Error(`unknown case: ${options.caseName}`);
  }
  return options;
}

/** Equal epoch contracts mean no fence can be observed, so a failed `fenced` check is vacuous. */
export function sameEpochContract(a: Fingerprint, z: Fingerprint): boolean {
  return a.manifest_version === z.manifest_version && a.schema_digest === z.schema_digest;
}

export function evaluateCheck(
  check: Check,
  records: StepRecord[],
  prints: Record<BuildName, Fingerprint>,
): CheckResult {
  const find = (label: string): StepRecord => {
    const record = records.find((step) => step.label === label);
    if (!record) throw new Error(`check refers to unknown step ${label}`);
    return record;
  };
  const result = (ok: boolean, detail: string): CheckResult => {
    if (!ok && check.fenced && sameEpochContract(prints.baseline, prints.candidate)) {
      return {
        check,
        verdict: "vacuous",
        detail: `${detail}; candidate epoch contract = baseline`,
      };
    }
    return { check, verdict: ok ? "pass" : "fail", detail };
  };
  switch (check.type) {
    case "appended": {
      const s = find(check.step);
      const grew = s.after.active_bytes - s.before.active_bytes;
      const kept = s.after.prefix_sha256 === s.before.active_sha256;
      return result(
        grew > 0 && kept,
        `${s.label}: +${grew} bytes, prefix ${kept ? "kept" : "replaced"}`,
      );
    }
    case "unchanged": {
      const { before, after, label } = find(check.step);
      const delta = after.active_bytes - before.active_bytes;
      const same =
        after.active_sha256 === before.active_sha256 && after.archives === before.archives;
      const bytes = `${delta >= 0 ? "+" : ""}${delta} bytes`;
      return result(same, `${label}: ${bytes}, archives ${before.archives}->${after.archives}`);
    }
    case "archives": {
      const delta = find(check.to).after.archives - find(check.from).before.archives;
      return result(delta === check.equals, `archives ${check.from}..${check.to}: +${delta}`);
    }
    case "genesis_same": {
      const from = find(check.from).after.genesis_id;
      const to = find(check.to).after.genesis_id;
      return result(from !== null && from === to, `genesis ${from} -> ${to}`);
    }
    case "genesis_changed": {
      const { before, after } = find(check.step);
      const changed = after.genesis_id !== null && after.genesis_id !== before.genesis_id;
      return result(changed, `genesis ${before.genesis_id} -> ${after.genesis_id}`);
    }
    case "status_in":
    case "status_not_in": {
      const status = find(check.step).status[check.build];
      const state = status?.state ?? "missing";
      const member = check.states.includes(state);
      const reason = status?.reason ? ` (${status.reason})` : "";
      const detail = `${check.build} status after ${check.step}: ${state}${reason}`;
      return result(check.type === "status_in" ? member : !member, detail);
    }
    case "staged_absent": {
      const staged = Object.entries(find(check.step).staged ?? {});
      const detail = staged.map(([id, at]) => `${id} -> ${at}`).join("; ") || "nothing staged";
      return result(staged.length > 0 && !staged.some(([, at]) => at.includes("active")), detail);
    }
    case "capability_digests_equal": {
      const a = prints.baseline.capability_digests;
      const z = prints.candidate.capability_digests;
      const equal = a.length > 0 && a.length === z.length && a.every((d, i) => d === z[i]);
      return result(equal, `baseline ${a.length} digests, candidate ${z.length}, equal=${equal}`);
    }
  }
}

export const sha256 = (bytes: Buffer): string =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

/** Measure the ledger's files. `prefixOf` hashes that many leading bytes for the append proof. */
export function measureRoot(root: string, prefixOf?: number): FileFacts {
  const ledger = join(root, ...LEDGER);
  const activePath = join(ledger, "active.ndjson");
  const active = fs.existsSync(activePath) ? fs.readFileSync(activePath) : null;
  const archives = join(root, ...ARCHIVES);
  const spool = join(ledger, "spool");
  const facts: FileFacts = {
    active_bytes: active?.length ?? 0,
    active_sha256: active ? sha256(active) : null,
    archives: fs.existsSync(archives)
      ? fs.readdirSync(archives, { withFileTypes: true }).filter((e) => e.isDirectory()).length
      : 0,
    genesis_id: genesisIdOf(join(ledger, "genesis.json")),
    spool_files: fs.existsSync(spool) ? fs.readdirSync(spool).sort() : [],
  };
  if (prefixOf !== undefined) {
    const covered = active && active.length >= prefixOf;
    facts.prefix_sha256 = covered ? sha256(active.subarray(0, prefixOf)) : null;
  }
  return facts;
}

export function genesisIdOf(path: string): string | null {
  try {
    return JSON.parse(fs.readFileSync(path, "utf8"))?.event?.payload?.genesis_id ?? null;
  } catch {
    return null;
  }
}

export function parseStatus(output: string, exit: number | null): StatusFacts {
  try {
    const data = JSON.parse(output.trim().split("\n").pop() ?? "");
    if (typeof data?.state === "string") {
      const reason = typeof data.reason === "string" ? { reason: data.reason } : {};
      return { state: data.state, ...reason, manifest_version: data.genesis?.manifest_version };
    }
    const code = data?.error?.code ?? data?.code ?? "unknown";
    return { state: `error:${code}`, reason: data?.error?.message ?? data?.message };
  } catch {
    return { state: `error:exit-${exit}`, reason: output.slice(0, 200) };
  }
}

/** Where each staged event id is now: the active file, and any spool file naming it. */
export function stagedFate(ids: string[], active: string, spool: string[]): Record<string, string> {
  const fate: Record<string, string> = {};
  for (const id of ids) {
    const places = active.includes(`"event_id":"${id}"`) ? ["active"] : [];
    for (const name of spool.filter((file) => file.includes(id))) {
      places.push(`spool${name.slice(name.lastIndexOf("."))}`);
    }
    fate[id] = places.join(", ") || "absent";
  }
  return fate;
}

// ── provisioning (network, packing, install) ─────────────────────────────────

type Installed = { version: string; bins: Record<string, string> };
const win = process.platform === "win32";

function findOnPath(name: string): string | null {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    const path = join(dir, win ? `${name}.exe` : name);
    if (dir && fs.existsSync(path)) return path;
  }
  return null;
}

const nodeBin = process.versions.bun ? findOnPath("node") : process.execPath;
const bunBin = process.versions.bun ? process.execPath : findOnPath("bun");

function exec(command: string, args: string[], cwd: string): string {
  const options = { cwd, encoding: "utf8" as const, windowsHide: true, maxBuffer: 64 << 20 };
  const run = spawnSync(command, args, options);
  if (run.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed (${run.status}): ${run.stderr || run.error}`,
    );
  }
  return run.stdout;
}

/** Run npm through its JS entry beside Node, so Windows needs no `.cmd` shim or shell. */
function npm(args: string[], cwd: string): string {
  if (!nodeBin) throw new Error("node is required on PATH");
  const cli = [
    process.env.npm_execpath ?? "",
    join(dirname(nodeBin), "node_modules", "npm", "bin", "npm-cli.js"),
    join(dirname(nodeBin), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ].find((path) => path.endsWith("npm-cli.js") && fs.existsSync(path));
  if (!cli) throw new Error(`cannot locate npm-cli.js next to ${nodeBin}`);
  const name = exec(nodeBin, [cli, ...args], cwd).trim();
  return name.split(/\r?\n/).pop() ?? "";
}

function packed(dir: string, name: string): string {
  if (!name.endsWith(".tgz")) throw new Error(`npm pack printed no tarball name: ${name}`);
  return join(dir, name);
}

function baselineTarball(version: string): string {
  const base = process.env.XDG_CACHE_HOME || (win && process.env.LOCALAPPDATA) || "";
  const dir = join(base || join(homedir(), ".cache"), "harnery", "rehearsal", version);
  const tarball = join(dir, `harnery-${version}.tgz`);
  if (fs.existsSync(tarball)) return tarball;
  fs.mkdirSync(dir, { recursive: true });
  return packed(dir, npm(["pack", `harnery@${version}`, "--silent"], dir));
}

function candidateTarball(checkout: string, out: string): string {
  if (!bunBin) throw new Error("bun is required to build the candidate");
  exec(bunBin, ["run", "build"], checkout);
  return packed(out, npm(["pack", "--pack-destination", out, "--silent"], checkout));
}

function install(tarball: string, prefix: string): Installed {
  fs.mkdirSync(prefix, { recursive: true });
  fs.writeFileSync(join(prefix, "package.json"), '{"name":"rehearsal","private":true}\n');
  const flags = ["--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock"];
  npm(["install", tarball, ...flags], prefix);
  const dir = join(prefix, "node_modules", "harnery");
  const pkg = JSON.parse(fs.readFileSync(join(dir, "package.json"), "utf8"));
  const bins = Object.entries(pkg.bin as Record<string, string>);
  return {
    version: pkg.version,
    bins: Object.fromEntries(bins.map(([n, p]) => [n, join(dir, p)])),
  };
}

// ── running a case ───────────────────────────────────────────────────────────

/** The caller's own agent and coordination identity never reaches a case's processes. */
const SCRUB = /^(HARN|CLAUDE|CODEX|CURSOR|OPENCODE)/i;
type Run = { exit: number | null; stdout: string; stderr: string };

function runBin(
  build: Installed,
  bin: string,
  args: string[],
  root: string,
  extra = {},
  input?: string,
): Run {
  const script = build.bins[bin];
  if (!script || !nodeBin) throw new Error(`missing ${bin} bin or node`);
  const home = join(root, "..", "home");
  const env: NodeJS.ProcessEnv = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !SCRUB.test(key))),
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    HARNERY_COORD_ROOT_OVERRIDE: root,
    HARN_COORD_ROOT: root,
    ...extra,
  };
  const options = { cwd: root, env, input, encoding: "utf8" as const, timeout: 120_000 };
  const run = spawnSync(nodeBin, [script, ...args], { ...options, windowsHide: true });
  return {
    exit: run.status,
    stdout: run.stdout ?? "",
    stderr: run.stderr || String(run.error ?? ""),
  };
}

function runAction(step: Step, build: Installed, root: string, env: Record<string, string>): Run {
  const session = SESSION[step.build!];
  const harn = (args: string[], extra = env) => runBin(build, "harn", args, root, extra);
  switch (step.action) {
    case "init":
      return harn(["init", "--project-root", root, "--adapter", "claude-code"]);
    case "initialize":
      return harn(["ledger-v3", "initialize", "--root", root, "--approval-record-id", "rehearsal"]);
    case "command": {
      const extra = { ...env, HARNERY_AGENT_COORD_SESSION_ID: session };
      return harn(["agents", "set-task", `rehearsal ${step.label}`], extra);
    }
    case "hook": {
      const begin = step.event === "session-start";
      const payload = JSON.stringify({
        session_id: session,
        hook_event_name: begin ? "SessionStart" : "UserPromptSubmit",
        cwd: root,
        ...(begin ? { source: "startup", model: "rehearsal" } : { prompt: step.label }),
      });
      return runBin(
        build,
        "agent-hook",
        [step.event!, "--adapter", "claude-code"],
        root,
        env,
        payload,
      );
    }
  }
  throw new Error(`action ${step.action} runs no build`);
}

/** Write each row into the spool under the writer's ready-file name; the first is epoch-tagged. */
function stageLateRows(root: string, rows: string[], oldGenesis: string | null): string[] {
  const spool = join(root, ...LEDGER, "spool");
  fs.mkdirSync(spool, { recursive: true });
  return rows.map((row, index) => {
    const event = JSON.parse(row);
    const digest = createHash("sha256").update(`${row}\n`).digest("hex");
    const tag = index === 0 && oldGenesis ? `-${oldGenesis}` : "";
    const seq = String(event.producer.sequence).padStart(16, "0");
    fs.writeFileSync(join(spool, `${seq}-${event.event_id}-${digest}${tag}.ready`), `${row}\n`);
    return event.event_id as string;
  });
}

function runCase(def: CaseDef, builds: Record<BuildName, Installed>, keep: boolean) {
  const dir = fs.mkdtempSync(join(tmpdir(), "hr-")); // short prefix: Windows path limits
  const root = join(dir, "root");
  fs.mkdirSync(root);
  spawnSync("git", ["init", "-q"], { cwd: root, windowsHide: true });
  const records: StepRecord[] = [];
  const lastRow = new Map<string, string>(); // step label -> last row it appended
  let priorGenesis: string | null = null;
  let stagedIds: string[] = [];
  try {
    for (const step of def.steps) {
      const before = measureRoot(root);
      let run: Run = { exit: 0, stdout: "", stderr: "" };
      let note: string | undefined;
      if (step.action === "delete-witness") {
        const ledger = join(root, ...LEDGER);
        const removed = WITNESS_FILES.filter((name) => fs.existsSync(join(ledger, name)));
        for (const name of removed) fs.rmSync(join(ledger, name), { force: true });
        note = `removed ${removed.join(", ") || "nothing"}`;
      } else if (step.action === "stage-late-rows") {
        const rows = (step.from ?? []).map((label) => lastRow.get(label) ?? "").filter(Boolean);
        stagedIds = stageLateRows(root, rows, priorGenesis);
        note = `simulation: staged ${stagedIds.join(", ")} (first tagged ${priorGenesis})`;
      } else {
        const threshold = String(Math.max(1, before.active_bytes));
        const env: Record<string, string> = {};
        if (step.rotate) env.HARNERY_EVENT_V3_ROTATE_ACTIVE_BYTES = threshold;
        run = runAction(step, builds[step.build!], root, env);
      }
      const after = measureRoot(root, before.active_bytes);
      const activePath = join(root, ...LEDGER, "active.ndjson");
      const active = fs.existsSync(activePath) ? fs.readFileSync(activePath) : Buffer.alloc(0);
      if (after.genesis_id === before.genesis_id && after.active_bytes > before.active_bytes) {
        const rows = active.subarray(before.active_bytes).toString("utf8").trim().split("\n");
        lastRow.set(step.label, rows.at(-1) ?? "");
      }
      if (after.genesis_id !== before.genesis_id) priorGenesis = before.genesis_id;
      const status: StepRecord["status"] = {};
      for (const name of BUILDS) {
        const out = runBin(builds[name], "harn", ["ledger-v3", "status", "--root", root], root);
        status[name] = parseStatus(out.stdout || out.stderr, out.exit);
      }
      const staged = stagedIds.length
        ? { staged: stagedFate(stagedIds, active.toString("utf8"), after.spool_files) }
        : {};
      records.push({
        label: step.label,
        ...(step.build ? { build: step.build } : {}),
        action: step.action,
        exit: run.exit,
        ...(run.exit !== 0 ? { stderr_tail: run.stderr.trim().slice(-400) } : {}),
        ...{ before, after, status, ...staged },
        ...(note ? { note } : {}),
      });
    }
  } finally {
    if (!keep) fs.rmSync(dir, { recursive: true, force: true });
  }
  return { records, root: keep ? root : undefined };
}

/** Each build's epoch contract, read from the genesis its own `init` writes in a scratch root. */
function fingerprint(build: Installed): Fingerprint {
  const dir = fs.mkdtempSync(join(tmpdir(), "hr-probe-"));
  const root = join(dir, "root");
  fs.mkdirSync(root);
  try {
    spawnSync("git", ["init", "-q"], { cwd: root, windowsHide: true });
    runBin(build, "harn", ["init", "--project-root", root, "--adapter", "claude-code"], root);
    const out = runBin(build, "harn", ["ledger-v3", "status", "--root", root], root);
    const genesis = JSON.parse(out.stdout.trim().split("\n").pop() || "{}")?.genesis ?? {};
    const profile = genesis.profile ?? {};
    return {
      version: build.version,
      manifest_version: genesis.manifest_version ?? null,
      schema_digest: profile.initial_schema_digest ?? null,
      capability_digests: [...(profile.adapter_capability_profile_digests ?? [])].sort(),
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ── main ─────────────────────────────────────────────────────────────────────

function main(): number {
  const options = parseArgs(process.argv.slice(2), resolve(import.meta.dir, ".."));
  const say = (line: string) => options.json || process.stdout.write(`${line}\n`);
  const work = fs.mkdtempSync(join(tmpdir(), "harnery-rehearsal-builds-"));
  try {
    say(`baseline harnery@${options.baseline}, candidate ${options.candidate}`);
    const builds: Record<BuildName, Installed> = {
      baseline: install(baselineTarball(options.baseline), join(work, "baseline")),
      candidate: install(candidateTarball(options.candidate, work), join(work, "candidate")),
    };
    const prints = {
      baseline: fingerprint(builds.baseline),
      candidate: fingerprint(builds.candidate),
    };
    if (sameEpochContract(prints.baseline, prints.candidate)) {
      say("note: the candidate's epoch contract equals the baseline's; fenced checks are vacuous");
    }
    const results = [];
    for (const def of CASES.filter((d) => !options.caseName || d.name === options.caseName)) {
      const { records, root } = runCase(def, builds, options.keep);
      const checks = def.checks.map((check) => evaluateCheck(check, records, prints));
      const has = (v: Verdict) => checks.some((x) => x.verdict === v);
      const verdict: Verdict = has("fail") ? "fail" : has("vacuous") ? "vacuous" : "pass";
      const shown = def.kind === "must" ? verdict.toUpperCase() : `observed (${verdict})`;
      say(`${def.kind.toUpperCase().padEnd(6)} ${shown.padEnd(7)} ${def.name}`);
      if (def.simulation) say(`         simulation: ${def.simulation}`);
      for (const check of checks) say(`         ${check.verdict.padEnd(7)} ${check.detail}`);
      for (const step of records.filter((s) => s.note || s.exit !== 0)) {
        const tail = step.stderr_tail ? `: ${step.stderr_tail.split("\n").at(-1)}` : "";
        say(
          `         step ${step.label} exit ${step.exit}${step.note ? `, ${step.note}` : ""}${tail}`,
        );
      }
      if (root) say(`         kept ${root}`);
      results.push({ name: def.name, kind: def.kind, verdict, checks, records });
    }
    // A vacuous `must` case proved nothing, so it does not pass the run.
    const failed = results
      .filter((r) => r.kind === "must" && r.verdict !== "pass")
      .map((r) => r.name);
    if (options.json)
      process.stdout.write(`${JSON.stringify({ prints, results, failed }, null, 2)}\n`);
    say(failed.length === 0 ? "rehearsal passed" : `rehearsal failed: ${failed.join(", ")}`);
    return failed.length === 0 ? 0 : 1;
  } finally {
    if (!options.keep) fs.rmSync(work, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  try {
    process.exit(main());
  } catch (error) {
    process.stderr.write(`rehearsal: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  }
}

/**
 * The credential engine: pull, check, heal, and verify over a host registry.
 *
 * Every report is plain data, so a command layer can render it and a test can
 * assert it. Two orderings matter:
 *
 * - Pull evaluates local reuse before resolving 1Password, so a fully
 *   provisioned clone never invokes `op` and never prompts.
 * - Heal repairs missing or unusable files and explicit revision bumps, never
 *   age alone, because a file's age is not evidence that it needs a new read.
 */

import { existsSync, lstatSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import { JSON_SCHEMA, load as loadYaml } from "js-yaml";
import type { OpClient } from "../op/client.ts";
import type { LocalCredentials } from "../op/local-credentials.ts";
import { runProcess } from "../op/process.ts";
import {
  groupByItem,
  healBackoffHours,
  healRetryAfter,
  isStaleRevision,
  isTransportFailure,
  loadHealBackoff,
  loadRevisions,
  readItemWithRetry,
  revisionKey,
  saveHealBackoff,
  saveRevisions,
} from "./state.ts";
import type {
  CredentialFileSpec,
  CredentialSource,
  CredsHostConfig,
  ProbeResult,
  ProbeStatus,
} from "./types.ts";

/** One file the registry expects, with the source that recreates it (if any). */
export interface ExpectedFile {
  spec: CredentialFileSpec;
  /** Absolute path on this machine. */
  absPath: string;
  description: string;
  /** Revision wanted by the registry. */
  revision?: number;
  /** Repository name used in revision keys. */
  repo: string;
  /** Source key that recreates the file, or null when nothing can. */
  pullKey: string | null;
  pending: boolean;
}

export interface RepairNeed {
  path: string;
  repo: string;
  description: string;
  pullKey: string | null;
  reason: "missing" | "stale";
}

export type ScriptRunner = (
  absScript: string,
  cwd: string,
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

export interface CredsEngineDeps {
  op: OpClient;
  /** Mirrors validated structurally when a registered file is one of them. */
  local?: LocalCredentials;
  /** Runs a pull script. Defaults to spawning it directly with a 60-second limit. */
  runScript?: ScriptRunner;
  now?: () => number;
}

export class CredsTargetError extends Error {
  constructor(
    target: string,
    readonly known: string[],
  ) {
    super(`No credential scripts found for "${target}".`);
    this.name = "CredsTargetError";
  }
}

export class OpMissingError extends Error {
  constructor() {
    super("1Password CLI (op / op.exe) not found.");
    this.name = "OpMissingError";
  }
}

const defaultRunScript: ScriptRunner = (absScript, cwd) =>
  runProcess([absScript], { cwd, timeoutMs: 60_000 });

function usableCredentialValue(value: unknown): boolean {
  if (typeof value !== "string") return value !== null && value !== undefined;
  const text = value.trim();
  return (
    text !== "" &&
    text !== '""' &&
    text !== "''" &&
    !/^(?:<REDACTED(?::[^>]*)?>|\[REDACTED\])$/i.test(text)
  );
}

/** Bind the credential engine to one host's registry and 1Password client. */
export function createCredsEngine(config: CredsHostConfig, deps: CredsEngineDeps) {
  const runScript = deps.runScript ?? defaultRunScript;
  const now = deps.now ?? Date.now;

  function repoRoot(repo?: string | null): string {
    if (!repo) return config.repoRoot;
    const root = config.repoPaths?.[repo];
    if (!root) throw new Error(`credential registry names unknown repository "${repo}"`);
    return root;
  }

  function repoName(repo?: string | null): string {
    return repo ?? config.repoName;
  }

  function filePath(spec: CredentialFileSpec): string {
    return spec.path.startsWith("~/")
      ? resolve(homedir(), spec.path.slice(2))
      : resolve(repoRoot(spec.repo), spec.path);
  }

  function scriptPath(source: CredentialSource): string {
    return resolve(repoRoot(source.repo), source.script);
  }

  /** True when the file exists, is non-empty, and holds usable values for its required keys. */
  function fileReady(spec: CredentialFileSpec): boolean {
    const abs = filePath(spec);
    try {
      const stat = lstatSync(abs);
      if (!stat.isFile() || stat.size === 0) return false;
      const mirror = deps.local?.sources.find((s) => resolve(config.repoRoot, s.path) === abs);
      if (mirror && deps.local) {
        deps.local.getLocalOpFields(mirror, mirror.fields);
        return true;
      }
      const text = readFileSync(abs, "utf8").trim();
      if (!usableCredentialValue(text)) return false;
      const required = spec.requiredKeys ?? [];
      if (abs.endsWith(".json")) {
        const value = JSON.parse(text);
        return (
          value !== null &&
          typeof value === "object" &&
          !Array.isArray(value) &&
          Object.keys(value).length > 0 &&
          required.every((key) => usableCredentialValue(value[key]))
        );
      }
      // Check the effective value: a later empty assignment overrides an
      // earlier usable one, and YAML rejects duplicate keys outright.
      const values = /\.ya?ml$/i.test(abs)
        ? loadYaml(text, { schema: JSON_SCHEMA })
        : parseEnv(text);
      return (
        values !== null &&
        typeof values === "object" &&
        !Array.isArray(values) &&
        required.every((key) => usableCredentialValue((values as Record<string, unknown>)[key]))
      );
    } catch {
      return false;
    }
  }

  /** Every file the registry expects, sources first, then standalone files. */
  function expectedFiles(): ExpectedFile[] {
    const out: ExpectedFile[] = [];
    for (const source of config.sources) {
      for (const spec of source.files) {
        out.push({
          spec,
          absPath: filePath(spec),
          description: spec.description ?? source.description,
          revision: spec.revision ?? source.revision,
          repo: repoName(spec.repo ?? source.repo),
          pullKey: source.key,
          pending: source.pending ?? false,
        });
      }
    }
    for (const spec of config.standaloneFiles ?? []) {
      out.push({
        spec,
        absPath: filePath(spec),
        description: spec.description,
        revision: spec.revision,
        repo: repoName(spec.repo),
        pullKey: null,
        pending: false,
      });
    }
    return out;
  }

  /** Sources for a key, or for a repository name; all non-pending sources without a target. */
  function sourcesForTarget(target?: string): CredentialSource[] {
    if (!target) return config.sources.filter((s) => !s.pending);
    const byKey = config.sources.filter((s) => s.key === target);
    if (byKey.length > 0) return byKey;
    return config.sources.filter(
      (s) => !s.pending && (s.repo === target || (target === config.repoName && !s.repo)),
    );
  }

  function sourceReady(source: CredentialSource): boolean {
    return source.files.length > 0 && source.files.every((spec) => fileReady(spec));
  }

  function recordPulledRevisions(key: string): void {
    const state = loadRevisions(config.revisionStatePath);
    for (const file of expectedFiles()) {
      if (file.pullKey === key) state[revisionKey(file.repo, file.spec.path)] = file.revision ?? 1;
    }
    saveRevisions(config.revisionStatePath, state);
  }

  /** Files that are missing, unusable, or behind their registry revision. */
  function repairs(): RepairNeed[] {
    const pulled = loadRevisions(config.revisionStatePath);
    const out: RepairNeed[] = [];
    for (const file of expectedFiles()) {
      if (file.pending) continue;
      let reason: RepairNeed["reason"];
      if (!fileReady(file.spec)) reason = "missing";
      else if (isStaleRevision(file.revision, pulled[revisionKey(file.repo, file.spec.path)]))
        reason = "stale";
      else continue;
      out.push({
        path: file.spec.path,
        repo: file.repo,
        description: file.description,
        pullKey: file.pullKey,
        reason,
      });
    }
    return out;
  }

  function pullScriptMtimeMs(key: string): number | null {
    let newest: number | null = null;
    for (const source of config.sources.filter((s) => s.key === key)) {
      try {
        newest = Math.max(newest ?? 0, statSync(scriptPath(source)).mtimeMs);
      } catch {
        // A missing script is reported by the pull itself.
      }
    }
    return newest;
  }

  async function runSource(
    source: CredentialSource,
  ): Promise<{ ok: boolean; detail?: string; transport: boolean }> {
    const abs = scriptPath(source);
    if (!existsSync(abs))
      return { ok: false, detail: "registered pull script is missing", transport: false };
    const r = await runScript(abs, repoRoot(source.repo));
    if (r.exitCode === 0 && sourceReady(source)) return { ok: true, transport: false };
    const output = `${r.stderr}\n${r.stdout}`;
    const detail =
      r.exitCode === 0
        ? "pull exited successfully but local credentials remain unusable"
        : (r.stderr || r.stdout || `pull exited ${r.exitCode}`)
            .trim()
            .split("\n")
            .slice(-3)
            .join("\n");
    return { ok: false, detail, transport: isTransportFailure(output) };
  }

  /** Ensure credentials exist locally, running pull scripts only for what is missing (or all with refresh). */
  async function pull(target?: string, opts: { refresh?: boolean } = {}) {
    const sources = sourcesForTarget(target);
    if (sources.length === 0 && target) {
      throw new CredsTargetError(target, config.sources.map((s) => s.key).sort());
    }
    type Status = "ok" | "fail" | "local";
    const results: {
      key: string;
      script: string;
      description: string;
      status: Status;
      stderr?: string;
    }[] = [];
    const toRun: CredentialSource[] = [];
    for (const source of sources) {
      if (!opts.refresh && sourceReady(source)) {
        results.push({
          key: source.key,
          script: source.script,
          description: source.description,
          status: "local",
        });
      } else toRun.push(source);
    }
    if (toRun.length > 0 && !deps.op.detectOp()) throw new OpMissingError();
    const pulledKeys: string[] = [];
    for (const source of toRun) {
      const r = await runSource(source);
      if (r.ok) {
        recordPulledRevisions(source.key);
        pulledKeys.push(source.key);
        results.push({
          key: source.key,
          script: source.script,
          description: source.description,
          status: "ok",
        });
      } else {
        results.push({
          key: source.key,
          script: source.script,
          description: source.description,
          status: "fail",
          stderr: r.detail,
        });
      }
    }
    if (pulledKeys.length > 0) await config.hooks?.afterPull?.(pulledKeys);
    const count = (s: Status) => results.filter((r) => r.status === s).length;
    return {
      ok: count("fail") === 0,
      target: target ?? null,
      refresh: opts.refresh ?? false,
      contacted: toRun.length > 0,
      counts: { ok: count("ok"), fail: count("fail"), local: count("local") },
      results,
    };
  }

  /**
   * Recreate missing, unusable, or rotated files by running their pull
   * scripts. Never throws for a pull failure; a failing key waits out the
   * retry delay unless the failure was a 1Password transport hiccup.
   */
  async function heal(opts: { dryRun?: boolean; force?: boolean } = {}) {
    const needs = repairs();
    const unrecoverable = needs.filter((m) => m.pullKey === null).map((m) => m.path);
    const backoff = loadHealBackoff(config.backoffStatePath);
    const hours = healBackoffHours(config.backoffHoursEnv);
    const at = now();
    const backedOff: { path: string; pull_key: string; retry_after: string; detail?: string }[] =
      [];
    const healable = needs.filter((m) => {
      if (m.pullKey === null) return false;
      if (opts.force) return true;
      const retryAfter = healRetryAfter(
        backoff[m.pullKey],
        at,
        hours,
        pullScriptMtimeMs(m.pullKey),
      );
      if (!retryAfter) return true;
      backedOff.push({
        path: m.path,
        pull_key: m.pullKey,
        retry_after: retryAfter.toISOString(),
        detail: backoff[m.pullKey]?.detail,
      });
      return false;
    });

    if (opts.dryRun) {
      return {
        ok: true,
        dry_run: true as const,
        would_heal: healable.map((m) => ({ path: m.path, pull_key: m.pullKey, reason: m.reason })),
        missing: needs.length,
        unrecoverable,
        backed_off: backedOff,
        rows: [] as {
          pull_key: string;
          status: "healed" | "refreshed" | "failed";
          detail?: string;
        }[],
      };
    }

    const rows: { pull_key: string; status: "healed" | "refreshed" | "failed"; detail?: string }[] =
      [];
    // One script can write several files, so run each key once.
    const keys = [...new Set(healable.map((m) => m.pullKey as string))];
    const staleKeys = new Set(
      healable.filter((m) => m.reason === "stale").map((m) => m.pullKey as string),
    );
    const healedKeys: string[] = [];
    for (const key of keys) {
      const sources = config.sources.filter((s) => s.key === key);
      let result: { ok: boolean; detail?: string; transport: boolean } = {
        ok: false,
        detail: "no pull script registered for key",
        transport: false,
      };
      for (const source of sources) {
        result = await runSource(source);
        if (!result.ok) break;
      }
      if (sources.length > 0 && result.ok) {
        recordPulledRevisions(key);
        healedKeys.push(key);
        delete backoff[key];
        rows.push({ pull_key: key, status: staleKeys.has(key) ? "refreshed" : "healed" });
      } else {
        rows.push({ pull_key: key, status: "failed", detail: result.detail });
        if (!result.transport)
          backoff[key] = { failed_at: new Date(now()).toISOString(), detail: result.detail };
      }
    }
    if (keys.length > 0) saveHealBackoff(config.backoffStatePath, backoff);
    if (healedKeys.length > 0) await config.hooks?.afterPull?.(healedKeys);
    const failed = rows.filter((r) => r.status === "failed").length;
    return {
      ok: failed === 0,
      healed: rows.length - failed,
      failed,
      missing: needs.length,
      unrecoverable,
      backed_off: backedOff,
      rows,
    };
  }

  /** File freshness by mtime, plus live probes unless `live` is false. */
  async function check(opts: { live?: boolean } = {}) {
    const live = opts.live ?? true;
    const rows: {
      path: string;
      description: string;
      status: "missing" | "stale" | "warning" | "ok";
      age_days: number | null;
      age_human: string;
      live?: ProbeStatus;
      live_detail?: string;
    }[] = [];
    const files = expectedFiles().filter((f) => !f.pending);
    for (const file of files) {
      if (!fileReady(file.spec)) {
        rows.push({
          path: file.spec.path,
          description: file.description,
          status: "missing",
          age_days: null,
          age_human: "missing",
        });
        continue;
      }
      const days = Math.floor((now() - statSync(file.absPath).mtimeMs) / 86_400_000);
      rows.push({
        path: file.spec.path,
        description: file.description,
        status: days > 90 ? "stale" : days > 30 ? "warning" : "ok",
        age_days: days,
        age_human: days === 0 ? "today" : days === 1 ? "1 day ago" : `${days} days ago`,
      });
    }
    const missing = rows.some((r) => r.status === "missing");
    if (!live) return { ok: !missing, mode: "mtime" as const, rows };

    // One probe per key: a source that writes two files shares one identity.
    const probes = config.hooks?.probes ?? {};
    const results = new Map<string, ProbeResult>();
    for (const key of new Set(files.map((f) => f.pullKey).filter((k): k is string => k !== null))) {
      const probe = probes[key];
      results.set(
        key,
        probe
          ? await probe().catch((e: unknown) => ({ status: "dead" as const, detail: String(e) }))
          : {
              status: "skipped",
              detail: "no probe defined",
            },
      );
    }
    files.forEach((file, i) => {
      const result = file.pullKey ? results.get(file.pullKey) : undefined;
      const row = rows[i];
      if (!result || !row) return;
      row.live = result.status;
      row.live_detail = result.detail;
    });
    const tally = (s: ProbeStatus) => rows.filter((r) => r.live === s).length;
    return {
      ok: tally("dead") === 0 && !missing,
      mode: "live" as const,
      counts: {
        live: tally("live"),
        dead: tally("dead"),
        skipped: tally("skipped"),
        files: rows.length,
      },
      rows,
    };
  }

  /** Confirm every manifest item and field still resolves in 1Password. */
  async function verify(account?: string) {
    if (!deps.op.detectOp()) throw new OpMissingError();
    const chosen = account ?? config.defaultAccount;
    const groups = groupByItem(config.manifest);
    const rows: {
      vault: string;
      item: string;
      field: string;
      status: "ok" | "missing" | "item_missing" | "unreadable" | "pending";
      scripts: string;
      reason?: string;
    }[] = [];
    for (const g of groups) {
      let present: Set<string> | null = null;
      let readError: unknown;
      try {
        const res = await readItemWithRetry(() =>
          deps.op.getItemFields(
            { account: chosen, vault: g.vault, item: g.item },
            { reveal: false },
          ),
        );
        present = new Set(Object.keys(res.fields));
      } catch (error) {
        readError = error;
      }
      const scripts = g.scripts.join(", ");
      if (readError && isTransportFailure(readError)) {
        for (const field of g.kind === "document" ? ["(item exists)"] : g.fields) {
          rows.push({
            vault: g.vault,
            item: g.item,
            field,
            status: "unreadable",
            scripts,
            reason: "1Password CLI transport failure after retries",
          });
        }
        continue;
      }
      if (g.kind === "document") {
        rows.push({
          vault: g.vault,
          item: g.item,
          field: "(item exists)",
          status: present ? "ok" : "item_missing",
          scripts,
        });
        continue;
      }
      for (const f of g.fields) {
        const found = present?.has(f) ?? false;
        const status = found
          ? "ok"
          : g.pendingFields.includes(f)
            ? "pending"
            : present === null
              ? "item_missing"
              : "missing";
        rows.push({ vault: g.vault, item: g.item, field: f, status, scripts });
      }
    }
    const problems = rows.filter((r) => r.status !== "ok" && r.status !== "pending");
    return {
      ok: problems.length === 0,
      account: chosen ?? null,
      counts: {
        items: groups.length,
        fields: rows.length,
        ok: rows.filter((r) => r.status === "ok").length,
        pending: rows.filter((r) => r.status === "pending").length,
        problems: problems.length,
      },
      problems,
    };
  }

  return {
    config,
    filePath,
    fileReady,
    expectedFiles,
    sourcesForTarget,
    repairs,
    pull,
    heal,
    check,
    verify,
  };
}

export type CredsEngine = ReturnType<typeof createCredsEngine>;

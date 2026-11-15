/** Inspection and explicit retirement of cross-machine refs on origin. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveMachineLabel } from "../../lib/machine.ts";
import {
  DOCKET_REF_PREFIX,
  MAIL_REF_PREFIX,
  PRESENCE_REF_PREFIX,
  runPresenceGit,
  sanitizeRefComponent,
} from "./git.ts";
import { MAIL_TTL_MS } from "./mail.ts";

export const DEFAULT_REF_PRUNE_AGE = "30d";
/** Presence readers consider a machine stale after 900 seconds. */
const MIN_REF_PRUNE_AGE_MS = 900_000;
const PREFIXES = [PRESENCE_REF_PREFIX, MAIL_REF_PREFIX, DOCKET_REF_PREFIX] as const;

export interface MachineRefInfo {
  ref: string;
  sha: string;
  namespace: "presence" | "mail" | "docket";
  machine: string;
  own: boolean;
  committed_at: string | null;
  age_secs: number | null;
  undelivered_mail: number | null;
  error?: string;
}

export interface MachineRefInventory {
  remote: "origin";
  machine: string;
  refs: MachineRefInfo[];
}

export interface MachineRefPruneRow extends MachineRefInfo {
  would_delete: boolean;
  mail_messages_lost: number | null;
  reason: string;
}

export interface MachineRefPruneResult {
  remote: "origin";
  machine: string;
  older_than: string;
  preview: boolean;
  refs: MachineRefPruneRow[];
  deleted: string[];
  failed: Array<{ ref: string; error: string }>;
}

/** Strict units keep a typo from turning a long retention into a short one. */
export function parseRefPruneAge(value: string): number {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d|w)$/.exec(value);
  const units: Record<string, number> = {
    ms: 1,
    s: 1000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
    w: 604_800_000,
  };
  const ms = match ? Number(match[1]) * units[match[2]!]! : NaN;
  if (!Number.isFinite(ms) || ms < MIN_REF_PRUNE_AGE_MS) {
    throw new Error("--older-than needs a duration of at least 15m (units: ms, s, m, h, d, w)");
  }
  return ms;
}

function refIdentity(ref: string): Pick<MachineRefInfo, "machine" | "namespace"> | null {
  const prefix = PREFIXES.find((p) => ref.startsWith(p));
  if (!prefix) return null;
  return {
    machine: ref.slice(prefix.length),
    namespace:
      prefix === MAIL_REF_PREFIX ? "mail" : prefix === DOCKET_REF_PREFIX ? "docket" : "presence",
  };
}

interface MailContents {
  outbox: Array<{ message_id: string; to_machine: string; created_at: string }>;
  acks: string[];
}

/** Docket collisions can give this clone a suffixed publication ref. Read its
 * existing identity without creating one merely to inspect the remote. */
function localDocketIdentity(root: string): { refs: Set<string>; id?: string } {
  const refs = new Set<string>();
  let id: string | undefined;
  try {
    const candidate = readFileSync(
      join(root, ".harnery", "presence", "docket-machine-id"),
      "utf8",
    ).trim();
    if (/^[a-f0-9]{12}$/.test(candidate)) {
      id = candidate;
      refs.add(
        `${DOCKET_REF_PREFIX}${sanitizeRefComponent(`${resolveMachineLabel()}-${id.slice(0, 6)}`)}`,
      );
    }
  } catch {
    // No docket has been published from this clone yet.
  }
  try {
    const state = JSON.parse(
      readFileSync(join(root, ".harnery", "presence", "docket-state.json"), "utf8"),
    );
    if (typeof state?.ref === "string" && state.ref === sanitizeRefComponent(state.ref)) {
      refs.add(`${DOCKET_REF_PREFIX}${state.ref}`);
    }
  } catch {
    // The machine label and existing id still protect the ordinary refs.
  }
  return { refs, id };
}

function readMailContents(machine: string, message: string): MailContents | null {
  try {
    const blob = JSON.parse(message);
    if (
      blob?.v !== 1 ||
      typeof blob.machine !== "string" ||
      sanitizeRefComponent(blob.machine) !== machine ||
      !Number.isFinite(Date.parse(blob.published_at)) ||
      !Array.isArray(blob.outbox) ||
      !Array.isArray(blob.acks) ||
      !blob.acks.every((id: unknown) => typeof id === "string")
    )
      return null;
    for (const envelope of blob.outbox) {
      if (
        !envelope ||
        typeof envelope.message_id !== "string" ||
        typeof envelope.to_machine !== "string" ||
        typeof envelope.created_at !== "string" ||
        !Number.isFinite(Date.parse(envelope.created_at))
      )
        return null;
    }
    return blob;
  } catch {
    return null;
  }
}

/**
 * Read the remote advertisement, then fetch commits by their advertised SHA.
 * A removed name cannot make another peer's fetch fail. No local ref, mail
 * import, or publication changes during inspection, only the object database.
 */
export function listMachineRefs(root: string, now = new Date()): MachineRefInventory {
  const listed = runPresenceGit(root, [
    "ls-remote",
    "--refs",
    "origin",
    ...PREFIXES.map((p) => `${p}*`),
  ]);
  if (!listed.ok)
    throw new Error(listed.stderr.trim() || "Cannot list cross-machine refs on origin");
  const machine = sanitizeRefComponent(resolveMachineLabel());
  const docketIdentity = localDocketIdentity(root);
  const refs: MachineRefInfo[] = [];
  const mail = new Map<string, MailContents>();
  for (const line of listed.stdout.trim().split("\n")) {
    const [sha, ref] = line.split("\t");
    if (!sha || !ref || !/^[a-f0-9]{40,64}$/.test(sha)) continue;
    const identity = refIdentity(ref);
    if (!identity) continue;
    const row: MachineRefInfo = {
      ...identity,
      ref,
      sha,
      own: sanitizeRefComponent(identity.machine) === machine || docketIdentity.refs.has(ref),
      committed_at: null,
      age_secs: null,
      undelivered_mail: identity.namespace === "mail" ? null : 0,
    };
    refs.push(row);
    if (identity.machine !== sanitizeRefComponent(identity.machine)) {
      row.error = "unsupported machine ref name";
      continue;
    }
    let commit = runPresenceGit(root, ["show", "-s", "--format=%ct%x00%B", `${sha}^{commit}`]);
    if (!commit.ok) {
      const fetched = runPresenceGit(root, [
        "fetch",
        "--quiet",
        "--no-tags",
        "--no-write-fetch-head",
        "origin",
        sha,
      ]);
      if (!fetched.ok) {
        const current = runPresenceGit(root, ["ls-remote", "--refs", "origin", ref]);
        row.error =
          current.ok && !current.stdout.trim()
            ? "ref disappeared during inspection"
            : "cannot read advertised commit";
        continue;
      }
      commit = runPresenceGit(root, ["show", "-s", "--format=%ct%x00%B", `${sha}^{commit}`]);
    }
    const separator = commit.stdout.indexOf("\0");
    const timestamp = Number(commit.stdout.slice(0, separator)) * 1000;
    if (
      !commit.ok ||
      separator < 0 ||
      !Number.isFinite(timestamp) ||
      !Number.isFinite(new Date(timestamp).getTime())
    ) {
      row.error = "cannot read commit timestamp";
      continue;
    }
    row.committed_at = new Date(timestamp).toISOString();
    row.age_secs = Math.max(0, (now.getTime() - timestamp) / 1000);
    if (row.namespace === "docket" && docketIdentity.id) {
      try {
        const blob = JSON.parse(commit.stdout.slice(separator + 1));
        if (blob?.machine_id === docketIdentity.id) row.own = true;
      } catch {
        // A malformed docket does not weaken label-based ownership checks.
      }
    }
    if (row.namespace === "mail") {
      const blob = readMailContents(row.machine, commit.stdout.slice(separator + 1));
      if (blob) mail.set(row.machine, blob);
      else row.error = "cannot verify mail contents";
    }
  }
  for (const row of refs) {
    if (row.namespace !== "mail") continue;
    const blob = mail.get(row.machine);
    if (!blob) continue;
    const pending = new Set<string>();
    for (const envelope of blob.outbox) {
      if (now.getTime() - Date.parse(envelope.created_at) >= MAIL_TTL_MS) continue;
      if (mail.get(envelope.to_machine)?.acks.includes(envelope.message_id)) continue;
      pending.add(envelope.message_id);
    }
    row.undelivered_mail = pending.size;
  }
  return { remote: "origin", machine, refs: refs.sort((a, b) => a.ref.localeCompare(b.ref)) };
}

/** Exact leased deletion refuses a ref that was refreshed after inspection. */
export function deleteMachineRef(
  root: string,
  row: MachineRefInfo,
): { ok: boolean; error?: string } {
  const identity = refIdentity(row.ref);
  const self = sanitizeRefComponent(resolveMachineLabel());
  if (
    row.own ||
    !identity ||
    identity.machine !== sanitizeRefComponent(identity.machine) ||
    sanitizeRefComponent(identity.machine) === self ||
    localDocketIdentity(root).refs.has(row.ref) ||
    !/^[a-f0-9]{40,64}$/.test(row.sha)
  )
    return { ok: false, error: "ref is not an eligible peer ref" };
  const deleted = runPresenceGit(root, [
    "push",
    `--force-with-lease=${row.ref}:${row.sha}`,
    "origin",
    "--delete",
    row.ref,
  ]);
  if (!deleted.ok) return { ok: false, error: deleted.stderr.trim() || "remote deletion failed" };
  // A concurrent fetch may have refreshed this local ref. Never delete that
  // newer value, and do not touch local state until the remote push succeeds.
  const local = runPresenceGit(root, ["show-ref", "--verify", "--hash", row.ref]);
  if (!local.ok) return { ok: true };
  const removed = runPresenceGit(root, ["update-ref", "-d", row.ref, row.sha]);
  return removed.ok
    ? { ok: true }
    : { ok: true, error: `remote deleted; local cleanup failed: ${removed.stderr.trim()}` };
}

export function pruneMachineRefs(
  root: string,
  opts: { olderThan?: string; includeMail?: boolean; yes?: boolean; now?: Date } = {},
): MachineRefPruneResult {
  const olderThan = opts.olderThan ?? DEFAULT_REF_PRUNE_AGE;
  const ageMs = parseRefPruneAge(olderThan);
  const inventory = listMachineRefs(root, opts.now);
  const refs = inventory.refs.map((row): MachineRefPruneRow => {
    const reason = row.own
      ? "own machine"
      : row.error
        ? row.error
        : row.age_secs === null
          ? "unknown commit age"
          : row.age_secs * 1000 <= ageMs
            ? "not older than threshold"
            : row.namespace === "mail" && row.undelivered_mail === null
              ? "unknown mail contents"
              : row.namespace === "mail" && row.undelivered_mail! > 0 && !opts.includeMail
                ? "undelivered mail; requires --include-mail"
                : "older than threshold";
    const wouldDelete = reason === "older than threshold";
    return {
      ...row,
      would_delete: wouldDelete,
      mail_messages_lost: wouldDelete ? row.undelivered_mail : 0,
      reason,
    };
  });
  const result: MachineRefPruneResult = {
    remote: "origin",
    machine: inventory.machine,
    older_than: olderThan,
    preview: !opts.yes,
    refs,
    deleted: [],
    failed: [],
  };
  if (opts.yes) {
    for (const row of refs) {
      if (!row.would_delete) continue;
      const deletion = deleteMachineRef(root, row);
      if (deletion.ok) result.deleted.push(row.ref);
      if (deletion.error) result.failed.push({ ref: row.ref, error: deletion.error });
    }
  }
  return result;
}

/**
 * Council write-side helpers. Shells out to `agent-coord` for lifecycle
 * mutations (advance / close / archive / unarchive / delete / set-steward)
 * and to `harn council create` for creation, so the lifecycle
 * semantics stay in one place.
 */

import { lookupByName } from "./identities";
import { type HelperResult, runHarn } from "./run-harn";

export type { HelperResult };

function runHelper(args: string[]): Promise<HelperResult> {
  return runHarn(args, { executable: "agent-coord" });
}

const COUNCIL_ID_PATTERN = /^[a-z0-9][a-z0-9-]*-\d{4}-\d{2}-\d{2}-[0-9a-f]{4}$/;

export function safeCouncilId(id: string): boolean {
  return COUNCIL_ID_PATTERN.test(id);
}

export async function advanceCouncil(id: string, force: boolean): Promise<HelperResult> {
  const args = ["council-advance", id];
  if (force) args.push("--force");
  return runHelper(args);
}

export async function closeCouncil(id: string): Promise<HelperResult> {
  return runHelper(["council-close", id]);
}

export async function archiveCouncil(id: string): Promise<HelperResult> {
  return runHelper(["council-archive", id]);
}

export async function unarchiveCouncil(id: string): Promise<HelperResult> {
  return runHelper(["council-unarchive", id]);
}

export async function deleteCouncil(id: string): Promise<HelperResult> {
  return runHelper(["council-delete", id]);
}

/** Resolve a known agent's `agent_id` UUID by display name (`agent-Maya` or
 * `Maya`). Returns null when no identity record matches; used by routes that
 * need to convert the picker's name selection into the (steward, steward_id)
 * pair the helper expects. */
export function lookupAgentIdByName(name: string): string | null {
  if (!name) return null;
  return lookupByName(name)?.agent_id ?? null;
}

export async function setSteward(
  id: string,
  steward: string | null,
  stewardId: string | null = null,
): Promise<HelperResult> {
  // agent-coord signature: council-set-steward <councilId> <steward> <stewardId>
  // Empty strings clear the field; the helper distinguishes them from the
  // positional defaults internally.
  return runHelper(["council-set-steward", id, steward ?? "", stewardId ?? ""]);
}

export interface CreateCouncilOpts {
  objective: string;
  members: string[];
  steward?: string | null;
  target_doc?: string | null;
  auto_advance?: boolean;
}

/** Create a council via `harn council create`. Returns the new
 * council_id (parsed from stdout JSON) when successful. */
export async function createCouncil(
  opts: CreateCouncilOpts,
): Promise<HelperResult & { council_id?: string }> {
  // `council` is a top-level command (promoted out of `agents`).
  const args = ["council", "create"];
  // CLI signature is `--members <comma-list>` (not a repeated `--member` flag).
  args.push("--members", opts.members.join(","));
  if (opts.steward) args.push("--steward", opts.steward);
  if (opts.target_doc) args.push("--target-doc", opts.target_doc);
  if (opts.auto_advance) args.push("--auto-advance");
  // The HTTP request carries no agent identity, so the running agent's name
  // can't default the convener. Pass --created-by explicitly (steward, falling
  // back to the first member). Matches the CLI help's web-UI guidance.
  const createdBy = opts.steward ?? opts.members[0];
  if (createdBy) args.push("--created-by", createdBy);
  args.push("--json");
  // Free text goes after `--` so an objective starting with "-" is never read
  // as an option. (Option values like --steward are safe: Commander consumes
  // the next argument as a required value even when it starts with "-".)
  args.push("--", opts.objective);
  const result = await runHarn(args);
  if (!result.ok) return result;
  try {
    // `--json` emits the standard envelope { rows: [{ council_id, … }], meta };
    // accept a bare { council_id } too for forward/backward compatibility.
    const parsed = JSON.parse(result.stdout) as {
      council_id?: string;
      rows?: Array<{ council_id?: string }>;
    };
    const councilId = parsed.rows?.[0]?.council_id ?? parsed.council_id;
    return { ...result, council_id: councilId };
  } catch {
    return result;
  }
}

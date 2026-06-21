/**
 * Council write-side helpers. Shells out to `harnery/bin/agent-coord`
 * for mutations (advance / close / archive / unarchive / delete) so the
 * lifecycle semantics stay in one place.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { coordRoot } from "./coord-reader";

export interface HelperResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exit_code: number | null;
}

function helperPath(): string {
  // harnery/web/lib/council-writer.ts → harnery/web/ → harnery/ → harnery/bin/
  return path.join(coordRoot(), "harnery", "bin", "agent-coord");
}

async function runHelper(args: string[]): Promise<HelperResult> {
  const root = coordRoot();
  return new Promise((resolve) => {
    const proc = spawn(helperPath(), args, {
      cwd: root,
      env: { ...process.env, HARNERY_COORD_ROOT_OVERRIDE: root },
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    proc.on("close", (code) => {
      resolve({ ok: code === 0, stdout, stderr, exit_code: code });
    });
    proc.on("error", (err) => {
      resolve({
        ok: false,
        stdout,
        stderr: `${stderr}${err.message}`,
        exit_code: null,
      });
    });
  });
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
  // Local import to avoid circular dep: identities.ts imports coord-reader.
  const { lookupByName } = require("./identities") as {
    lookupByName: (n: string) => { agent_id: string } | null;
  };
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
  return runHelper([
    "council-set-steward",
    id,
    steward ?? "",
    stewardId ?? "",
  ]);
}

export interface CreateCouncilOpts {
  objective: string;
  members: string[];
  steward?: string | null;
  target_doc?: string | null;
  auto_advance?: boolean;
}

async function runHarn(args: string[]): Promise<HelperResult> {
  const root = coordRoot();
  const harnBin = path.join(root, "harnery", "bin", "harn");
  return new Promise((resolve) => {
    const proc = spawn(harnBin, args, {
      cwd: root,
      env: { ...process.env, HARNERY_COORD_ROOT_OVERRIDE: root },
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    proc.on("close", (code) => {
      resolve({ ok: code === 0, stdout, stderr, exit_code: code });
    });
    proc.on("error", (err) => {
      resolve({
        ok: false,
        stdout,
        stderr: `${stderr}${err.message}`,
        exit_code: null,
      });
    });
  });
}

/** Create a council via `harn agents council create`. Returns the new
 * council_id (parsed from stdout JSON) when successful. */
export async function createCouncil(
  opts: CreateCouncilOpts,
): Promise<HelperResult & { council_id?: string }> {
  const args = ["agents", "council", "create", opts.objective];
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
  const result = await runHarn(args);
  if (!result.ok) return result;
  try {
    const parsed = JSON.parse(result.stdout) as { council_id?: string };
    return { ...result, council_id: parsed.council_id };
  } catch {
    return result;
  }
}

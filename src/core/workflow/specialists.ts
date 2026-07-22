import type { AgentOpts, WorkflowSpecialistProfile } from "./types.ts";

const SPECIALIST_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_SPECIALISTS = 32;
const MAX_INSTRUCTIONS = 4_000;
const MAX_OPTION = 200;

export function normalizeWorkflowSpecialists(
  input: Readonly<Record<string, WorkflowSpecialistProfile>> | undefined,
): Record<string, WorkflowSpecialistProfile> {
  if (input === undefined) return {};
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("workflow specialists must be an object keyed by role id");
  }
  const entries = Object.entries(input);
  if (entries.length > MAX_SPECIALISTS) {
    throw new Error(`workflow specialists exceed ${MAX_SPECIALISTS} roles`);
  }
  const normalized: Record<string, WorkflowSpecialistProfile> = {};
  for (const [id, profile] of entries.sort(([left], [right]) => left.localeCompare(right))) {
    if (!SPECIALIST_ID.test(id))
      throw new Error(`invalid workflow specialist id ${JSON.stringify(id)}`);
    if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
      throw new Error(`workflow specialist ${id} must be an object`);
    }
    normalized[id] = {
      instructions: bounded(
        profile.instructions,
        `workflow specialist ${id} instructions`,
        MAX_INSTRUCTIONS,
      ),
      harness: optional(profile.harness, `workflow specialist ${id} harness`),
      model: optional(profile.model, `workflow specialist ${id} model`),
      effort: optional(profile.effort, `workflow specialist ${id} effort`),
      maxAttempts: positiveOptional(
        profile.maxAttempts,
        `workflow specialist ${id} maxAttempts`,
        10,
      ),
      timeoutMs: positiveOptional(
        profile.timeoutMs,
        `workflow specialist ${id} timeoutMs`,
        24 * 60 * 60 * 1_000,
      ),
      maxTurns: positiveOptional(profile.maxTurns, `workflow specialist ${id} maxTurns`, 1_000),
    };
  }
  return normalized;
}

export function resolveSpecialistAssignment(
  profiles: Readonly<Record<string, WorkflowSpecialistProfile>>,
  prompt: string,
  opts: AgentOpts,
): { prompt: string; opts: AgentOpts } {
  if (!opts.specialist) return { prompt, opts };
  if (!SPECIALIST_ID.test(opts.specialist)) {
    throw new Error(`invalid workflow specialist id ${JSON.stringify(opts.specialist)}`);
  }
  const profile = profiles[opts.specialist];
  if (!profile)
    throw new Error(`workflow specialist ${JSON.stringify(opts.specialist)} is not configured`);
  return {
    prompt: `${profile.instructions}\n\nAssignment:\n${prompt}`,
    opts: {
      specialist: opts.specialist,
      harness: opts.harness ?? profile.harness,
      model: opts.model ?? profile.model,
      effort: opts.effort ?? profile.effort,
      maxAttempts: opts.maxAttempts ?? profile.maxAttempts,
      timeoutMs: opts.timeoutMs ?? profile.timeoutMs,
      maxTurns: opts.maxTurns ?? profile.maxTurns,
      label: opts.label,
      schema: opts.schema,
    },
  };
}

function bounded(value: unknown, field: string, max: number): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} must not be empty`);
  if (normalized.length > max) throw new Error(`${field} exceeds ${max} characters`);
  return normalized;
}

function optional(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : bounded(value, field, MAX_OPTION);
}

function positiveOptional(value: unknown, field: string, max: number): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > max) {
    throw new Error(`${field} must be an integer from 1 to ${max}`);
  }
  return value as number;
}

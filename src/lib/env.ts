/**
 * Read a harnery environment variable by its suffix (the part after the
 * `HARNERY_` prefix). Centralizes the env-var namespace so the prefix lives in
 * exactly one place.
 *
 * Examples:
 *   coordEnv("AGENT_COORD_OWNER")   → process.env.HARNERY_AGENT_COORD_OWNER
 *   coordEnv("COORD_ROOT_OVERRIDE") → process.env.HARNERY_COORD_ROOT_OVERRIDE
 */
export function coordEnv(suffix: string): string | undefined {
  return process.env[`HARNERY_${suffix}`];
}

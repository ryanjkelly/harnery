/**
 * Put `process.env` back to a snapshot taken with `{ ...process.env }`,
 * mutating the live object instead of replacing it.
 *
 * Never write `process.env = snapshot`. On Windows, Bun's `process.env` is
 * case-insensitive, so `PATH` and the runner's `Path` name one variable. A
 * plain-object replacement is case-sensitive: a later test that saves and
 * restores `process.env.PATH` then leaves both `Path` and `PATH` in the object,
 * child processes inherit the wrong one, and every `git` spawn in the rest of
 * the Bun process fails with `ENOENT ... uv_spawn 'git'`.
 */
export function restoreProcessEnv(snapshot: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(process.env)) {
    if (!Object.hasOwn(snapshot, key)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

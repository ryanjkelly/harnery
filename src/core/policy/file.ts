import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { stripJsonComments } from "../config.ts";
import { normalizePolicy } from "./evaluate.ts";
import type { NormalizedPolicy, PolicySpec } from "./types.ts";

export function loadPolicyFile(path: string): Readonly<NormalizedPolicy> {
  const absolute = resolve(path);
  let parsed: PolicySpec;
  try {
    parsed = JSON.parse(stripJsonComments(readFileSync(absolute, "utf8"))) as PolicySpec;
  } catch (error) {
    throw new Error(`cannot parse policy at ${absolute}: ${(error as Error).message}`);
  }
  try {
    return normalizePolicy(parsed, { baseDir: dirname(absolute) });
  } catch (error) {
    throw new Error(`invalid policy at ${absolute}: ${(error as Error).message}`);
  }
}

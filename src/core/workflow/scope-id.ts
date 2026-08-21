import { createHash } from "node:crypto";

/** Stable opaque scope identity for a workflow run. Pure and safe for read-only consumers. */
export function stableScopeId<P extends "run" | "wf">(prefix: P, value: string): `${P}_${string}` {
  return `${prefix}_${createHash("sha256").update(value.normalize("NFC")).digest("hex")}`;
}

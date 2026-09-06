import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { PageReviewSourceEvidence } from "./page-review-contracts.ts";

/** The caller supplies the already-canonicalized DOM. Keep every identity input
 * and its order: this receipt diagnoses differences without accepting them. */
export function retainPageReviewSourceIdentity(
  input: { nodes: unknown[]; stylesheets: unknown[]; dom: string },
  artifactPrefix?: string,
): { digest: string; evidence?: PageReviewSourceEvidence } {
  const bytes = Buffer.from(
    JSON.stringify({ nodes: input.nodes, stylesheets: input.stylesheets, dom: input.dom }),
    "utf8",
  );
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (!artifactPrefix) return { digest };

  // Raw source can contain session metadata. Keep it out of stdout and create
  // a private directory per attempt, preserving both sides of a failed retry.
  const prefix = resolve(artifactPrefix);
  mkdirSync(dirname(prefix), { recursive: true, mode: 0o700 });
  const dir = mkdtempSync(`${prefix}.source-identity-`);
  const path = join(dir, `${digest}.json`);
  writeFileSync(path, bytes, { mode: 0o600, flag: "wx" });
  return {
    digest,
    evidence: { path, sha256: digest, bytes: bytes.length, encoding: "utf8" },
  };
}

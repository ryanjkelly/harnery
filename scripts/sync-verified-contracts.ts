/**
 * Maintainer script: write each profile's `verified` block from a live
 * attestation instead of by hand.
 *
 * `verified: { date, version }` records the last real vendor CLI contract a
 * declaration was validated against. It used to be typed from memory, which is
 * how two of three built-in profiles came to name a version nobody was running
 * (ADR 0037). An attestation is an actual observation of the installed CLI
 * (ADR 0038), so it is the only honest source for that field.
 *
 * One rule makes this safe: a `verified` block may only be written from an
 * attestation that AGREES with the declaration. If the attestation contradicts
 * a claim, the claim is wrong, and stamping a fresh version over it would
 * launder a false statement into a verified-looking one. In that case this
 * script refuses and tells you to fix the claim.
 *
 * This is deliberately not a `harn` command. `verified` is a committed source
 * fact about what the maintainer validated, not a per-host value; letting any
 * consumer's machine rewrite it would make the committed value churn.
 *
 *   bun run scripts/sync-verified-contracts.ts            # rewrite profiles.ts
 *   bun run scripts/sync-verified-contracts.ts --check     # report only, exit 2 if stale
 *
 * Record an attestation first: `bin/harn adapter attest --yes`.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  isAttestationCurrent,
  probeBinaryVersion,
  readAttestation,
} from "../src/core/adapters/index.ts";
import { createBuiltinAdapterRegistry } from "../src/core/adapters/registry.ts";
import type { AdapterProfile } from "../src/core/adapters/types.ts";
import { workflowSubscriptionOnly } from "../src/core/config.ts";

const PROFILES_PATH = fileURLToPath(new URL("../src/core/adapters/profiles.ts", import.meta.url));

interface Plan {
  adapter: string;
  action: "write" | "current" | "no-attestation" | "contradicted";
  version?: string;
  date?: string;
  detail: string;
}

function planFor(profile: AdapterProfile): Plan {
  const installed = probeBinaryVersion(profile.binary);
  const record = readAttestation(profile.id);
  if (!isAttestationCurrent(record, installed, profile, workflowSubscriptionOnly())) {
    return {
      adapter: profile.id,
      action: "no-attestation",
      detail: record
        ? "an attestation exists but is stale; re-run `harn adapter attest --yes`"
        : `no attestation recorded${installed ? "" : `; ${profile.binary} is not installed`}`,
    };
  }

  // Refuse to stamp a version onto a declaration the observation contradicts.
  const contradictions = Object.entries(record.observations)
    .filter(([dimension, observed]) => {
      const declared = profile.capabilities[dimension as keyof AdapterProfile["capabilities"]];
      return declared && declared.support !== observed;
    })
    .map(
      ([dimension, observed]) =>
        `${dimension} declared ${profile.capabilities[dimension as keyof AdapterProfile["capabilities"]].support}, observed ${observed}`,
    );

  if (contradictions.length > 0) {
    return {
      adapter: profile.id,
      action: "contradicted",
      detail: `fix the declaration first: ${contradictions.join("; ")}`,
    };
  }

  const date = record.observed_at.slice(0, 10);
  if (profile.verified?.version === record.binary_version && profile.verified?.date === date) {
    return { adapter: profile.id, action: "current", detail: record.binary_version };
  }
  return {
    adapter: profile.id,
    action: "write",
    version: record.binary_version,
    date,
    detail: `${profile.verified ? `${profile.verified.version} (${profile.verified.date})` : "unrecorded"} -> ${record.binary_version} (${date})`,
  };
}

/** Rewrite the `verified` literal inside one profile's object body. The
 * profiles catalog is a plain object literal keyed by adapter id, so the block
 * is located by its key rather than by line number. */
function rewrite(source: string, adapter: string, date: string, version: string): string {
  // Object keys are quoted only when they are not valid identifiers, so
  // `"claude-code":` and `codex:` both appear in the same literal.
  const keyIndex = [`  "${adapter}": {`, `  ${adapter}: {`]
    .map((needle) => source.indexOf(needle))
    .find((index) => index !== -1);
  if (keyIndex === undefined) throw new Error(`could not locate profile block for ${adapter}`);
  const verifiedIndex = source.indexOf("verified: {", keyIndex);
  if (verifiedIndex === -1) throw new Error(`could not locate verified block for ${adapter}`);
  const end = source.indexOf("}", verifiedIndex);
  if (end === -1) throw new Error(`unterminated verified block for ${adapter}`);
  const replacement = `verified: { date: ${JSON.stringify(date)}, version: ${JSON.stringify(version)} `;
  return source.slice(0, verifiedIndex) + replacement + source.slice(end);
}

const check = process.argv.includes("--check");
const registry = createBuiltinAdapterRegistry();
const plans = registry.list().map((adapter) => planFor(adapter.profile));

let source = readFileSync(PROFILES_PATH, "utf8");
let changed = 0;
let refused = 0;

for (const plan of plans) {
  const label = plan.adapter.padEnd(12);
  if (plan.action === "write") {
    console.log(`${label} ${check ? "STALE  " : "write  "} ${plan.detail}`);
    if (!check) source = rewrite(source, plan.adapter, plan.date!, plan.version!);
    changed++;
  } else if (plan.action === "contradicted") {
    console.log(`${label} REFUSED ${plan.detail}`);
    refused++;
  } else if (plan.action === "current") {
    console.log(`${label} current ${plan.detail}`);
  } else {
    console.log(`${label} skip    ${plan.detail}`);
  }
}

if (!check && changed > 0) {
  writeFileSync(PROFILES_PATH, source);
  console.log(`\nwrote ${changed} verified block(s) to src/core/adapters/profiles.ts`);
} else if (!check) {
  console.log("\nno changes");
}

if (refused > 0) {
  console.error("\nrefusing to stamp a verified contract over a contradicted declaration");
  process.exit(1);
}
if (check && changed > 0) {
  console.error("\nverified contracts are stale; run bun run verify:contracts");
  process.exit(2);
}

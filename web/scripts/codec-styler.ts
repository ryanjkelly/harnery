/**
 * Optional detached Codec styler worker.
 *
 * This is the plan's "small read-only worker" host for the inference styler.
 * It is NOT part of the director: no codec render-path module imports it (the
 * boundary test would fail on its child_process import if one ever did). It
 * reads bounded evidence from /api/codec-evidence, makes at most ONE bounded
 * classification request per new evidence signature through the harness CLI
 * the user already has, validates the result with the same output validator
 * the director uses, and writes surviving suggestions to the Codec-owned
 * `.harnery/codec/suggestions.json`. The director merely reads that file and
 * re-validates. Stopping this worker (or never running it) leaves the
 * complete deterministic view.
 *
 * Interpreter policy (plan § interpreter model policy): use the installed
 * harness's current small, fast model; never fall upward to a materially more
 * expensive model; when no suitable interpreter is available, print why and
 * exit 0 with inference disabled.
 *
 * Usage:
 *   bun web/scripts/codec-styler.ts [--base http://localhost:4276] [--once]
 *   bun web/scripts/codec-styler.ts --watch 30
 */

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CodecEvidence, DirectorSuggestion } from "../lib/codec/validator";
import { validateSuggestion } from "../lib/codec/validator";
import { harneryDir } from "../lib/coord-reader";

const EXPRESSIONS =
  "neutral, focused, curious, deliberating, investigating, building, coordinating, waiting, recovering, celebrating, alert";
const SUGGESTION_TTL_MS = 5 * 60_000;
const MODEL_TIMEOUT_MS = 30_000;
/** Bounded per-pass model budget: an unexpected panel flood must not fan out. */
const MAX_CALLS_PER_PASS = 4;

interface Interpreter {
  label: string;
  run: (prompt: string) => string;
}

function probe(cmd: string, args: string[]): boolean {
  try {
    const r = spawnSync(cmd, args, { timeout: 10_000, stdio: "ignore" });
    return r.status === 0;
  } catch {
    return false;
  }
}

/**
 * Interpreters run from a neutral empty directory, never the worker's cwd.
 * A harness launched inside a coordinated repo loads that repo's agent
 * instructions and fires its hooks: the tiny classification request then
 * registers a phantom session on the coordination roster, burns tokens on
 * end-of-turn rituals, and can exceed MODEL_TIMEOUT_MS on ceremony alone
 * (measured 42s vs 6s for the same one-line prompt). The classification
 * needs zero project context, so an empty tmpdir is the correct home.
 */
const NEUTRAL_CWD = fs.mkdtempSync(path.join(os.tmpdir(), "codec-styler-"));

/**
 * Resolve the cheapest WORKING local interpreter; null disables inference.
 * Presence is not enough (an installed harness can still fail headless on
 * expired auth), so each candidate must pass one tiny real request before it
 * is selected — never silently falling upward to a pricier model, only
 * sideways to the next harness or off.
 */
function resolveInterpreter(): Interpreter | null {
  const candidates: Interpreter[] = [];
  if (probe("claude", ["--version"])) {
    candidates.push({
      label: "claude-code/fable",
      run: (prompt) =>
        execFileSync("claude", ["-p", prompt, "--model", "fable"], {
          timeout: MODEL_TIMEOUT_MS,
          encoding: "utf8",
          cwd: NEUTRAL_CWD,
        }),
    });
  }
  if (probe("codex", ["--version"])) {
    candidates.push({
      label: "codex/gpt-5.6-luna",
      run: (prompt) =>
        execFileSync("codex", ["exec", "-m", "gpt-5.6-luna", prompt], {
          timeout: MODEL_TIMEOUT_MS,
          encoding: "utf8",
          cwd: NEUTRAL_CWD,
        }),
    });
  }
  for (const candidate of candidates) {
    try {
      const out = candidate.run('Reply with ONLY this JSON: {"ok":true}');
      if ((extractJson(out) as { ok?: boolean } | null)?.ok === true) return candidate;
      console.error(`[codec-styler] ${candidate.label} responded but not with JSON; skipping.`);
    } catch (err) {
      console.error(
        `[codec-styler] ${candidate.label} failed validation: ${(err as Error).message.split("\n")[0]?.slice(0, 160)}`,
      );
    }
  }
  return null;
}

function evidenceSignature(evidence: CodecEvidence): string {
  const { observed_at: _observedAt, ...rest } = evidence;
  return createHash("sha256").update(JSON.stringify(rest)).digest("hex").slice(0, 24);
}

function buildPrompt(evidence: CodecEvidence, expiresAt: string): string {
  return [
    "You style ONE panel of a read-only agent status board. From the bounded",
    "evidence JSON below, optionally suggest a portrait expression and/or a",
    "focus bubble of AT MOST four words summarizing the current work.",
    `Allowed expressions: ${EXPRESSIONS}.`,
    "Reply with ONLY a JSON object, no prose, in exactly this shape (omit",
    "expression or focus_bubble when you have nothing helpful; reply {} to",
    "suggest nothing):",
    `{"schema_version":1,"instance_id":"${evidence.instance_id}",`,
    `"expression":"<one allowed value>",`,
    `"focus_bubble":{"text":"<max four words>","basis":"inferred"},`,
    `"confidence":"low","evidence_event_ids":["<ids from the evidence>"],`,
    `"expires_at":"${expiresAt}"}`,
    "Cite only event ids that appear in the evidence. Do not invent facts,",
    "outcomes, or emotions beyond what the evidence shows.",
    "",
    `Evidence: ${JSON.stringify(evidence)}`,
  ].join("\n");
}

function extractJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 1)}\n`);
  fs.renameSync(tmp, file);
}

async function pass(base: string, interpreter: Interpreter, root: string): Promise<void> {
  const codecRoot = path.join(root, "codec");
  const suggestionsFile = path.join(codecRoot, "suggestions.json");
  const cacheFile = path.join(codecRoot, "styler-cache.json");

  const res = await fetch(`${base}/api/codec-evidence`);
  if (!res.ok) {
    console.error(`evidence fetch failed: ${res.status}`);
    return;
  }
  const body = (await res.json()) as { evidence?: CodecEvidence[] };
  const evidenceList = body.evidence ?? [];

  const cache = readJson<Record<string, { suggestion: DirectorSuggestion | null }>>(cacheFile, {});
  const now = new Date();
  const kept: DirectorSuggestion[] = [];
  let calls = 0;

  for (const evidence of evidenceList) {
    const signature = evidenceSignature(evidence);
    let entry = cache[signature];
    if (!entry && calls < MAX_CALLS_PER_PASS) {
      calls += 1;
      const expiresAt = new Date(now.getTime() + SUGGESTION_TTL_MS).toISOString();
      let suggestion: DirectorSuggestion | null = null;
      try {
        const raw = extractJson(interpreter.run(buildPrompt(evidence, expiresAt)));
        const verdict = raw ? validateSuggestion(raw, evidence, now.toISOString()) : null;
        if (verdict?.ok) suggestion = verdict.suggestion;
      } catch (err) {
        console.error(`interpreter call failed: ${(err as Error).message.slice(0, 200)}`);
      }
      entry = { suggestion };
      cache[signature] = entry;
    }
    if (entry?.suggestion && Date.parse(entry.suggestion.expires_at) > now.getTime()) {
      kept.push(entry.suggestion);
    }
  }

  // Prune the cache to a sane size (newest wins by insertion order).
  const keys = Object.keys(cache);
  if (keys.length > 500) for (const key of keys.slice(0, keys.length - 500)) delete cache[key];

  writeJsonAtomic(cacheFile, cache);
  writeJsonAtomic(suggestionsFile, { schema_version: 1, suggestions: kept });
  console.log(
    `[codec-styler] ${interpreter.label}: ${evidenceList.length} panels, ${calls} model calls, ${kept.length} live suggestions`,
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const baseIdx = args.indexOf("--base");
  const base = baseIdx >= 0 ? (args[baseIdx + 1] ?? "") : "http://localhost:4276";
  const watchIdx = args.indexOf("--watch");
  const watchSecs = watchIdx >= 0 ? Number(args[watchIdx + 1] ?? 30) : 0;
  // The suggestions file must land in the SAME coord root the queried web
  // server reads (they can differ when the worker runs from a submodule
  // checkout), so print the resolution and allow an explicit override.
  const rootIdx = args.indexOf("--root");
  const root = rootIdx >= 0 ? path.resolve(args[rootIdx + 1] ?? "") : harneryDir();
  console.log(`[codec-styler] base=${base} coord root=${root}`);

  const interpreter = resolveInterpreter();
  if (!interpreter) {
    console.log(
      "[codec-styler] no suitable local interpreter (tried claude, codex); inference stays disabled and the deterministic view is complete without it.",
    );
    return;
  }

  await pass(base, interpreter, root);
  while (watchSecs > 0) {
    await new Promise((resolve) => setTimeout(resolve, watchSecs * 1000));
    await pass(base, interpreter, root);
  }
}

await main();

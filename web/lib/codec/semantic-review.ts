import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  SemanticReviewReceiptV1,
  SemanticReviewStudyV1,
  SemanticReviewSubmissionV1,
} from "harnery/core/semantic";
import { coordRoot } from "../coord-reader";

interface SemanticReviewCommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export async function prepareCodecSemanticReview(): Promise<SemanticReviewStudyV1> {
  const root = coordRoot();
  const result = await runSemanticReviewCommand(["semantic", "review", "prepare", "--root", root]);
  if (!result.ok) throw new Error(commandError(result, "semantic review could not be prepared"));
  return parseCommandJson<SemanticReviewStudyV1>(result.stdout);
}

export async function submitCodecSemanticReview(
  submission: SemanticReviewSubmissionV1,
): Promise<SemanticReviewReceiptV1> {
  const root = coordRoot();
  const temporary = await mkdtemp(path.join(tmpdir(), "harnery-semantic-review-"));
  const file = path.join(temporary, "submission.json");
  try {
    await writeFile(file, `${JSON.stringify(submission)}\n`, { mode: 0o600, flag: "wx" });
    const result = await runSemanticReviewCommand([
      "semantic",
      "review",
      "submit",
      "--file",
      file,
      "--root",
      root,
    ]);
    if (!result.ok) throw new Error(commandError(result, "semantic review could not be stored"));
    return parseCommandJson<SemanticReviewReceiptV1>(result.stdout);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

function harnBinary(root: string): string {
  const embedded = path.join(root, "harnery", "bin", "harn");
  if (existsSync(embedded)) return embedded;
  return path.join(root, "bin", "harn");
}

function runSemanticReviewCommand(args: string[]): Promise<SemanticReviewCommandResult> {
  const root = coordRoot();
  return new Promise((resolve) => {
    const process = spawn(harnBinary(root), args, {
      cwd: root,
      env: { ...globalThis.process.env, HARNERY_COORD_ROOT_OVERRIDE: root },
    });
    let stdout = "";
    let stderr = "";
    process.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    process.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    process.on("close", (code) => {
      resolve({ ok: code === 0, stdout, stderr, exitCode: code });
    });
    process.on("error", (error) => {
      resolve({ ok: false, stdout, stderr: `${stderr}${error.message}`, exitCode: null });
    });
  });
}

function parseCommandJson<T>(stdout: string): T {
  const value = JSON.parse(stdout) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("semantic review command returned an invalid response");
  }
  return value as T;
}

function commandError(result: SemanticReviewCommandResult, fallback: string): string {
  const text = result.stderr.trim() || result.stdout.trim();
  if (!text) return fallback;
  try {
    const value = JSON.parse(text) as { message?: unknown };
    return typeof value.message === "string" ? value.message : fallback;
  } catch {
    return text.slice(0, 240);
  }
}

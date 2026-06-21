import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { NO_DATA } from "./format.ts";

export type PresenceState = "mobile" | "office";
export type PresenceSource = "hook" | "cli";

export interface PresenceRecord {
  state: PresenceState;
  updated_at: string;
  source: PresenceSource;
}

export interface PresenceRead {
  state: PresenceState;
  updated_at: string | null;
  source: PresenceSource | null;
  is_default: boolean;
}

const DEFAULT_STATE: PresenceState = "office";

export function presenceFilePath(): string {
  return join(homedir(), ".claude", "presence");
}

export function readPresence(): PresenceRead {
  const path = presenceFilePath();
  if (!existsSync(path)) {
    return { state: DEFAULT_STATE, updated_at: null, source: null, is_default: true };
  }
  try {
    const raw = readFileSync(path, "utf8").trim();
    const parsed = JSON.parse(raw) as Partial<PresenceRecord>;
    const state =
      parsed.state === "mobile" || parsed.state === "office" ? parsed.state : DEFAULT_STATE;
    const source = parsed.source === "hook" || parsed.source === "cli" ? parsed.source : null;
    return {
      state,
      updated_at: typeof parsed.updated_at === "string" ? parsed.updated_at : null,
      source,
      is_default: false,
    };
  } catch {
    return { state: DEFAULT_STATE, updated_at: null, source: null, is_default: true };
  }
}

export function writePresence(state: PresenceState, source: PresenceSource): PresenceRecord {
  const path = presenceFilePath();
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const record: PresenceRecord = {
    state,
    updated_at: new Date().toISOString(),
    source,
  };
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify(record)}\n`);
  renameSync(tmp, path);
  return record;
}

export function clearPresence(): boolean {
  const path = presenceFilePath();
  if (!existsSync(path)) return false;
  unlinkSync(path);
  return true;
}

const CURLY_RE = /[‘’“”]/;
const STRAIGHT_RE = /['"]/;
const FENCED_BACKTICK_RE = /^```[\s\S]*?^```/gm;
const FENCED_TILDE_RE = /^~~~[\s\S]*?^~~~/gm;
const BLOCK_QUOTE_RE = /^>.*$/gm;

/**
 * Strip fenced code blocks and `>`-quoted lines from the prompt before
 * scanning for quote characters. Pasted code or quoted prose with smart
 * quotes is the most common contamination vector; it shouldn't influence
 * presence inference. Inline code spans are intentionally left as-is.
 */
export function preprocessForDetection(prompt: string): string {
  return prompt
    .replace(FENCED_BACKTICK_RE, "")
    .replace(FENCED_TILDE_RE, "")
    .replace(BLOCK_QUOTE_RE, "");
}

/**
 * Apply the detection rules to a prompt. Returns the inferred state, or null
 * if the prompt carries no actionable signal (mixed quotes, no quotes + not
 * short-trailing-space, etc.), in which case the caller should preserve
 * current state.
 *
 * Rule order (first match wins):
 *   1. Both curly AND straight present -> null (mixed)
 *   2. Curly only -> mobile
 *   3. Straight only -> office
 *   4. <100 chars and ends with space -> mobile
 *   5. Otherwise -> null
 */
export function detectFromPrompt(prompt: string): PresenceState | null {
  const cleaned = preprocessForDetection(prompt);
  const hasCurly = CURLY_RE.test(cleaned);
  const hasStraight = STRAIGHT_RE.test(cleaned);

  if (hasCurly && hasStraight) return null;
  if (hasCurly) return "mobile";
  if (hasStraight) return "office";
  if (prompt.length < 100 && prompt.endsWith(" ")) return "mobile";
  return null;
}

export interface DetectResult {
  changed: boolean;
  before: PresenceState;
  after: PresenceState;
  detected: PresenceState | null;
}

export function applyDetection(prompt: string): DetectResult {
  const current = readPresence();
  const detected = detectFromPrompt(prompt);
  if (detected === null || detected === current.state) {
    return { changed: false, before: current.state, after: current.state, detected };
  }
  writePresence(detected, "hook");
  return { changed: true, before: current.state, after: detected, detected };
}

export function ageSeconds(updated_at: string | null): number | null {
  if (!updated_at) return null;
  const t = Date.parse(updated_at);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((Date.now() - t) / 1000));
}

export function formatAge(seconds: number | null): string {
  if (seconds === null) return NO_DATA;
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

/**
 * The plain end-of-turn status (ADR 0259): the same facts as the status box,
 * written as short everyday sentences for a reader who does not read code.
 *
 * Shape, compact:
 *   ◇ Trent · working on: Fix the table · still in progress
 *   3 other agents are active; none is using the same files · 9:41 AM CDT
 *   Heads up: this conversation has used 85% of its memory
 *
 * The third line appears only when something needs attention. `--full` adds
 * one labelled line per fact instead. The `◇` first line is the Stop hook's
 * detection signal for this style, as `┌─ agent-` is for the box.
 */

import type { TaskState } from "../state/session-state.ts";
import { sanitizeStatusLabel } from "./status-box.ts";

/** First characters of a plain status; the Stop hook looks for them. */
export const PLAIN_STATUS_MARKER = "◇ ";

/** One other agent, reduced to what the plain style needs. */
export interface PlainStatusPeer {
  name: string;
  /** Files this peer holds that this session also touched (basenames or paths). */
  sharedFiles: string[];
}

export interface PlainStatusInput {
  /** Agent name without the `agent-` prefix. */
  name: string;
  task: string;
  state: TaskState;
  stateReason: string | null;
  /** Other agents active now, on this machine and others the status shows. */
  otherAgents: number;
  /** Peers holding a file this session also touched. */
  overlaps: PlainStatusPeer[];
  /** Short clock time, e.g. `9:41 AM CDT`. */
  time: string;
  /** Plain sentences for conditions the box shows only when something is wrong. */
  attention: string[];
}

export interface PlainStatusFullInput extends PlainStatusInput {
  /** Full date and time, e.g. `Sat, Oct 31, 2026, 9:41 AM CDT`. */
  fullTime: string;
  sessionLength: string;
  turnLength: string | null;
  changes: string;
  activity: string;
  startedBy: string;
  memory: string;
  computer: string;
  filesHeld: string[];
  peerNames: string[];
}

export function plainStateWords(state: TaskState, reason: string | null): string {
  if (state === "done") return "finished";
  if (state === "blocked") {
    const why = reason ? sanitizeStatusLabel(reason) : "";
    return why ? `waiting on something: ${why}` : "waiting on something";
  }
  return "still in progress";
}

function headLine(input: PlainStatusInput): string {
  const name = sanitizeStatusLabel(input.name) || "unnamed";
  const task = sanitizeStatusLabel(input.task);
  const doing = task ? `working on: ${task}` : "no task named yet";
  return `${PLAIN_STATUS_MARKER}${name} · ${doing} · ${plainStateWords(input.state, input.stateReason)}`;
}

function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names.at(-1)}`;
}

function capList(items: string[], cap: number): string {
  if (items.length <= cap) return items.join(", ");
  return `${items.slice(0, cap).join(", ")}, and ${items.length - cap} more`;
}

/** The sentence about other agents: a count, plus a warning only for a shared file. */
export function plainPeersSentence(otherAgents: number, overlaps: PlainStatusPeer[]): string {
  const count =
    otherAgents === 0
      ? "No other agents are active"
      : otherAgents === 1
        ? "1 other agent is active"
        : `${otherAgents} other agents are active`;
  const clashing = overlaps.filter((peer) => peer.sharedFiles.length > 0);
  if (clashing.length === 0) {
    if (otherAgents === 0) return count;
    return `${count}; ${otherAgents === 1 ? "it is not" : "none is"} using the same files`;
  }
  const names = clashing.map((peer) => sanitizeStatusLabel(peer.name) || "unnamed");
  const files = [
    ...new Set(clashing.flatMap((peer) => peer.sharedFiles.map((f) => sanitizeStatusLabel(f)))),
  ];
  const who =
    joinNames(names.slice(0, 3)) + (names.length > 3 ? ` and ${names.length - 3} more` : "");
  const verb = names.length === 1 ? "is" : "are";
  return `${count}; careful: ${who} ${verb} also using ${capList(files, 3)}`;
}

/** At most three lines; the third only when something needs attention. */
export function formatPlainStatus(input: PlainStatusInput): string {
  const lines = [
    headLine(input),
    `${plainPeersSentence(input.otherAgents, input.overlaps)} · ${sanitizeStatusLabel(input.time)}`,
  ];
  const attention = input.attention.map((item) => sanitizeStatusLabel(item)).filter(Boolean);
  if (attention.length > 0) lines.push(`Heads up: ${attention.join("; ")}`);
  return lines.join("\n");
}

/** `--full`: one labelled line per fact, still without box drawing. */
export function formatPlainStatusFull(input: PlainStatusFullInput): string {
  const line = (label: string, value: string) => `${label}: ${sanitizeStatusLabel(value)}`;
  const lines = [
    headLine(input),
    line("Session length", input.sessionLength),
    ...(input.turnLength ? [line("This turn", input.turnLength)] : []),
    line("Changes this turn", input.changes),
    line("Doing right now", input.activity),
    line("Started by", input.startedBy),
    line("Conversation memory", input.memory),
    line("Computer", input.computer),
    line(
      "Files this agent holds",
      input.filesHeld.length > 0 ? capList(input.filesHeld, 6) : "none",
    ),
    line(
      "Other agents",
      `${plainPeersSentence(input.otherAgents, input.overlaps)}${
        input.peerNames.length > 0 ? ` (${capList(input.peerNames, 6)})` : ""
      }`,
    ),
  ];
  const attention = input.attention.map((item) => sanitizeStatusLabel(item)).filter(Boolean);
  if (attention.length > 0) lines.push(`Heads up: ${attention.join("; ")}`);
  lines.push(line("Time", input.fullTime));
  return lines.join("\n");
}

const PLAIN_HEAD = /^◇ \S.* · \S/u;
const CLOCK = /\b\d{1,2}:\d{2}\s?[AP]M\b/u;

/** Loose telemetry signal: any line that starts like a plain status head. */
export function textHasPlainStatusHead(text: string): boolean {
  return text.split(/\r?\n/).some((line) => PLAIN_HEAD.test(line.trim()));
}

/**
 * Whether `text` carries a pasted plain status inside a fenced code block.
 * Same strictness as the box detector: a structural header, at least one
 * following content line, contiguous up to the closing fence, and the clock
 * time every plain status prints. Matched on line structure, not wording.
 */
export function containsFencedPlainStatus(text: string): boolean {
  let fence: { marker: string; length: number } | undefined;
  let block: string[] | undefined;
  for (const line of text.split(/\r?\n/)) {
    const fenceLine = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!fence) {
      if (fenceLine && (fenceLine[1]![0] !== "`" || !fenceLine[2]!.includes("`"))) {
        fence = { marker: fenceLine[1]![0]!, length: fenceLine[1]!.length };
        block = undefined;
      }
      continue;
    }
    if (
      fenceLine &&
      fenceLine[1]![0] === fence.marker &&
      fenceLine[1]!.length >= fence.length &&
      fenceLine[2]!.trim().length === 0
    ) {
      if (block && block.length >= 2 && block.some((l) => CLOCK.test(l))) return true;
      fence = undefined;
      block = undefined;
      continue;
    }
    const value = line.trim();
    if (PLAIN_HEAD.test(value)) {
      block = [value];
    } else if (block && value.length > 0) {
      block.push(value);
    } else {
      block = undefined;
    }
  }
  return false;
}

import { EVIDENCE_KINDS } from "./types.ts";

/**
 * Reject an unusable evidence kind before the first agent is spawned.
 *
 * `evidence()` is by construction near the end of a workflow, so an invalid
 * kind throws after every agent has finished. Measured: a fifty-minute run with
 * three completed agents died at its final line on `kind: "design"`, reported
 * `work_failed`, and burned an attempt. The work survived only because it had
 * already been written to the tree; nothing in the proof could recover it.
 *
 * A workflow's evidence kinds are usually written literally, and a literal is
 * checkable by reading the file. Where a kind is computed the scan says nothing
 * and the existing runtime validation still applies — a partial check that
 * costs one file read is worth more than a complete one nobody can implement.
 */

export interface EvidencePreflightProblem {
  kind: string;
  line: number;
}

/** Every literal `evidence({ kind: … })` in this source whose kind is not in the
 * vocabulary. Computed kinds are invisible here, by design. */
export function findInvalidEvidenceKinds(source: string): EvidencePreflightProblem[] {
  const { masked, literals } = maskSource(source);
  const problems: EvidencePreflightProblem[] = [];
  const valid = new Set<string>(EVIDENCE_KINDS);

  for (const call of evidenceCallRanges(masked)) {
    // `kind` as an object key, then the value's first character. A quote there
    // means a literal we can read; anything else is computed, so skip it.
    const property = /\bkind\s*:\s*/g;
    property.lastIndex = 0;
    const slice = masked.slice(call.start, call.end);
    let match = property.exec(slice);
    while (match !== null) {
      const valueAt = call.start + match.index + match[0].length;
      const literal = literals.get(valueAt);
      if (literal !== undefined && !valid.has(literal)) {
        problems.push({ kind: literal, line: lineOf(source, valueAt) });
      }
      match = property.exec(slice);
    }
  }
  return problems;
}

/** The thrown message, or undefined when the script is clean or unreadable. */
export function evidencePreflightError(source: string, scriptPath: string): string | undefined {
  const problems = findInvalidEvidenceKinds(source);
  if (problems.length === 0) return undefined;
  const listed = problems
    .map((problem) => `line ${problem.line}: ${JSON.stringify(problem.kind)}`)
    .join(", ");
  return (
    `${scriptPath}: evidence kind must be one of: ${EVIDENCE_KINDS.join(", ")} ` +
    `(${listed}). Rejected before running, because an invalid kind would otherwise ` +
    `throw at the end of the workflow and discard the work every agent had already done.`
  );
}

interface MaskedSource {
  /** The source with comment bodies and string interiors blanked to spaces, so
   * structural scanning cannot be fooled by a brace or paren inside either.
   * Same length as the input, so every index still maps back. */
  masked: string;
  /** String-literal value, keyed by the index of its opening quote. Template
   * literals are absent: one may interpolate, so its value is not static. */
  literals: Map<number, string>;
}

function maskSource(source: string): MaskedSource {
  const out = source.split("");
  const literals = new Map<number, string>();
  let index = 0;
  const blank = (from: number, to: number): void => {
    for (let i = from; i < to && i < out.length; i++) {
      if (out[i] !== "\n") out[i] = " ";
    }
  };

  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];
    if (char === "/" && next === "/") {
      const end = source.indexOf("\n", index);
      blank(index, end === -1 ? source.length : end);
      index = end === -1 ? source.length : end;
      continue;
    }
    if (char === "/" && next === "*") {
      const end = source.indexOf("*/", index + 2);
      const stop = end === -1 ? source.length : end + 2;
      blank(index, stop);
      index = stop;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      const start = index;
      let cursor = index + 1;
      let value = "";
      while (cursor < source.length) {
        const inner = source[cursor];
        if (inner === "\\") {
          value += source[cursor + 1] ?? "";
          cursor += 2;
          continue;
        }
        if (inner === char) break;
        // An unterminated single- or double-quoted string cannot span lines, so
        // stop rather than swallowing the rest of the file on a syntax error.
        if (inner === "\n" && char !== "`") break;
        value += inner;
        cursor++;
      }
      const closed = source[cursor] === char;
      blank(start + 1, cursor);
      if (closed && char !== "`") literals.set(start, value);
      index = closed ? cursor + 1 : cursor;
      continue;
    }
    index++;
  }
  return { masked: out.join(""), literals };
}

/** The argument list of every `evidence(` call, as index ranges into the masked
 * source. A dotted receiver (`ctx.evidence(`) counts; a longer identifier that
 * merely ends in "evidence" does not. */
function evidenceCallRanges(masked: string): { start: number; end: number }[] {
  const ranges: { start: number; end: number }[] = [];
  const call = /evidence\s*\(/g;
  let match = call.exec(masked);
  while (match !== null) {
    const before = match.index > 0 ? masked[match.index - 1]! : "";
    if (!/[A-Za-z0-9_$]/.test(before)) {
      const open = match.index + match[0].length - 1;
      const close = matchingParen(masked, open);
      if (close > open) ranges.push({ start: open + 1, end: close });
    }
    match = call.exec(masked);
  }
  return ranges;
}

function matchingParen(masked: string, open: number): number {
  let depth = 0;
  for (let i = open; i < masked.length; i++) {
    if (masked[i] === "(") depth++;
    else if (masked[i] === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function lineOf(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i++) {
    if (source[i] === "\n") line++;
  }
  return line;
}

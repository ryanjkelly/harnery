/**
 * Render a JSON value as syntax-highlighted, 2-space-indented JSX. Pure
 * server-renderable component: no useEffect, no client state.
 *
 * Why a custom renderer instead of `JSON.stringify` + a regex highlighter:
 * regex-based JSON highlighting eats real characters from inside strings
 * (e.g. a string value containing `:` gets misclassified as a punct). A
 * tree-walk produces correctly classified tokens with zero ambiguity.
 *
 * String values that are themselves JSON-encoded (a `line` carrying a
 * stringified error blob, a stringified `tool_input` / `output_summary`)
 * are decoded and rendered nested (and recursively, so a doubly-encoded payload
 * expands too) instead of shown as an escaped one-line blob. This is
 * display-only: `copy JSON` in the expand row still serializes the original raw
 * row, so the on-disk encoded form is preserved for fidelity. (The per-field
 * `unpackToolInput` adapter predates this general handling and now only shapes
 * the copied/exported value, not the rendered view.)
 */

import { Fragment, type ReactNode } from "react";

interface Props {
  value: unknown;
  /** Override the indent width. Default 2 spaces. */
  indentSize?: number;
  className?: string;
}

export function ColorizedJson({ value, indentSize = 2, className }: Props) {
  const nodes = renderNode(value, 0, indentSize, 0);
  return (
    <pre
      className={`font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-all ${className ?? ""}`}
    >
      {nodes}
    </pre>
  );
}

const COLORS = {
  key: "text-sky-600 dark:text-sky-400",
  string: "text-emerald-700 dark:text-emerald-400",
  number: "text-amber-600 dark:text-amber-400",
  bool: "text-violet-600 dark:text-violet-400",
  null: "text-rose-600 dark:text-rose-400",
  punct: "text-muted-foreground/70",
} as const;

/** Max levels of JSON-in-string unwrapping. A guardrail, not a functional
 * limit: real events nest 1–3 deep, and decoding terminates on its own anyway
 * (each unwrap consumes the wrapper and descends into a strictly smaller,
 * acyclic tree). This only bounds pathological/adversarial inputs from deep
 * recursion. Past it, an encoded string renders as a plain string rather than
 * expanding further. `decodeDepth` counts string-unwraps along the current
 * path; plain structural nesting (objects/arrays) does NOT count against it. */
const MAX_DECODE_DEPTH = 8;

function renderNode(
  value: unknown,
  depth: number,
  indentSize: number,
  decodeDepth: number,
): ReactNode {
  if (value === null) {
    return <span className={COLORS.null}>null</span>;
  }
  if (value === undefined) {
    return <span className={COLORS.null}>undefined</span>;
  }
  if (typeof value === "boolean") {
    return <span className={COLORS.bool}>{String(value)}</span>;
  }
  if (typeof value === "number") {
    return (
      <span className={COLORS.number}>
        {Number.isFinite(value) ? String(value) : "null"}
      </span>
    );
  }
  if (typeof value === "string") {
    const decoded =
      decodeDepth < MAX_DECODE_DEPTH ? decodeJsonContainer(value) : undefined;
    if (decoded !== undefined) {
      // The string is itself a JSON-encoded object/array (e.g. a `line` holding
      // a stringified error, or a stringified tool payload). Render the decoded
      // value nested + colored at this same depth, identical to how a native
      // object/array value here would render. Recursive: a string-encoded value
      // *inside* the decoded payload decodes too, up to MAX_DECODE_DEPTH.
      return renderNode(decoded, depth, indentSize, decodeDepth + 1);
    }
    return <span className={COLORS.string}>{JSON.stringify(value)}</span>;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return <span className={COLORS.punct}>[]</span>;
    }
    const indent = " ".repeat((depth + 1) * indentSize);
    const closeIndent = " ".repeat(depth * indentSize);
    return (
      <>
        <span className={COLORS.punct}>[</span>
        {"\n"}
        {value.map((item, idx) => (
          <Fragment key={idx}>
            {indent}
            {renderNode(item, depth + 1, indentSize, decodeDepth)}
            {idx < value.length - 1 && (
              <span className={COLORS.punct}>,</span>
            )}
            {"\n"}
          </Fragment>
        ))}
        {closeIndent}
        <span className={COLORS.punct}>]</span>
      </>
    );
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (keys.length === 0) {
      return <span className={COLORS.punct}>{"{}"}</span>;
    }
    const indent = " ".repeat((depth + 1) * indentSize);
    const closeIndent = " ".repeat(depth * indentSize);
    return (
      <>
        <span className={COLORS.punct}>{"{"}</span>
        {"\n"}
        {keys.map((key, idx) => (
          <Fragment key={key}>
            {indent}
            <span className={COLORS.key}>{JSON.stringify(key)}</span>
            <span className={COLORS.punct}>: </span>
            {renderNode(obj[key], depth + 1, indentSize, decodeDepth)}
            {idx < keys.length - 1 && (
              <span className={COLORS.punct}>,</span>
            )}
            {"\n"}
          </Fragment>
        ))}
        {closeIndent}
        <span className={COLORS.punct}>{"}"}</span>
      </>
    );
  }
  return <span className={COLORS.punct}>{String(value)}</span>;
}

/**
 * Decode a string that is itself a JSON-encoded object or array, else return
 * `undefined`. Gated on a `{`/`[` first char so plain prose (URLs, messages,
 * ISO timestamps) is never speculatively parsed, and intentionally limited to
 * containers. Scalar JSON (`"5"`, `"true"`, a quoted string) is left as the
 * literal string it reads as, since "expanding" it would only confuse.
 */
function decodeJsonContainer(
  s: string,
): Record<string, unknown> | unknown[] | undefined {
  const t = s.trim();
  if (t.length < 2) return undefined;
  const first = t[0];
  if (first !== "{" && first !== "[") return undefined;
  try {
    const parsed: unknown = JSON.parse(t);
    if (parsed !== null && typeof parsed === "object") {
      return parsed as Record<string, unknown> | unknown[];
    }
  } catch {
    // not JSON: render as a plain string
  }
  return undefined;
}

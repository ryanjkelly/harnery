/** ANSI color helpers, minimal, no dependencies */
const isColor = process.stdout.isTTY !== false;

const code = (n: number) => (isColor ? `\x1b[${n}m` : "");
const reset = code(0);

export const c = {
  bold: (s: string) => `${code(1)}${s}${reset}`,
  dim: (s: string) => `${code(2)}${s}${reset}`,
  green: (s: string) => `${code(32)}${s}${reset}`,
  red: (s: string) => `${code(31)}${s}${reset}`,
  yellow: (s: string) => `${code(33)}${s}${reset}`,
  cyan: (s: string) => `${code(36)}${s}${reset}`,
  gray: (s: string) => `${code(90)}${s}${reset}`,
  magenta: (s: string) => `${code(35)}${s}${reset}`,
};

/** Placeholder shown when a value is missing (null/empty), e.g. an unknown branch or age. */
export const NO_DATA = "—";

/**
 * Pretty-print + ANSI-colorize a JSON value. 2-space indent. TTY-aware: when
 * stdout is not a TTY, the underlying `c.*` helpers emit no ANSI codes, so
 * output is plain text. Use this for `--pretty` flags on JSON-emitting commands.
 *
 * Colors: keys=cyan, strings=green, numbers=magenta, booleans=yellow, null=dim.
 */
export function colorJson(value: unknown, indent = 0): string {
  const seen = new WeakSet<object>();
  const step = "  ";

  function fmt(v: unknown, depth: number): string {
    if (v === null) return c.dim("null");
    if (typeof v === "boolean") return c.yellow(String(v));
    if (typeof v === "number") return c.magenta(String(v));
    if (typeof v === "string") return c.green(JSON.stringify(v));
    if (typeof v === "bigint") return c.magenta(`${v}n`);
    if (Array.isArray(v)) {
      if (v.length === 0) return "[]";
      if (seen.has(v)) return c.dim('"[Circular]"');
      seen.add(v);
      const pad = step.repeat(depth + 1);
      const close = step.repeat(depth);
      const items = v.map((x) => pad + fmt(x, depth + 1)).join(",\n");
      return `[\n${items}\n${close}]`;
    }
    if (typeof v === "object") {
      // Class instances that define toJSON() (Big.js, Decimal.js, Date, etc.)
      // would render as their raw internal shape if we walked Object.keys
      // directly. Unwrap once so callers see the intended representation
      // (e.g. Big.js → "1.97" instead of its internal {s,e,c} fields).
      const maybeJsonable = v as { toJSON?: () => unknown };
      if (typeof maybeJsonable.toJSON === "function") {
        return fmt(maybeJsonable.toJSON(), depth);
      }
      const obj = v as Record<string, unknown>;
      const keys = Object.keys(obj);
      if (keys.length === 0) return "{}";
      if (seen.has(obj)) return c.dim('"[Circular]"');
      seen.add(obj);
      const pad = step.repeat(depth + 1);
      const close = step.repeat(depth);
      const items = keys
        .map((k) => `${pad}${c.cyan(JSON.stringify(k))}: ${fmt(obj[k], depth + 1)}`)
        .join(",\n");
      return `{\n${items}\n${close}}`;
    }
    return JSON.stringify(v) ?? "null";
  }

  return fmt(value, indent);
}

/** Render a table from rows of objects */
export function table(
  rows: Record<string, unknown>[],
  opts: { maxColWidth?: number } = {},
): string {
  if (rows.length === 0) return c.dim("(no rows)");

  const maxCol = opts.maxColWidth ?? 60;
  const keys = Object.keys(rows[0]!);

  // Compute column widths
  const widths = new Map<string, number>();
  for (const key of keys) {
    let max = key.length;
    for (const row of rows) {
      const val = stringify(row[key]);
      max = Math.max(max, Math.min(val.length, maxCol));
    }
    widths.set(key, max);
  }

  // Header
  const header = keys.map((k) => c.bold(k.padEnd(widths.get(k)!))).join("  ");
  const separator = keys.map((k) => "─".repeat(widths.get(k)!)).join("──");

  // Rows
  const lines = rows.map((row) =>
    keys
      .map((k) => {
        const val = stringify(row[k]);
        const display = val.length > maxCol ? `${val.slice(0, maxCol - 1)}…` : val;
        return display.padEnd(widths.get(k)!);
      })
      .join("  "),
  );

  return [header, separator, ...lines].join("\n");
}

/** Convert a value to a display string */
function stringify(val: unknown): string {
  if (val === null || val === undefined) return "NULL";
  if (typeof val === "object") {
    if (val instanceof Date) return val.toISOString();
    // Some data sources wrap a scalar as { value: "..." }; unwrap to the inner value.
    if ("value" in val && Object.keys(val).length === 1) {
      return String((val as { value: unknown }).value);
    }
    return JSON.stringify(val);
  }
  return String(val);
}

/** Format rows as CSV */
export function csv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "";
  const keys = Object.keys(rows[0]!);
  const header = keys.map(csvEscape).join(",");
  const lines = rows.map((row) => keys.map((k) => csvEscape(stringify(row[k]))).join(","));
  return [header, ...lines].join("\n");
}

function csvEscape(val: string): string {
  if (val.includes(",") || val.includes('"') || val.includes("\n")) {
    return `"${val.replace(/"/g, '""')}"`;
  }
  return val;
}

/** Print a labeled key-value section */
export function kvLine(label: string, value: string, color?: (s: string) => string): string {
  const colorFn = color ?? ((s: string) => s);
  return `  ${c.dim(label.padEnd(14))} ${colorFn(value)}`;
}

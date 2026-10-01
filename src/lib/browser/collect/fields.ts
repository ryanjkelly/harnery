/**
 * Field extractor grammar shared by presets and `--collect-field`.
 *
 *   <name>=<selector>[@<attr>]
 *   <name>[]=<selector>[@<attr>]     every match, as a de-duplicated array
 *
 * The selector runs inside each item. An empty selector or `:scope` means the
 * item itself. Without `@attr` the value is the element's visible text; with
 * it, the attribute (href and src resolve to absolute URLs).
 */

export interface Extractor {
  /** CSS selector relative to the item; "" means the item itself. */
  selector: string;
  /** Attribute to read; null reads visible text. */
  attr: string | null;
}

export interface FieldSpec extends Extractor {
  name: string;
  /** Collect every match as an array instead of the first one. */
  all: boolean;
}

/** Item properties the collector owns; fields cannot reuse these names. */
export const RESERVED_FIELD_NAMES = new Set(["key", "firstSeenStep"]);

const NAME_RE = /^[A-Za-z_][\w-]*$/;
const ATTR_RE = /^[A-Za-z_:][-\w:.]*$/;

/**
 * Parse `<selector>[@<attr>]`. The attribute separator is the last `@` that
 * sits outside quotes and brackets, so `a[href*="@"]@href` works.
 */
export function parseExtractor(spec: string): Extractor {
  const text = spec.trim();
  let at = -1;
  let quote: string | null = null;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "[" || ch === "(") depth++;
    else if (ch === "]" || ch === ")") depth = Math.max(0, depth - 1);
    else if (ch === "@" && depth === 0) at = i;
  }
  let selector = text;
  let attr: string | null = null;
  if (at >= 0) {
    const candidate = text.slice(at + 1).trim();
    if (!ATTR_RE.test(candidate)) {
      throw new Error(`Extractor "${spec}": "${candidate}" is not a valid attribute name.`);
    }
    attr = candidate;
    selector = text.slice(0, at).trim();
  }
  if (selector === ":scope") selector = "";
  return { selector, attr };
}

/** Parse `<name>=<extractor>` or `<name>[]=<extractor>`. */
export function parseFieldSpec(raw: string): FieldSpec {
  const eq = raw.indexOf("=");
  if (eq <= 0) {
    throw new Error(
      `--collect-field expects <name>=<selector>[@attr] (got "${raw}"). Example: time=time@datetime`,
    );
  }
  let name = raw.slice(0, eq).trim();
  let all = false;
  if (name.endsWith("[]")) {
    all = true;
    name = name.slice(0, -2);
  }
  if (!NAME_RE.test(name)) {
    throw new Error(`Field name "${name}" must start with a letter or _ and use word characters.`);
  }
  if (RESERVED_FIELD_NAMES.has(name)) {
    throw new Error(`Field name "${name}" is reserved by the collector.`);
  }
  return { name, all, ...parseExtractor(raw.slice(eq + 1)) };
}

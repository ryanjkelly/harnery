// Value assertions for `harn browse --assert`.
//
// The layout + content checks answer "does the page look right"; asserts answer
// "does the page SAY the right thing" — the h1 text, a price, how many cards
// rendered, whether an error banner is absent. It lets an agent confirm the
// values it expects without a human reading the page back.
//
// One repeatable flag with a small grammar:
//   --assert 'text h1 => Welcome'          first match's trimmed text equals
//   --assert 'contains .total => $49'      first match's text contains
//   --assert 'matches .sku => ^BN-\d+$'    first match's text matches a regex
//   --assert 'count .card => >=3'          match count vs a number or comparator
//   --assert 'exists .cta'                 at least one match
//   --assert 'absent .error'               zero matches
//
// `op selector => expected`; `exists`/`absent` take no `=> expected`.

export type AssertOp = "text" | "contains" | "matches" | "count" | "exists" | "absent";

export interface AssertSpec {
  raw: string;
  op: AssertOp;
  selector: string;
  expected: string;
}

export interface AssertResult {
  raw: string;
  op: AssertOp;
  selector: string;
  expected: string;
  /** Observed value: the text, or the match count as a string. */
  actual: string;
  found: boolean;
  outcome: "pass" | "fail";
  /** Populated when the spec itself was malformed (e.g. bad regex, bad count). */
  error?: string;
}

const OPS: readonly AssertOp[] = ["text", "contains", "matches", "count", "exists", "absent"];

/** Parse one `--assert` expression. Throws with a clear message on malformed input. */
export function parseAssertSpec(raw: string): AssertSpec {
  const trimmed = raw.trim();
  const spaceIdx = trimmed.indexOf(" ");
  if (spaceIdx < 0) {
    throw new Error(`--assert needs '<op> <selector> [=> expected]' (got: '${raw}')`);
  }
  const op = trimmed.slice(0, spaceIdx).toLowerCase() as AssertOp;
  if (!OPS.includes(op)) {
    throw new Error(`--assert op must be one of ${OPS.join(", ")} (got: '${op}')`);
  }
  const rest = trimmed.slice(spaceIdx + 1).trim();
  const sep = rest.indexOf("=>");
  if (op === "exists" || op === "absent") {
    return { raw, op, selector: (sep < 0 ? rest : rest.slice(0, sep)).trim(), expected: "" };
  }
  if (sep < 0) {
    throw new Error(`--assert '${op}' needs 'selector => expected' (got: '${raw}')`);
  }
  return {
    raw,
    op,
    selector: rest.slice(0, sep).trim(),
    expected: rest.slice(sep + 2).trim(),
  };
}

/**
 * Build the page evaluator. Serialized into the page by Playwright, so helpers
 * are nested. Comparison logic that does not touch the DOM (count comparators,
 * regex) also runs in-page to keep it one round trip.
 */
export function buildAssertCheck(): (specs: AssertSpec[]) => AssertResult[] {
  return (specs) => {
    const textOf = (el: Element): string => (el.textContent ?? "").replace(/\s+/g, " ").trim();

    const compareCount = (count: number, expected: string): { ok: boolean; error?: string } => {
      const m = /^(>=|<=|>|<|=)?\s*(\d+)$/.exec(expected.trim());
      if (!m) return { ok: false, error: `bad count expected '${expected}'` };
      const op = m[1] || "=";
      const n = Number.parseInt(m[2]!, 10);
      switch (op) {
        case ">=":
          return { ok: count >= n };
        case "<=":
          return { ok: count <= n };
        case ">":
          return { ok: count > n };
        case "<":
          return { ok: count < n };
        default:
          return { ok: count === n };
      }
    };

    return specs.map((spec): AssertResult => {
      const base = {
        raw: spec.raw,
        op: spec.op,
        selector: spec.selector,
        expected: spec.expected,
      };
      let nodes: Element[];
      try {
        nodes = Array.from(document.querySelectorAll(spec.selector));
      } catch {
        return { ...base, actual: "", found: false, outcome: "fail", error: "invalid selector" };
      }
      const first = nodes[0] ?? null;
      const firstText = first ? textOf(first) : "";

      switch (spec.op) {
        case "exists":
          return {
            ...base,
            actual: String(nodes.length),
            found: nodes.length > 0,
            outcome: nodes.length > 0 ? "pass" : "fail",
          };
        case "absent":
          return {
            ...base,
            actual: String(nodes.length),
            found: nodes.length > 0,
            outcome: nodes.length === 0 ? "pass" : "fail",
          };
        case "count": {
          const { ok, error } = compareCount(nodes.length, spec.expected);
          return {
            ...base,
            actual: String(nodes.length),
            found: true,
            outcome: ok ? "pass" : "fail",
            ...(error ? { error } : {}),
          };
        }
        case "text":
          return {
            ...base,
            actual: firstText,
            found: !!first,
            outcome: first && firstText === spec.expected ? "pass" : "fail",
          };
        case "contains":
          return {
            ...base,
            actual: firstText,
            found: !!first,
            outcome: first && firstText.includes(spec.expected) ? "pass" : "fail",
          };
        case "matches": {
          let re: RegExp;
          try {
            re = new RegExp(spec.expected);
          } catch {
            return {
              ...base,
              actual: firstText,
              found: !!first,
              outcome: "fail",
              error: `invalid regex '${spec.expected}'`,
            };
          }
          return {
            ...base,
            actual: firstText,
            found: !!first,
            outcome: first && re.test(firstText) ? "pass" : "fail",
          };
        }
        default:
          return { ...base, actual: "", found: false, outcome: "fail", error: "unknown op" };
      }
    });
  };
}

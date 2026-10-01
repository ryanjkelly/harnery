/**
 * Split a `browse --batch` string into steps.
 *
 * Steps are separated by `;`. Two rules keep JavaScript intact:
 *
 * 1. A step that starts with the `eval` verb ends only at a `;` that sits
 *    outside JavaScript quotes ('...', "...", `...`) and outside (), [] and {}.
 *    So `eval (() => { const a = 1; return a })(); wait 500` is two steps.
 * 2. Every other step ends at the next `;`, exactly as before. Selectors and
 *    fill values may contain apostrophes or brackets that are not balanced
 *    JavaScript, so they get no quote or bracket tracking.
 *
 * `\;` always inserts a literal `;` without ending the step, in any verb.
 * A top-level `;` inside an eval (two bare statements) still ends the step:
 * wrap multiple statements in a block or an arrow function.
 */
export function splitBatchSteps(input: string): string[] {
  const steps: string[] = [];
  let buf = "";
  let stepStart = true;
  let jsAware = false;
  let quote: string | null = null;
  let depth = 0;

  const endStep = () => {
    if (buf.trim()) steps.push(buf);
    buf = "";
    stepStart = true;
    jsAware = false;
    quote = null;
    depth = 0;
  };

  for (let i = 0; i < input.length; i++) {
    if (stepStart) {
      // Decide the splitting rule once per step from its leading verb.
      jsAware = /^\s*eval(\s|$)/i.test(input.slice(i));
      stepStart = false;
    }
    const ch = input[i] as string;
    if (ch === "\\" && input[i + 1] === ";") {
      buf += ";";
      i++;
      continue;
    }
    if (jsAware) {
      if (quote) {
        buf += ch;
        if (ch === "\\" && i + 1 < input.length) {
          buf += input[i + 1];
          i++;
        } else if (ch === quote) {
          quote = null;
        }
        continue;
      }
      if (ch === "'" || ch === '"' || ch === "`") {
        quote = ch;
        buf += ch;
        continue;
      }
      if (ch === "(" || ch === "[" || ch === "{") depth++;
      else if (ch === ")" || ch === "]" || ch === "}") depth = Math.max(0, depth - 1);
      if (ch === ";" && depth === 0) {
        endStep();
        continue;
      }
      buf += ch;
      continue;
    }
    if (ch === ";") {
      endStep();
      continue;
    }
    buf += ch;
  }
  if (buf.trim()) steps.push(buf);
  return steps;
}

import { describe, expect, test } from "bun:test";
import { splitBatchSteps } from "./batch-steps.ts";

const trimmed = (input: string) => splitBatchSteps(input).map((s) => s.trim());

describe("splitBatchSteps", () => {
  test("splits plain steps on every semicolon", () => {
    expect(trimmed("click button; wait 1500; reload; wait 3000")).toEqual([
      "click button",
      "wait 1500",
      "reload",
      "wait 3000",
    ]);
  });

  test("drops empty steps", () => {
    expect(trimmed(";; click a ;  ; wait 10;")).toEqual(["click a", "wait 10"]);
  });

  test("keeps semicolons inside eval braces, parens and brackets", () => {
    expect(
      trimmed(
        "eval (() => { const a = 1; return [a, 2]; })(); wait 500; eval window.scrollBy(0,10)",
      ),
    ).toEqual([
      "eval (() => { const a = 1; return [a, 2]; })()",
      "wait 500",
      "eval window.scrollBy(0,10)",
    ]);
  });

  test("keeps semicolons inside eval string and template literals", () => {
    expect(trimmed(`eval x = "a;b"; eval y = 'c;d'; eval z = \`e;\${1};f\`; wait 1`)).toEqual([
      `eval x = "a;b"`,
      `eval y = 'c;d'`,
      `eval z = \`e;\${1};f\``,
      "wait 1",
    ]);
  });

  test("respects escaped quotes inside eval strings", () => {
    expect(trimmed(`eval s = "say \\"hi;\\""; wait 1`)).toEqual([
      `eval s = "say \\"hi;\\""`,
      "wait 1",
    ]);
  });

  test("a feed harvester with arrow bodies stays one step", () => {
    const grab =
      'document.querySelectorAll("article").forEach(a=>{const t=a.querySelector("time"); window.__acc[a.id]={t}})';
    expect(trimmed(`wait 3000; eval ${grab}; eval window.scrollBy(0,2500); wait 2200`)).toEqual([
      "wait 3000",
      `eval ${grab}`,
      "eval window.scrollBy(0,2500)",
      "wait 2200",
    ]);
  });

  test("non-eval steps get no quote tracking, so an apostrophe cannot swallow the rest", () => {
    expect(trimmed("fill input[name=q]=>it's here; press Enter; wait 100")).toEqual([
      "fill input[name=q]=>it's here",
      "press Enter",
      "wait 100",
    ]);
  });

  test("an unbalanced eval does not leak tracking into later steps once closed", () => {
    expect(trimmed("eval f(); click a[title='x']; wait 5")).toEqual([
      "eval f()",
      "click a[title='x']",
      "wait 5",
    ]);
  });

  test("backslash-semicolon is a literal semicolon in any verb", () => {
    expect(trimmed("fill input=>a\\;b; eval 1\\;2; wait 1")).toEqual([
      "fill input=>a;b",
      "eval 1;2",
      "wait 1",
    ]);
  });

  test("verb detection is case-insensitive and needs a word boundary", () => {
    expect(trimmed("EVAL f({a:1;}); evaluator; x")).toEqual(["EVAL f({a:1;})", "evaluator", "x"]);
  });
});

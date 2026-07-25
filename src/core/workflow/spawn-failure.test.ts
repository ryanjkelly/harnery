import { describe, expect, test } from "bun:test";
import { isUpstreamFailureText, vendorFailureText } from "./spawn-failure.ts";

describe("vendorFailureText", () => {
  test("keeps the tail, where the reason is", () => {
    // Observed shape: banner and resolved config first, real failure last.
    const stderr = [
      "ERROR codex_models_manager::cache: failed to load models cache",
      "OpenAI Codex v0.144.5",
      "-".repeat(400),
      "workdir: /tmp",
      "ERROR: Your workspace is out of credits. Add credits to continue.",
    ].join("\n");
    const text = vendorFailureText({ stderr, stdout: "" });
    expect(text).toContain("out of credits");
    expect(text).not.toContain("failed to load models cache");
    expect(text.startsWith("…")).toBe(true);
  });

  test("includes both streams so the reason survives on either", () => {
    const text = vendorFailureText({ stdout: "reason on stdout", stderr: "warning on stderr" });
    expect(text).toContain("reason on stdout");
    expect(text).toContain("warning on stderr");
  });

  test("stderr leads when both are present", () => {
    const text = vendorFailureText({ stdout: "second", stderr: "first" });
    expect(text.indexOf("first")).toBeLessThan(text.indexOf("second"));
  });

  test("short text is returned whole, with no ellipsis", () => {
    expect(vendorFailureText({ stderr: "boom" })).toBe("boom");
  });

  test("empty streams yield an empty string rather than noise", () => {
    expect(vendorFailureText({ stdout: "  ", stderr: "" })).toBe("");
    expect(vendorFailureText({})).toBe("");
  });

  test("the bound is respected", () => {
    expect(vendorFailureText({ stderr: "x".repeat(5000) }, 100)).toHaveLength(101);
  });
});

// ADR 0046: upstream is the one class with no structural signal, so it is the
// one text match in the classifier. The list is deliberately SHORT — a false
// positive wrongly withholds a charge (grants an uncharged retry), so it must
// stay tight and refuse to grow into a per-vendor regex zoo.
describe("isUpstreamFailureText (ADR 0046)", () => {
  test("bare 5xx and 429 statuses read as upstream", () => {
    for (const status of ["500", "502", "503", "504", "599", "429"]) {
      expect(isUpstreamFailureText(`request failed with status ${status}`)).toBe(true);
    }
  });

  test("a status embedded in a longer number does not match", () => {
    // "4295"/"5031" are not statuses; matching them would misclassify unrelated
    // ids and hashes as upstream.
    expect(isUpstreamFailureText("id 4295 not found")).toBe(false);
    expect(isUpstreamFailureText("record 5031 missing")).toBe(false);
    expect(isUpstreamFailureText("value 15000 exceeded")).toBe(false);
  });

  test("a 5xx/429 outside HTTP-status context does not match (f1)", () => {
    // Operator finding f1: a bare-number match treats a line number, an item
    // count, or a duration that merely lands in the 429/5xx range as an upstream
    // refusal — wrongly withholding a charge for a failure that was entirely our
    // code, then blocking with a misleading "waiting on an outside service"
    // reason. The number must sit in status context to count.
    expect(isUpstreamFailureText("TypeError at line 500 in foo.ts")).toBe(false);
    expect(isUpstreamFailureText("assertion failed: got 429 items, wanted 430")).toBe(false);
    expect(isUpstreamFailureText("Error: exited after 502 seconds")).toBe(false);
    // Other everyday numbers in the range, none of them statuses.
    expect(isUpstreamFailureText("processed 500 records")).toBe(false);
    expect(isUpstreamFailureText("waited 503ms for a lock")).toBe(false);
    expect(isUpstreamFailureText("port 5001 already in use")).toBe(false);
  });

  test("a status in HTTP-status context matches", () => {
    // The genuine upstream shapes: after an HTTP/status label, or a bare status
    // line "<code> <Reason-Phrase>".
    expect(isUpstreamFailureText("HTTP 429")).toBe(true);
    expect(isUpstreamFailureText("HTTP/1.1 503 Service Unavailable")).toBe(true);
    expect(isUpstreamFailureText("status: 500")).toBe(true);
    expect(isUpstreamFailureText("status code 502")).toBe(true);
    expect(isUpstreamFailureText("429 Too Many Requests")).toBe(true);
    // The live 2026-07-25 outage as a bare status line.
    expect(isUpstreamFailureText("503 biscuit_baker_service_me_circuit_open")).toBe(true);
  });

  test("explicit vendor wording matches even without a numeric status", () => {
    // The live 2026-07-25 outage: a circuit-open refusal with no status number.
    expect(isUpstreamFailureText("upstream refused: circuit_open")).toBe(true);
    expect(isUpstreamFailureText("Service Unavailable")).toBe(true);
    expect(isUpstreamFailureText("Too Many Requests")).toBe(true);
    expect(isUpstreamFailureText("the model provider is overloaded")).toBe(true);
    expect(isUpstreamFailureText("502 Bad Gateway")).toBe(true);
    expect(isUpstreamFailureText("gateway timeout")).toBe(true);
  });

  test("an ordinary work failure is NOT upstream — it stays charged", () => {
    // The default-to-charging property: anything not positively upstream falls
    // through to a charged work failure.
    expect(isUpstreamFailureText("codex exited 1: your workspace is out of credits")).toBe(false);
    expect(isUpstreamFailureText("schema validation failed after 2 attempts")).toBe(false);
    expect(isUpstreamFailureText("TypeError: cannot read property of undefined")).toBe(false);
    expect(isUpstreamFailureText("")).toBe(false);
  });
});

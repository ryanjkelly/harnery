import { describe, expect, test } from "bun:test";
import { vendorFailureText } from "./spawn-failure.ts";

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

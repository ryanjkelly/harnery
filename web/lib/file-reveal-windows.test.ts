import { expect, test } from "bun:test";
import { explorerRevealScript } from "./file-reveal-windows";

test("Windows paths stay data rather than executable PowerShell", () => {
  const filename = "\\\\wsl.localhost\\Ubuntu\\repo\\A user's $(exit 99) `file`; café.json";
  const script = explorerRevealScript(filename);
  expect(script).not.toContain(filename);
  expect(script).not.toContain("$(exit 99)");
  const encoded = /FromBase64String\('([^']+)'\)/.exec(script)?.[1];
  expect(encoded).toBeDefined();
  expect(Buffer.from(encoded!, "base64").toString("utf8")).toBe(filename);
});

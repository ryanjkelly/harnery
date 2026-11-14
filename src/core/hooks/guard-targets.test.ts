import { describe, expect, test } from "bun:test";
import { applyPatchPaths, writeToolFilePath, writeToolTargets } from "./guard-targets.ts";

// Larger than the 8000-character clamp applied to the ledger's copy of tool_input.
const BIG = "x".repeat(20_000);

describe("writeToolTargets", () => {
  test("names the file of a Write whose content is larger than the ledger clamp", () => {
    expect(writeToolTargets("Write", { file_path: "/repo/big.ts", content: BIG })).toEqual([
      "/repo/big.ts",
    ]);
  });

  test("reads path and notebook_path, and a JSON-string input", () => {
    expect(writeToolTargets("StrReplace", { path: "a.ts" })).toEqual(["a.ts"]);
    expect(writeToolTargets("NotebookEdit", { notebook_path: "n.ipynb" })).toEqual(["n.ipynb"]);
    expect(
      writeToolTargets("Edit", JSON.stringify({ file_path: "e.ts", old_string: BIG })),
    ).toEqual(["e.ts"]);
  });

  test("returns nothing for non-write tools and inputs without a path", () => {
    expect(writeToolTargets("Bash", { command: "ls" })).toEqual([]);
    expect(writeToolTargets("Write", { content: "x" })).toEqual([]);
    expect(writeToolTargets("Write", undefined)).toEqual([]);
    expect(writeToolTargets("Write", "not json")).toEqual([]);
    expect(writeToolFilePath({ file_path: "" })).toBeUndefined();
  });
});

describe("applyPatchPaths", () => {
  const patch = [
    "*** Begin Patch",
    "*** Add File: src/new.ts",
    `+${BIG}`,
    "*** Update File: src/old.ts",
    "@@",
    "-a",
    "+b",
    "*** Delete File: src/gone.ts",
    "*** End Patch",
  ].join("\n");
  const paths = ["src/new.ts", "src/old.ts", "src/gone.ts"];

  test("reads a large patch in every shape the adapters deliver", () => {
    expect(applyPatchPaths(patch)).toEqual(paths);
    expect(applyPatchPaths({ command: patch })).toEqual(paths);
    expect(applyPatchPaths({ patch })).toEqual(paths);
    expect(applyPatchPaths({ input: patch })).toEqual(paths);
    expect(writeToolTargets("apply_patch", { command: patch })).toEqual(paths);
  });

  test("returns nothing without a patch body", () => {
    expect(applyPatchPaths({})).toEqual([]);
    expect(applyPatchPaths("plain text")).toEqual([]);
  });
});

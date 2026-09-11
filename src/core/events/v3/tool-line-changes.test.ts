import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareToolLineChanges } from "./tool-line-changes.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function root() {
  const path = mkdtempSync(join(tmpdir(), "line-count-test-"));
  roots.push(path);
  return path;
}
function count(cwd: string, tool_name: string, tool_input: unknown) {
  return prepareToolLineChanges({ tool_name, tool_input, raw: {} }, cwd);
}

test("counts patch updates, new files, and complete deletions before they disappear", () => {
  const cwd = root();
  writeFileSync(join(cwd, "gone.txt"), "one\ntwo");
  expect(
    count(
      cwd,
      "apply_patch",
      "*** Begin Patch\n*** Update File: existing.txt\n@@\n-old\n+new\n+extra\n context\n*** Add File: fresh.txt\n+first\n*** Delete File: gone.txt\n*** End Patch",
    ),
  ).toEqual({ added: 3, removed: 3 });
});

test("accepts JSON-wrapped patches without counting directive or context lines", () => {
  expect(
    count(
      root(),
      "apply_patch",
      JSON.stringify({
        patch: "*** Begin Patch\n*** Update File: a\n*** Move to: b\n@@\n same\n*** End Patch",
      }),
    ),
  ).toEqual({ added: 0, removed: 0 });
});

test("accepts the Codex hook's command envelope", () => {
  expect(
    count(root(), "apply_patch", {
      command: "*** Begin Patch\n*** Add File: a\n+first\n+second\n*** End Patch",
    }),
  ).toEqual({ added: 2, removed: 0 });
});

test("Write compares against existing contents and handles creation and empty files", () => {
  const cwd = root();
  writeFileSync(join(cwd, "a"), "keep\nold\n");
  expect(count(cwd, "Write", { file_path: "a", content: "keep\nnew\nextra\n" })).toEqual({
    added: 2,
    removed: 1,
  });
  expect(count(cwd, "Write", { file_path: "new", content: "first\nlast" })).toEqual({
    added: 2,
    removed: 0,
  });
  expect(count(cwd, "Write", { file_path: "empty", content: "" })).toEqual({
    added: 0,
    removed: 0,
  });
});

test("Edit counts changed lines, repeated replacements, and literal dollar strings", () => {
  const cwd = root();
  writeFileSync(join(cwd, "a"), "repeat\nrepeat\nkeep\n");
  const edit = { file_path: "a", old_string: "repeat", new_string: "$&", replace_all: true };
  expect(count(cwd, "Edit", edit)).toEqual({ added: 2, removed: 2 });
  expect(count(cwd, "Edit", { ...edit, replace_all: false })).toBeUndefined();
  expect(count(cwd, "Edit", { ...edit, old_string: "absent" })).toBeUndefined();
});

test("MultiEdit applies sequential replacements before counting", () => {
  const cwd = root();
  writeFileSync(join(cwd, "a"), "before\n");
  expect(
    count(cwd, "MultiEdit", {
      file_path: "a",
      edits: [
        { old_string: "before", new_string: "middle" },
        { old_string: "middle", new_string: "after" },
      ],
    }),
  ).toEqual({ added: 1, removed: 1 });
});

test("unknown, binary, inaccessible, and malformed edits never become zero", () => {
  const cwd = root();
  writeFileSync(join(cwd, "binary"), Buffer.from([0, 1]));
  expect(count(cwd, "Write", { file_path: "binary", content: "new" })).toBeUndefined();
  expect(
    count(cwd, "apply_patch", "*** Begin Patch\n*** Delete File: missing\n*** End Patch"),
  ).toBeUndefined();
  expect(count(cwd, "exec_command", { cmd: "python change.py" })).toBeUndefined();
  expect(count(cwd, "Read", { file_path: "a" })).toEqual({ added: 0, removed: 0 });
});

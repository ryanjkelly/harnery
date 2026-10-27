import { describe, expect, test } from "bun:test";
import { shellCommitTreeReason } from "./shell-commit-tree.ts";

describe("git commit-tree guard", () => {
  const blocked = [
    "git commit-tree HEAD^{tree} -p origin/main -m msg",
    "GIT_INDEX_FILE=/tmp/idx git commit-tree $TREE -p $PARENT -m x",
    "c=$(git commit-tree $t -m x) && git push origin $c:main",
    "git -C app commit-tree $t -m x",
    "git -c user.name=a --no-pager commit-tree $t -m x",
    "bash -lc 'git commit-tree $t -m x'",
    "env GIT_INDEX_FILE=/tmp/i git commit-tree $t -m x",
  ];
  for (const command of blocked) {
    test(`blocks ${command}`, () => {
      expect(shellCommitTreeReason("Bash", { command }, "acme")).toContain("acme admission status");
    });
  }
  const allowed = [
    "git commit -m 'avoid git commit-tree'",
    'echo "git commit-tree is plumbing"',
    "grep -rn commit-tree docs",
    "git log --oneline -3",
    "HARNERY_ALLOW_COMMIT_TREE=1 git commit-tree $t -m x",
    "man git-commit-tree | head",
  ];
  for (const command of allowed) {
    test(`allows ${command}`, () => {
      expect(shellCommitTreeReason("Bash", { command }, "acme")).toBeNull();
    });
  }
  test("ignores non-shell tools", () => {
    expect(shellCommitTreeReason("Edit", { command: "git commit-tree x" }, "acme")).toBeNull();
  });
});

import { describe, expect, test } from "bun:test";
import { shellRmReason } from "./shell-rm.ts";

describe("shell rm guard", () => {
  const blocked = [
    "rm $D/$OLD",
    "rm -rf build",
    "cd /repo; D=docs; cp new.mp4 $D/new.mp4; rm $D/old.mp4; ls -la $D",
    "true && /bin/rm -f out.txt",
    "sudo -n rm -f /tmp/x",
    "FOO=1 rm x",
    "find . -name '*.tmp' -exec rm {} ;",
    "ls *.log | xargs -n 1 rm -f",
    "bash -lc 'rm -rf dist'",
    "echo $(rm x)",
    "if test -f x; then rm x; fi",
    "command rm x",
  ];
  for (const command of blocked) {
    test(`blocks ${command}`, () => {
      expect(shellRmReason("Bash", { command }, "acme")).toContain("acme rm --root");
    });
  }
  const allowed = [
    "acme rm --root /tmp/s /tmp/s/a.txt --yes",
    "git rm docs/old.md",
    "docker rm -f web",
    "npm rm left-pad",
    'echo "rm -rf build"',
    "grep -rn 'rm -f' scripts",
    "rmdir empty",
    "cat <<'EOF' > doc.md\nrm -rf build\nEOF",
    "HARNERY_ALLOW_RM=1 rm -f /tmp/x",
    "trap 'rm -f $tmp' EXIT",
    "# rm old files later\nls",
    "find . -name '*.tmp' -print",
  ];
  for (const command of allowed) {
    test(`allows ${JSON.stringify(command)}`, () => {
      expect(shellRmReason("Bash", { command }, "acme")).toBeNull();
    });
  }
  test("ignores non-shell tools", () => {
    expect(shellRmReason("Write", { command: "rm x" }, "acme")).toBeNull();
  });
  test("reads Codex exec_command input", () => {
    expect(shellRmReason("exec_command", JSON.stringify({ cmd: "rm x" }), "harn")).toContain(
      "harn rm --root",
    );
  });
});

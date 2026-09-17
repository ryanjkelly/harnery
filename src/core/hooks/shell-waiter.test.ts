import { describe, expect, test } from "bun:test";
import { shellWaiterReason } from "./shell-waiter.ts";

describe("inline shell waiter guard", () => {
  const blocked = [
    'until grep -qE "verdict|PASS|FAIL" /tmp/job.log; do sleep 45; done',
    "until ! pgrep -f image-builder >/dev/null; do sleep 10; done",
    "while pgrep -f image-builder; do :; done",
    'while kill -0 "$pid"; do sleep 1; done',
    "while true; do tail -10 /tmp/job.log; sleep 45; done",
    "for i in 1 2 3; do sleep 3; grep PASS /tmp/job.log; done",
    "until test -f /tmp/done; do /bin/sleep 2; done",
    "sleep 45; tail -40 /tmp/job.log",
    "cd /tmp && sleep 45 && tail -40 job.log | grep PASS",
    "(sleep 45; cat /tmp/job.log) &",
    "bash -lc 'until grep -q PASS /tmp/job.log; do sleep 2; done'",
    "timeout 60s bash -c 'until grep -q PASS /tmp/job.log; do sleep 2; done'",
    "# wait for result\nuntil test -f /tmp/done\ndo\n sleep 1\ndone",
    "until test -f /tmp/done; do command sleep 1; done",
    "sleep 1 \\\n && tail -10 /tmp/job.log",
  ];
  for (const command of blocked) {
    test(`blocks ${command}`, () => {
      expect(
        shellWaiterReason("Bash", { command, timeout: 1000, run_in_background: true }),
      ).toContain("existing task handle");
    });
  }
  const allowed = [
    "tail -40 /tmp/job.log",
    "cat /tmp/job.log | grep PASS",
    "sleep 1",
    "sleep 1; npm test",
    "npm test; sleep 1; cat /tmp/result",
    "sleep 1; sed -i 's/old/new/' config.txt",
    "sleep 1; sed --in-place=.bak 's/old/new/' config.txt; tail config.txt",
    'wait "$pid"',
    "ps -eo pid,ppid,etimes,args",
    'pgrep -af "[i]mage-builder"',
    "bash scripts/wait-for-job.sh --deadline 60",
    'while read -r line; do printf "%s\\n" "$line"; done < /tmp/job.log',
    'for path in a b; do cat "$path"; done',
    'echo "until grep PASS log; do sleep 45; done"',
    'printf "%s\\n" "sleep 45; tail log"',
    'rg "while|sleep|pgrep" src',
    "# until grep PASS log; do sleep 1; done\ntail log",
    "cat <<'EOF' > /tmp/example\nuntil grep PASS log; do sleep 1; done\nEOF\ntail log",
    "cat <<-EOF\n\twhile true; do sleep 1; done\n\tEOF\ncat log",
    "cat <<A <<'B'\nwhile true; do sleep 1; done\nA\nsleep 1; tail log\nB\ncat log",
    "python -c 'print(\"sleep 45; tail log\")'",
  ];
  for (const command of allowed) {
    test(`allows ${command}`, () => {
      expect(shellWaiterReason("Bash", { command })).toBeNull();
    });
  }
  test("heredoc examples do not hide a subsequent real waiter", () => {
    expect(
      shellWaiterReason("Bash", {
        command: "cat <<EOF\nsleep 1; tail log\nEOF\nsleep 1; tail log",
      }),
    ).not.toBeNull();
  });
  test("supports shell tool payloads across adapters", () => {
    for (const tool of [
      "Bash",
      "Shell",
      "shell_command",
      "functions.shell_command",
      "exec_command",
      "functions.exec_command",
    ]) {
      for (const input of [{ command: "sleep 1; tail log" }, { cmd: "sleep 1; tail log" }]) {
        expect(shellWaiterReason(tool, input)).not.toBeNull();
        expect(shellWaiterReason(tool, JSON.stringify(input))).not.toBeNull();
      }
    }
  });
  test("ignores non-shell tools and malformed payloads", () => {
    expect(shellWaiterReason("Write", { command: "sleep 1; tail log" })).toBeNull();
    for (const input of [null, false, [], {}, "{bad", { command: 42 }]) {
      expect(shellWaiterReason("Bash", input)).toBeNull();
    }
    expect(shellWaiterReason(null, {})).toBeNull();
  });
});

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { extname, join, relative } from "node:path";

const retired = [
  "events.ndjson",
  "heal-heartbeat",
  "kill-heartbeat",
  "set-turn-summary",
  "stamp-tool-activity",
  "session.start",
  "session.end",
  "turn.stop",
  "tool.pre_use",
  "tool.post_use",
  "tool.post_use_failure",
  "command.start",
  "command.end",
  "command-start",
  "command-output",
  "command-completed",
  "command_start",
  "command_end",
  "state.task_set",
  "state.ping",
  "claim.acquire",
  "claim.release",
  "claim.conflict",
  "turn_summary",
  "last_tool",
] as const;

const canonicalPrefixes = new Set(["session.started", "session.ended", "command.started"]);

describe("V3-only runtime vocabulary", () => {
  test("production source has no retired V1 ledger or command semantics", () => {
    const root = join(import.meta.dir, "../..");
    const findings: string[] = [];
    for (const file of productionFiles(root)) {
      const source = readFileSync(file, "utf8");
      for (const token of retired) {
        let offset = source.indexOf(token);
        while (offset >= 0) {
          const suffix = source.slice(offset, offset + token.length + 2);
          if (!Array.from(canonicalPrefixes).some((prefix) => suffix.startsWith(prefix))) {
            findings.push(`${relative(root, file)}:${token}`);
          }
          offset = source.indexOf(token, offset + token.length);
        }
      }
    }
    expect(findings).toEqual([]);
  });

  test("owner resolution cannot import the disposable coordination cache reader", () => {
    const source = readFileSync(
      join(import.meta.dir, "../../src/core/agents/coord-client.ts"),
      "utf8",
    );
    expect(source).not.toContain("readHeartbeat");
    expect(source).not.toContain("export interface Heartbeat");
  });

  test("production consumers cannot import sealed V2 runtime modules", () => {
    const root = join(import.meta.dir, "../..");
    const findings = productionFiles(root)
      .filter((file) => {
        const rel = relative(root, file).replaceAll("\\", "/");
        return !rel.startsWith("src/core/events/v2/") && !rel.startsWith("src/core/events/v3/");
      })
      .flatMap((file) => {
        const source = readFileSync(file, "utf8");
        return source.includes("events/v2") || source.includes("live-session-v2")
          ? [relative(root, file).replaceAll("\\", "/")]
          : [];
      });
    expect(findings).toEqual([]);
  });
});

function productionFiles(root: string): string[] {
  return [join(root, "src"), join(root, "web")].flatMap(walk);
}

function walk(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".next") continue;
      files.push(...walk(path));
      continue;
    }
    if (
      (extname(entry.name) === ".ts" || extname(entry.name) === ".tsx") &&
      !entry.name.endsWith(".test.ts") &&
      !entry.name.endsWith(".test.tsx")
    ) {
      files.push(path);
    }
  }
  return files;
}

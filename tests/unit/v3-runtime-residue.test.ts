import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
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

  test("retired event ledger generations are absent", () => {
    const root = join(import.meta.dir, "../..");
    for (const path of [
      "src/core/events/v1",
      "src/core/events/v2",
      "schemas/event-v1.schema.json",
      "schemas/event-v2.schema.json",
      "scripts/generate-event-v1-contract.ts",
      "scripts/generate-event-v2-contract.ts",
      "tests/fixtures/event-v1-writer-child.ts",
      "tests/fixtures/event-v2-writer-child.ts",
    ]) {
      expect(existsSync(join(root, path))).toBeFalse();
    }
    const findings = productionFiles(root).flatMap((file) => {
      const source = readFileSync(file, "utf8");
      return /events\/v[12]|live-session-v[12]/.test(source)
        ? [relative(root, file).replaceAll("\\", "/")]
        : [];
    });
    expect(findings).toEqual([]);
  });

  test("V3 implementation uses only V3 canonicalization helpers", () => {
    const root = join(import.meta.dir, "../..");
    const files = [
      ...sourceFiles(join(root, "src/core/events/v3")),
      join(root, "scripts/generate-event-v3-contract.ts"),
      join(root, "tests/helpers/event-v3.ts"),
      join(root, "src/commands/events.test.ts"),
    ];
    const findings = files.flatMap((file) => {
      const source = readFileSync(file, "utf8");
      return source.includes("canonicalJsonV2") || source.includes("sha256V2")
        ? [relative(root, file).replaceAll("\\", "/")]
        : [];
    });
    expect(findings).toEqual([]);
  });

  test("the public package exports only the live V3 ledger generation", () => {
    const root = join(import.meta.dir, "../..");
    const source = readFileSync(join(root, "package.json"), "utf8");
    expect(source).toContain('"./core/events/v3"');
    expect(source).not.toContain('"./core/events/v2"');
  });

  test("V3 runtime fixtures have no V2 helper identity", () => {
    const root = join(import.meta.dir, "../..");
    expect(existsSync(join(root, "tests/helpers/event-v2.ts"))).toBeFalse();
    const source = readFileSync(join(root, "tests/helpers/event-v3-runtime.ts"), "utf8");
    expect(source).not.toContain("initializeV2Fixture");
    expect(source).not.toContain("seedV2Session");
  });

  test("current operator docs do not teach retired ledger generations", () => {
    const root = join(import.meta.dir, "../..");
    const generationTerms = [
      "ledger-v2",
      "ledgers/v2",
      "V2 event ledger",
      "V2 session-finalization",
      "canonical V2",
      "live V2",
    ];
    const findings: string[] = [];
    for (const file of currentDocumentFiles(root)) {
      const source = readFileSync(file, "utf8");
      for (const token of [...retired, ...generationTerms]) {
        let offset = source.indexOf(token);
        while (offset >= 0) {
          const suffix = source.slice(offset, offset + token.length + 2);
          if (!Array.from(canonicalPrefixes).some((prefix) => suffix.startsWith(prefix))) {
            findings.push(`${relative(root, file).replaceAll("\\", "/")}:${token}`);
          }
          offset = source.indexOf(token, offset + token.length);
        }
      }
    }
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

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...sourceFiles(path));
    } else if (extname(entry.name) === ".ts" || extname(entry.name) === ".tsx") {
      files.push(path);
    }
  }
  return files;
}

function currentDocumentFiles(root: string): string[] {
  const docsRoot = join(root, "docs/src/content/docs");
  const sections = ["cli", "concepts", "features", "guides", "getting-started", "reference"];
  return [
    join(root, "AGENTS.md"),
    join(root, "CLAUDE.md"),
    join(root, "SECURITY.md"),
    join(root, ".github/ISSUE_TEMPLATE/bug_report.md"),
    ...sections.flatMap((section) => documentFiles(join(docsRoot, section))),
  ];
}

function documentFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...documentFiles(path));
    } else if (extname(entry.name) === ".md" || extname(entry.name) === ".mdx") {
      files.push(path);
    }
  }
  return files;
}

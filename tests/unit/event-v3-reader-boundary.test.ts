import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  EXACT_DECLARATION_EXCEPTIONS,
  LEDGER_SEGMENT_JOIN_TOKEN,
  scanEventV3ReaderBoundary,
} from "../../scripts/check-event-v3-reader-boundary.ts";
import { removeDir } from "../helpers/remove-dir.ts";

const REPO_ROOT = resolve(import.meta.dir, "../..");

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) removeDir(root);
});

describe("event V3 canonical reader boundary", () => {
  test("permits storage access only in the canonical storage and control modules", () => {
    const root = fixtureRoot();
    write(root, "src/core/events/v3/reader.ts", 'const root = ".harnery/ledgers/v3";');
    write(root, "src/core/events/v3/catalog.ts", "readEventV3Catalog(path);");
    write(root, "src/core/events/v3/control.ts", 'const root = ".harnery/ledgers/v3";');
    write(root, "src/core/events/v3/authority-outbox.ts", "eventV3Paths(root);");
    write(root, "src/core/events/v3/writer.ts", "eventV3Paths(root);");
    write(root, "web/lib/coord-reader.ts", "eventV3Paths(root);");
    write(root, "web/lib/codec/scene-source.ts", "eventV3Paths(root);");
    expect(scanEventV3ReaderBoundary(root)).toEqual([]);
  });

  test("reports direct consumer traversal with exact source locations", () => {
    const root = fixtureRoot();
    write(
      root,
      "src/commands/events.ts",
      'const path = ".harnery/ledgers/v3";\nconst paths = eventV3Paths(root);',
    );
    write(root, "web/lib/direct-reader.ts", "eventV3Paths(root);");
    expect(scanEventV3ReaderBoundary(root)).toEqual([
      { file: "src/commands/events.ts", line: 1, token: ".harnery/ledgers/v3" },
      { file: "src/commands/events.ts", line: 2, token: "eventV3Paths(" },
      { file: "web/lib/direct-reader.ts", line: 1, token: "eventV3Paths(" },
    ]);
  });

  test("permits only the exact read-only storage catalog inventory declarations", () => {
    const root = fixtureRoot();
    write(
      root,
      "src/core/storage/builtins.ts",
      [
        'exact(context, ".harnery/ledgers/v3/active.ndjson", "file"),',
        'subtree(context, ".harnery/ledgers/v3/diagnostics", OWNER_PROTOCOL_LINKS),',
        'partition(context, ".harnery/ledgers/v3-archives", "canonical", [',
        'roots: (context) => [subtree(context, ".harnery/ledgers/v3-recoveries")],',
      ].join("\n"),
    );
    expect(scanEventV3ReaderBoundary(root)).toEqual([]);
  });

  test("rejects runtime access and catalog near-misses even inside builtins", () => {
    const root = fixtureRoot();
    write(
      root,
      "src/core/storage/builtins.ts",
      [
        'const root = ".harnery/ledgers/v3";',
        'exact(context, ".harnery/ledgers/v3/new-runtime.ndjson", "file"),',
        "eventV3Paths(root);",
      ].join("\n"),
    );
    expect(scanEventV3ReaderBoundary(root)).toEqual([
      { file: "src/core/storage/builtins.ts", line: 1, token: ".harnery/ledgers/v3" },
      { file: "src/core/storage/builtins.ts", line: 2, token: ".harnery/ledgers/v3" },
      { file: "src/core/storage/builtins.ts", line: 3, token: "eventV3Paths(" },
    ]);
  });

  test("rejects an allowlisted catalog declaration in every other source file", () => {
    const root = fixtureRoot();
    write(
      root,
      "src/core/storage/runtime-reader.ts",
      'exact(context, ".harnery/ledgers/v3/active.ndjson", "file"),',
    );
    expect(scanEventV3ReaderBoundary(root)).toEqual([
      { file: "src/core/storage/runtime-reader.ts", line: 1, token: ".harnery/ledgers/v3" },
    ]);
  });

  test("reports the path-segment form of the ledger location, including wrapped calls", () => {
    const root = fixtureRoot();
    write(
      root,
      "src/core/events/v3/history.ts",
      [
        'const active = join(coordRoot, ".harnery", "ledgers", "v3");',
        "const archives = join(",
        "  root,",
        '  ".harnery",',
        '  "ledgers",',
        '  "v3-archives",',
        ");",
        "const other = join(root, 'ledgers', 'v3', 'segments');",
      ].join("\n"),
    );
    expect(scanEventV3ReaderBoundary(root)).toEqual([
      { file: "src/core/events/v3/history.ts", line: 1, token: LEDGER_SEGMENT_JOIN_TOKEN },
      { file: "src/core/events/v3/history.ts", line: 5, token: LEDGER_SEGMENT_JOIN_TOKEN },
      { file: "src/core/events/v3/history.ts", line: 8, token: LEDGER_SEGMENT_JOIN_TOKEN },
    ]);
  });

  test("ignores unrelated ledger names that only share a prefix", () => {
    const root = fixtureRoot();
    write(
      root,
      "src/core/other.ts",
      'join(root, ".harnery", "ledgers", "v30");\njoin(root, "v3");',
    );
    expect(scanEventV3ReaderBoundary(root)).toEqual([]);
  });

  test("every exact-declaration exception carries a reason and names one line", () => {
    for (const entry of EXACT_DECLARATION_EXCEPTIONS) {
      expect(entry.reason.trim().length).toBeGreaterThan(20);
      expect(entry.declaration).toBe(entry.declaration.trim());
      expect(entry.declaration).not.toContain("\n");
      expect(entry.file.endsWith(".test.ts")).toBe(false);
    }
  });

  test("an exception covers only its exact declaration in its own file", () => {
    for (const entry of EXACT_DECLARATION_EXCEPTIONS) {
      const root = fixtureRoot();
      const variant = `${entry.declaration.replace(/;$/, "")}; // second use`;
      write(root, entry.file, [entry.declaration, variant].join("\n"));
      write(root, "src/core/elsewhere.ts", entry.declaration);
      const found = scanEventV3ReaderBoundary(root);
      expect(found).toHaveLength(2);
      expect(found).toContainEqual({ file: "src/core/elsewhere.ts", line: 1, token: entry.token });
      expect(found).toContainEqual({ file: entry.file, line: 2, token: entry.token });
    }
  });

  test("every exception still matches a real declaration, so stale entries are removed", () => {
    for (const entry of EXACT_DECLARATION_EXCEPTIONS) {
      const lines = readFileSync(join(REPO_ROOT, entry.file), "utf8")
        .split("\n")
        .map((line) => line.trim());
      expect(lines).toContain(entry.declaration);
    }
  });

  test("the real source tree has no reader-boundary violations", () => {
    expect(scanEventV3ReaderBoundary(REPO_ROOT)).toEqual([]);
  });
});

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "event-v3-reader-boundary-"));
  roots.push(root);
  return root;
}

function write(root: string, relative: string, content: string): void {
  const path = join(root, relative);
  mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  writeFileSync(path, `${content}\n`, "utf8");
}

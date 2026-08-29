import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanEventV3ReaderBoundary } from "../../scripts/check-event-v3-reader-boundary.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
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
        'subtree(context, ".harnery/ledgers/v3/diagnostics"),',
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

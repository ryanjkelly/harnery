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
    expect(scanEventV3ReaderBoundary(root)).toEqual([]);
  });

  test("reports direct consumer traversal with exact source locations", () => {
    const root = fixtureRoot();
    write(
      root,
      "src/commands/events.ts",
      'const path = ".harnery/ledgers/v3";\nconst paths = eventV3Paths(root);',
    );
    expect(scanEventV3ReaderBoundary(root)).toEqual([
      { file: "src/commands/events.ts", line: 1, token: ".harnery/ledgers/v3" },
      { file: "src/commands/events.ts", line: 2, token: "eventV3Paths(" },
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

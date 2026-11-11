import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type TSchema, Type } from "@sinclair/typebox";
import {
  checkEventV3Contract,
  EVENT_V3_GENERATED_RELATIVE_PATH,
  EVENT_V3_LINEAGE_RELATIVE_PATH,
  EVENT_V3_SCHEMA_RELATIVE_PATH,
  type EventV3ContractSource,
  EventV3GeneratorError,
  generateEventV3Contract,
  liveLedgerRefusalV3,
  schemaDigestV3,
} from "../../scripts/generate-event-v3-contract.ts";

const CORE_TYPES = ["fixture.started", "fixture.finished"] as const;
const strict = (properties: Parameters<typeof Type.Object>[0]) =>
  Type.Object(properties, { additionalProperties: false });
const branch = (eventType: string, extra: Parameters<typeof Type.Object>[0] = {}) =>
  strict({ event_type: Type.Literal(eventType), id: Type.String(), ...extra });

const BASE = Type.Union([
  branch("fixture.started"),
  branch("fixture.progressed"),
  branch("fixture.finished"),
]);

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempDir(): string {
  const root = mkdtempSync(join(tmpdir(), "event-v3-generator-"));
  roots.push(root);
  return root;
}

function git(root: string, ...args: string[]): void {
  const result = spawnSync(
    "git",
    ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args],
    { cwd: root, encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
}

function write(root: string, relative: string, body: string): void {
  mkdirSync(dirname(join(root, relative)), { recursive: true });
  writeFileSync(join(root, relative), body, "utf8");
}

function read(root: string, relative: string): string {
  return readFileSync(join(root, relative), "utf8");
}

function source(root: string, schema: TSchema): EventV3ContractSource {
  return { root, schema, coreTypes: CORE_TYPES };
}

function lineageGroups(root: string): string[][] {
  return JSON.parse(read(root, EVENT_V3_LINEAGE_RELATIVE_PATH)).groups;
}

/** A git checkout whose HEAD holds `schema` as the only lineage entry, fully generated. */
function committedCheckout(root = tempDir(), schema: TSchema = BASE): string {
  mkdirSync(dirname(join(root, EVENT_V3_GENERATED_RELATIVE_PATH)), { recursive: true });
  write(root, EVENT_V3_SCHEMA_RELATIVE_PATH, `${JSON.stringify(schema, null, 2)}\n`);
  write(
    root,
    EVENT_V3_LINEAGE_RELATIVE_PATH,
    `${JSON.stringify({
      format: "harnery-event-v3-schema-lineage",
      format_version: 1,
      groups: [[schemaDigestV3(schema)]],
    })}\n`,
  );
  git(root, "init", "-q");
  git(root, "add", "--", "schemas");
  git(root, "commit", "-q", "--no-gpg-sign", "-m", "base");
  generateEventV3Contract(source(root, schema));
  git(root, "add", "--", ".");
  git(root, "commit", "-q", "--no-gpg-sign", "-m", "generated");
  return root;
}

function withOptionalField(): TSchema {
  return Type.Union([
    branch("fixture.started", { note: Type.Optional(Type.String()) }),
    branch("fixture.progressed"),
    branch("fixture.finished"),
  ]);
}

function expectRefusal(run: () => unknown, pattern: RegExp): void {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(EventV3GeneratorError);
  expect((caught as Error).message).toMatch(pattern);
}

describe("event V3 contract generator", () => {
  test("appends an additive optional field to the current lineage group", () => {
    const root = committedCheckout();
    const next = withOptionalField();
    const result = generateEventV3Contract(source(root, next));
    expect(result.action).toBe("appended");
    expect(lineageGroups(root)).toEqual([[schemaDigestV3(BASE), schemaDigestV3(next)]]);
    expect(read(root, EVENT_V3_GENERATED_RELATIVE_PATH)).toContain(
      `EVENT_V3_SCHEMA_DIGEST =\n  "${schemaDigestV3(next)}"`,
    );
    expect(checkEventV3Contract(source(root, next))).toEqual([]);
  });

  test("re-running keeps the committed lineage plus at most one new digest", () => {
    const root = committedCheckout();
    const first = withOptionalField();
    generateEventV3Contract(source(root, first));
    const afterFirst = [
      read(root, EVENT_V3_LINEAGE_RELATIVE_PATH),
      read(root, EVENT_V3_GENERATED_RELATIVE_PATH),
    ];
    generateEventV3Contract(source(root, first));
    expect([
      read(root, EVENT_V3_LINEAGE_RELATIVE_PATH),
      read(root, EVENT_V3_GENERATED_RELATIVE_PATH),
    ]).toEqual(afterFirst);

    // A second uncommitted change replaces the first uncommitted digest.
    const second = Type.Union([
      branch("fixture.started", {
        note: Type.Optional(Type.String()),
        tag: Type.Optional(Type.String()),
      }),
      branch("fixture.progressed"),
      branch("fixture.finished"),
    ]);
    generateEventV3Contract(source(root, second));
    expect(lineageGroups(root)).toEqual([[schemaDigestV3(BASE), schemaDigestV3(second)]]);
  });

  test("an unchanged contract rewrites the committed files byte for byte", () => {
    const root = committedCheckout();
    const before = [EVENT_V3_SCHEMA_RELATIVE_PATH, EVENT_V3_LINEAGE_RELATIVE_PATH].map((path) =>
      read(root, path),
    );
    expect(generateEventV3Contract(source(root, BASE)).action).toBe("unchanged");
    expect(
      [EVENT_V3_SCHEMA_RELATIVE_PATH, EVENT_V3_LINEAGE_RELATIVE_PATH].map((path) =>
        read(root, path),
      ),
    ).toEqual(before);
  });

  test("ignores a hand-edited working-tree lineage and reads the committed base", () => {
    const root = committedCheckout();
    write(
      root,
      EVENT_V3_LINEAGE_RELATIVE_PATH,
      `${JSON.stringify({
        format: "harnery-event-v3-schema-lineage",
        format_version: 1,
        groups: [[schemaDigestV3(BASE)], [`sha256:${"0".repeat(64)}`]],
      })}\n`,
    );
    generateEventV3Contract(source(root, withOptionalField()));
    expect(lineageGroups(root)).toEqual([
      [schemaDigestV3(BASE), schemaDigestV3(withOptionalField())],
    ]);
  });

  test("refuses a newly required field, a removed branch and an unmodelled keyword", () => {
    const root = committedCheckout();
    const committedLineage = read(root, EVENT_V3_LINEAGE_RELATIVE_PATH);
    const required = Type.Union([
      branch("fixture.started", { note: Type.String() }),
      branch("fixture.progressed"),
      branch("fixture.finished"),
    ]);
    const removed = Type.Union([branch("fixture.started"), branch("fixture.finished")]);
    const unmodelled = Type.Union([
      Type.Object(
        {
          event_type: Type.Literal("fixture.started"),
          id: Type.String(),
          note: Type.Optional(Type.String()),
        },
        { additionalProperties: false, maxProperties: 2 },
      ),
      branch("fixture.progressed"),
      branch("fixture.finished"),
    ]);
    expectRefusal(
      () => generateEventV3Contract(source(root, required)),
      /not additive[\s\S]*branch_removed_or_narrowed[\s\S]*--breaking/,
    );
    expectRefusal(
      () => generateEventV3Contract(source(root, removed)),
      /not additive[\s\S]*anyOf\/1:branch_removed_or_narrowed/,
    );
    expectRefusal(() => generateEventV3Contract(source(root, unmodelled)), /not additive/);
    expect(read(root, EVENT_V3_LINEAGE_RELATIVE_PATH)).toBe(committedLineage);
    expect(checkEventV3Contract(source(root, BASE))).toEqual([]);
  });

  test("--breaking starts a new group holding only the new digest", () => {
    const root = committedCheckout();
    const removed = Type.Union([branch("fixture.started"), branch("fixture.finished")]);
    const result = generateEventV3Contract(source(root, removed), { breaking: true });
    expect(result.action).toBe("new_group");
    expect(lineageGroups(root)).toEqual([[schemaDigestV3(BASE)], [schemaDigestV3(removed)]]);
    expect(checkEventV3Contract(source(root, removed))).toEqual([]);

    // Repeating it does not accumulate groups.
    generateEventV3Contract(source(root, removed), { breaking: true });
    expect(lineageGroups(root)).toEqual([[schemaDigestV3(BASE)], [schemaDigestV3(removed)]]);
  });

  test("refuses a digest already recorded in an earlier group", () => {
    const root = committedCheckout();
    const next = withOptionalField();
    generateEventV3Contract(source(root, next));
    git(root, "add", "--", ".");
    git(root, "commit", "-q", "--no-gpg-sign", "-m", "additive");
    expectRefusal(
      () => generateEventV3Contract(source(root, BASE), { breaking: true }),
      /already recorded in an earlier lineage group/,
    );
  });

  test("requires a committed base", () => {
    const root = tempDir();
    write(root, EVENT_V3_SCHEMA_RELATIVE_PATH, `${JSON.stringify(BASE, null, 2)}\n`);
    expectRefusal(
      () => generateEventV3Contract(source(root, BASE)),
      /a committed base is required/,
    );
    git(root, "init", "-q");
    expectRefusal(
      () => generateEventV3Contract(source(root, BASE)),
      /a committed base is required/,
    );
  });

  test("refuses a checkout that serves a live ledger at its root", () => {
    const root = committedCheckout();
    write(root, ".harnery/ledgers/v3/genesis.json", "{}\n");
    const lineage = read(root, EVENT_V3_LINEAGE_RELATIVE_PATH);
    expect(liveLedgerRefusalV3(root)).toMatch(/this checkout serves a live event ledger/);
    expectRefusal(
      () => generateEventV3Contract(source(root, withOptionalField())),
      /live event ledger[\s\S]*git worktree add <path> <branch>/,
    );
    expect(read(root, EVENT_V3_LINEAGE_RELATIVE_PATH)).toBe(lineage);
    expect(checkEventV3Contract(source(root, BASE))).toEqual([]);
  });

  test("refuses a checkout nested inside a host that serves a live ledger", () => {
    const host = tempDir();
    const root = committedCheckout(join(host, "vendor", "harnery"));
    write(host, ".harnery/ledgers/v3/genesis.json", "{}\n");
    expect(liveLedgerRefusalV3(root)).toMatch(
      /the repository that contains this checkout .* serves a live event ledger/,
    );
    expectRefusal(
      () => generateEventV3Contract(source(root, withOptionalField())),
      /git worktree add/,
    );
    expect(checkEventV3Contract(source(root, BASE))).toEqual([]);
  });

  test("check mode reports each disagreement", () => {
    const root = committedCheckout();
    const next = withOptionalField();
    expect(checkEventV3Contract(source(root, next))).toEqual([
      expect.stringContaining("lineage head"),
      expect.stringContaining("schema file digest"),
      expect.stringContaining("EVENT_V3_SCHEMA_DIGEST"),
    ]);

    generateEventV3Contract(source(root, next));
    const generated = read(root, EVENT_V3_GENERATED_RELATIVE_PATH);
    write(
      root,
      EVENT_V3_GENERATED_RELATIVE_PATH,
      generated.replace(
        `    [\n      "${schemaDigestV3(BASE)}",`,
        `    ["${schemaDigestV3(BASE)}"],\n    [`,
      ),
    );
    expect(checkEventV3Contract(source(root, next))).toEqual([
      expect.stringContaining("EVENT_V3_SCHEMA_LINEAGE differs"),
    ]);
  });
});

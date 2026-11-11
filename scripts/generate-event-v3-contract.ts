/**
 * Generates the Event Ledger V3 contract artifacts and records schema lineage
 * (ADR 0245).
 *
 *   bun run scripts/generate-event-v3-contract.ts             regenerate
 *   bun run scripts/generate-event-v3-contract.ts --breaking  regenerate; start a new group
 *   bun run scripts/generate-event-v3-contract.ts --check     read-only drift check
 *
 * Regeneration compares the contract source with the schema and lineage
 * committed at HEAD, never with the working-tree copies, so the result is
 * always the committed lineage plus at most one new digest. An additive change
 * joins the current group; any other change is refused unless `--breaking` is
 * given. Regeneration also refuses to run in a checkout that serves a live
 * ledger, because the runtime there would start stamping a schema that may
 * never be committed.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { TSchema } from "@sinclair/typebox";
import { validateAdditiveSchemaAdvanceV3 } from "../src/core/events/v3/advance.ts";
import { canonicalJsonV3 } from "../src/core/events/v3/canonical.ts";

export const EVENT_V3_SCHEMA_RELATIVE_PATH = "schemas/event-v3.schema.json";
export const EVENT_V3_LINEAGE_RELATIVE_PATH = "schemas/event-v3-lineage.json";
export const EVENT_V3_GENERATED_RELATIVE_PATH = "src/core/events/v3/generated.ts";
const LINEAGE_FORMAT = "harnery-event-v3-schema-lineage";
const LINEAGE_FORMAT_VERSION = 1;
const LIVE_GENESIS_SEGMENTS = [".harnery", "ledgers", "v3", "genesis.json"] as const;
const LINEAGE_EXPORT = "export const EVENT_V3_SCHEMA_LINEAGE";
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

export type SchemaDigest = `sha256:${string}`;
export type LineageGroups = SchemaDigest[][];

export interface EventV3ContractSource {
  /** Checkout root: the directory holding `schemas/` and `src/`. */
  root: string;
  schema: TSchema;
  coreTypes: readonly string[];
}

export type LineageAction = "unchanged" | "appended" | "new_group";

export interface GenerateResult {
  digest: SchemaDigest;
  action: LineageAction;
  groups: LineageGroups;
  written: string[];
}

export class EventV3GeneratorError extends Error {}

export function schemaDigestV3(schema: unknown): SchemaDigest {
  return `sha256:${createHash("sha256").update(canonicalJsonV3(schema)).digest("hex")}`;
}

/**
 * Returns the reason regeneration must not run in `root`, or undefined. A
 * checkout serves a live ledger when it, or any directory above it (an
 * embedding host), holds an initialized V3 epoch.
 */
export function liveLedgerRefusalV3(root: string): string | undefined {
  let directory = resolve(root);
  for (;;) {
    const genesis = join(directory, ...LIVE_GENESIS_SEGMENTS);
    if (existsSync(genesis)) {
      const where =
        directory === resolve(root)
          ? "this checkout"
          : `the repository that contains this checkout (${directory})`;
      return [
        `refusing to regenerate the V3 contract: ${where} serves a live event ledger (${genesis}).`,
        "Regenerating here changes the schema digest every running agent stamps on its events",
        "before the change is committed; if the change is then edited or dropped, the live epoch",
        "holds a digest no runtime knows and every runtime blocks.",
        "Create a separate worktree and regenerate there:",
        "  git worktree add <path> <branch>",
      ].join("\n");
    }
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

/** Regenerates the schema, lineage and generated module under `source.root`. */
export function generateEventV3Contract(
  source: EventV3ContractSource,
  options: { breaking?: boolean } = {},
): GenerateResult {
  const refusal = liveLedgerRefusalV3(source.root);
  if (refusal) throw new EventV3GeneratorError(refusal);

  const committedSchema = JSON.parse(
    gitShowHead(source.root, EVENT_V3_SCHEMA_RELATIVE_PATH),
  ) as TSchema;
  const committedGroups = parseLineage(
    gitShowHead(source.root, EVENT_V3_LINEAGE_RELATIVE_PATH),
    `HEAD:${EVENT_V3_LINEAGE_RELATIVE_PATH}`,
  );
  const committedHead = lineageHead(committedGroups);
  if (schemaDigestV3(committedSchema) !== committedHead) {
    throw new EventV3GeneratorError(
      `the committed base is inconsistent: HEAD:${EVENT_V3_SCHEMA_RELATIVE_PATH} has digest ${schemaDigestV3(committedSchema)}, but the committed lineage ends at ${committedHead}.`,
    );
  }

  const digest = schemaDigestV3(source.schema);
  const groups = committedGroups.map((group) => [...group]);
  let action: LineageAction = "unchanged";
  if (digest !== committedHead) {
    if (groups.some((group) => group.includes(digest))) {
      throw new EventV3GeneratorError(
        `schema digest ${digest} is already recorded in an earlier lineage group. Returning to an earlier schema is not additive and cannot reuse its digest; change the contract so it produces a new schema.`,
      );
    }
    const advance = validateAdditiveSchemaAdvanceV3(committedSchema, source.schema);
    // An empty issue list means every committed document stays valid. A change
    // that only edits annotations is not strict, but it is still additive.
    const additive = advance.issues.length === 0;
    if (additive && !options.breaking) {
      groups[groups.length - 1]?.push(digest);
      action = "appended";
    } else if (options.breaking) {
      groups.push([digest]);
      action = "new_group";
    } else {
      throw new EventV3GeneratorError(
        [
          `the contract change is not additive to HEAD:${EVENT_V3_SCHEMA_RELATIVE_PATH}:`,
          ...advance.issues.map((issue) => `  ${issue}`),
          "Make the change additive, or rerun with --breaking to start a new lineage group",
          "(every existing epoch is then replaced when the new runtime meets it).",
        ].join("\n"),
      );
    }
  }
  if (lineageHead(groups) !== digest) {
    throw new EventV3GeneratorError(
      `internal error: lineage would end at ${lineageHead(groups)} but the generated digest is ${digest}.`,
    );
  }

  const outputs = contractOutputs(source, digest, groups);
  for (const [path, body] of outputs) writeFileSync(path, body, "utf8");
  return { digest, action, groups, written: outputs.map(([path]) => path) };
}

/**
 * Read-only drift check. Returns one message per disagreement among the
 * contract source, the schema file, `generated.ts` and the lineage file.
 * Never consults git and is never blocked by the live-ledger guard.
 */
export function checkEventV3Contract(source: EventV3ContractSource): string[] {
  const problems: string[] = [];
  const schemaPath = join(source.root, EVENT_V3_SCHEMA_RELATIVE_PATH);
  const lineagePath = join(source.root, EVENT_V3_LINEAGE_RELATIVE_PATH);
  const generatedPath = join(source.root, EVENT_V3_GENERATED_RELATIVE_PATH);
  const sourceDigest = schemaDigestV3(source.schema);

  let groups: LineageGroups | undefined;
  try {
    groups = parseLineage(readFileSync(lineagePath, "utf8"), lineagePath);
  } catch (error) {
    problems.push(errorMessage(error));
  }
  if (groups && lineageHead(groups) !== sourceDigest) {
    problems.push(
      `lineage head ${lineageHead(groups)} differs from the contract source digest ${sourceDigest}: ${lineagePath}`,
    );
  }

  if (!existsSync(schemaPath)) {
    problems.push(`missing schema file: ${schemaPath}`);
  } else {
    const schemaText = readFileSync(schemaPath, "utf8");
    let fileDigest: SchemaDigest | undefined;
    try {
      fileDigest = schemaDigestV3(JSON.parse(schemaText));
    } catch (error) {
      problems.push(`unreadable schema file ${schemaPath}: ${errorMessage(error)}`);
    }
    if (fileDigest && fileDigest !== sourceDigest) {
      problems.push(
        `schema file digest ${fileDigest} differs from the contract source digest ${sourceDigest}: ${schemaPath}`,
      );
    } else if (fileDigest && schemaText !== schemaBody(source.schema)) {
      problems.push(`schema file is not in generated form: ${schemaPath}`);
    }
  }

  if (!existsSync(generatedPath)) {
    problems.push(`missing generated module: ${generatedPath}`);
  } else {
    const generatedText = readFileSync(generatedPath, "utf8");
    const recorded = /EVENT_V3_SCHEMA_DIGEST =\s*"(sha256:[0-9a-f]{64})"/.exec(generatedText)?.[1];
    if (recorded !== sourceDigest) {
      problems.push(
        `EVENT_V3_SCHEMA_DIGEST ${recorded ?? "(missing)"} differs from the contract source digest ${sourceDigest}: ${generatedPath}`,
      );
    }
    if (groups) {
      const expected = generatedBody(source, sourceDigest, groups);
      const recordedLineage = sectionFrom(generatedText, LINEAGE_EXPORT);
      if (recordedLineage !== sectionFrom(expected, LINEAGE_EXPORT)) {
        problems.push(`EVENT_V3_SCHEMA_LINEAGE differs from ${lineagePath}: ${generatedPath}`);
      } else if (recorded === sourceDigest && generatedText !== expected) {
        problems.push(`generated module is not in generated form: ${generatedPath}`);
      }
    }
  }
  return problems;
}

function contractOutputs(
  source: EventV3ContractSource,
  digest: SchemaDigest,
  groups: LineageGroups,
): (readonly [string, string])[] {
  return [
    [join(source.root, EVENT_V3_SCHEMA_RELATIVE_PATH), schemaBody(source.schema)],
    [join(source.root, EVENT_V3_LINEAGE_RELATIVE_PATH), lineageBody(groups)],
    [join(source.root, EVENT_V3_GENERATED_RELATIVE_PATH), generatedBody(source, digest, groups)],
  ];
}

function schemaBody(schema: TSchema): string {
  return `${JSON.stringify(schema, null, 2)}\n`;
}

function generatedBody(
  source: EventV3ContractSource,
  digest: SchemaDigest,
  groups: LineageGroups,
): string {
  const generatedTypes = source.coreTypes
    .map((eventType) => `  ${JSON.stringify(eventType)},`)
    .join("\n");
  const generatedLineage = groups.map((group) => formatGroup(group, ",", "ts")).join("\n");
  return `/** Generated by scripts/generate-event-v3-contract.ts. Do not edit. */\nexport const EVENT_V3_SCHEMA_DIGEST =\n  ${JSON.stringify(digest)} as const;\nexport const EVENT_V3_GENERATED_CORE_TYPES = [\n${generatedTypes}\n] as const;\n/** Committed schema history: additive groups, oldest first (schemas/event-v3-lineage.json). */\n${LINEAGE_EXPORT} = {\n  groups: [\n${generatedLineage}\n  ],\n} as const;\n`;
}

/** The lineage file in the layout the repository formatter keeps. */
function lineageBody(groups: LineageGroups): string {
  const lines = groups.map((group, index) =>
    formatGroup(group, index === groups.length - 1 ? "" : ",", "json"),
  );
  return `{\n  "format": "${LINEAGE_FORMAT}",\n  "format_version": ${LINEAGE_FORMAT_VERSION},\n  "groups": [\n${lines.join("\n")}\n  ]\n}\n`;
}

/**
 * One lineage group at four spaces of indent, inline when it fits the
 * formatter's line width. TypeScript keeps a trailing comma after every entry;
 * JSON separates entries and has no trailing comma.
 */
function formatGroup(group: readonly string[], trailing: "," | "", syntax: "ts" | "json"): string {
  const inline = `    [${group.map((entry) => JSON.stringify(entry)).join(", ")}]${trailing}`;
  if (inline.length <= 100) return inline;
  const entries = group.map((entry, index) => {
    const comma = syntax === "ts" || index < group.length - 1 ? "," : "";
    return `      ${JSON.stringify(entry)}${comma}`;
  });
  return `    [\n${entries.join("\n")}\n    ]${trailing}`;
}

function parseLineage(text: string, label: string): LineageGroups {
  let lineage: { format?: unknown; format_version?: unknown; groups?: unknown };
  try {
    lineage = JSON.parse(text);
  } catch (error) {
    throw new EventV3GeneratorError(
      `unreadable V3 schema lineage ${label}: ${errorMessage(error)}`,
    );
  }
  if (lineage.format !== LINEAGE_FORMAT || lineage.format_version !== LINEAGE_FORMAT_VERSION) {
    throw new EventV3GeneratorError(`unsupported V3 schema lineage format: ${label}`);
  }
  const groups = lineage.groups;
  if (
    !Array.isArray(groups) ||
    groups.length === 0 ||
    !groups.every(
      (group) =>
        Array.isArray(group) &&
        group.length > 0 &&
        group.every((entry) => typeof entry === "string" && DIGEST_PATTERN.test(entry)),
    )
  ) {
    throw new EventV3GeneratorError(`invalid V3 schema lineage groups: ${label}`);
  }
  const flat = (groups as string[][]).flat();
  if (new Set(flat).size !== flat.length) {
    throw new EventV3GeneratorError(`V3 schema lineage lists a digest twice: ${label}`);
  }
  return groups as LineageGroups;
}

function lineageHead(groups: LineageGroups): SchemaDigest | undefined {
  return groups.at(-1)?.at(-1);
}

function gitShowHead(root: string, relativePath: string): string {
  const result = spawnSync("git", ["show", `HEAD:./${relativePath}`], {
    cwd: root,
    encoding: "utf8",
    // The checkout is chosen by `cwd`; an inherited repository override would
    // read some other repository's HEAD.
    env: withoutGitLocation(process.env),
    windowsHide: true,
  });
  if (result.status !== 0) {
    const detail = (result.stderr || result.error?.message || "").trim();
    throw new EventV3GeneratorError(
      [
        `a committed base is required: could not read HEAD:${relativePath} in ${root}.`,
        "The generator compares the new schema with the committed schema and lineage, so run it",
        "in a git checkout whose HEAD contains both files.",
        ...(detail ? [`git: ${detail}`] : []),
      ].join("\n"),
    );
  }
  return result.stdout;
}

function withoutGitLocation(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const { GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE, GIT_COMMON_DIR, ...rest } = env;
  return rest;
}

function sectionFrom(text: string, marker: string): string | undefined {
  const index = text.indexOf(marker);
  return index < 0 ? undefined : text.slice(index);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function main(argv: readonly string[]): Promise<number> {
  const known = new Set(["--check", "--breaking"]);
  const unknown = argv.filter((arg) => !known.has(arg));
  if (unknown.length > 0) {
    console.error(`unknown argument(s): ${unknown.join(" ")}`);
    console.error("usage: generate-event-v3-contract.ts [--check | --breaking]");
    return 2;
  }
  if (argv.includes("--check") && argv.includes("--breaking")) {
    console.error("--check is read-only and cannot be combined with --breaking");
    return 2;
  }
  const { EVENT_V3_CORE_EVENT_TYPES, EventV3Schema } = await import(
    "../src/core/events/v3/contract.ts"
  );
  const source: EventV3ContractSource = {
    root: resolve(dirname(fileURLToPath(import.meta.url)), ".."),
    schema: EventV3Schema,
    coreTypes: EVENT_V3_CORE_EVENT_TYPES,
  };
  if (argv.includes("--check")) {
    const problems = checkEventV3Contract(source);
    for (const problem of problems) console.error(`generated V3 contract drift: ${problem}`);
    return problems.length > 0 ? 1 : 0;
  }
  try {
    const result = generateEventV3Contract(source, { breaking: argv.includes("--breaking") });
    for (const path of result.written) console.log(`generated ${path}`);
    console.log(`schema digest ${result.digest}`);
    const group = result.groups.length;
    if (result.action === "unchanged") console.log(`lineage unchanged (group ${group})`);
    if (result.action === "appended") console.log(`lineage: digest appended to group ${group}`);
    if (result.action === "new_group") console.log(`lineage: digest starts new group ${group}`);
    return 0;
  } catch (error) {
    if (!(error instanceof EventV3GeneratorError)) throw error;
    console.error(error.message);
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}

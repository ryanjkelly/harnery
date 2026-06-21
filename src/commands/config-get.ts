import { existsSync, readFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import type { Command } from "commander";
import yaml from "js-yaml";
import type { EmitContext } from "../commander.ts";

/**
 * `config-get <file> <key>`: extract one value from a JSON or YAML config
 * file by dotted-path. Avoids reading the whole file or shelling out to jq
 * (which doesn't stream well through session-tee). Bracket notation supported
 * for hyphenated keys and arrays: `compilerOptions.paths["@/*"][0]`.
 */

interface ConfigGetOpts {
  json?: boolean;
  raw?: boolean;
}

interface ConfigGetResult {
  file: string;
  format: string;
  key: string;
  value: unknown;
  type: string;
  found: boolean;
}

export function registerConfigGetCommand(program: Command, emit: EmitContext): void {
  program
    .command("config-get <file> <key>")
    .description(
      "Extract a single value from a JSON/YAML config file by dotted-path. " +
        "Bracket notation supported: `config-get tsconfig.json compilerOptions.paths`.",
    )
    .option("--json", "Structured JSON envelope {file, format, key, value, type, found}")
    .option("--raw", "Print raw string value (no JSON encoding wrapper)")
    .action(async (file: string, key: string, opts: ConfigGetOpts) => {
      try {
        const result = await runConfigGet(file, key);
        if (opts.json) {
          emit.config({ format: "json" });
          emit.data(result);
          return;
        }
        if (!result.found) {
          emit.error({ code: "key_not_found", message: `key "${key}" not found in ${file}` });
          process.exit(1);
        }
        emit.text(`${renderValue(result.value)}\n`);
      } catch (err) {
        emit.error({ code: "config_get_failed", message: (err as Error).message });
        process.exit(1);
      }
    });
}

async function runConfigGet(file: string, key: string): Promise<ConfigGetResult> {
  const absPath = resolve(file);
  if (!existsSync(absPath)) throw new Error(`no such file: ${file}`);
  const content = readFileSync(absPath, "utf8");
  const ext = extname(absPath).toLowerCase();

  let format: string;
  let parsed: unknown;

  if (ext === ".json") {
    format = "json";
    try {
      parsed = JSON.parse(content);
    } catch (err) {
      throw new Error(`json parse failed: ${(err as Error).message}`);
    }
  } else if (ext === ".yaml" || ext === ".yml") {
    format = "yaml";
    try {
      parsed = yaml.load(content);
    } catch (err) {
      throw new Error(`yaml parse failed: ${(err as Error).message}`);
    }
  } else {
    throw new Error(
      `unsupported file type: ${ext || "(no extension)"} (supported: .json, .yaml, .yml)`,
    );
  }

  const parts = parseDottedPath(key);
  let cur: unknown = parsed;
  let found = true;

  for (const p of parts) {
    if (cur == null || typeof cur !== "object") {
      found = false;
      cur = undefined;
      break;
    }
    const obj = cur as Record<string, unknown>;
    if (!(p in obj)) {
      found = false;
      cur = undefined;
      break;
    }
    cur = obj[p];
  }

  const type =
    cur === null
      ? "null"
      : Array.isArray(cur)
        ? "array"
        : cur === undefined
          ? "undefined"
          : typeof cur;

  return {
    file,
    format,
    key,
    value: cur,
    type,
    found,
  };
}

function parseDottedPath(path: string): string[] {
  const parts: string[] = [];
  let i = 0;
  while (i < path.length) {
    if (path[i] === ".") {
      i++;
      continue;
    }
    if (path[i] === "[") {
      const end = path.indexOf("]", i);
      if (end < 0) throw new Error(`unmatched [ in key: ${path}`);
      let inner = path.slice(i + 1, end);
      if (
        (inner.startsWith('"') && inner.endsWith('"')) ||
        (inner.startsWith("'") && inner.endsWith("'"))
      ) {
        inner = inner.slice(1, -1);
      }
      parts.push(inner);
      i = end + 1;
      continue;
    }
    let end = i;
    while (end < path.length && path[end] !== "." && path[end] !== "[") end++;
    parts.push(path.slice(i, end));
    i = end;
  }
  return parts;
}

function renderValue(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return String(value);
  }
  return JSON.stringify(value, null, 2);
}

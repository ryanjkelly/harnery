import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Command } from "commander";
import { countTokens } from "gpt-tokenizer/model/gpt-4o";
import type { EmitContext } from "../commander.ts";
import type { Adapter } from "../core/adapter.ts";
import { monorepoRoot } from "../core/agents/index.ts";
import {
  buildInstructionBundle,
  type InstructionBundleComponent,
} from "../lib/instructions/bundle.ts";

interface ManifestOptions {
  adapter: string;
  format: string;
  output?: string;
}

export function registerInstructionsCommand(program: Command, emit: EmitContext): void {
  const command = program
    .command("instructions")
    .description(
      "Inspect and version the repo-authored instruction bundle loaded by each adapter.",
    );

  command
    .command("manifest [paths...]")
    .description("Emit a machine-readable bundle manifest for one or more working paths")
    .option("--adapter <adapter>", "claude-code, cursor, codex, or all", "all")
    .option("--format <type>", "Output format: json or table", "json")
    .option("-o, --output <file>", "Write the complete JSON manifest to a file")
    .action((paths: string[], options: ManifestOptions) => {
      if (options.format === "json") emit.config({ format: "json" });
      const coordRoot = monorepoRoot() ?? process.cwd();
      const adapters = parseAdapters(options.adapter);
      const profiles = (paths.length > 0 ? paths : [process.cwd()]).flatMap((path) =>
        adapters.map((adapter) =>
          enrichBundle(
            buildInstructionBundle({ coordRoot, cwd: resolve(path), adapter }),
            coordRoot,
          ),
        ),
      );

      const manifest = {
        ok: true,
        schema_version: 1,
        generated_at: new Date().toISOString(),
        source_commit: gitHead(coordRoot),
        tokenizer: "o200k_base",
        coord_root: ".",
        profile_count: profiles.length,
        profiles,
      };
      if (options.output) {
        const output = resolve(options.output);
        writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
        emit.data({
          ok: true,
          output,
          schema_version: manifest.schema_version,
          generated_at: manifest.generated_at,
          source_commit: manifest.source_commit,
          profile_count: manifest.profile_count,
        });
      } else {
        emit.data(manifest);
      }
    });
}

function parseAdapters(value: string): Adapter[] {
  if (value === "all") return ["claude-code", "cursor", "codex"];
  if (value === "claude-code" || value === "cursor" || value === "codex") return [value];
  throw new Error(`unsupported adapter '${value}' (expected claude-code, cursor, codex, or all)`);
}

function enrichBundle(bundle: ReturnType<typeof buildInstructionBundle>, coordRoot: string) {
  const components = bundle.components.map((component) => enrichComponent(component, coordRoot));
  const canonicalSources = bundle.canonical_sources.map((component) =>
    enrichComponent(component, coordRoot),
  );
  return {
    ...bundle,
    coord_root: ".",
    components,
    canonical_sources: canonicalSources,
    totals: totals(components),
    canonical_source_totals: totals(canonicalSources),
  };
}

function enrichComponent(component: InstructionBundleComponent, coordRoot: string) {
  const bytes = readFileSync(resolve(coordRoot, component.path));
  const text = bytes.includes(0) ? null : bytes.toString("utf8");
  return {
    ...component,
    chars: text?.length ?? null,
    tokens: text === null ? null : countTokens(text),
  };
}

function totals(components: ReturnType<typeof enrichComponent>[]) {
  const roles = ["always_loaded", "just_in_time", "runtime_config"] as const;
  return {
    files: components.length,
    bytes: components.reduce((sum, component) => sum + component.bytes, 0),
    tokens: components.reduce((sum, component) => sum + (component.tokens ?? 0), 0),
    by_role: Object.fromEntries(
      roles.map((role) => {
        const selected = components.filter((component) => component.role === role);
        return [
          role,
          {
            files: selected.length,
            bytes: selected.reduce((sum, component) => sum + component.bytes, 0),
            tokens: selected.reduce((sum, component) => sum + (component.tokens ?? 0), 0),
          },
        ];
      }),
    ),
  };
}

function gitHead(root: string): string | null {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

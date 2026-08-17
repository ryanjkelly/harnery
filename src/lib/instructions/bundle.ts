import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Adapter } from "../../core/hooks/events/schema.ts";

export type InstructionComponentRole = "always_loaded" | "just_in_time" | "runtime_config";

export interface InstructionBundleComponent {
  path: string;
  role: InstructionComponentRole;
  bytes: number;
  sha256: string;
}

export interface InstructionBundle {
  schema_version: 1;
  adapter: Adapter;
  coord_root: string;
  profile_root: string;
  instruction_roots: string[];
  instruction_bundle_id: string;
  canonical_source_id: string;
  components: InstructionBundleComponent[];
  canonical_sources: InstructionBundleComponent[];
}

interface BuildBundleOptions {
  coordRoot: string;
  cwd: string;
  adapter: Adapter;
}

interface Candidate {
  absolutePath: string;
  role: InstructionComponentRole;
}

/**
 * Build the content identity for the repo-authored instruction surface an
 * adapter can load at one working path. The identity intentionally excludes
 * timestamps and git revisions: two checkouts with byte-identical effective
 * instructions belong to the same cohort.
 */
export function buildInstructionBundle(options: BuildBundleOptions): InstructionBundle {
  const coordRoot = resolve(options.coordRoot);
  const cwd = resolve(options.cwd);
  const roots = resolveInstructionRoots(coordRoot, cwd);
  const profileRoot = roots.at(-1) ?? coordRoot;
  const components = dedupeCandidates(
    roots.flatMap((root) => adapterCandidates(root, options.adapter)),
    coordRoot,
  );
  const canonicalSources = dedupeCandidates(
    roots.flatMap((root) => canonicalCandidates(root)),
    coordRoot,
  );

  return {
    schema_version: 1,
    adapter: options.adapter,
    coord_root: coordRoot,
    profile_root: relativePath(coordRoot, profileRoot),
    instruction_roots: roots.map((root) => relativePath(coordRoot, root)),
    instruction_bundle_id: identity("instruction-bundle-v1", options.adapter, components),
    canonical_source_id: identity("instruction-source-v1", null, canonicalSources),
    components,
    canonical_sources: canonicalSources,
  };
}

function resolveInstructionRoots(coordRoot: string, cwd: string): string[] {
  const roots = [coordRoot];
  if (!isWithin(coordRoot, cwd)) return roots;

  const ancestors: string[] = [];
  let cursor = cwd;
  while (cursor !== coordRoot) {
    if (existsSync(join(cursor, "AGENTS.md")) || existsSync(join(cursor, "CLAUDE.md"))) {
      ancestors.push(cursor);
    }
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  roots.push(...ancestors.reverse().filter((root) => root !== coordRoot));
  return roots;
}

function adapterCandidates(root: string, adapter: Adapter): Candidate[] {
  const candidates: Candidate[] = [];
  const addFile = (path: string, role: InstructionComponentRole) => {
    if (existsSync(path) && lstatSync(path).isFile()) candidates.push({ absolutePath: path, role });
  };
  const addTree = (path: string, role: InstructionComponentRole) => {
    for (const file of walkFiles(path)) candidates.push({ absolutePath: file, role });
  };

  if (adapter === "claude-code") {
    addFile(join(root, "CLAUDE.md"), "always_loaded");
    addTree(join(root, ".claude", "rules"), "always_loaded");
    addTree(join(root, ".claude", "skills"), "just_in_time");
    addFile(join(root, ".claude", "settings.json"), "runtime_config");
    addFile(join(root, ".claude", "settings.local.json"), "runtime_config");
  } else if (adapter === "cursor") {
    addFile(join(root, "AGENTS.md"), "always_loaded");
    addTree(join(root, ".cursor", "rules"), "always_loaded");
    addTree(join(root, ".agents", "skills"), "just_in_time");
    addTree(join(root, ".cursor", "skills"), "just_in_time");
    addFile(join(root, ".cursor", "hooks.json"), "runtime_config");
  } else {
    addFile(join(root, "AGENTS.md"), "always_loaded");
    addTree(join(root, ".agents", "skills"), "just_in_time");
    addFile(join(root, ".codex", "hooks.json"), "runtime_config");
  }

  // Harnery's host configuration governs hook enforcement for all adapters.
  addFile(join(root, ".harnery", "config.jsonc"), "runtime_config");
  return candidates;
}

function canonicalCandidates(root: string): Candidate[] {
  const candidates: Candidate[] = [];
  const agents = join(root, "AGENTS.md");
  if (existsSync(agents) && lstatSync(agents).isFile()) {
    candidates.push({ absolutePath: agents, role: "always_loaded" });
  }
  for (const file of walkFiles(join(root, ".agents"))) {
    candidates.push({ absolutePath: file, role: "just_in_time" });
  }
  return candidates;
}

function walkFiles(root: string): string[] {
  if (!existsSync(root) || !lstatSync(root).isDirectory()) return [];
  const files: string[] = [];
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push(path);
    }
  };
  visit(root);
  return files;
}

function dedupeCandidates(
  candidates: Candidate[],
  coordRoot: string,
): InstructionBundleComponent[] {
  const byPath = new Map<string, Candidate>();
  for (const candidate of candidates) {
    const key = resolve(candidate.absolutePath);
    const prior = byPath.get(key);
    if (!prior || roleRank(candidate.role) < roleRank(prior.role)) byPath.set(key, candidate);
  }

  return [...byPath.values()]
    .map(({ absolutePath, role }) => {
      const bytes = readFileSync(absolutePath);
      return {
        path: relativePath(coordRoot, absolutePath),
        role,
        bytes: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
    })
    .sort((a, b) => a.path.localeCompare(b.path) || a.role.localeCompare(b.role));
}

function identity(
  prefix: string,
  adapter: Adapter | null,
  components: InstructionBundleComponent[],
): string {
  const body = components.map(({ path, role, sha256 }) => ({ path, role, sha256 }));
  return `sha256:${createHash("sha256")
    .update(JSON.stringify({ prefix, ...(adapter ? { adapter } : {}), components: body }))
    .digest("hex")}`;
}

function relativePath(root: string, path: string): string {
  const rel = relative(root, path);
  return rel === "" ? "." : rel.split(sep).join("/");
}

function isWithin(root: string, path: string): boolean {
  if (!isAbsolute(root) || !isAbsolute(path)) return false;
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== "..");
}

function roleRank(role: InstructionComponentRole): number {
  if (role === "always_loaded") return 0;
  if (role === "runtime_config") return 1;
  return 2;
}

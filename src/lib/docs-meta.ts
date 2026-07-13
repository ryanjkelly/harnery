import { readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { parseFrontmatter } from "./docs-frontmatter.ts";

export interface DocsMetadata {
  path: string;
  data: Record<string, unknown>;
}

/**
 * Read the leading YAML frontmatter from a markdown file.
 *
 * Relative paths resolve from the host repo root so the command behaves the
 * same no matter which directory invoked it.
 */
export function readDocsMetadata(repoRoot: string, inputPath: string): DocsMetadata {
  const path = isAbsolute(inputPath) ? resolve(inputPath) : resolve(repoRoot, inputPath);
  try {
    if (!statSync(path).isFile()) throw new Error("not a file");
  } catch {
    throw new Error(`Documentation file not found: ${inputPath}`);
  }

  const parsed = parseFrontmatter(readFileSync(path, "utf8"));
  if (parsed.raw === null) {
    throw new Error(`Documentation file has no leading YAML frontmatter: ${inputPath}`);
  }
  if (Object.keys(parsed.data).length === 0) {
    throw new Error(`Documentation frontmatter is empty or malformed: ${inputPath}`);
  }
  return { path, data: parsed.data };
}

/** Read one top-level metadata key, failing when the key is absent. */
export function readDocsMetadataKey(
  metadata: Record<string, unknown>,
  key: string,
  inputPath: string,
): unknown {
  if (!Object.hasOwn(metadata, key)) {
    throw new Error(`Documentation frontmatter key '${key}' not found: ${inputPath}`);
  }
  return metadata[key];
}

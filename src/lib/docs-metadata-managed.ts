import { basename } from "node:path";
import { type DocsMetadataType, isDocsMetadataType } from "./docs-metadata-v2.ts";

function normalized(path: string): string {
  return path.replaceAll("\\", "/");
}

function lifecycleType(path: string): DocsMetadataType | null {
  const rel = normalized(path);
  if (basename(rel).toLowerCase() === "readme.md") return null;
  if (/^(?:[^/]+\/)?docs\/plans\//.test(rel)) return "plan";
  if (/^(?:[^/]+\/)?docs\/issues\//.test(rel)) return "issue";
  if (/^(?:[^/]+\/)?docs\/handoffs\//.test(rel)) return "handoff";
  if (/^harnery-dev\/plans\//.test(rel)) return "plan";
  if (/^harnery-dev\/issues\//.test(rel)) return "issue";
  return null;
}

/**
 * Return the v2 type expected for a Markdown file that participates in the
 * managed metadata contract. Unmanaged Markdown and unrelated YAML-frontmatter
 * systems return null.
 */
export function managedDocsMetadataType(
  path: string,
  data: Record<string, unknown>,
  hasFrontmatter: boolean,
): DocsMetadataType | null {
  const rel = normalized(path);
  if (
    rel.split("/").includes(".wiki-data") ||
    /^(?:[^/]+\/)?docs\/shopify\/admin-api\//.test(rel) ||
    /^(?:[^/]+\/)?docs\/templates\//.test(rel)
  ) {
    return null;
  }
  if (isDocsMetadataType(data.type)) return data.type;

  const lifecycle = lifecycleType(path);
  if (lifecycle) return lifecycle;

  const name = basename(rel).toLowerCase();
  if (/^(?:[^/]+\/)?docs\/runbook\.md$/.test(rel) || (hasFrontmatter && /^.+-runbook\.md$/.test(name))) {
    return "runbook";
  }

  return null;
}

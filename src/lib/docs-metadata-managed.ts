import { basename } from "node:path";
import { type DocsMetadataType, isDocsMetadataType, isDocsMetadataV2 } from "./docs-metadata-v2.ts";

function normalized(path: string): string {
  return path.replaceAll("\\", "/");
}

/**
 * Paths whose Markdown carries frontmatter belonging to another system:
 * generated mirrors of documents that live elsewhere, vendored vendor
 * specifications, and the placeholder headers inside document templates.
 */
export function isExcludedDocsMetadataPath(path: string): boolean {
  const rel = normalized(path);
  const segments = rel.split("/");
  return (
    segments.includes(".wiki-data") ||
    // Dashboard surfaces render from copies of other repositories' documents.
    /(?:^|\/)content\/dashboards\//.test(rel) ||
    /(?:^|\/)docs\/shopify\/admin-api\//.test(rel) ||
    // Template skeletons carry placeholder frontmatter by design. Hosts keep
    // them under docs/templates/ or another documentation root such as
    // meta-docs/templates/, so match the directory name rather than one root.
    /(?:^|\/)templates\//.test(rel)
  );
}

function lifecycleType(path: string): DocsMetadataType | null {
  const rel = normalized(path);
  if (basename(rel).toLowerCase() === "readme.md") return null;
  // A repository may sit at any depth inside the host checkout, so the
  // directory rules anchor on `docs/<kind>/` rather than a single optional
  // path segment. A one-segment-only prefix hid every document in a
  // repository nested two or more levels down.
  if (/(?:^|\/)docs\/plans\//.test(rel)) return "plan";
  if (/(?:^|\/)docs\/issues\//.test(rel)) return "issue";
  if (/(?:^|\/)docs\/coordination\/issues\//.test(rel)) return "issue";
  if (/(?:^|\/)docs\/handoffs\//.test(rel)) return "handoff";
  if (/(?:^|\/)docs\/audits\//.test(rel)) return "audit";
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
  if (isExcludedDocsMetadataPath(rel)) return null;
  if (isDocsMetadataType(data.type)) return data.type;

  const lifecycle = lifecycleType(rel);
  if (lifecycle) return lifecycle;

  const name = basename(rel).toLowerCase();
  if (/(?:^|\/)docs\/runbook\.md$/.test(rel) || (hasFrontmatter && /^.+-runbook\.md$/.test(name))) {
    return "runbook";
  }

  return null;
}

/**
 * Whether a Markdown file has to satisfy the v2 contract.
 *
 * A file that claims the v2 schema marker is always checked, even when its
 * `type` is missing or misspelled. Deciding membership from the type alone
 * let a typo drop the document out of the audit entirely, so an invalid
 * header reported as nothing rather than as an error.
 */
export function isManagedDocsMetadataFile(
  path: string,
  data: Record<string, unknown>,
  hasFrontmatter: boolean,
): boolean {
  if (isExcludedDocsMetadataPath(path)) return false;
  if (isDocsMetadataV2(data)) return true;
  return managedDocsMetadataType(path, data, hasFrontmatter) !== null;
}

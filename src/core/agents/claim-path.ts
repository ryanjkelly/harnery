import { isAbsolute, relative, resolve, sep } from "node:path";

/**
 * Canonical identity for an authority-bearing write claim.
 *
 * Workspace paths stay portable and repository-relative. Approved paths
 * outside the coordination root become resolved absolute paths so a later
 * release matches whether the caller supplies the stored dot-dot form or the
 * absolute target. This is lexical identity only; finalization policy owns the
 * physical containment and symlink checks before a claim is acquired.
 */
export function canonicalClaimPath(coordRoot: string, value: string): string {
  const root = resolve(coordRoot);
  const absolute = resolve(root, value);
  const fromRoot = relative(root, absolute);
  const contained = fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot);
  if (contained) return portable(fromRoot || ".");
  return portable(absolute);
}

function portable(value: string): string {
  return value.split(sep).join("/");
}

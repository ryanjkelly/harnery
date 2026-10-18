/** The sanitized tree subset needed to assign local heading targets. */
interface MarkdownNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: MarkdownNode[];
}

const HEADING_PREFIX = "user-content-";

function visit(node: MarkdownNode, fn: (node: MarkdownNode) => void): void {
  fn(node);
  for (const child of node.children ?? []) visit(child, fn);
}

function headingText(node: MarkdownNode): string {
  if (node.type === "text") return node.value ?? "";
  if (node.tagName === "img") {
    return typeof node.properties?.alt === "string" ? node.properties.alt : "";
  }
  return (node.children ?? []).map(headingText).join("");
}

/** Run after sanitization; only generated heading targets receive link rewrites. */
export function rehypeHeadingLinks() {
  return (tree: MarkdownNode): void => {
    const slugs = new Set<string>();
    const ids = new Set<string>();
    const targets = new Map<string, string>();
    visit(tree, (node) => {
      if (typeof node.properties?.id === "string") ids.add(node.properties.id);
    });
    visit(tree, (node) => {
      if (node.type !== "element" || !/^h[1-6]$/.test(node.tagName ?? "")) return;
      // GFM footnotes already supply a sanitized heading ID used by ARIA.
      if (typeof node.properties?.id === "string") return;
      // Match the documented heading rule: keep Unicode letters/numbers and
      // literal underscores; each space survives as a hyphen, even around punctuation.
      const base = headingText(node)
        .trim()
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s_-]/gu, "")
        .replace(/\s/g, "-");
      let slug = base;
      for (let suffix = 1; slugs.has(slug); suffix++) slug = `${base}-${suffix}`;
      slugs.add(slug);
      let id = `${HEADING_PREFIX}${slug}`;
      for (let suffix = 1; ids.has(id); suffix++) id = `${HEADING_PREFIX}${slug}-${suffix}`;
      ids.add(id);
      targets.set(slug, id);
      node.properties ??= {};
      // Retain the sanitizer's clobber protection rather than exposing names
      // such as location directly as document properties.
      node.properties.id = id;
    });

    // Links may precede their heading, so resolve against the completed set.
    visit(tree, (node) => {
      if (node.type !== "element" || node.tagName !== "a") return;
      const href = node.properties?.href;
      if (typeof href !== "string" || !href.startsWith("#") || href.length === 1) return;
      let fragment: string;
      try {
        fragment = decodeURIComponent(href.slice(1));
      } catch {
        return;
      }
      const target = targets.get(fragment);
      if (target) {
        node.properties!.href = `#${encodeURIComponent(target)}`;
      }
    });
  };
}

/** Short opening previews preserve the complete catalog for search and browsing. */
export function paletteHomeSections<T, S extends { items: T[]; initialLimit?: number }>(
  sections: S[],
  browseItem: (section: S) => T,
): S[] {
  return sections.map((section) => {
    const limit = section.initialLimit;
    if (
      limit === undefined ||
      !Number.isInteger(limit) ||
      limit < 0 ||
      section.items.length <= limit
    ) {
      return section;
    }
    return { ...section, items: [...section.items.slice(0, limit), browseItem(section)] };
  });
}

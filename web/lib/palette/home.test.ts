import { expect, test } from "bun:test";
import { paletteHomeSections } from "./home";

test("a home preview retains every original entry in its browse action", () => {
  type Item = { label: string; all?: Item[] };
  const entries: Item[] = Array.from({ length: 200 }, (_, i) => ({ label: `Entry ${i}` }));
  const sections = [{ label: "Catalog", initialLimit: 4, items: entries }];
  const displayed = paletteHomeSections(sections, (section) => ({
    label: "Browse all",
    all: section.items,
  }));
  expect(displayed[0].items).toHaveLength(5);
  expect(displayed[0].items[4].all).toBe(entries);
  expect(displayed[0].items[4].all?.at(-1)?.label).toBe("Entry 199");
  // Search receives the original section, including entries outside the preview.
  expect(sections[0].items).toBe(entries);
  expect(sections[0].items).toHaveLength(200);
});

test("small and unbounded sections retain their identity and create no browse action", () => {
  const sections = [{ items: [1, 2], initialLimit: 2 }, { items: [3, 4] }];
  const displayed = paletteHomeSections(sections, (): number => {
    throw new Error("Unexpected browse action");
  });
  expect(displayed[0]).toBe(sections[0]);
  expect(displayed[1]).toBe(sections[1]);
});

test("invalid limits never hide catalog entries", () => {
  for (const initialLimit of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    const section = { items: [1, 2, 3], initialLimit };
    expect(paletteHomeSections([section], () => 0)[0]).toBe(section);
  }
});

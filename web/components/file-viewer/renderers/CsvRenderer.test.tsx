import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { FileText } from "@/lib/file-viewer/types";
import CsvRenderer from "./CsvRenderer";

function renderCsv(content: string, relPath = "reports/fixture.csv"): string {
  const file: FileText = {
    relPath,
    size: content.length,
    mtime: "2026-10-18T00:00:00.000Z",
    mime: "text/csv",
    category: "csv",
    content,
    lines: content.split("\n").length,
    truncated: false,
  };
  return renderToStaticMarkup(<CsvRenderer file={file} />);
}

test("CSV columns include fields first encountered after the initial rows", () => {
  const content = [
    "Account,Amount",
    ...Array.from({ length: 55 }, (_, i) => `${i},12.00`),
    'late,12.00,"preserve this later field"',
  ].join("\n");
  const html = renderCsv(content);
  expect(html).toContain("56 rows · 3 cols");
  expect(html).toContain("col 3");
});

test("TSV columns also include later wider rows", () => {
  const content = [
    "Account\tAmount",
    ...Array.from({ length: 55 }, (_, i) => `${i}\t12.00`),
    "late\t12.00\textra\tlast",
  ].join("\n");
  const html = renderCsv(content, "reports/fixture.tsv");
  expect(html).toContain("56 rows · 4 cols");
  expect(html).toContain("col 4");
});

test("a wider header keeps its columns when data rows are narrower", () => {
  const html = renderCsv("Account,Amount,Notes\n000123,12.00");
  expect(html).toContain("1 rows · 3 cols");
  expect(html).toContain("Notes");
});

test("quoted delimiters and newlines remain inside their header cells", () => {
  const html = renderCsv('"Account, ID","Notes\ncontinued",Amount\n000123,"a,b",12.00');
  expect(html).toContain("1 rows · 3 cols");
  expect(html).toContain("Account, ID");
  expect(html).toContain("Notes\ncontinued");
});

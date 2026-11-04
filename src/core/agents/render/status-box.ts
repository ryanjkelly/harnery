// biome-ignore lint/suspicious/noControlCharactersInRegex: Match OSC control sequences so they cannot reach a terminal.
const OSC = /\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: Both ESC and C1 forms introduce terminal control sequences.
const CSI = /(?:\u001B\[|\u009B)[0-?]*[ -/]*[@-~]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: Strip remaining terminal escape commands.
const ESCAPE = /\u001B[ -/]*[@-Z\\-_]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: C0/C1 controls are deliberately removed, except LF and TAB.
const CONTROLS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;

/** Terminal-cell widths are deterministic here; individual fonts may render differently. */
const segmenter =
  typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;

export function statusGraphemes(text: string, useSegmenter = true): string[] {
  return useSegmenter && segmenter
    ? Array.from(segmenter.segment(text), ({ segment }) => segment)
    : Array.from(text);
}

function wide(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2329 && code <= 0x232a) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe10 && code <= 0xfe6f) ||
    (code >= 0xff01 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x20000 && code <= 0x3fffd)
  );
}

function graphemeWidth(text: string): number {
  if (/^[\p{Mark}\p{Cf}]+$/u.test(text)) return 0;
  if (
    !text.includes("\uFE0E") &&
    (/\p{Emoji_Presentation}/u.test(text) ||
      (/\p{Extended_Pictographic}/u.test(text) && text.includes("\uFE0F")) ||
      /[0-9#*]\uFE0F?\u20E3/u.test(text))
  ) {
    return 2;
  }
  return wide(text.codePointAt(0) ?? 0) ? 2 : 1;
}

export function statusDisplayWidth(text: string): number {
  return statusGraphemes(text).reduce((width, part) => width + graphemeWidth(part), 0);
}

/** Remove terminal instructions while retaining LF as an intentional row boundary. */
export function sanitizeStatusText(text: string): string {
  const clean = text
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0085\u2028\u2029]/g, "\n")
    .replace(OSC, "")
    .replace(CSI, "")
    .replace(ESCAPE, "")
    .replace(CONTROLS, "")
    .replace(/\t/g, "    ");
  return statusGraphemes(clean)
    .map((part) =>
      part.replace(/\p{Cf}/gu, (character) =>
        character === "\u200D" && /\p{Extended_Pictographic}/u.test(part) ? character : "",
      ),
    )
    .join("");
}

/** Names, paths, titles, and stored task text are single-line fields. */
export function sanitizeStatusLabel(text: string): string {
  return sanitizeStatusText(text).replace(/\s+/gu, " ").trim();
}

function hardWrap(text: string, budget: number): string[] {
  const lines: string[] = [];
  let line = "";
  let width = 0;
  for (const part of statusGraphemes(text)) {
    const cells = graphemeWidth(part);
    if (line && width + cells > budget) {
      lines.push(line);
      line = "";
      width = 0;
    }
    line += part;
    width += cells;
  }
  if (line || lines.length === 0) lines.push(line);
  return lines;
}

export function wrapStatusText(text: string, maxWidth: number): string[] {
  const budget = Math.max(2, maxWidth);
  return sanitizeStatusText(text)
    .split("\n")
    .flatMap((source) => {
      if (statusDisplayWidth(source) <= budget) return [source];
      const lines: string[] = [];
      let current = "";
      for (const token of source.split(/(\s+)/u)) {
        if (statusDisplayWidth(current + token) <= budget) {
          current += token;
          continue;
        }
        if (current) lines.push(current.trimEnd());
        const chunks = hardWrap(token.trimStart(), budget);
        lines.push(...chunks.slice(0, -1));
        current = chunks.at(-1) ?? "";
      }
      if (current || lines.length === 0) lines.push(current.trimEnd());
      return lines;
    });
}

function clip(text: string, budget: number): string {
  if (statusDisplayWidth(text) <= budget) return text;
  let clipped = "";
  for (const part of statusGraphemes(text)) {
    if (statusDisplayWidth(clipped + part) > budget - 1) break;
    clipped += part;
  }
  return `${clipped}…`;
}

const MAX_BOX_CONTENT_WIDTH = 100;

export function formatBox(title: string, rows: Array<[string, string]>): string {
  const titleStr = ` ${clip(sanitizeStatusLabel(title), MAX_BOX_CONTENT_WIDTH - 6)} `;
  const safeRows = rows.map(([key, value]): [string, string] => [
    clip(sanitizeStatusLabel(key), MAX_BOX_CONTENT_WIDTH - 24),
    value,
  ]);
  const keyWidth = Math.max(0, ...safeRows.map(([key]) => statusDisplayWidth(key)));
  const valueBudget = MAX_BOX_CONTENT_WIDTH - keyWidth - 4;
  const visualRows = safeRows.flatMap(([key, value]) =>
    wrapStatusText(value, valueBudget).map((line, index): [string, string] => [
      index === 0 ? key : "",
      line,
    ]),
  );
  const titleWidth = statusDisplayWidth(titleStr);
  const contentWidth = Math.max(
    titleWidth + 4,
    ...visualRows.map(([, value]) => keyWidth + statusDisplayWidth(value) + 4),
  );
  const top = `┌─${titleStr}${"─".repeat(Math.max(0, contentWidth - titleWidth - 2))}─┐`;
  const lines = visualRows.map(([key, value]) => {
    const content = ` ${key}${" ".repeat(keyWidth - statusDisplayWidth(key))}  ${value}`;
    return `│${content}${" ".repeat(Math.max(0, contentWidth - statusDisplayWidth(content)))}│`;
  });
  return [top, ...lines, `└${"─".repeat(contentWidth)}┘`].join("\n");
}

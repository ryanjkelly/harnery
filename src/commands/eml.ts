import { readFileSync, writeFileSync } from "node:fs";
import type { Command } from "commander";
import { parseHTML } from "linkedom";
import { type ParsedMail, simpleParser } from "mailparser";
import type { EmitContext } from "../commander.ts";

/**
 * `eml` - Parse Gmail .eml thread exports into clean chronological markdown.
 *
 * Gmail exports a thread as a single .eml where older messages are nested
 * inside `<div class="gmail_quote">` blocks with attribution lines in
 * `<div class="gmail_attr">`. This command reconstructs the full thread
 * in chronological order. Falls back to plain-text quote parsing (`> `
 * prefixes + "On ... wrote:") when HTML is unavailable. Uses the injected
 * EmitContext so composed and standalone consumers share one code path.
 */

interface ThreadMessage {
  from: string;
  date: Date | null;
  body: string;
}

export function registerEmlCommand(program: Command, emit: EmitContext): void {
  program
    .command("eml")
    .description("Parse a Gmail .eml file into a clean chronological markdown thread")
    .argument("<file>", "Path to the .eml file")
    .option("-o, --output <path>", "Write output to a file instead of stdout")
    .option("--format <type>", "Output format: markdown, json", "markdown")
    .option("--headers", "Include the source message's full email headers")
    .option("--attachments", "List attachment filenames and sizes")
    .action(async (file: string, opts: EmlOpts) => {
      try {
        await handleEml(file, opts, emit);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        emit.error({ code: "eml_error", message: msg });
        process.exit(1);
      }
    });
}

export interface EmlOpts {
  output?: string;
  format: string;
  headers?: boolean;
  attachments?: boolean;
}

async function handleEml(file: string, opts: EmlOpts, emit: EmitContext): Promise<void> {
  const raw = readFileSync(file);
  const parsed = await simpleParser(raw);

  const messages = extractThread(parsed);

  if (messages.length === 0) {
    emit.error({ code: "no_messages", message: "No messages found in the .eml file." });
    process.exit(1);
  }

  if (opts.format === "json") {
    const rows = messages.map((m, i) => ({
      index: i + 1,
      from: m.from,
      date: m.date?.toISOString() ?? null,
      body: m.body,
    }));
    if (opts.output) {
      writeFileSync(opts.output, JSON.stringify(rows));
      emit.file(opts.output, { messages: messages.length, format: "json" });
    } else {
      emit.config({ format: "json" });
      emit.rows(rows as Record<string, unknown>[]);
    }
    return;
  }

  const output = renderMarkdown(parsed, messages, opts);
  if (opts.output) {
    writeFileSync(opts.output, output);
    emit.file(opts.output, { messages: messages.length, format: "markdown" });
  } else {
    emit.text(output);
  }
}

/**
 * Extract individual messages from the parsed email.
 * Strategy: use HTML body (Gmail quote structure) first, fall back to plain text.
 */
export function extractThread(parsed: ParsedMail): ThreadMessage[] {
  if (parsed.html && typeof parsed.html === "string") {
    const messages = extractFromHtml(parsed.html, parsed);
    if (messages.length > 0) return messages;
  }

  // Fallback: plain text
  if (parsed.text) {
    return extractFromPlainText(parsed.text, parsed);
  }

  return [];
}

/**
 * Parse Gmail's nested HTML quote structure.
 *
 * Gmail wraps each quoted reply in:
 *   <div class="gmail_quote">
 *     <div class="gmail_attr">On <date>, <name> <<email>> wrote:</div>
 *     <blockquote class="gmail_quote">...nested older messages...</blockquote>
 *   </div>
 */
function extractFromHtml(html: string, parsed: ParsedMail): ThreadMessage[] {
  const messages: ThreadMessage[] = [];

  // Work with the decoded HTML
  const doc = html;

  // Extract attribution lines and their positions to find message boundaries
  // Pattern: <div ... class="gmail_attr">On ..., ... wrote:<br></div>
  const attrPattern = /class=["']gmail_attr["'][^>]*>([\s\S]*?)<\/div>/gi;
  const attrs: { text: string; index: number }[] = [];

  let match: RegExpExecArray | null = attrPattern.exec(doc);
  while (match !== null) {
    attrs.push({ text: stripHtml(match[1]), index: match.index });
    match = attrPattern.exec(doc);
  }

  // The top-level message (newest) is before the first gmail_quote
  const firstQuoteIdx = doc.search(/class=["']gmail_quote\s*(gmail_quote_container)?["']/i);
  if (firstQuoteIdx > 0) {
    // Extract the top-level body (everything before the first quote container)
    const topBody = extractBodyBeforeQuote(doc, firstQuoteIdx);
    if (topBody.trim()) {
      messages.push({
        from: formatAddress(parsed.from),
        date: parsed.date ?? null,
        body: topBody,
      });
    }
  } else {
    // No quotes - single message
    messages.push({
      from: formatAddress(parsed.from),
      date: parsed.date ?? null,
      body: cleanBody(stripHtml(doc)),
    });
    return messages;
  }

  // Now extract each quoted message using attribution lines
  for (let i = 0; i < attrs.length; i++) {
    const attr = attrs[i];
    const { name, date } = parseAttribution(attr.text);

    // Find the blockquote that follows this attribution
    const afterAttr = doc.indexOf("</div>", attr.index + 10);
    if (afterAttr === -1) continue;

    // Find the blockquote content after the attribution div
    const searchRegion = doc.slice(afterAttr, afterAttr + 500);
    const bqStart = searchRegion.indexOf("<blockquote");
    if (bqStart === -1) continue;

    const bqStartAbsolute = afterAttr + bqStart;
    const bqContent = extractBlockquoteContent(doc, bqStartAbsolute);

    // The body is everything in this blockquote BEFORE any nested gmail_quote
    const nestedQuoteIdx = bqContent.search(/class=["']gmail_quote["']/i);
    const bodyHtml = nestedQuoteIdx > 0 ? bqContent.slice(0, nestedQuoteIdx) : bqContent;

    // Find the actual start of content (skip the opening blockquote tag)
    const tagEnd = bodyHtml.indexOf(">");
    const content = tagEnd > 0 ? bodyHtml.slice(tagEnd + 1) : bodyHtml;

    const body = cleanBody(stripHtml(content));
    if (body.trim()) {
      messages.push({ from: name, date, body });
    }
  }

  // Reverse: messages are newest-first in the .eml, we want oldest-first
  messages.reverse();
  return messages;
}

/**
 * Extract content of a blockquote tag, handling nested blockquotes.
 */
function extractBlockquoteContent(html: string, startIdx: number): string {
  let depth = 0;
  let i = startIdx;
  const openTag = /<blockquote/gi;
  const closeTag = /<\/blockquote>/gi;

  // Find the end of the opening tag
  const tagEnd = html.indexOf(">", startIdx);
  if (tagEnd === -1) return "";

  i = tagEnd + 1;
  depth = 1;

  while (depth > 0 && i < html.length) {
    openTag.lastIndex = i;
    closeTag.lastIndex = i;

    const nextOpen = openTag.exec(html);
    const nextClose = closeTag.exec(html);

    if (!nextClose) break;

    if (nextOpen && nextOpen.index < nextClose.index) {
      depth++;
      i = nextOpen.index + 12;
    } else {
      depth--;
      if (depth === 0) {
        return html.slice(tagEnd + 1, nextClose.index);
      }
      i = nextClose.index + 13;
    }
  }

  return html.slice(tagEnd + 1, Math.min(startIdx + 50000, html.length));
}

/**
 * Get body content before the first gmail_quote div.
 */
function extractBodyBeforeQuote(html: string, quoteIdx: number): string {
  // Walk backwards from the quote to find the containing div
  // The body is typically in the main content area before the quote
  let bodyHtml = html.slice(0, quoteIdx);

  // Remove the outermost container divs and get to the content
  // Look for the last closing tag before the quote div's opening
  const lastDivOpen = bodyHtml.lastIndexOf('<div class="gmail_quote');
  if (lastDivOpen === -1) {
    // Try the simpler approach: strip from after <body> or start of content
    const bodyTag = bodyHtml.indexOf("<body");
    if (bodyTag > 0) {
      const bodyEnd = bodyHtml.indexOf(">", bodyTag);
      bodyHtml = bodyHtml.slice(bodyEnd + 1);
    }
  } else {
    bodyHtml = bodyHtml.slice(0, lastDivOpen);
  }

  return cleanBody(stripHtml(bodyHtml));
}

/**
 * Fallback: parse plain text thread using "> " quote markers and "On ... wrote:" patterns.
 */
function extractFromPlainText(text: string, parsed: ParsedMail): ThreadMessage[] {
  const messages: ThreadMessage[] = [];
  const wrotePattern = /^On\s+.+\s+wrote:\s*$/m;

  const parts = text.split(wrotePattern);

  if (parts.length <= 1) {
    // No quoted thread found, single message
    messages.push({
      from: formatAddress(parsed.from),
      date: parsed.date ?? null,
      body: cleanBody(text),
    });
    return messages;
  }

  // First part is the newest message body
  messages.push({
    from: formatAddress(parsed.from),
    date: parsed.date ?? null,
    body: cleanBody(parts[0]),
  });

  // Find all "On ... wrote:" lines to get attributions
  const attrMatches = [...text.matchAll(/^(On\s+.+\s+wrote:)\s*$/gm)];
  for (let i = 0; i < attrMatches.length; i++) {
    const attrText = attrMatches[i][1];
    const { name, date } = parseAttribution(attrText);

    // The body is the next part, with ">" prefixes stripped
    if (i + 1 < parts.length) {
      const quotedBody = parts[i + 1]
        .split("\n")
        .map((line) => line.replace(/^>+\s?/, ""))
        .join("\n");
      messages.push({ from: name, date, body: cleanBody(quotedBody) });
    }
  }

  messages.reverse();
  return messages;
}

/**
 * Parse an attribution line like "On Fri, Apr 10, 2026 at 9:21 AM Tyler Prins <tyler@...> wrote:"
 */
function parseAttribution(text: string): { name: string; date: Date | null } {
  const cleaned = text.replace(/\s+/g, " ").trim();

  // Extract date: "On <date>, <name> ... wrote:"
  // Pattern: On <day>, <month> <day>, <year> at <time> <AM/PM>
  const dateMatch = cleaned.match(
    /On\s+\w+,\s+(\w+\s+\d{1,2},\s+\d{4})\s+at\s+(\d{1,2}:\d{2})\s*(?:\u202F|\s)*(AM|PM)?/i,
  );

  let date: Date | null = null;
  if (dateMatch) {
    const dateStr = `${dateMatch[1]} ${dateMatch[2]} ${dateMatch[3] ?? ""}`.trim();
    const parsed = new Date(dateStr);
    if (!Number.isNaN(parsed.getTime())) {
      date = parsed;
    }
  }

  // Extract name: everything after the time and before "wrote:" or before < email >
  const nameMatch = cleaned.match(/(?:AM|PM)\s+(.+?)(?:\s*<[^>]+>)?\s+wrote:/i);
  let name = "Unknown";
  if (nameMatch) {
    name = nameMatch[1].trim();
  } else {
    // Try simpler pattern without AM/PM
    const simpleMatch = cleaned.match(/at\s+[\d:]+\s+(.+?)(?:\s*<[^>]+>)?\s+wrote:/i);
    if (simpleMatch) {
      name = simpleMatch[1].trim();
    }
  }

  return { name, date };
}

/**
 * Strip HTML tags, decode entities, and normalize whitespace.
 */
function stripHtml(html: string): string {
  const { document } = parseHTML(`<html><body>${html}</body></html>`);
  for (const unsafe of document.querySelectorAll("script, style, template, noscript")) {
    unsafe.remove();
  }
  let text = document.body?.innerText ?? "";

  // Normalize whitespace (but preserve newlines)
  text = text
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n");

  return text;
}

/**
 * Clean up message body text.
 */
function cleanBody(text: string): string {
  let body = text;

  // Remove common email signatures
  const sigPatterns = [
    /^--\s*$/m, // standard sig delimiter
    /^Sent from my (iPhone|iPad|Galaxy|Android|Samsung)/m,
    /^Get Outlook for/m,
  ];

  for (const pattern of sigPatterns) {
    const match = body.match(pattern);
    if (match?.index !== undefined) {
      // Only strip if the signature is in the latter half of the message
      if (match.index > body.length * 0.3) {
        body = body.slice(0, match.index);
      }
    }
  }

  // The renderer emits Markdown. Neutralize raw HTML in both DOM-derived and
  // plain-text messages so decoded entities cannot become executable markup.
  body = body.replaceAll("<", "&lt;").replaceAll(">", "&gt;");

  // Collapse 3+ consecutive newlines into 2
  body = body.replace(/\n{3,}/g, "\n\n");

  return body.trim();
}

/**
 * Format an address object from mailparser into "Name <email>" or just "email".
 */
function formatAddress(addr: ParsedMail["from"]): string {
  if (!addr?.value?.[0]) return "Unknown";
  const a = addr.value[0];
  if (a.name) return a.name;
  return a.address ?? "Unknown";
}

/**
 * Render the thread as markdown.
 */
export function renderMarkdown(
  parsed: ParsedMail,
  messages: ThreadMessage[],
  opts: EmlOpts,
): string {
  const subject = parsed.subject ?? "Untitled Thread";
  const participants = new Map<string, boolean>();
  for (const m of messages) {
    participants.set(m.from, true);
  }

  const dates = messages.filter((m) => m.date).map((m) => m.date!);
  const minDate =
    dates.length > 0 ? formatDate(new Date(Math.min(...dates.map((d) => d.getTime())))) : "unknown";
  const maxDate =
    dates.length > 0 ? formatDate(new Date(Math.max(...dates.map((d) => d.getTime())))) : "unknown";

  const lines: string[] = [];
  lines.push(`# ${subject}`);
  lines.push("");
  lines.push(`**Participants:** ${[...participants.keys()].join(", ")}`);
  lines.push(`**Date range:** ${minDate} to ${maxDate}`);
  lines.push(`**Messages:** ${messages.length}`);

  if (opts.headers && parsed.headerLines?.length) {
    // A Gmail thread export is a SINGLE .eml (older messages are quoted HTML,
    // not separate MIME parts), so there is one real header set — the source
    // message's. Render it verbatim.
    lines.push("");
    lines.push("**Source headers:**");
    lines.push("");
    lines.push("```");
    for (const h of parsed.headerLines) {
      lines.push(h.line);
    }
    lines.push("```");
  }

  if (opts.attachments && parsed.attachments?.length) {
    lines.push("");
    lines.push("**Attachments:**");
    for (const att of parsed.attachments) {
      const size = att.size ? `(${formatSize(att.size)})` : "";
      lines.push(`- ${att.filename ?? "unnamed"} ${size}`);
    }
  }

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const dateStr = m.date ? formatDateTime(m.date) : "unknown date";

    lines.push("");
    lines.push("---");
    lines.push("");
    lines.push(`## ${i + 1}. ${m.from} - ${dateStr}`);
    lines.push("");
    lines.push(m.body);
  }

  lines.push("");
  return lines.join("\n");
}

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function formatDateTime(d: Date): string {
  return d.toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: "America/Chicago",
  });
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

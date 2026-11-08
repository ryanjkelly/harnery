import { describe, expect, test } from "bun:test";
import {
  formatJournalTimestamp,
  isUnreadableEntryHeader,
  parseEntryHeader,
  parseJournal,
  parseJournalTimestamp,
  serializeJournal,
} from "./codec.ts";

const at = (iso: string) => new Date(iso);

describe("formatJournalTimestamp", () => {
  test("writes wall clock plus numeric offset in the given zone", () => {
    expect(formatJournalTimestamp(at("2026-11-08T04:38:00Z"), "America/Chicago")).toBe(
      "2026-11-07 10:38 PM -06:00",
    );
    expect(formatJournalTimestamp(at("2026-07-01T00:05:00Z"), "UTC")).toBe(
      "2026-07-01 12:05 AM +00:00",
    );
    expect(formatJournalTimestamp(at("2026-07-01T12:00:59.999Z"), "UTC")).toBe(
      "2026-07-01 12:00 PM +00:00",
    );
  });

  test("spring-forward day never writes the skipped hour", () => {
    // 2026-03-08: Chicago jumps from 1:59:59 AM CST to 3:00 AM CDT at 08:00Z.
    expect(formatJournalTimestamp(at("2026-03-08T07:59:00Z"), "America/Chicago")).toBe(
      "2026-03-08 1:59 AM -06:00",
    );
    expect(formatJournalTimestamp(at("2026-03-08T08:00:00Z"), "America/Chicago")).toBe(
      "2026-03-08 3:00 AM -05:00",
    );
    expect(formatJournalTimestamp(at("2026-03-08T08:30:00Z"), "America/Chicago")).toBe(
      "2026-03-08 3:30 AM -05:00",
    );
  });

  test("fall-back day keeps the repeated hour distinct and ordered", () => {
    // 2026-11-01: 1:00-1:59 AM happens twice in Chicago (CDT, then CST).
    const first = formatJournalTimestamp(at("2026-11-01T06:30:00Z"), "America/Chicago");
    const second = formatJournalTimestamp(at("2026-11-01T07:30:00Z"), "America/Chicago");
    expect(first).toBe("2026-11-01 1:30 AM -05:00");
    expect(second).toBe("2026-11-01 1:30 AM -06:00");
    expect(parseJournalTimestamp(second)!.epoch_ms - parseJournalTimestamp(first)!.epoch_ms).toBe(
      3_600_000,
    );
  });

  test("fractional offsets", () => {
    expect(formatJournalTimestamp(at("2026-11-08T04:38:00Z"), "Asia/Kolkata")).toBe(
      "2026-11-08 10:08 AM +05:30",
    );
    expect(formatJournalTimestamp(at("2026-11-08T04:38:00Z"), "Asia/Kathmandu")).toBe(
      "2026-11-08 10:23 AM +05:45",
    );
    expect(formatJournalTimestamp(at("2026-07-01T12:00:00Z"), "America/St_Johns")).toBe(
      "2026-07-01 9:30 AM -02:30",
    );
  });

  test("round-trips to the same instant in every zone", () => {
    const instant = at("2026-11-08T04:38:00Z");
    for (const zone of [
      "UTC",
      "America/Chicago",
      "Asia/Kolkata",
      "Asia/Kathmandu",
      "Pacific/Kiritimati",
      "Pacific/Pago_Pago",
      "Australia/Lord_Howe",
    ]) {
      const parsed = parseJournalTimestamp(formatJournalTimestamp(instant, zone));
      expect(parsed?.epoch_ms).toBe(instant.getTime());
    }
  });
});

describe("parseJournalTimestamp", () => {
  test("accepts valid stamps and yields an exact ISO instant", () => {
    expect(parseJournalTimestamp("2026-11-07 10:38 PM -06:00")).toEqual({
      display: "2026-11-07 10:38 PM -06:00",
      iso: "2026-11-07T22:38:00-06:00",
      epoch_ms: Date.parse("2026-11-08T04:38:00Z"),
    });
    expect(parseJournalTimestamp("2026-01-01 12:00 AM +00:00")?.iso).toBe(
      "2026-01-01T00:00:00+00:00",
    );
    expect(parseJournalTimestamp("2026-01-01 12:15 PM +14:00")?.iso).toBe(
      "2026-01-01T12:15:00+14:00",
    );
    expect(parseJournalTimestamp("2028-02-29 1:00 AM +05:45")).not.toBeNull();
  });

  test.each([
    ["retired zone abbreviation", "2026-11-07 10:38 PM CST"],
    ["impossible date", "2026-02-30 1:00 AM -06:00"],
    ["non-leap February 29", "2026-02-29 1:00 AM -06:00"],
    ["month 13", "2026-13-01 1:00 AM -06:00"],
    ["hour 0", "2026-11-07 0:38 PM -06:00"],
    ["hour 13", "2026-11-07 13:38 PM -06:00"],
    ["leading-zero hour", "2026-11-07 01:38 PM -06:00"],
    ["minute 60", "2026-11-07 1:60 PM -06:00"],
    ["offset beyond 14 hours", "2026-11-07 1:00 PM +14:30"],
    ["offset minutes 60", "2026-11-07 1:00 PM +05:60"],
    ["negative zero offset", "2026-11-07 1:00 PM -00:00"],
    ["lowercase period", "2026-11-07 1:00 pm -06:00"],
    ["missing offset colon", "2026-11-07 1:00 PM -0600"],
    ["trailing text", "2026-11-07 1:00 PM -06:00 extra"],
  ])("rejects %s", (_label, stamp) => {
    expect(parseJournalTimestamp(stamp)).toBeNull();
  });
});

describe("entry headers", () => {
  test("parses only well-formed headers with a known category", () => {
    expect(parseEntryHeader("## 2026-11-07 10:38 PM -06:00 · note")?.category).toBe("note");
    expect(parseEntryHeader("## 2026-11-07 10:38 PM -06:00 · idea")).toBeNull();
    expect(parseEntryHeader("## Findings")).toBeNull();
  });

  test("flags header-shaped lines it cannot read", () => {
    expect(isUnreadableEntryHeader("## 2026-11-07 10:38 PM CST · note")).toBe(true);
    expect(isUnreadableEntryHeader("## 2026-02-30 10:38 PM -06:00 · note")).toBe(true);
    expect(isUnreadableEntryHeader("## 2026-11-07 10:38 PM -06:00 · note")).toBe(false);
    expect(isUnreadableEntryHeader("## 2026-11-07 notes from the call")).toBe(false);
    expect(isUnreadableEntryHeader("## Findings")).toBe(false);
  });
});

describe("parseJournal / serializeJournal", () => {
  const file = [
    "# Journal: agent-Test",
    "session_id: s1",
    "machine: box",
    "started: 2026-11-07 9:49 PM -06:00",
    "last_updated: 2026-11-07 10:38 PM -06:00",
    "",
    "---",
    "",
    "## 2026-11-07 10:38 PM -06:00 · handoff",
    "summary",
    "## Findings",
    "## 2026-11-07 notes, not a header",
    "detail",
    "",
    "## 2026-11-07 9:50 PM -06:00 · note",
    "first",
    "",
  ].join("\n");

  test("keeps markdown headings and date-led lines inside bodies", () => {
    const doc = parseJournal("x.md", file);
    expect(doc.unreadable_lines).toEqual([]);
    expect(doc.entries.map((e) => e.body)).toEqual([
      "summary\n## Findings\n## 2026-11-07 notes, not a header\ndetail",
      "first",
    ]);
    expect(serializeJournal(doc)).toBe(file);
  });

  test("reports unreadable header and metadata lines by line number", () => {
    const doc = parseJournal(
      "x.md",
      [
        "# Journal: agent-Test",
        "started: 2026-11-07 9:49 PM CST",
        "last_updated: not a date",
        "---",
        "## 2026-11-07 10:38 PM -06:00 · note",
        "body",
        "## 2026-11-07 9:55 PM CST · plan",
        "older",
      ].join("\n"),
    );
    expect(doc.unreadable_lines).toEqual([2, 7]);
    expect(doc.entries).toHaveLength(1);
  });
});

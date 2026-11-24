import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RemoteFeedsResult } from "../../src/core/presence/feed";
import {
  FEED_WINDOWS,
  feedItemAgents,
  feedItemMachines,
  parseFeedWindow,
  readFeedSnapshot,
} from "./feed-reader";

const HOUR = 60 * 60_000;
const roots: string[] = [];
// Real "now": the core reader skips files whose mtime predates the window.
const NOW = new Date();

afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "feed-reader-"));
  roots.push(root);
  mkdirSync(join(root, ".harnery", "inbox"), { recursive: true });
  mkdirSync(join(root, ".harnery", "journal"), { recursive: true });
  return root;
}

function ago(ms: number): Date {
  return new Date(NOW.getTime() - ms);
}

function message(id: string, at: Date, from: string, to: string, body: string): string {
  return JSON.stringify({
    schema: "harnery.inbox-record/v1",
    kind: "message",
    message_id: id,
    sender_instance_id: `inst-${from}`,
    sender_display_name: from,
    recipient_instance_id: `inst-${to}`,
    recipient_display_name: to,
    created_at: at.toISOString(),
    body,
    body_bytes: body.length,
  });
}

/** Journal stamp in a fixed -06:00 offset: `2026-11-23 6:14 PM -06:00`. */
function stamp(d: Date): string {
  const local = new Date(d.getTime() - 6 * HOUR);
  const pad = (n: number) => String(n).padStart(2, "0");
  const h24 = local.getUTCHours();
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  const ampm = h24 < 12 ? "AM" : "PM";
  return `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())} ${h12}:${pad(local.getUTCMinutes())} ${ampm} -06:00`;
}

function journal(name: string, machine: string, entries: Array<[Date, string, string]>): string {
  const first = entries[0]?.[0] ?? NOW;
  const last = entries[entries.length - 1]?.[0] ?? NOW;
  const body = entries
    .map(([at, category, text]) => `## ${stamp(at)} · ${category}\n${text}\n`)
    .join("\n");
  return `# Journal: agent-${name}\nsession_id: x\nmachine: ${machine}\nstarted: ${stamp(first)}\nlast_updated: ${stamp(last)}\n\n---\n\n${body}`;
}

function seed(root: string): void {
  writeFileSync(
    join(root, ".harnery", "inbox", "inst-Orion.jsonl"),
    [
      message("msg_1", ago(2 * HOUR), "Tessa", "Orion", "hi"),
      message("msg_old", ago(30 * HOUR), "Tessa", "Orion", "yesterday"),
      "not json",
    ].join("\n"),
  );
  writeFileSync(
    join(root, ".harnery", "journal", "11111111-2222-3333-4444-555555555555.md"),
    journal("Lorenzo", "m1", [
      [ago(5 * HOUR), "plan", "about to start"],
      [ago(HOUR), "done", "body\n  indented line"],
    ]),
  );
}

const noRemote = {
  presenceEnabled: () => false,
  feedShareEnabled: () => false,
  machine: "m1",
};

describe("readFeedSnapshot", () => {
  test("merges local messages and journal entries newest first", () => {
    const root = tempRoot();
    seed(root);
    const snap = readFeedSnapshot(root, { windowMs: FEED_WINDOWS["3d"] }, noRemote);
    expect(snap.error).toBeNull();
    expect(snap.items.map((i) => i.kind)).toEqual(["journal", "message", "journal", "message"]);
    const ats = snap.items.map((i) => Date.parse(i.at));
    expect([...ats].sort((a, b) => b - a)).toEqual(ats);
    const msg = snap.items.find((i) => i.kind === "message" && i.id === "msg_1");
    expect(msg?.kind === "message" && msg.from.name).toBe("Tessa");
    expect(msg?.kind === "message" && msg.to.name).toBe("Orion");
    const done = snap.items[0];
    expect(done.kind === "journal" && done.agent.name).toBe("Lorenzo");
    expect(done.kind === "journal" && done.category).toBe("done");
    expect(snap.sources).toHaveLength(1);
    expect(snap.sources[0]).toMatchObject({ local: true, label: "m1", items: 4 });
    expect(snap.sharing).toBe(false);
  });

  test("the window drops older items", () => {
    const root = tempRoot();
    seed(root);
    const snap = readFeedSnapshot(root, { windowMs: FEED_WINDOWS["24h"] }, noRemote);
    expect(snap.items.map((i) => i.id)).not.toContain("msg_old");
    expect(snap.items).toHaveLength(3);
  });

  test("an empty coord root yields an empty, error-free snapshot", () => {
    const root = mkdtempSync(join(tmpdir(), "feed-reader-empty-"));
    roots.push(root);
    const snap = readFeedSnapshot(root, {}, noRemote);
    expect(snap.items).toEqual([]);
    expect(snap.error).toBeNull();
  });

  test("a root with no git origin reads local items with real presence readers", () => {
    const root = tempRoot();
    seed(root);
    const snap = readFeedSnapshot(root, { windowMs: FEED_WINDOWS["3d"] }, { machine: "m1" });
    expect(snap.error).toBeNull();
    expect(snap.items).toHaveLength(4);
    expect(snap.sources.filter((s) => !s.local)).toEqual([]);
  });

  test("remote feeds merge, dedupe by id, honor the window and report sources", () => {
    const root = tempRoot();
    seed(root);
    const remote: RemoteFeedsResult = {
      feeds: [
        {
          ref: "m2-abc",
          machine: "m2",
          machine_id: "abc",
          published_at: ago(HOUR).toISOString(),
          age_secs: 3600,
          stale: false,
          truncated: 2,
          items: [
            {
              kind: "message",
              id: "msg_1",
              at: ago(2 * HOUR).toISOString(),
              from: { name: "Tessa", instance_id: "inst-Tessa", machine: "m2" },
              to: { name: "Orion", instance_id: "inst-Orion", machine: "m1" },
              body: "h…",
              body_truncated: true,
            },
            {
              kind: "journal",
              id: "j_remote",
              at: ago(10 * 60_000).toISOString(),
              agent: { name: "Nate", instance_id: null, machine: "m2" },
              category: "note",
              body: "remote note",
            },
            {
              kind: "journal",
              id: "j_remote_old",
              at: ago(40 * HOUR).toISOString(),
              agent: { name: "Nate", instance_id: null, machine: "m2" },
              category: "note",
              body: "too old for 24h",
            },
          ],
        },
      ],
      skipped: [
        { ref: "m3", reason: "invalid_json" },
        { ref: "self", reason: "self" },
      ],
    };
    const snap = readFeedSnapshot(
      root,
      { windowMs: FEED_WINDOWS["24h"] },
      {
        ...noRemote,
        presenceEnabled: () => true,
        feedShareEnabled: () => true,
        readRemoteFeeds: () => remote,
      },
    );
    expect(snap.items[0].id).toBe("j_remote");
    const ids = snap.items.map((i) => i.id);
    expect(ids.filter((id) => id === "msg_1")).toHaveLength(1);
    expect(ids).not.toContain("j_remote_old");
    const merged = snap.items.find((i) => i.id === "msg_1");
    expect(merged?.body).toBe("hi");
    expect(snap.sources).toHaveLength(2);
    expect(snap.sources[1]).toMatchObject({ label: "m2", local: false, items: 2, truncated: 2 });
    expect(snap.malformedRefs).toEqual(["m3"]);
    expect(snap.sharing).toBe(true);
  });

  test("the render cap keeps the newest items and counts the rest", () => {
    const root = tempRoot();
    seed(root);
    const snap = readFeedSnapshot(
      root,
      { windowMs: FEED_WINDOWS["3d"] },
      {
        ...noRemote,
        renderCap: 2,
      },
    );
    expect(snap.items).toHaveLength(2);
    expect(snap.dropped).toBe(2);
    expect(snap.items[0].kind).toBe("journal");
  });

  test("a throwing reader degrades to an empty snapshot with a reason", () => {
    const snap = readFeedSnapshot(
      "/nonexistent",
      {},
      {
        ...noRemote,
        readLocalFeed: () => {
          throw new Error("boom");
        },
      },
    );
    expect(snap.items).toEqual([]);
    expect(snap.error).toBe("boom");
  });
});

describe("helpers", () => {
  test("parseFeedWindow falls back to 3d", () => {
    expect(parseFeedWindow("24h")).toBe("24h");
    expect(parseFeedWindow(["7d"])).toBe("7d");
    expect(parseFeedWindow("1y")).toBe("3d");
    expect(parseFeedWindow(undefined)).toBe("3d");
  });

  test("item machines and agents cover both message ends", () => {
    const item = {
      kind: "message" as const,
      id: "x",
      at: NOW.toISOString(),
      from: { name: "A", instance_id: null, machine: "m1" },
      to: { name: "B", instance_id: null, machine: "m2" },
      body: "",
    };
    expect(feedItemMachines(item)).toEqual(["m1", "m2"]);
    expect(feedItemAgents(item)).toEqual(["A", "B"]);
  });
});

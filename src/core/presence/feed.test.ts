import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeDir } from "../../../tests/helpers/remove-dir.ts";
import { mergeFeedItems, readLocalFeed } from "../feed/index.ts";
import {
  buildFeedBlob,
  FEED_STALE_SECS,
  feedShareEnabled,
  parseFeedBlob,
  publishFeed,
  readRemoteFeeds,
} from "./feed.ts";
import { FEED_REF_PREFIX, pushMachineRef, writePresenceCommit } from "./git.ts";
import { fetchPresence, publishPresence } from "./index.ts";

/** Shared agent feed (ADR 0274) against a bare temp origin and two clones. */

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", ["-C", cwd, ...args], { windowsHide: true, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

function share(root: string, on: boolean): void {
  writeFileSync(
    join(root, ".harnery", "config.jsonc"),
    `// test config\n{ "feed": { "share": ${on} } }\n`,
  );
}

function ping(root: string, id: string, body: string, at = new Date().toISOString()): void {
  mkdirSync(join(root, ".harnery", "inbox"), { recursive: true });
  writeFileSync(
    join(root, ".harnery", "inbox", "recipient-1.jsonl"),
    `${JSON.stringify({
      schema: "harnery.inbox-record/v1",
      kind: "message",
      message_id: id,
      sender_instance_id: "s-1",
      sender_display_name: "Tessa",
      recipient_instance_id: "recipient-1",
      recipient_display_name: "Orion",
      created_at: at,
      body,
      body_bytes: body.length,
    })}\n`,
    { flag: "a" },
  );
}

let base: string;
let origin: string;
let cloneA: string;
let cloneB: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "harnery-feed-share-"));
  origin = join(base, "origin.git");
  cloneA = join(base, "a");
  cloneB = join(base, "b");
  spawnSync("git", ["init", "--bare", origin], { encoding: "utf8" });
  for (const c of [cloneA, cloneB]) {
    spawnSync("git", ["init", c], { encoding: "utf8" });
    git(c, "remote", "add", "origin", origin);
    mkdirSync(join(c, ".harnery"), { recursive: true });
  }
  for (const k of ["HARNERY_MACHINE", "HARNERY_PRESENCE", "HARNERY_FEED_SHARE"]) {
    savedEnv[k] = process.env[k];
  }
  process.env.HARNERY_PRESENCE = "1";
  delete process.env.HARNERY_FEED_SHARE;
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  removeDir(base);
});

describe("feedShareEnabled", () => {
  test("off by default, on with feed.share, env overrides, needs presence", () => {
    expect(feedShareEnabled(cloneA)).toBe(false);
    share(cloneA, true);
    expect(feedShareEnabled(cloneA)).toBe(true);
    process.env.HARNERY_FEED_SHARE = "0";
    expect(feedShareEnabled(cloneA)).toBe(false);
    process.env.HARNERY_FEED_SHARE = "1";
    process.env.HARNERY_PRESENCE = "0";
    expect(feedShareEnabled(cloneA)).toBe(false);
  });

  test("sharing off publishes nothing", () => {
    ping(cloneA, "msg_1", "hello");
    expect(publishFeed(cloneA, { sync: true }).status).toBe("skipped");
    expect(git(origin, "for-each-ref", `${FEED_REF_PREFIX}*`)).toBe("");
  });
});

describe("buildFeedBlob", () => {
  test("clamps bodies and caps items and bytes, oldest first", () => {
    const now = new Date();
    for (let i = 0; i < 6; i++) {
      ping(cloneA, `msg_${i}`, "x".repeat(900), new Date(now.getTime() - i * 60_000).toISOString());
    }
    const clamped = buildFeedBlob(cloneA, { now, machine: "m", limits: { body: 100 } });
    expect(clamped.blob.items.every((i) => i.body.length <= 100 && i.body_truncated)).toBe(true);

    const counted = buildFeedBlob(cloneA, { now, machine: "m", limits: { items: 4 } });
    expect(counted.blob.items.map((i) => i.id)).toEqual(["msg_0", "msg_1", "msg_2", "msg_3"]);
    expect(counted.blob.truncated).toBe(2);

    const sized = buildFeedBlob(cloneA, { now, machine: "m", limits: { bytes: 3_000 } });
    expect(Buffer.byteLength(sized.json)).toBeLessThanOrEqual(3_000);
    expect(sized.blob.items[0]!.id).toBe("msg_0");
    expect(sized.blob.truncated).toBeGreaterThan(0);
  });

  test("parseFeedBlob drops malformed items and rejects bad blobs", () => {
    expect(parseFeedBlob("{nope")).toBeNull();
    expect(parseFeedBlob(JSON.stringify({ v: 2, kind: "feed" }))).toBeNull();
    const blob = parseFeedBlob(
      JSON.stringify({
        v: 1,
        kind: "feed",
        machine: "m",
        machine_id: "abcdef123456",
        published_at: "2026-11-23T00:00:00Z",
        truncated: 0,
        items: [
          {
            kind: "journal",
            id: "j_1",
            at: "2026-11-23T00:00:00Z",
            body: "ok",
            category: "done",
            agent: { name: "agent-Ada", machine: "m" },
          },
          {
            kind: "journal",
            id: "j_2",
            at: "2026-11-23T00:00:00Z",
            body: "bad",
            category: "rant",
            agent: { name: "Ada", machine: "m" },
          },
          {
            kind: "message",
            id: "has space",
            at: "2026-11-23T00:00:00Z",
            body: "x",
            from: {},
            to: {},
          },
        ],
      }),
    );
    expect(blob?.items).toHaveLength(1);
    expect(blob?.items[0]).toMatchObject({ id: "j_1", agent: { name: "Ada" } });
  });
});

describe("publish → fetch → read", () => {
  test("machine B reads machine A's feed, and a cross-machine ping merges to one item", () => {
    process.env.HARNERY_MACHINE = "machine-a";
    share(cloneA, true);
    ping(cloneA, "msg_shared", "seen on both machines");
    ping(cloneA, "msg_only_a", "only on A");
    publishPresence(cloneA, { sync: true });
    expect(git(origin, "for-each-ref", `${FEED_REF_PREFIX}*`)).toContain(
      `${FEED_REF_PREFIX}machine-a`,
    );

    process.env.HARNERY_MACHINE = "machine-b";
    ping(cloneB, "msg_shared", "seen on both machines");
    expect(fetchPresence(cloneB, { force: true, sync: true }).status).toBe("fetched");
    const { feeds } = readRemoteFeeds(cloneB);
    expect(feeds).toHaveLength(1);
    expect(feeds[0]).toMatchObject({ machine: "machine-a", stale: false });
    const merged = mergeFeedItems(readLocalFeed(cloneB).items, ...feeds.map((f) => f.items));
    expect(merged.map((i) => i.id).sort()).toEqual(["msg_only_a", "msg_shared"]);

    fetchPresence(cloneA, { force: true, sync: true });
    expect(readRemoteFeeds(cloneA).feeds).toHaveLength(0);
  });

  test("unchanged feed is skipped; turning sharing off withdraws it", () => {
    process.env.HARNERY_MACHINE = "machine-a";
    share(cloneA, true);
    const t0 = new Date();
    ping(cloneA, "msg_1", "first", t0.toISOString());
    expect(publishFeed(cloneA, { sync: true, now: t0 }).status).toBe("published");
    const t1 = new Date(t0.getTime() + 120_000);
    expect(publishFeed(cloneA, { sync: true, now: t1 }).status).toBe("skipped");

    share(cloneA, false);
    const t2 = new Date(t0.getTime() + 240_000);
    expect(publishFeed(cloneA, { sync: true, now: t2 }).status).toBe("published");
    process.env.HARNERY_MACHINE = "machine-b";
    fetchPresence(cloneB, { force: true, sync: true });
    expect(readRemoteFeeds(cloneB, { now: t2 }).feeds).toHaveLength(0);
    expect(publishFeed(cloneA, { sync: true }).status).toBe("skipped");
  });

  test("stale feeds are flagged and malformed refs are skipped with a reason", () => {
    process.env.HARNERY_MACHINE = "machine-a";
    share(cloneA, true);
    const old = new Date(Date.now() - (FEED_STALE_SECS + 600) * 1000);
    ping(cloneA, "msg_old", "old news", old.toISOString());
    expect(publishFeed(cloneA, { sync: true, now: old }).status).toBe("published");
    const junk = writePresenceCommit(cloneA, "{not json");
    pushMachineRef(cloneA, FEED_REF_PREFIX, "broken", junk!, { sync: true });

    process.env.HARNERY_MACHINE = "machine-b";
    fetchPresence(cloneB, { force: true, sync: true });
    const { feeds, skipped } = readRemoteFeeds(cloneB);
    expect(feeds.map((f) => f.ref)).toEqual(["machine-a"]);
    expect(feeds[0]!.stale).toBe(true);
    expect(skipped).toEqual([{ ref: "broken", reason: "invalid_json" }]);
  });
});

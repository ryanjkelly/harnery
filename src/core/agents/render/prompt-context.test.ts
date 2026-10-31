import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeV3Fixture, seedV3Session } from "../../../../tests/helpers/event-v3-runtime.ts";
import {
  recordLiveHookSignalV3,
  resolveLiveEventLedgerRouteV3,
} from "../../events/v3/live-routing.ts";
import { readLiveCoordinationRows } from "../state/live-coordination-view.ts";
import { markTurnRitualBounced, renderPeerTable, renderPromptContext } from "./prompt-context.ts";

let root: string;

beforeEach(() => {
  root = join(tmpdir(), `harnery-prompt-v3-${process.pid}-${crypto.randomUUID()}`);
  initializeV3Fixture(root);
  writeFileSync(
    join(root, ".harnery", "config.jsonc"),
    `{ "agents": { "requireGitFinalization": false } }`,
    "utf8",
  );
  seedV3Session(root, "self", { name: "Maya", task: "current focus" });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("renderPromptContext on the V3 coordination projection", () => {
  test("no peers, no councils, and a current task produce no extra context", () => {
    expect(render()).toBe("");
  });

  test("the Codex footer remains fresh and uses the host's configured finalization command", () => {
    const first = render({ statusFooterNudge: true });
    const second = render({ statusFooterNudge: true });
    for (const output of [first, second]) {
      expect(output).toContain("complete the user's request first");
      expect(output).toContain("harn agents status");
      expect(output).not.toContain("status --end-turn");
    }

    writeFileSync(
      join(root, ".harnery", "config.jsonc"),
      `{ "agents": { "requireGitFinalization": true } }`,
      "utf8",
    );
    expect(render({ statusFooterNudge: true })).toContain("harn agents status --end-turn");
  });

  test("the host prompt reminder stays fresh without entering deduplication state", () => {
    const reminder = "Use the project voice without dropping uncertainty.";
    writeFileSync(
      join(root, ".harnery", "config.jsonc"),
      JSON.stringify({ instructions: { promptReminder: reminder } }),
      "utf8",
    );
    seedV3Session(root, "peer", { name: "Adelaide", claims: ["docs/x.md"] });

    expect(render({ hostPromptReminder: true })).toContain(reminder);
    expect(render({ hostPromptReminder: true })).toBe(reminder);

    const runtimeFiles = readdirSync(join(root, ".harnery"))
      .filter((name) => name !== "config.jsonc")
      .filter((name) => existsSync(join(root, ".harnery", name)))
      .filter((name) => name.startsWith(".last-"));
    const runtimeText = runtimeFiles
      .map((name) => readFileSync(join(root, ".harnery", name), "utf8"))
      .join("\n");
    expect(runtimeText).not.toContain(reminder);
  });

  test("the stop-enforced turn ritual is adapter-specific", () => {
    const claude = render({ turnRitualNudge: "claude-code" });
    expect(claude).toContain("Turn ritual (Stop-enforced)");
    expect(claude).toContain("paste its output verbatim in a fenced code block");

    markTurnRitualBounced(root, "self");
    const cursor = render({ turnRitualNudge: "cursor" });
    expect(cursor).toContain("Turn ritual (Stop-enforced)");
    expect(cursor).toContain("paste its output verbatim in a fenced code block");
  });

  test("the turn ritual reminder appears only when it is news", () => {
    expect(render({ turnRitualNudge: "claude-code" })).toContain("Turn ritual (Stop-enforced)");
    expect(render({ turnRitualNudge: "claude-code" })).toBe("");
    expect(render({ turnRitualNudge: "claude-code" })).toBe("");

    markTurnRitualBounced(root, "self");
    const afterBounce = render({ turnRitualNudge: "claude-code" });
    expect(afterBounce).toContain("previous turn was bounced by the Stop hook");
    expect(afterBounce).toContain("Turn ritual (Stop-enforced)");
    expect(render({ turnRitualNudge: "claude-code" })).toBe("");

    // A compaction advances the context generation and drops the old reminder.
    const dir = join(
      root,
      ".harnery",
      "context",
      createHash("sha256").update("self").digest("hex").slice(0, 24),
    );
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "state.json"), JSON.stringify({ generation: 2 }), "utf8");
    expect(render({ turnRitualNudge: "claude-code" })).toContain("Turn ritual (Stop-enforced)");
    expect(render({ turnRitualNudge: "claude-code" })).toBe("");
  });

  test("peer changes refresh the semantic hash from canonical V3 claims", () => {
    seedV3Session(root, "peer", {
      name: "Adelaide",
      task: "review docs",
      claims: ["docs/x.md"],
    });
    const first = render();
    expect(first).toContain("agent-Adelaide");
    expect(first).toContain("docs/x.md");
    expect(render()).toBe("");
    expect(existsSync(join(root, ".harnery", ".last-peer-hash.self"))).toBe(true);
  });

  test("a peer that only changes activity does not reprint the table", () => {
    seedV3Session(root, "peer", { name: "Adelaide", claims: ["docs/x.md"] });
    expect(render()).toContain("agent-Adelaide");
    const before = peerActivity("peer");
    const route = resolveLiveEventLedgerRouteV3(root);
    if (route.state !== "v3") throw new Error("expected V3 route");
    recordLiveHookSignalV3({
      coordRoot: root,
      route,
      eventName: "user-prompt-submit",
      adapter: "codex",
      instanceId: "peer",
      payload: { session_id: "peer", turn_id: "peer-turn-1", raw: {} },
    });
    expect(peerActivity("peer")).not.toBe(before);
    expect(render()).toBe("");

    // A new claim is news and reprints.
    seedV3Session(root, "peer", { name: "Adelaide", claims: ["docs/y.md"] });
    expect(render()).toContain("docs/y.md");
    // A peer arriving is news and reprints.
    seedV3Session(root, "peer2", { name: "Bruno" });
    expect(render()).toContain("agent-Bruno");
    // A lifecycle change is news and reprints.
    seedV3Session(root, "peer2", { name: "Bruno", lifecycle: "done" });
    expect(render()).toContain("lifecycle=done");
  });

  test("an empty task produces one deduplicated focus nudge", () => {
    seedV3Session(root, "unset", { name: "Nora" });
    const opts = {
      coordRoot: root,
      instanceId: "unset",
      sessionId: "unset",
      agentName: "Nora",
      taskNudge: true,
    };
    expect(renderPromptContext(opts)).toContain("set-task");
    expect(renderPromptContext(opts)).toBe("");
  });

  test("session-name nudges cover unminted, pending, shown, and re-minted states", () => {
    const cachePath = join(root, ".harnery", "active", "self.json");
    const updateSelf = (fields: Record<string, unknown>) => {
      const row = JSON.parse(readFileSync(cachePath, "utf8")) as Record<string, unknown>;
      for (const [key, value] of Object.entries(fields)) {
        if (value === undefined) delete row[key];
        else row[key] = value;
      }
      writeFileSync(cachePath, JSON.stringify(row), "utf8");
    };

    updateSelf({ suggested_session_name: undefined, session_name_seen_for: undefined });
    const unminted = render({ sessionNameNudge: true });
    expect(unminted).toContain("has no name yet");
    expect(render({ sessionNameNudge: true })).toContain("has no name yet");

    const name = "Agent Maya - Current focus";
    updateSelf({ suggested_session_name: name });
    const pending = render({ sessionNameNudge: true });
    expect(pending).toContain("still pending display");
    expect(pending).toContain(`\`\`\`\n${name}\n\`\`\``);
    expect(render({ sessionNameNudge: true })).toBe("");
    updateSelf({ task: "A different current focus", task_updated_at: new Date().toISOString() });
    expect(render({ sessionNameNudge: true })).toBe("");

    updateSelf({ session_name_seen_for: name });
    expect(render({ sessionNameNudge: true })).toBe("");

    const reminted = "[DONE] Agent Maya - Current focus";
    updateSelf({ suggested_session_name: reminted });
    expect(render({ sessionNameNudge: true })).toContain(reminted);
  });

  test("the peer hash retains no rendered identities", () => {
    seedV3Session(root, "peer", { name: "Adelaide", claims: ["docs/x.md"] });
    render();
    const hash = readFileSync(join(root, ".harnery", ".last-peer-hash.self"), "utf8");
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
    expect(hash).not.toContain("Adelaide");
  });
});

function peerActivity(id: string): string | undefined {
  return readLiveCoordinationRows(root).find((row) => row.instance_id === id)?.activity;
}

function render(extra: Record<string, unknown> = {}): string {
  return renderPromptContext({
    coordRoot: root,
    instanceId: "self",
    sessionId: "self",
    agentName: "Maya",
    ...extra,
  });
}

describe("renderPeerTable", () => {
  const nowMs = Date.parse("2026-10-31T15:00:00Z");
  const iso = (agoSec: number) => new Date(nowMs - agoSec * 1000).toISOString();
  const peer = (id: string, agoSec: number, extra: Record<string, unknown> = {}) => ({
    instance_id: id,
    name: `P${id}`,
    session_id: `s-${id}`,
    kind: "session",
    started_at: iso(agoSec + 60),
    last_heartbeat: iso(agoSec),
    activity: "working" as const,
    task_state: "active" as const,
    ...extra,
  });
  const table = (peers: ReturnType<typeof peer>[]) =>
    renderPeerTable({ peers, remote: [], mySessionId: "me", nowMs, freshnessSeconds: 600 });

  test("peers past the freshness window are counted, not listed", () => {
    const peers = [
      ...Array.from({ length: 8 }, (_, i) => peer(`live${i}`, 30)),
      ...Array.from({ length: 30 }, (_, i) => peer(`old${i}`, 3600)),
    ];
    const out = table(peers).table;
    expect(out.match(/^ {2}- agent-/gm)).toHaveLength(8);
    expect(out).not.toContain("Pold");
    expect(out).toContain("+30 more (30 with no recent heartbeat)");
  });

  test("no live peers prints nothing, and a peer going stale changes the key", () => {
    expect(table([peer("a", 3600)]).table).toBe("");
    const fresh = table([peer("a", 30), peer("b", 30)]).hash;
    expect(table([peer("a", 30), peer("b", 3600)]).hash).not.toBe(fresh);
  });

  test("activity and task changes keep the key; claims and lifecycle change it", () => {
    const base = table([peer("a", 30)]).hash;
    expect(table([peer("a", 30, { activity: "idle", task: "other" })]).hash).toBe(base);
    expect(table([peer("a", 30, { files_touched: ["x.ts"] })]).hash).not.toBe(base);
    expect(table([peer("a", 30, { task_state: "done" })]).hash).not.toBe(base);
  });

  test("unnamed and duplicate names render as one full, distinct name", () => {
    const out = table([
      peer("01a171dc-b571-72c3-b4b7-5d5a9612a322", 30, { name: undefined }),
      peer("01a171dc-b969-7fc2-8407-a0a559c7b9f9", 30, { name: undefined }),
      peer("wf-2026-10-25T07-00-48-619Z-7c0c84-a4", 30, { name: undefined }),
      peer("one", 30, { name: "Amelia" }),
      peer("two", 30, { name: "Amelia" }),
    ]).table;
    expect(out).toContain("agent-01a171dc-b571-72c3-b4b7-5d5a9612a322 ");
    expect(out).toContain("agent-01a171dc-b969-7fc2-8407-a0a559c7b9f9 ");
    expect(out).toContain("agent-wf-2026-10-25T07-00-48-619Z-7c0c84-a4 ");
    expect(out).toContain("agent-Amelia (one)");
    expect(out).toContain("agent-Amelia (two)");
  });
});

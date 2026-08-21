import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeV3Fixture, seedV3Session } from "../../../../tests/helpers/event-v3-runtime.ts";
import { renderPromptContext } from "./prompt-context.ts";

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

  test("the stop-enforced turn ritual is adapter-specific", () => {
    const claude = render({ turnRitualNudge: "claude-code" });
    expect(claude).toContain("Turn ritual (Stop-enforced)");
    expect(claude).toContain("paste its output verbatim in a fenced code block");

    const cursor = render({ turnRitualNudge: "cursor" });
    expect(cursor).toContain("Turn ritual (Stop-enforced)");
    expect(cursor).not.toContain("paste its output verbatim in a fenced code block");
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
    expect(render({ sessionNameNudge: true })).toContain("still pending display");

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

function render(extra: Record<string, unknown> = {}): string {
  return renderPromptContext({
    coordRoot: root,
    instanceId: "self",
    sessionId: "self",
    agentName: "Maya",
    ...extra,
  });
}

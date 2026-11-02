import { describe, expect, test } from "bun:test";
import type { RelayStatus } from "../core/presence/relay-status.ts";
import { formatRelayStatus } from "./presence.ts";

const status: RelayStatus = {
  generated_at: "2026-01-01T01:00:00.000Z",
  machine: "machine-local",
  presence_enabled: true,
  relay: { configured: true, url: "wss://relay.test" },
  room: { id_prefix: "abcd1234", salted: false },
  daemon: {
    pid_record: { pid: 42, url: "wss://relay.test", started_at: "2026-01-01T00:00:00.000Z" },
    pid_alive: true,
    running: true,
    url_matches_config: true,
    started_at: "2026-01-01T00:00:00.000Z",
    uptime_secs: 3600,
  },
  log: {
    source: "shared",
    truncated: false,
    last_connected: {
      at: "2026-01-01T00:59:00.000Z",
      event: "relay.lifecycle",
      phase: "connected",
      message: "connected",
      fields: {},
    },
    last_disconnected: {
      at: "2026-01-01T00:58:59.000Z",
      event: "relay.disconnected",
      phase: "disconnected",
      message: "disconnected",
      fields: { code: 1006 },
    },
    last_idle_exit: null,
    last_superseded: null,
    last_error: null,
    since_daemon_start: { connects: 2, disconnects: 1 },
  },
  relay_cache: [
    {
      machine: "machine-b",
      self: false,
      published_at: "2026-01-01T00:59:30.000Z",
      age_secs: 30,
      stale: false,
      agents: 2,
    },
  ],
  git_refs: [],
  publish_state: null,
};

describe("formatRelayStatus", () => {
  test("summarizes relay, daemon, last events and peers in plain lines", () => {
    const text = formatRelayStatus(status);
    expect(text).toContain("relay: wss://relay.test");
    expect(text).toContain("room: abcd1234…");
    expect(text).toContain("daemon: running, pid 42");
    expect(text).toContain("last disconnect: ");
    expect(text).toContain("(code 1006)");
    expect(text).toContain("last idle exit: never");
    expect(text).toContain("since daemon start: 2 connects, 1 disconnects logged");
    expect(text).toContain("  machine-b  2 agents, published ");
    expect(text).toContain("git refs: none");
    expect(text).toContain("last git publish: never");
    expect(text.endsWith("\n")).toBeTrue();
  });

  test("an unconfigured relay says so", () => {
    const text = formatRelayStatus({
      ...status,
      relay: { configured: false, url: null },
      daemon: { ...status.daemon, pid_record: null, pid_alive: false, running: false },
    });
    expect(text).toContain("relay: not configured (git-refs transport only)");
    expect(text).toContain("daemon: not running\n");
  });
});

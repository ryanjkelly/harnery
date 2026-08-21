import { beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { readRemotePanels } from "./remote-source";

const NOW = new Date("2026-08-16T12:00:00.000Z");

let root: string;

function writeBlob(machine: string, blob: unknown): void {
  const dir = path.join(root, "presence", "remote");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${machine}.json`), JSON.stringify(blob));
}

function agent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    instance_id: "remote-1",
    name: "Quentin",
    task: "Review round-4 fixes",
    activity: "working",
    task_state: "active",
    last_heartbeat: "2026-08-16T11:59:30.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "codec-remote-"));
});

describe("readRemotePanels", () => {
  test("a fresh blob renders labeled online panels with projection provenance", () => {
    writeBlob("rk-machine", {
      v: 1,
      machine: "rk-machine",
      published_at: "2026-08-16T11:59:40.000Z",
      agents: [agent()],
    });
    const panels = readRemotePanels(NOW, root);
    expect(panels).toHaveLength(1);
    const p = panels[0];
    if (!p) throw new Error("panel missing");
    expect(p.machine).toBe("rk-machine");
    expect(p.identity.display_name).toBe("Quentin");
    expect(p.presence).toMatchObject({
      value: "online",
      provenance: "projection",
      confidence: "medium",
    });
    expect(p.activity.value).toBe("working");
    expect(p.lifecycle).toMatchObject({ value: "active", confidence: "medium" });
    expect(p.expression.value).toBe("neutral");
    expect(p.character.pack_id).toBe("fallback-neutral");
  });

  test("renders only validated remote Codec digest fields", () => {
    writeBlob("rk-machine", {
      v: 1,
      machine: "rk-machine",
      published_at: "2026-08-16T11:59:40.000Z",
      agents: [
        agent({
          codec: {
            schema_version: 1,
            observed_at: "2026-08-16T11:59:35.000Z",
            operation: {
              category: "test",
              label: "Testing",
              event_id: "evt_remote_open",
              observed_at: "2026-08-16T11:59:32.000Z",
            },
            context: {
              used_percent: 88,
              confidence: "exact",
              event_id: "evt_remote_context",
              observed_at: "2026-08-16T11:59:31.000Z",
            },
            recent_actions: [
              {
                category: "edit",
                outcome: "ok",
                event_id: "evt_remote_action",
                observed_at: "2026-08-16T11:59:30.000Z",
                secret: "must not cross",
              },
            ],
          },
        }),
      ],
    });
    const panel = readRemotePanels(NOW, root)[0];
    expect(panel?.operation).toMatchObject({
      value: { category: "test", label: "Testing", state: "active" },
      provenance: "projection",
      evidence_event_ids: ["evt_remote_open"],
    });
    expect(panel?.context_band.value).toBe("low");
    expect(panel?.recent_actions).toEqual([
      {
        category: "edit",
        outcome: "ok",
        event_id: "evt_remote_action",
        observed_at: "2026-08-16T11:59:30.000Z",
      },
    ]);
  });

  test("an aging blob degrades presence; an old one drops the machine", () => {
    writeBlob("aging", {
      v: 1,
      machine: "aging",
      published_at: "2026-08-16T11:55:00.000Z", // 5 min: past fresh, before drop
      agents: [agent({ instance_id: "remote-2" })],
    });
    writeBlob("gone", {
      v: 1,
      machine: "gone",
      published_at: "2026-08-16T11:45:00.000Z", // 15 min: dropped
      agents: [agent({ instance_id: "remote-3" })],
    });
    const panels = readRemotePanels(NOW, root);
    expect(panels.map((p) => p.instance_id)).toEqual(["remote-2"]);
    expect(panels[0]?.presence.value).toBe("unknown");
  });

  test("a stale per-agent heartbeat inside a fresh blob is not online", () => {
    writeBlob("rk-machine", {
      v: 1,
      machine: "rk-machine",
      published_at: "2026-08-16T11:59:40.000Z",
      agents: [agent({ last_heartbeat: "2026-08-16T11:40:00.000Z" })],
    });
    expect(readRemotePanels(NOW, root)[0]?.presence.value).toBe("unknown");
  });

  test("unknown blob versions and malformed files fail closed; empty cache is empty", () => {
    expect(readRemotePanels(NOW, root)).toEqual([]);
    writeBlob("v2", {
      v: 2,
      machine: "v2",
      published_at: "2026-08-16T11:59:40.000Z",
      agents: [agent()],
    });
    const dir = path.join(root, "presence", "remote");
    writeFileSync(path.join(dir, "junk.json"), "{not json");
    expect(readRemotePanels(NOW, root)).toEqual([]);
  });
});

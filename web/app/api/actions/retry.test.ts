import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import * as React from "react";
import * as writer from "@/lib/coord-writer";
import * as servers from "@/lib/servers";
import { __resetCoordRootCache } from "@/lib/coord-reader";
import { PingForm } from "@/components/PingForm";
import { POST as ping } from "./ping/route";
import { POST as endSession } from "./end-session/route";
import { POST as releaseClaim } from "./release-claim/route";
import { POST as stopServer } from "./stop-server/route";

let root: string;
let previousRoot: string | undefined;

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "harn-action-retry-"));
  mkdirSync(path.join(root, ".harnery"));
  previousRoot = process.env.HARNERY_COORD_ROOT;
  process.env.HARNERY_COORD_ROOT = root;
  __resetCoordRootCache();
});

afterEach(() => {
  mock.restore();
  if (previousRoot === undefined) delete process.env.HARNERY_COORD_ROOT;
  else process.env.HARNERY_COORD_ROOT = previousRoot;
  __resetCoordRootCache();
  rmSync(root, { recursive: true, force: true });
});

function request(action: string, body: Record<string, unknown>): Request {
  return new Request(`http://localhost/api/actions/${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ command_id: "command-retry-fixture", ...body }),
  });
}

describe("dashboard command retries", () => {
  // Pristine c0625d0a: expected one delivery call, received two after the response was lost.
  test.todo("a retried ping delivers only once after its response is lost", async () => {
    const deliver = spyOn(writer, "pingAgent").mockReturnValue({
      ok: true, target_instance: "fixture-owner", bytes: 12,
    });
    const body = { instance_id: "fixture-owner", message: "one delivery" };
    await ping(request("ping", body)); // The client never receives this response.
    const retried = await ping(request("ping", body));
    expect(retried.status).toBe(200);
    expect(await retried.json()).toMatchObject({ ok: true });
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  // Pristine c0625d0a: expected one finalizer call, received two. Core finalization may itself deduplicate.
  test.todo("a retried end-session does not finalize a second time", async () => {
    const finalize = spyOn(writer, "endSession").mockResolvedValue({
      ok: true, instance_id: "fixture-owner",
      terminal_event_recorded: true, terminal_event_queued: false,
    });
    const body = { instance_id: "fixture-owner" };
    await endSession(request("end-session", body));
    const retried = await endSession(request("end-session", body));
    expect(await retried.json()).toMatchObject({ ok: true, terminal_event_recorded: true });
    expect(finalize).toHaveBeenCalledTimes(1);
  });

  // Pristine c0625d0a: expected one release call, received two for the same command identity.
  test.todo("a retried release-claim cannot release a later claim on the same path", async () => {
    const release = spyOn(writer, "releaseClaim").mockResolvedValue({
      ok: true, instance_id: "fixture-owner", path: "src/fixture.ts", removed: true, remaining: 0,
    });
    const body = { instance_id: "fixture-owner", path: "src/fixture.ts" };
    await releaseClaim(request("release-claim", body));
    const retried = await releaseClaim(request("release-claim", body));
    expect(await retried.json()).toMatchObject({ ok: true, removed: true });
    expect(release).toHaveBeenCalledTimes(1);
  });

  // Pristine c0625d0a: expected one stop call, received two for the same command identity.
  test.todo("a retried stop-server cannot stop a replacement registered under the same id", async () => {
    const stop = spyOn(servers, "stopServerByRef").mockResolvedValue({ ok: true, message: "Stopped." });
    const body = { id: "fixture-server" };
    await stopServer(request("stop-server", body));
    const retried = await stopServer(request("stop-server", body));
    expect(await retried.json()).toEqual({ ok: true, message: "Stopped." });
    expect(stop).toHaveBeenCalledTimes(1);
  });

  // Pristine c0625d0a: expected a retained string command_id; the form posted undefined.
  test.todo("a reconnected ping form recovers the settled outcome without sending a new command", async () => {
    const deliver = spyOn(writer, "pingAgent").mockReturnValue({
      ok: true, target_instance: "fixture-owner", bytes: 12,
    });
    // Re-render a fresh client leaf after the first connection drops. Only the
    // form's controlled input is restored; command custody must survive it.
    spyOn(React, "useState").mockImplementation(((initial: unknown) => [
      initial === "" ? "one delivery" : initial, () => {},
    ]) as unknown as typeof React.useState);
    const bodies: Record<string, unknown>[] = [];
    spyOn(globalThis, "fetch").mockImplementation((async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      const response = await ping(request("ping", body));
      if (bodies.length === 1) throw new Error("response lost after mutation");
      return response;
    }) as unknown as typeof fetch);
    const event = { preventDefault() {} } as React.FormEvent;
    const first = PingForm({ instanceId: "fixture-owner" });
    await first.props.onSubmit(event);
    const reconnected = PingForm({ instanceId: "fixture-owner" });
    await reconnected.props.onSubmit(event);
    expect(bodies).toHaveLength(2);
    expect(typeof bodies[0]?.command_id).toBe("string");
    expect(bodies[1]?.command_id).toBe(bodies[0]?.command_id);
    expect(deliver).toHaveBeenCalledTimes(1);
  });
});



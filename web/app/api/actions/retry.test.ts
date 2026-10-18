import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { __resetCoordRootCache } from "@/lib/coord-reader";
import * as writer from "@/lib/coord-writer";
import { type CommandStorage, dashboardCommandClient } from "@/lib/dashboard-command-client";
import * as servers from "@/lib/servers";
import { GET as commandStatus } from "./commands/[commandId]/route";
import { POST as endSession } from "./end-session/route";
import { POST as ping } from "./ping/route";
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
    body: JSON.stringify({ command_id: "command-retry-fixture", project_root: root, ...body }),
  });
}

describe("dashboard command retries", () => {
  // Pristine c0625d0a: expected one delivery call, received two after the response was lost.
  test("a retried ping delivers only once after its response is lost", async () => {
    const deliver = spyOn(writer, "pingAgent").mockReturnValue({
      ok: true,
      target_instance: "fixture-owner",
      bytes: 12,
    });
    const body = { instance_id: "fixture-owner", message: "one delivery" };
    await ping(request("ping", body)); // The client never receives this response.
    const retried = await ping(request("ping", body));
    expect(retried.status).toBe(200);
    expect(await retried.json()).toMatchObject({ state: "settled", result: { ok: true } });
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  // Pristine c0625d0a: expected one finalizer call, received two. Core finalization may itself deduplicate.
  test("a retried end-session does not finalize a second time", async () => {
    const finalize = spyOn(writer, "endSession").mockResolvedValue({
      ok: true,
      instance_id: "fixture-owner",
      terminal_event_recorded: true,
      terminal_event_queued: false,
    });
    const body = { instance_id: "fixture-owner" };
    await endSession(request("end-session", body));
    const retried = await endSession(request("end-session", body));
    expect(await retried.json()).toMatchObject({
      state: "settled",
      result: { ok: true, terminal_event_recorded: true },
    });
    expect(finalize).toHaveBeenCalledTimes(1);
  });

  // Pristine c0625d0a: expected one release call, received two for the same command identity.
  test("a retried release-claim cannot release a later claim on the same path", async () => {
    let claimGeneration = 1;
    const release = spyOn(writer, "releaseClaim").mockImplementation(async () => {
      claimGeneration = 0;
      return {
        ok: true,
        instance_id: "fixture-owner",
        path: "src/fixture.ts",
        removed: true,
        remaining: 0,
      };
    });
    const body = { instance_id: "fixture-owner", path: "src/fixture.ts" };
    await releaseClaim(request("release-claim", body));
    claimGeneration = 2; // The owner later claims this path again.
    const retried = await releaseClaim(request("release-claim", body));
    expect(await retried.json()).toMatchObject({
      state: "settled",
      result: { ok: true, removed: true },
    });
    expect(release).toHaveBeenCalledTimes(1);
    expect(claimGeneration).toBe(2);
  });

  // Pristine c0625d0a: expected one stop call, received two for the same command identity.
  test("a retried stop-server cannot stop a replacement registered under the same id", async () => {
    let processGeneration = 1;
    const stop = spyOn(servers, "stopServerByRef").mockImplementation(async () => {
      processGeneration = 0;
      return { ok: true, message: "Stopped." };
    });
    const body = { id: "fixture-server" };
    await stopServer(request("stop-server", body));
    processGeneration = 2; // A replacement is registered under the same name.
    const retried = await stopServer(request("stop-server", body));
    expect(await retried.json()).toMatchObject({
      state: "settled",
      result: { ok: true, message: "Stopped." },
    });
    expect(stop).toHaveBeenCalledTimes(1);
    expect(processGeneration).toBe(2);
  });

  // Pristine c0625d0a: expected a retained string command_id; the form posted undefined.
  test("a reconnected ping form recovers the settled outcome without sending a new command", async () => {
    const deliver = spyOn(writer, "pingAgent").mockReturnValue({
      ok: true,
      target_instance: "fixture-owner",
      bytes: 12,
    });
    // The production form uses this client. A separate browser regression
    // exercises its actual mount/reload; here both requests use real routes.
    const values = new Map<string, string>();
    const storage: CommandStorage = {
      get length() {
        return values.size;
      },
      key: (n) => [...values.keys()][n] ?? null,
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => {
        values.set(key, value);
      },
    };
    const bodies: Record<string, unknown>[] = [];
    let reads = 0;
    const send = (async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        bodies.push(body);
        await ping(request("ping", body));
        throw new Error("response lost after mutation");
      }
      reads++;
      return commandStatus(new Request(`http://localhost${url}`), {
        params: Promise.resolve({ commandId: url.split("/").at(-1)! }),
      });
    }) as typeof fetch;
    const make = () =>
      dashboardCommandClient(root, "ping", { instance_id: "fixture-owner" }, () => storage, send);
    await expect(
      make().submit({ instance_id: "fixture-owner", message: "one delivery" }),
    ).rejects.toThrow("response lost");
    const recovered = await make().recover();
    expect(bodies).toHaveLength(1);
    expect(typeof bodies[0]?.command_id).toBe("string");
    expect(recovered).toMatchObject({
      command_id: bodies[0]?.command_id,
      state: "settled",
      result: { ok: true, bytes: 12 },
    });
    expect(reads).toBe(1);
    expect(deliver).toHaveBeenCalledTimes(1);
  });
});

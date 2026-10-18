import { describe, expect, test } from "bun:test";
import { type CommandStorage, dashboardCommandClient } from "./dashboard-command-client";
import type { CommandIntent } from "./dashboard-command-protocol";

function memory() {
  const data = new Map<string, string>();
  const storage: CommandStorage = {
    get length() {
      return data.size;
    },
    key: (n) => [...data.keys()][n] ?? null,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => {
      data.set(k, v);
    },
  };
  return { data, storage };
}
const args = { instance_id: "fixture", message: "once" };
function wireIntent(body: string): CommandIntent {
  const { command_id, project_root, ...arguments_ } = JSON.parse(body);
  return { command_id, project_root, action: "ping", arguments: arguments_ };
}

describe("browser command custody", () => {
  test("damaged saved settlement cannot discard an unconfirmed intent or mint a new id", async () => {
    for (const damage of ["wrong-id", "missing-result", "array-result"]) {
      const { data, storage } = memory();
      let calls = 0;
      const send = (async () => {
        calls++;
        throw new Error("lost response");
      }) as typeof fetch;
      const make = () =>
        dashboardCommandClient("project", "ping", { instance_id: "fixture" }, () => storage, send);
      await expect(make().submit(args)).rejects.toThrow("lost response");
      const key = [...data.keys()][0]!;
      const original = JSON.parse(data.get(key)!);
      const receipt = {
        ...original.intent,
        state: "settled",
        result:
          damage === "missing-result" ? undefined : damage === "array-result" ? [] : { ok: true },
      };
      if (damage === "wrong-id") receipt.command_id = "another-command";
      data.set(key, JSON.stringify({ ...original, receipt }));
      await expect(make().submit(args)).rejects.toThrow("does not confirm");
      await expect(make().recover()).rejects.toThrow("does not confirm");
      expect(JSON.parse(data.get(key)!).intent).toEqual(original.intent);
      expect(data.size).toBe(1);
      expect(calls).toBe(1);
    }
  });
  test("retains before transport and recovers after a new client mounts without POST", async () => {
    const { data, storage } = memory();
    let original!: CommandIntent,
      posts = 0,
      reads = 0;
    const send = (async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        posts++;
        original = wireIntent(String(init.body));
        expect([...data.values()].map((text) => JSON.parse(text))[0].intent).toEqual(original);
        throw new Error("response lost");
      }
      reads++;
      return Response.json({ ...original, state: "settled", result: { ok: true, bytes: 41 } });
    }) as typeof fetch;
    const client = () =>
      dashboardCommandClient("project", "ping", { instance_id: "fixture" }, () => storage, send);
    await expect(client().submit(args)).rejects.toThrow("response lost");
    expect(await client().recover()).toMatchObject({
      command_id: original.command_id,
      state: "settled",
      result: { bytes: 41 },
    });
    expect(posts).toBe(1);
    expect(reads).toBe(1);
    expect(data.size).toBe(1);
  });

  test("a proven absent receipt permits only explicit resend of the retained original id", async () => {
    const { storage } = memory();
    const ids: string[] = [];
    const send = (async (_url: string, init?: RequestInit) => {
      if (!init) return new Response(null, { status: 404 });
      const intent = wireIntent(String(init.body));
      ids.push(intent.command_id);
      if (ids.length === 1) throw new Error("request lost before server");
      return Response.json({ ...intent, state: "settled", result: { ok: true } });
    }) as typeof fetch;
    const client = () =>
      dashboardCommandClient("project", "ping", { instance_id: "fixture" }, () => storage, send);
    await expect(client().submit(args)).rejects.toThrow();
    expect(await client().recover()).toMatchObject({ command_id: ids[0], state: "unknown" });
    await client().submit(args);
    expect(ids).toHaveLength(2);
    expect(ids[1]).toBe(ids[0]);
  });

  test("unknown and pending receipts do not resend; new payload cannot replace retained intent", async () => {
    for (const state of ["unknown", "pending"]) {
      const { data, storage } = memory();
      let original!: CommandIntent,
        posts = 0;
      const send = (async (_url: string, init?: RequestInit) => {
        if (init) {
          posts++;
          original = wireIntent(String(init.body));
          throw new Error("lost");
        }
        return Response.json(
          { ...original, state, reason: "unconfirmed" },
          { status: state === "unknown" ? 409 : 202 },
        );
      }) as typeof fetch;
      const make = () =>
        dashboardCommandClient("project", "ping", { instance_id: "fixture" }, () => storage, send);
      await expect(make().submit(args)).rejects.toThrow();
      expect((await make().submit(args)).state).toBe(state);
      await expect(make().submit({ ...args, message: "new" })).rejects.toThrow(
        "original arguments",
      );
      expect(posts).toBe(1);
      expect(data.size).toBe(1);
    }
  });

  test("one settled tab cannot hide another tab's unresolved command", async () => {
    const { data, storage } = memory();
    let calls = 0;
    const send = (async (url: string, init?: RequestInit) => {
      calls++;
      if (init) throw new Error("lost");
      const record = [...data.values()]
        .map((text) => JSON.parse(text))
        .find((r) => url.endsWith(r.intent.command_id));
      return Response.json({
        ...record.intent,
        state: record.intent.command_id === "second-tab" ? "settled" : "unknown",
        ...(record.intent.command_id === "second-tab"
          ? { result: { ok: true } }
          : { reason: "unconfirmed first effect" }),
      });
    }) as typeof fetch;
    const make = () =>
      dashboardCommandClient("project", "ping", { instance_id: "fixture" }, () => storage, send);
    await expect(make().submit(args)).rejects.toThrow("lost");
    const [key, value] = [...data.entries()][0]!;
    const original = JSON.parse(value);
    const second = { intent: { ...original.intent, command_id: "second-tab" } };
    data.set(
      key.slice(0, -original.intent.command_id.length) + "second-tab",
      JSON.stringify(second),
    );
    expect(await make().recover()).toMatchObject({
      command_id: original.intent.command_id,
      state: "unknown",
    });
    expect(data.size).toBe(2);
    expect(calls).toBe(3);
    expect([...data.values()].map((text) => JSON.parse(text)).map((r) => r.receipt.state)).toEqual([
      "unknown",
      "settled",
    ]);
  });

  test("storage refusal prevents the first network mutation", async () => {
    let calls = 0;
    const storage: CommandStorage = {
      length: 0,
      key: () => null,
      getItem: () => null,
      setItem: () => {
        throw new Error("quota");
      },
    };
    const client = dashboardCommandClient(
      "project",
      "ping",
      { instance_id: "fixture" },
      () => storage,
      (async () => {
        calls++;
        return Response.json({});
      }) as typeof fetch,
    );
    await expect(client.submit(args)).rejects.toThrow("quota");
    expect(calls).toBe(0);
  });

  test("another project cannot reconcile or retarget an old command", async () => {
    const { data, storage } = memory();
    let calls = 0;
    const send = (async () => {
      calls++;
      throw new Error("lost");
    }) as typeof fetch;
    await expect(
      dashboardCommandClient("one", "ping", { instance_id: "fixture" }, () => storage, send).submit(
        args,
      ),
    ).rejects.toThrow();
    expect(
      await dashboardCommandClient(
        "two",
        "ping",
        { instance_id: "fixture" },
        () => storage,
        send,
      ).recover(),
    ).toBeNull();
    expect(data.size).toBe(1);
    expect(calls).toBe(1);
  });

  test("mismatched authoritative reply leaves the original intent unconfirmed", async () => {
    const { data, storage } = memory();
    const send = (async (_url: string, init?: RequestInit) => {
      const intent = wireIntent(String(init?.body));
      return Response.json({
        ...intent,
        arguments: { ...args, instance_id: "wrong" },
        state: "settled",
        result: { ok: true },
      });
    }) as typeof fetch;
    await expect(
      dashboardCommandClient(
        "project",
        "ping",
        { instance_id: "fixture" },
        () => storage,
        send,
      ).submit(args),
    ).rejects.toThrow("could not be confirmed");
    expect([...data.values()].map((text) => JSON.parse(text))[0].receipt).toBeUndefined();
  });
});

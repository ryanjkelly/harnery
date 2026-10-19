import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { __resetCoordRootCache } from "@/lib/coord-reader";
import { POST } from "./route";

const previous = process.env.HARNERY_COORD_ROOT;
const roots: string[] = [];
afterEach(() => {
  if (previous === undefined) delete process.env.HARNERY_COORD_ROOT;
  else process.env.HARNERY_COORD_ROOT = previous;
  __resetCoordRootCache();
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function root(withCoord = true) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "attention-route-"));
  roots.push(dir);
  if (withCoord) mkdirSync(path.join(dir, ".harnery"));
  process.env.HARNERY_COORD_ROOT = dir;
  __resetCoordRootCache();
  return dir;
}
const post = (body: unknown) =>
  POST(
    new Request("https://fixture.invalid/api/attention", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
const observation = {
  operation: "observe",
  clientId: "tab",
  eventKey: "event",
  visible: false,
  focused: false,
  interaction: 0,
  holdingGeneration: null,
};
test("the route shares selection, dedupes claims and records separate acknowledgment", async () => {
  root();
  const response = await post(observation),
    selection = await response.json();
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(selection).toMatchObject({ recipientId: "tab", state: "selected" });
  const claim = {
    operation: "claim",
    clientId: "tab",
    eventKey: "event",
    generation: selection.generation,
  };
  const claimed = await post(claim);
  expect(claimed.status).toBe(200);
  expect(await claimed.json()).toMatchObject({ granted: true });
  expect((await (await post(claim)).json()).granted).toBe(false);
  expect(
    (await (await post({ operation: "acknowledge", clientId: "tab", eventKey: "event" })).json())
      .state,
  ).toBe("acknowledged");
  expect((await (await post(claim)).json()).granted).toBe(false);
});
test("future browser timestamps, unknown fields and malformed identity are refused", async () => {
  root();
  for (const body of [
    { ...observation, interactionAt: Date.now() + 1e12 },
    { ...observation, clientId: "../../x" },
    { ...observation, interaction: Number.MAX_SAFE_INTEGER + 1 },
    { ...observation, eventKey: "" },
    { ...observation, holdingGeneration: "../generation" },
    null,
    [],
    { operation: "bogus", clientId: "tab" },
  ]) {
    expect((await post(body)).status).toBe(400);
  }
});
test("storage failure never grants an automatic channel", async () => {
  const dir = root(false);
  writeFileSync(path.join(dir, ".harnery"), "unavailable");
  const response = await post(observation);
  expect(response.status).toBe(503);
  expect((await response.json()).granted).toBeUndefined();
});
test("malformed JSON is rejected without touching state", async () => {
  root();
  expect(
    (
      await POST(
        new Request("https://fixture.invalid/api/attention", { method: "POST", body: "{" }),
      )
    ).status,
  ).toBe(400);
});

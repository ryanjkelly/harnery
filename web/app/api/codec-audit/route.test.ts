import { describe, expect, test } from "bun:test";

import { POST } from "./route";

function request(body: string): Request {
  return new Request("http://localhost/api/codec-audit", { method: "POST", body });
}

describe("Codec card audit request boundary", () => {
  test("rejects malformed JSON as invalid input", async () => {
    const response = await POST(request("{not json"));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid card capture" });
  });

  test("rejects invalid captures before reading coordination state", async () => {
    const response = await POST(request(JSON.stringify({ cards: [] })));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid card capture" });
  });

  test("rejects captures larger than the request limit", async () => {
    const response = await POST(request(" ".repeat(256_001)));
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "capture too large" });
  });

  test("keeps request read failures distinct from invalid JSON", async () => {
    const unreadable = request("{}");
    await unreadable.text();
    const response = await POST(unreadable);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "card comparison unavailable" });
  });
});

import { describe, expect, test } from "bun:test";
import { POST } from "./route";

const post = (body: unknown) =>
  POST(
    new Request("http://localhost/api/councils", {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );

describe("POST /api/councils validation", () => {
  test("wrong payload types answer 400, not 500", async () => {
    const cases: Array<[unknown, string]> = [
      ["not json", "invalid_json"],
      [[1, 2], "invalid_payload"],
      [{ objective: 42, members: ["A"] }, "invalid_objective"],
      [{ objective: "x", members: "A,B" }, "invalid_members"],
      [{ objective: "x", members: ["A", 3] }, "invalid_members"],
      [{ objective: "x", members: ["A,B"] }, "invalid_members"],
      [{ objective: "x", members: [] }, "no_members"],
      [{ objective: " ", members: ["A"] }, "missing_objective"],
      [{ objective: "x", members: ["A"], steward: 7 }, "invalid_payload"],
      [{ objective: "x", members: ["A"], auto_advance: "yes" }, "invalid_payload"],
    ];
    for (const [body, error] of cases) {
      const response = await post(body);
      expect(response.status).toBe(400);
      expect((await response.json()).error).toBe(error);
    }
  });
});

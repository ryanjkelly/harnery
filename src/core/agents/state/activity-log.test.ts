import { describe, expect, test } from "bun:test";
import { agentDisplayName } from "./activity-log.ts";

describe("agentDisplayName", () => {
  test("uses distinct short instance ids for unnamed sessions", () => {
    expect(agentDisplayName("11111111-aaaa-bbbb-cccc-000000000000", "")).toBe("agent-11111111");
    expect(agentDisplayName("22222222-aaaa-bbbb-cccc-000000000000", "   ")).toBe("agent-22222222");
  });

  test("prefers a non-empty assigned name", () => {
    expect(agentDisplayName("11111111-aaaa-bbbb-cccc-000000000000", " Scout ")).toBe("agent-Scout");
  });
});

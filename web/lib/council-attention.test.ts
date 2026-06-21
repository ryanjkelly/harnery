import { describe, expect, test } from "bun:test";

import {
  councilAttentionRequest,
  councilWrapupAttentionRequest,
} from "./council-attention";

const base = {
  councilId: "c-887c",
  currentRound: 3,
  nextRound: 4,
  activeMember: null as string | null,
  activeMemberWorking: false,
  pendingUnrouted: [] as string[],
  workingUnrouted: [] as string[],
};

describe("councilAttentionRequest", () => {
  test("stage 1: copy-able prompt alerts with member-scoped key", () => {
    const req = councilAttentionRequest({
      ...base,
      activeMember: "agent-Astrid",
    });
    expect(req?.key).toBe("att:council:c-887c:r3:copy:agent-Astrid");
    expect(req?.label).toContain("agent-Astrid");
  });

  test("stage 1: suppressed while the active member is working (post-paste)", () => {
    const req = councilAttentionRequest({
      ...base,
      activeMember: "agent-Astrid",
      activeMemberWorking: true,
    });
    expect(req).toBeNull();
  });

  test("stage 2: idle unrouted member (steward) alerts", () => {
    const req = councilAttentionRequest({
      ...base,
      pendingUnrouted: ["agent-Jenna"],
    });
    expect(req?.key).toBe("att:council:c-887c:r3:unrouted:agent-Jenna");
    expect(req?.label).toContain("agent-Jenna");
  });

  test("stage 2: suppressed while every unrouted member is working", () => {
    const req = councilAttentionRequest({
      ...base,
      pendingUnrouted: ["agent-Jenna"],
      workingUnrouted: ["agent-Jenna"],
    });
    expect(req).toBeNull();
  });

  test("stage 3: round complete always alerts (advance is operator-only)", () => {
    const req = councilAttentionRequest(base);
    expect(req?.key).toBe("att:council:c-887c:r3:advance");
    expect(req?.label).toContain("advance to round 4");
  });

  test("keys differ across members and rounds (fresh alert per moment)", () => {
    const a = councilAttentionRequest({ ...base, activeMember: "agent-A" });
    const b = councilAttentionRequest({ ...base, activeMember: "agent-B" });
    const r4 = councilAttentionRequest({
      ...base,
      activeMember: "agent-A",
      currentRound: 4,
    });
    expect(a?.key).not.toBe(b?.key);
    expect(a?.key).not.toBe(r4?.key);
  });

  test("stage 4: closeRecommended alerts with a round-scoped close key", () => {
    const req = councilAttentionRequest({ ...base, closeRecommended: true });
    expect(req?.key).toBe("att:council:c-887c:r3:close");
    expect(req?.label).toContain("close");
  });

  test("stage 4 beats stage 3: a collected final round points at Close, not Advance", () => {
    // base alone is the stage-3 shape (all in); closeRecommended must win.
    const req = councilAttentionRequest({ ...base, closeRecommended: true });
    expect(req?.key).not.toContain(":advance");
    expect(req?.key).toContain(":close");
  });

  test("stage 4: close keys differ across rounds (later re-met criterion re-alerts)", () => {
    const r3 = councilAttentionRequest({ ...base, closeRecommended: true });
    const r6 = councilAttentionRequest({
      ...base,
      closeRecommended: true,
      currentRound: 6,
      nextRound: 7,
    });
    expect(r3?.key).not.toBe(r6?.key);
  });

  test("closeRecommended=false falls through to the normal stage machine", () => {
    const req = councilAttentionRequest({ ...base, closeRecommended: false });
    expect(req?.key).toBe("att:council:c-887c:r3:advance");
  });
});

describe("councilWrapupAttentionRequest", () => {
  const wrapBase = {
    councilId: "c-887c",
    closed: true,
    handoffDone: false,
    stewardWorking: false,
  };

  test("step 1: handoff pending + idle steward → handoff alert", () => {
    const req = councilWrapupAttentionRequest(wrapBase);
    expect(req?.key).toBe("att:council:c-887c:wrapup:handoff");
  });

  test("step 1: suppressed while the steward is working on it", () => {
    const req = councilWrapupAttentionRequest({
      ...wrapBase,
      stewardWorking: true,
    });
    expect(req).toBeNull();
  });

  test("step 2: handoff landed → archive alert (fresh key past step-1 ack)", () => {
    const req = councilWrapupAttentionRequest({
      ...wrapBase,
      handoffDone: true,
    });
    expect(req?.key).toBe("att:council:c-887c:wrapup:archive");
    expect(req?.key).not.toBe(
      councilWrapupAttentionRequest(wrapBase)?.key,
    );
  });

  test("not closed (active or archived) → null", () => {
    const req = councilWrapupAttentionRequest({ ...wrapBase, closed: false });
    expect(req).toBeNull();
  });
});

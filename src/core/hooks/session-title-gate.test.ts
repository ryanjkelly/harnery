import { describe, expect, test } from "bun:test";
import {
  sessionNameDisplayInstruction,
  sessionNameDisplayRecoveryInstruction,
  sessionNameDisplayReminder,
} from "../agents/session-name-display.ts";
import {
  pendingTitleRequest,
  postToolTitleDecision,
  preToolTitleDecision,
  type TitleRow,
  titleGateDenial,
} from "./session-title-gate.ts";

const THREAD = "thread-1";
const TITLE = "Agent Orion - T3 thread title";
const TOOL = "mcp__t3-code__t3_thread_update";

const t3Row = (extra: Partial<TitleRow> = {}): TitleRow => ({
  suggested_session_name: TITLE,
  session_title_surface: "t3-code",
  session_title_client_thread: THREAD,
  ...extra,
});

const rename = (title: string) => ({ action: "rename", title });
const renamed = (title: string) => JSON.stringify({ threadId: THREAD, action: "rename", title });

function request(row: TitleRow, adapter: "claude-code" | "codex" | "cursor" = "claude-code") {
  const req = pendingTitleRequest(adapter, {}, row);
  if (!req) throw new Error("expected a pending title");
  return req;
}

describe("pendingTitleRequest", () => {
  test("nothing owed returns null", () => {
    expect(pendingTitleRequest("claude-code", {}, null)).toBeNull();
    expect(
      pendingTitleRequest("claude-code", {}, t3Row({ session_name_seen_for: TITLE })),
    ).toBeNull();
  });
  test("a T3 row resolves the t3-code surface; no surface resolves the name block", () => {
    expect(request(t3Row()).surface.id).toBe("t3-code");
    expect(request({ suggested_session_name: TITLE }).surface.id).toBe("name-block");
  });
  test("a recorded fallback for the owed title resolves the name block", () => {
    expect(request(t3Row({ session_title_fallback_for: TITLE })).surface.id).toBe("name-block");
  });
});

describe("postToolTitleDecision", () => {
  test("a mint on a T3 row instructs the rename", () => {
    const row = t3Row();
    const decision = postToolTitleDecision(
      request(row),
      row,
      { toolName: "Bash", toolInput: {}, toolResponse: "" },
      true,
    );
    expect(decision.kind).toBe("instruct");
    if (decision.kind !== "instruct") return;
    expect(decision.text).toContain("Session title required.");
    expect(decision.text).toContain(TOOL);
    expect(decision.text).toContain(TITLE);
  });
  test("a mint on a name-block row keeps today's instruction byte for byte", () => {
    const row = { suggested_session_name: TITLE };
    const decision = postToolTitleDecision(
      request(row),
      row,
      { toolName: "Bash", toolInput: {}, toolResponse: "" },
      true,
    );
    expect(decision).toEqual({ kind: "instruct", text: sessionNameDisplayInstruction(TITLE) });
  });
  test("a successful rename confirms the title", () => {
    const row = t3Row();
    const decision = postToolTitleDecision(
      request(row),
      row,
      { toolName: TOOL, toolInput: rename(TITLE), toolResponse: renamed(TITLE) },
      false,
    );
    expect(decision).toEqual({ kind: "applied", title: TITLE, drift: false });
  });
  test("a failed rename falls back to the name block once", () => {
    const row = t3Row();
    const call = {
      toolName: TOOL,
      toolInput: rename(TITLE),
      toolResponse: { isError: true, content: [{ type: "text", text: "boom" }] },
    };
    const decision = postToolTitleDecision(request(row), row, call, false);
    expect(decision).toEqual({
      kind: "fallback",
      text: sessionNameDisplayInstruction(TITLE),
      reason: "t3-code-rename-failed",
      first: true,
    });
    // After the fallback is recorded the session owes the name block, which
    // has no rename tool and so no further fallback.
    const after = t3Row({ session_title_fallback_for: TITLE });
    expect(postToolTitleDecision(request(after), after, call, false).kind).toBe("remind");
  });
  test("the ToolSearch that loads the rename tool is not reminded", () => {
    const row = t3Row();
    const decision = postToolTitleDecision(
      request(row),
      row,
      { toolName: "ToolSearch", toolInput: { query: `select:${TOOL}` }, toolResponse: "ok" },
      false,
    );
    expect(decision).toEqual({ kind: "remind", allowedWhilePending: true });
    const ordinary = postToolTitleDecision(
      request(row),
      row,
      { toolName: "Bash", toolInput: { command: "ls" }, toolResponse: "ok" },
      false,
    );
    expect(ordinary).toEqual({ kind: "remind", allowedWhilePending: false });
  });
  test("a mid-session title after an applied one is suppressed", () => {
    const row = t3Row({ suggested_session_name: "A - y", session_title_applied_for: "A - x" });
    const decision = postToolTitleDecision(
      request(row),
      row,
      { toolName: "Bash", toolInput: {}, toolResponse: "" },
      true,
    );
    expect(decision).toEqual({ kind: "suppressed", applied: "A - x" });
  });
  test("the done title after an applied one is instructed and confirmed", () => {
    const done = "[DONE] A - x";
    const row = t3Row({ suggested_session_name: done, session_title_applied_for: "A - x" });
    const minted = postToolTitleDecision(
      request(row),
      row,
      { toolName: "Bash", toolInput: {}, toolResponse: "" },
      true,
    );
    expect(minted.kind).toBe("instruct");
    const confirmed = postToolTitleDecision(
      request(row),
      row,
      { toolName: TOOL, toolInput: rename(done), toolResponse: renamed(done) },
      false,
    );
    expect(confirmed).toEqual({ kind: "applied", title: done, drift: false });
  });
});

describe("preToolTitleDecision", () => {
  const row = t3Row();
  test("loading and calling the exact rename pass while owed", () => {
    expect(
      preToolTitleDecision(request(row), row, {
        toolName: "ToolSearch",
        toolInput: { query: `select:${TOOL}` },
      }),
    ).toEqual({ kind: "allow" });
    expect(
      preToolTitleDecision(request(row), row, { toolName: TOOL, toolInput: rename(TITLE) }),
    ).toEqual({ kind: "allow" });
  });
  test("other calls and other titles go to evidence inspection", () => {
    expect(
      preToolTitleDecision(request(row), row, { toolName: "Bash", toolInput: { command: "ls" } }),
    ).toEqual({ kind: "inspect" });
    expect(
      preToolTitleDecision(request(row), row, { toolName: TOOL, toolInput: rename("other") }),
    ).toEqual({ kind: "inspect" });
  });
  test("an applied title suppresses a mid-session change", () => {
    const applied = t3Row({ suggested_session_name: "A - y", session_title_applied_for: "A - x" });
    expect(
      preToolTitleDecision(request(applied), applied, { toolName: "Bash", toolInput: {} }),
    ).toEqual({ kind: "suppressed", applied: "A - x" });
  });
});

describe("titleGateDenial", () => {
  test("the name block keeps today's recovery text", () => {
    expect(titleGateDenial(request({ suggested_session_name: TITLE }), "acme")).toBe(
      sessionNameDisplayRecoveryInstruction(TITLE, "acme"),
    );
  });
  test("T3 sends the rename instruction plus one recovery sentence", () => {
    const req = request(t3Row());
    const text = titleGateDenial(req, "acme");
    expect(text.startsWith(req.surface.instruction(TITLE, req.ctx))).toBe(true);
    expect(text).toContain("run `acme agents suggest-name --json` as the only tool call");
  });
  test("reminder wording follows the surface", () => {
    expect(request({ suggested_session_name: TITLE }).surface.reminder(TITLE, {} as never)).toBe(
      sessionNameDisplayReminder(TITLE),
    );
  });
});

describe("done request that keeps the operator's own title", () => {
  const START = "Agent A - x";
  const DONE = "[DONE] Agent A - x";
  const OWN = "[DONE] My own title";
  const READ = "mcp__t3-code__t3_thread_read";
  const row = t3Row({ suggested_session_name: DONE, session_title_applied_for: START });

  test("loading both tools and reading this thread pass the gate", () => {
    expect(
      preToolTitleDecision(request(row), row, {
        toolName: "ToolSearch",
        toolInput: { query: `select:${READ},${TOOL}` },
      }),
    ).toEqual({ kind: "allow" });
    expect(
      preToolTitleDecision(request(row), row, {
        toolName: READ,
        toolInput: { threadId: THREAD, limit: 1, maxCharsPerItem: 1 },
      }),
    ).toEqual({ kind: "allow" });
    expect(
      preToolTitleDecision(request(row), row, { toolName: TOOL, toolInput: rename(OWN) }),
    ).toEqual({ kind: "allow" });
  });
  test("an unrelated call is inspected and denied with the done instruction", () => {
    const req = request(row);
    expect(
      preToolTitleDecision(req, row, { toolName: "Bash", toolInput: { command: "ls" } }),
    ).toEqual({ kind: "inspect" });
    const text = titleGateDenial(req, "acme");
    expect(text).toContain("t3_thread_read");
    expect(text).toContain(`\`threadId: "${THREAD}"\``);
    expect(text).toContain(`\n${DONE}\n`);
  });
  test("the read is not reminded and a rename to the operator's title applies as drift", () => {
    expect(
      postToolTitleDecision(
        request(row),
        row,
        { toolName: READ, toolInput: { threadId: THREAD }, toolResponse: "{}" },
        false,
      ),
    ).toEqual({ kind: "remind", allowedWhilePending: true });
    expect(
      postToolTitleDecision(
        request(row),
        row,
        { toolName: TOOL, toolInput: rename(OWN), toolResponse: renamed(OWN) },
        false,
      ),
    ).toEqual({ kind: "applied", title: OWN, drift: true });
  });
  test("a failed done rename falls back to the owed name block", () => {
    const decision = postToolTitleDecision(
      request(row),
      row,
      {
        toolName: TOOL,
        toolInput: rename(OWN),
        toolResponse: { isError: true, content: [{ type: "text", text: "boom" }] },
      },
      false,
    );
    expect(decision).toEqual({
      kind: "fallback",
      text: sessionNameDisplayInstruction(DONE),
      reason: "t3-code-rename-failed",
      first: true,
    });
  });
});

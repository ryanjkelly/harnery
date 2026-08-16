import { describe, expect, test } from "bun:test";

import { categorizeTool, sanitizeEvent, sanitizeLine } from "./sanitize";

const BASE = {
  schema_version: 1,
  event_id: "01J0000000000000000000000",
  ts: "2026-08-16T10:00:00.000Z",
  instance_id: "inst-1",
  session_id: "sess-1",
  adapter: "claude-code",
  source: "agent-hooks",
};

/** Sentinels that must never survive sanitization. */
const SECRET_PROMPT = "SENTINEL_PROMPT_BODY";
const SECRET_INPUT = "SENTINEL_TOOL_INPUT";
const SECRET_OUTPUT = "SENTINEL_TOOL_OUTPUT";
const SECRET_ERROR = "SENTINEL_ERROR_BODY";
const SECRET_CMD = "SENTINEL_COMMAND_BODY";

describe("sanitizeEvent", () => {
  test("drops unknown event types and unsupported schema versions", () => {
    expect(
      sanitizeEvent({ ...BASE, event_type: "council.contribution", data: { body_summary: "x" } }),
    ).toBeNull();
    expect(
      sanitizeEvent({ ...BASE, schema_version: 2, event_type: "turn.stop", data: {} }),
    ).toBeNull();
    expect(sanitizeEvent(null)).toBeNull();
    expect(sanitizeEvent("row")).toBeNull();
  });

  test("tool events keep name/category/outcome and drop inputs and outputs", () => {
    const pre = sanitizeEvent({
      ...BASE,
      event_type: "tool.pre_use",
      data: { tool_name: "Read", tool_input: SECRET_INPUT, intent: "read the schema" },
    });
    expect(pre).toMatchObject({
      tool_name: "Read",
      category: "research",
      outcome: "started",
      intent: "read the schema",
    });

    const post = sanitizeEvent({
      ...BASE,
      event_type: "tool.post_use",
      data: { tool_name: "Edit", output_summary: SECRET_OUTPUT, exit_status: "error" },
    });
    expect(post).toMatchObject({ tool_name: "Edit", category: "edit", outcome: "error" });

    const failure = sanitizeEvent({
      ...BASE,
      event_type: "tool.post_use_failure",
      data: { tool_name: "Bash", error: SECRET_ERROR, duration_ms: 5 },
    });
    expect(failure).toMatchObject({ tool_name: "Bash", category: "diagnostic", outcome: "error" });

    for (const evidence of [pre, post, failure]) {
      expect(JSON.stringify(evidence)).not.toContain("SENTINEL");
    }
  });

  test("prompts and commands cross as envelope-only / bounded-intent evidence", () => {
    const prompt = sanitizeEvent({
      ...BASE,
      event_type: "user_prompt.submit",
      data: { prompt_text: SECRET_PROMPT },
    });
    expect(prompt).not.toBeNull();
    expect(JSON.stringify(prompt)).not.toContain(SECRET_PROMPT);

    const command = sanitizeEvent({
      ...BASE,
      event_type: "command.start",
      data: { cmd_id: "c1", cmd: SECRET_CMD, intent: "check peers" },
    });
    expect(command).toMatchObject({ category: "diagnostic", outcome: "started", intent: "check peers" });
    expect(JSON.stringify(command)).not.toContain(SECRET_CMD);
  });

  test("labels are clamped to the bounded length", () => {
    const long = "x".repeat(500);
    const taskSet = sanitizeEvent({
      ...BASE,
      event_type: "state.task_set",
      data: { task: long, cleared: false },
    });
    expect(taskSet?.task?.length).toBeLessThanOrEqual(120);
  });

  test("context, task state, and identity lift only their allowed scalars", () => {
    const ctx = sanitizeEvent({
      ...BASE,
      event_type: "context.sampled",
      data: { used_percent: 71, confidence: "reported", model: "m", used_tokens: 1 },
    });
    expect(ctx).toMatchObject({ used_percent: 71, context_confidence: "reported" });
    expect(JSON.stringify(ctx)).not.toContain("used_tokens");

    const state = sanitizeEvent({
      ...BASE,
      event_type: "state.task_state",
      data: { state: "blocked", reason: "waiting on a docket ruling about credentials" },
    });
    expect(state).toMatchObject({ task_state: "blocked" });
    expect(JSON.stringify(state)).not.toContain("docket ruling");

    const identity = sanitizeEvent({
      ...BASE,
      event_type: "identity.assumed",
      data: { name: "Sara", agent_id: "a1" },
    });
    expect(identity).toMatchObject({ identity_name: "Sara" });
  });

  test("state.ping lifts the recipient id and drops the message body", () => {
    const ping = sanitizeEvent({
      ...BASE,
      event_type: "state.ping",
      data: { peer_instance_id: "inst-2", peer_name: "Tony", body_summary: SECRET_PROMPT },
    });
    expect(ping).toMatchObject({ ping_to: "inst-2" });
    expect(JSON.stringify(ping)).not.toContain(SECRET_PROMPT);
    expect(JSON.stringify(ping)).not.toContain("Tony");
  });

  test("sanitizeLine drops malformed rows silently", () => {
    expect(sanitizeLine("")).toBeNull();
    expect(sanitizeLine("{not json")).toBeNull();
  });
});

describe("categorizeTool", () => {
  test("maps known tools and falls back to other", () => {
    expect(categorizeTool("Grep")).toBe("research");
    expect(categorizeTool("Write")).toBe("edit");
    expect(categorizeTool("Workflow")).toBe("coordinate");
    expect(categorizeTool("SomeNewTool")).toBe("other");
    expect(categorizeTool(undefined)).toBe("other");
  });
});

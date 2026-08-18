import { describe, expect, test } from "bun:test";
import { isShellToolName, selectCommandParentSpan } from "./span-parent.ts";

const turn = `tid_${"a".repeat(64)}` as const;
const otherTurn = `tid_${"b".repeat(64)}` as const;
const span = (id: number, toolName: string, turnId = turn) => ({
  span_id: `span_00000000-0000-7000-8000-${String(id).padStart(12, "0")}` as `span_${string}`,
  turn_id: turnId,
  requested_event_id:
    `evt_00000000-0000-7000-8000-${String(id).padStart(12, "0")}` as `evt_${string}`,
  tool_name: toolName,
});

describe("command parent selection", () => {
  test("recognizes harness and namespaced shell executors", () => {
    expect(["Bash", "Shell", "functions.exec_command", "apply-patch"].map(isShellToolName)).toEqual(
      [true, true, true, true],
    );
    expect(isShellToolName("Read")).toBe(false);
  });

  test("selects one open span and ignores closed or foreign-turn spans", () => {
    const selected = span(1, "Read");
    expect(
      selectCommandParentSpan(
        [
          selected,
          { ...span(2, "Bash"), requested_event_id: undefined },
          span(3, "Bash", otherTurn),
        ],
        turn,
      ),
    ).toBe(selected.span_id);
  });

  test("selects exactly one shell among parallel tools and refuses ambiguity", () => {
    const shell = span(1, "Bash");
    expect(selectCommandParentSpan([span(2, "Read"), shell], turn)).toBe(shell.span_id);
    expect(selectCommandParentSpan([span(2, "Read"), span(3, "Write")], turn)).toBeUndefined();
    expect(selectCommandParentSpan([shell, span(4, "Shell")], turn)).toBeUndefined();
  });
});

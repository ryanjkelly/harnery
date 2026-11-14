import { describe, expect, test } from "bun:test";
import {
  SESSION_NAME_DISPLAY_NOTE,
  sessionNameDisplayInstruction,
  sessionNameDisplayReminder,
} from "../../session-name-display.ts";
import { NAME_BLOCK_SURFACE_ID } from "../types.ts";
import { nameBlockSurface } from "./name-block.ts";

const ctx = { adapter: "cursor" as const, env: {} };

describe("nameBlockSurface", () => {
  test("is the display surface and always matches", () => {
    expect(nameBlockSurface.id).toBe(NAME_BLOCK_SURFACE_ID);
    expect(nameBlockSurface.delivery).toBe("display");
    expect(nameBlockSurface.detect(ctx)).toBe(true);
    expect(nameBlockSurface.detect({ adapter: null, env: {} })).toBe(true);
  });
  test("uses the session-name-display wording unchanged", () => {
    expect(nameBlockSurface.instruction("Agent Orion - X", ctx)).toBe(
      sessionNameDisplayInstruction("Agent Orion - X"),
    );
    expect(nameBlockSurface.reminder("Agent Orion - X", ctx)).toBe(
      sessionNameDisplayReminder("Agent Orion - X"),
    );
    expect(nameBlockSurface.note).toBe(SESSION_NAME_DISPLAY_NOTE);
  });
  test("has no agent-tool methods", () => {
    expect(nameBlockSurface.allowsWhilePending).toBeUndefined();
    expect(nameBlockSurface.confirmFromTool).toBeUndefined();
    expect(nameBlockSurface.failedAttempt).toBeUndefined();
    expect(nameBlockSurface.clientThreadId).toBeUndefined();
  });
});

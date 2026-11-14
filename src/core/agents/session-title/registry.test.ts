import { describe, expect, test } from "bun:test";
import type { Adapter } from "../../adapter.ts";
import {
  resolveTitleSurface,
  TITLE_SURFACES,
  titleSurfaceById,
  titleSurfaceContext,
  titleSurfaceForRequest,
} from "./registry.ts";
import { nameBlockSurface } from "./surfaces/name-block.ts";
import { t3CodeSurface } from "./surfaces/t3-code.ts";
import { NAME_BLOCK_SURFACE_ID, T3_CODE_SURFACE_ID } from "./types.ts";

const ADAPTERS: (Adapter | null)[] = ["claude-code", "codex", "cursor", "opencode", null];
const T3_ENV = { T3CODE_THREAD_ID: "946f87f7-79bf-437b-8651-cc7fb936ab41" };

describe("registry", () => {
  test("keeps the name block last", () => {
    expect(TITLE_SURFACES.at(-1)).toBe(nameBlockSurface);
  });
  test("looks surfaces up by id", () => {
    expect(titleSurfaceById(T3_CODE_SURFACE_ID)).toBe(t3CodeSurface);
    expect(titleSurfaceById(NAME_BLOCK_SURFACE_ID)).toBe(nameBlockSurface);
    expect(titleSurfaceById("nope")).toBeUndefined();
    expect(titleSurfaceById(undefined)).toBeUndefined();
  });
  test("falls back to the name block for every adapter without T3", () => {
    for (const adapter of ADAPTERS) {
      expect(resolveTitleSurface(titleSurfaceContext(adapter, {}))).toBe(nameBlockSurface);
    }
  });
  test("resolves T3 for Claude Code and Codex only", () => {
    expect(resolveTitleSurface(titleSurfaceContext("claude-code", T3_ENV))).toBe(t3CodeSurface);
    expect(resolveTitleSurface(titleSurfaceContext("codex", T3_ENV))).toBe(t3CodeSurface);
    expect(resolveTitleSurface(titleSurfaceContext("cursor", T3_ENV))).toBe(nameBlockSurface);
    expect(resolveTitleSurface(titleSurfaceContext("opencode", T3_ENV))).toBe(nameBlockSurface);
  });
  test("excludes delegated child threads", () => {
    const env = { T3CODE_THREAD_ID: "thread:delegated-task:abc" };
    expect(resolveTitleSurface(titleSurfaceContext("codex", env))).toBe(nameBlockSurface);
  });
  test("a stored row surface wins over the environment", () => {
    expect(
      resolveTitleSurface(titleSurfaceContext("codex", T3_ENV), {
        session_title_surface: NAME_BLOCK_SURFACE_ID,
      }),
    ).toBe(nameBlockSurface);
    const row = { session_title_surface: T3_CODE_SURFACE_ID, session_title_client_thread: "t-1" };
    const ctx = titleSurfaceContext("codex", {}, row);
    expect(ctx.clientThreadId).toBe("t-1");
    expect(resolveTitleSurface(ctx, row)).toBe(t3CodeSurface);
  });
  test("an unknown stored surface falls through to detection", () => {
    expect(
      resolveTitleSurface(titleSurfaceContext("claude-code", T3_ENV), {
        session_title_surface: "gone",
      }),
    ).toBe(t3CodeSurface);
  });
  test("titleSurfaceForRequest returns the name block after a failed delivery of that title", () => {
    const ctx = titleSurfaceContext("claude-code", T3_ENV);
    const row = { session_title_surface: T3_CODE_SURFACE_ID, session_title_fallback_for: "A" };
    expect(titleSurfaceForRequest(ctx, row, "A")).toBe(nameBlockSurface);
    expect(titleSurfaceForRequest(ctx, row, "[DONE] A")).toBe(t3CodeSurface);
    expect(titleSurfaceForRequest(ctx, null, "A")).toBe(t3CodeSurface);
  });
});

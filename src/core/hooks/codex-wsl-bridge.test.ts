import { describe, expect, test } from "bun:test";
import { inspectCodexWslBridge, isWslUncPath } from "./codex-wsl-bridge.ts";

describe("isWslUncPath", () => {
  test("recognizes both WSL UNC host spellings and extended UNC syntax", () => {
    expect(isWslUncPath("\\\\wsl.localhost\\Ubuntu\\home\\project")).toBe(true);
    expect(isWslUncPath("\\\\wsl$\\Ubuntu\\home\\project")).toBe(true);
    expect(isWslUncPath("\\\\?\\UNC\\wsl.localhost\\Ubuntu\\home\\project")).toBe(true);
  });

  test("rejects native Linux and ordinary Windows paths", () => {
    expect(isWslUncPath("/home/project")).toBe(false);
    expect(isWslUncPath("C:\\project")).toBe(false);
  });
});

describe("inspectCodexWslBridge", () => {
  test("accepts a forwarded Codex thread id in WSL", () => {
    expect(
      inspectCodexWslBridge({
        WSL_DISTRO_NAME: "Ubuntu-22.04",
        CODEX_THREAD_ID: "thread-1",
        WSLENV: "OTHER/u:CODEX_THREAD_ID",
      }),
    ).toEqual({
      ok: true,
      detail: "thread identity forwarded through WSLENV (Ubuntu-22.04)",
      threadIdPresent: true,
      wslenvForwardsThreadId: true,
    });
  });

  test("accepts WSLENV flags on the forwarded variable", () => {
    expect(
      inspectCodexWslBridge({
        WSL_INTEROP: "/run/WSL/1_interop",
        CODEX_THREAD_ID: "thread-1",
        WSLENV: "CODEX_THREAD_ID/u",
      })?.ok,
    ).toBe(true);
  });

  test("warns when the thread id did not reach WSL", () => {
    expect(
      inspectCodexWslBridge(
        { WSL_DISTRO_NAME: "Ubuntu", WSLENV: "CODEX_THREAD_ID" },
        { expected: true },
      ),
    ).toMatchObject({
      ok: false,
      detail: "CODEX_THREAD_ID did not reach WSL",
      threadIdPresent: false,
      wslenvForwardsThreadId: true,
    });
  });

  test("warns when later WSL shells will lose the thread id", () => {
    expect(
      inspectCodexWslBridge({
        WSL_DISTRO_NAME: "Ubuntu",
        CODEX_THREAD_ID: "thread-1",
      }),
    ).toMatchObject({
      ok: false,
      detail: "WSLENV does not forward CODEX_THREAD_ID",
      threadIdPresent: true,
      wslenvForwardsThreadId: false,
    });
  });

  test("reports both missing values when a Codex hook expects the bridge", () => {
    expect(inspectCodexWslBridge({ WSL_DISTRO_NAME: "Ubuntu" }, { expected: true })?.detail).toBe(
      "CODEX_THREAD_ID did not reach WSL; WSLENV does not forward CODEX_THREAD_ID",
    );
  });

  test("stays quiet outside a detected hybrid session", () => {
    expect(inspectCodexWslBridge({ CODEX_THREAD_ID: "thread-1" })).toBeNull();
    expect(inspectCodexWslBridge({ WSL_DISTRO_NAME: "Ubuntu" })).toBeNull();
  });
});

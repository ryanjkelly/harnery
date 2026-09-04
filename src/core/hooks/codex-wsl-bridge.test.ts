import { describe, expect, test } from "bun:test";
import {
  codexWslFileLinkTelemetry,
  codexWslWorkspaceLinkMapping,
  codexWslWorkspaceLinuxPath,
  inspectCodexWslBridge,
  isWslUncPath,
  renderCodexWslFileLinkContext,
} from "./codex-wsl-bridge.ts";

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

describe("Codex WSL workspace file links", () => {
  const linuxRoot = "/home/dev/projects/example";
  const uncRoot = "\\\\wsl.localhost\\Ubuntu-22.04\\home\\dev\\projects\\example";

  test("derives the host root from a nested adapter cwd", () => {
    expect(codexWslWorkspaceLinkMapping(linuxRoot, `${uncRoot}\\src`)).toEqual({
      linuxRoot,
      hostRoot: "//wsl.localhost/Ubuntu-22.04/home/dev/projects/example",
      distro: "Ubuntu-22.04",
    });
  });

  test("derives the Linux cwd used by hook extensions", () => {
    expect(codexWslWorkspaceLinuxPath(linuxRoot, `${uncRoot}\\src\\hooks`)).toBe(
      `${linuxRoot}/src/hooks`,
    );
    expect(codexWslWorkspaceLinuxPath(linuxRoot, "C:\\projects\\example")).toBeNull();
  });

  test("normalizes extended UNC syntax", () => {
    expect(
      codexWslWorkspaceLinkMapping(
        linuxRoot,
        "\\\\?\\UNC\\wsl.localhost\\Ubuntu-22.04\\home\\dev\\projects\\example",
      )?.hostRoot,
    ).toBe("//wsl.localhost/Ubuntu-22.04/home/dev/projects/example");
  });

  test("rejects native paths and unrelated WSL workspaces", () => {
    expect(codexWslWorkspaceLinkMapping(linuxRoot, linuxRoot)).toBeNull();
    expect(
      codexWslWorkspaceLinkMapping(linuxRoot, "\\\\wsl.localhost\\Ubuntu\\srv\\other"),
    ).toBeNull();
  });

  test("renders a derived instruction that separates Markdown and shell paths", () => {
    const text = renderCodexWslFileLinkContext(linuxRoot, uncRoot);
    expect(text).toContain(linuxRoot);
    expect(text).toContain("//wsl.localhost/Ubuntu-22.04/home/dev/projects/example");
    expect(text).toContain("Keep Linux paths unchanged in shell commands");
  });

  test("counts only visible Markdown destinations under the Linux root", () => {
    const message = [
      `[bad](${linuxRoot}/src/a.ts:12)`,
      `[good](//wsl.localhost/Ubuntu-22.04/home/dev/projects/example/src/a.ts)`,
      `[web](https://example.com/home/dev/projects/example)`,
      `\`[inline](${linuxRoot}/ignored.ts)\``,
      "```markdown",
      `[fenced](${linuxRoot}/ignored-too.ts)`,
      "```",
      `[outside](/home/dev/projects/elsewhere/file.ts)`,
    ].join("\n");

    expect(codexWslFileLinkTelemetry(linuxRoot, uncRoot, message)).toEqual({
      wsl_linux_file_link_count: 1,
      wsl_linux_file_link_examples: [`${linuxRoot}/src/a.ts:12`],
    });
  });

  test("records a zero for a clean hybrid reply", () => {
    expect(codexWslFileLinkTelemetry(linuxRoot, uncRoot, "No local links here.")).toEqual({
      wsl_linux_file_link_count: 0,
    });
  });
});

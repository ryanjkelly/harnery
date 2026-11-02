import { describe, expect, test } from "bun:test";
import { type BashProbe, findBash, gitRootFromExecPath } from "./bash.ts";

function probe(over: Partial<BashProbe> & { files?: string[] } = {}): BashProbe {
  const files = new Set((over.files ?? []).map((f) => f.toLowerCase()));
  return {
    platform: over.platform ?? "win32",
    env: over.env ?? {
      SystemRoot: "C:\\Windows",
      ProgramFiles: "C:\\Program Files",
      "ProgramFiles(x86)": "C:\\Program Files (x86)",
      LOCALAPPDATA: "C:\\Users\\dev\\AppData\\Local",
      PATH: "",
    },
    override: over.override,
    exists: over.exists ?? ((p) => files.has(p.toLowerCase())),
    gitExecPath: over.gitExecPath ?? (() => null),
  };
}

describe("gitRootFromExecPath", () => {
  test("derives the install root from a forward-slash exec path", () => {
    expect(gitRootFromExecPath("C:/Program Files/Git/mingw64/libexec/git-core")).toBe(
      "C:\\Program Files\\Git",
    );
  });
  test("handles backslashes and a trailing newline", () => {
    expect(gitRootFromExecPath("D:\\Tools\\Git\\clangarm64\\libexec\\git-core\n")).toBe(
      "D:\\Tools\\Git",
    );
  });
  test("rejects a path that is not a git-core dir", () => {
    expect(gitRootFromExecPath("C:/somewhere/else")).toBeNull();
  });
});

describe("findBash", () => {
  test("non-Windows uses bash from PATH", () => {
    expect(findBash(probe({ platform: "linux" }))).toBe("bash");
    expect(findBash(probe({ platform: "darwin" }))).toBe("bash");
  });

  test("override wins on every platform when it exists", () => {
    expect(
      findBash(probe({ platform: "linux", override: "/opt/bash", files: ["/opt/bash"] })),
    ).toBe("/opt/bash");
    expect(
      findBash(
        probe({
          override: "E:\\bash.exe",
          files: ["E:\\bash.exe", "C:\\Program Files\\Git\\bin\\bash.exe"],
        }),
      ),
    ).toBe("E:\\bash.exe");
  });

  test("a missing override path disables bash instead of guessing", () => {
    expect(
      findBash(
        probe({ override: "E:\\nope\\bash.exe", files: ["C:\\Program Files\\Git\\bin\\bash.exe"] }),
      ),
    ).toBeNull();
  });

  test("a bare override name is left to PATH lookup", () => {
    expect(findBash(probe({ override: "bash" }))).toBe("bash");
  });

  test("derives Git bash from git --exec-path first", () => {
    const found = findBash(
      probe({
        gitExecPath: () => "D:/Tools/Git/mingw64/libexec/git-core",
        files: ["D:\\Tools\\Git\\bin\\bash.exe", "C:\\Program Files\\Git\\bin\\bash.exe"],
      }),
    );
    expect(found).toBe("D:\\Tools\\Git\\bin\\bash.exe");
  });

  test("falls back to usr\\bin under the exec-path root", () => {
    const found = findBash(
      probe({
        gitExecPath: () => "D:/Tools/Git/mingw64/libexec/git-core",
        files: ["D:\\Tools\\Git\\usr\\bin\\bash.exe"],
      }),
    );
    expect(found).toBe("D:\\Tools\\Git\\usr\\bin\\bash.exe");
  });

  test("fallback order: Program Files, then x86, then LOCALAPPDATA, then PATH", () => {
    const all = [
      "C:\\Program Files\\Git\\bin\\bash.exe",
      "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
      "C:\\Users\\dev\\AppData\\Local\\Programs\\Git\\bin\\bash.exe",
      "C:\\msys64\\usr\\bin\\bash.exe",
    ];
    const env = {
      SystemRoot: "C:\\Windows",
      ProgramFiles: "C:\\Program Files",
      "ProgramFiles(x86)": "C:\\Program Files (x86)",
      LOCALAPPDATA: "C:\\Users\\dev\\AppData\\Local",
      PATH: "C:\\msys64\\usr\\bin",
    };
    for (let i = 0; i < all.length; i++) {
      expect(findBash(probe({ env, files: all.slice(i) }))).toBe(all[i] ?? null);
    }
  });

  test("rejects the WSL launcher in System32 and WindowsApps on PATH", () => {
    const env = {
      SystemRoot: "C:\\Windows",
      PATH: "C:\\Windows\\System32;C:\\Users\\dev\\AppData\\Local\\Microsoft\\WindowsApps",
    };
    const files = [
      "C:\\Windows\\System32\\bash.exe",
      "C:\\Users\\dev\\AppData\\Local\\Microsoft\\WindowsApps\\bash.exe",
    ];
    expect(findBash(probe({ env, files }))).toBeNull();
  });

  test("skips the WSL launcher but takes a later PATH entry", () => {
    const env = {
      systemroot: "C:\\WINDOWS",
      Path: 'C:\\WINDOWS\\system32;"C:\\Program Files\\Git\\usr\\bin"',
    };
    const files = ["C:\\Windows\\System32\\bash.exe", "C:\\Program Files\\Git\\usr\\bin\\bash.exe"];
    expect(findBash(probe({ env, files }))).toBe("C:\\Program Files\\Git\\usr\\bin\\bash.exe");
  });

  test("returns null when nothing is installed", () => {
    expect(findBash(probe())).toBeNull();
  });
});

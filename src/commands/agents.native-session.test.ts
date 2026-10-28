import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnCoordBinSync } from "../core/agents/coord-bin.ts";
import { nativeSessionIdentity } from "./agents.ts";

test.skipIf(process.platform !== "win32")(
  "native coordination helpers preserve stdin, argument boundaries and veto exits",
  () => {
    const root = mkdtempSync(join(tmpdir(), "harnery helper paths "));
    const binary = join(root, "agent-coord");
    try {
      writeFileSync(
        `${binary}.mjs`,
        `import { readFileSync } from 'node:fs'; process.stdout.write(JSON.stringify({args:process.argv.slice(2),input:readFileSync(0,'utf8')})); process.exitCode=2;`,
      );
      const result = spawnCoordBinSync(binary, ["set-task", "session one", "hook task — verify"], {
        encoding: "utf8",
        input: "line one\nline two",
      });
      expect(result.status).toBe(2);
      expect(JSON.parse(result.stdout)).toEqual({
        args: ["set-task", "session one", "hook task — verify"],
        input: "line one\nline two",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

describe("nativeSessionIdentity", () => {
  test("prefers the cache's native adapter session ID", () => {
    expect(
      nativeSessionIdentity(
        { native_session_id: "native-session", session_id: `sid_${"a".repeat(64)}` },
        "owner",
      ),
    ).toBe("native-session");
  });

  test("falls back to the owner for a projection-only canonical session ID", () => {
    expect(nativeSessionIdentity({ session_id: `sid_${"a".repeat(64)}` }, "native-owner")).toBe(
      "native-owner",
    );
  });

  test("keeps a non-canonical session ID", () => {
    expect(nativeSessionIdentity({ session_id: "adapter-session" }, "owner")).toBe(
      "adapter-session",
    );
  });
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { plantFakeCli } from "../../../tests/helpers/fake-cli.ts";
import { removeDir } from "../../../tests/helpers/remove-dir.ts";
import { claudeCodeSpawner } from "./spawn-claude.ts";
import type { SpawnRequest } from "./types.ts";

// A fake `claude` on PATH records its argv and the connector env switch, then
// prints a success envelope, so the test exercises the real spawn path.
const envelope = { type: "result", is_error: false, result: "ok", session_id: "s1" };
let binDir: string;
let savedPath: string | undefined;
let savedSwitch: string | undefined;

beforeEach(() => {
  binDir = mkdtempSync(join(tmpdir(), "spawn-claude-test-"));
  plantFakeCli(
    binDir,
    "claude",
    [
      `import { writeFileSync } from "node:fs";`,
      `writeFileSync(${JSON.stringify(join(binDir, "argv"))}, process.argv.slice(2).map((a) => a + "\\n").join(""));`,
      `writeFileSync(${JSON.stringify(join(binDir, "switch"))}, process.env.ENABLE_CLAUDEAI_MCP_SERVERS ?? "unset");`,
      `process.stdout.write(${JSON.stringify(JSON.stringify(envelope))});`,
    ].join("\n"),
  );
  savedPath = process.env.PATH;
  savedSwitch = process.env.ENABLE_CLAUDEAI_MCP_SERVERS;
  process.env.PATH = `${binDir}${delimiter}${savedPath ?? ""}`;
  delete process.env.ENABLE_CLAUDEAI_MCP_SERVERS;
});

afterEach(() => {
  process.env.PATH = savedPath;
  if (savedSwitch === undefined) delete process.env.ENABLE_CLAUDEAI_MCP_SERVERS;
  else process.env.ENABLE_CLAUDEAI_MCP_SERVERS = savedSwitch;
  removeDir(binDir);
});

const request: SpawnRequest = {
  prompt: "hi",
  timeoutMs: 10_000,
  maxTurns: 1,
  cwd: tmpdir(),
};

describe("claudeCodeSpawner MCP guards", () => {
  test("a default spawn turns connectors off in argv and env", async () => {
    const result = await claudeCodeSpawner(request);
    expect(result.ok).toBe(true);
    const argv = readFileSync(join(binDir, "argv"), "utf8").trim().split("\n");
    expect(argv).toContain("--strict-mcp-config");
    expect(argv[argv.indexOf("--mcp-config") + 1]).toBe('{"mcpServers":{}}');
    expect(argv).not.toContain("--setting-sources");
    expect(readFileSync(join(binDir, "switch"), "utf8")).toBe("false");
  });

  test('mcp: "inherit" leaves Claude Code free to load its connectors', async () => {
    const result = await claudeCodeSpawner({ ...request, mcp: "inherit" });
    expect(result.ok).toBe(true);
    const argv = readFileSync(join(binDir, "argv"), "utf8");
    expect(argv).not.toContain("--strict-mcp-config");
    expect(readFileSync(join(binDir, "switch"), "utf8")).toBe("unset");
  });
});

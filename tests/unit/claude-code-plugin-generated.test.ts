import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  GENERATED_PLUGIN_MODULE,
  renderClaudeCodePluginModule,
} from "../../scripts/build-claude-code-plugin.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("Claude Code plugin generated module", () => {
  test("matches what the build script writes from the current source", () => {
    const committed = readFileSync(join(root, GENERATED_PLUGIN_MODULE), "utf8");
    // On failure: run `bun run build:claude-code-plugin` and commit the result.
    expect(committed).toBe(renderClaudeCodePluginModule());
  });

  test("imports nothing, so a hooks module can load it", () => {
    const text = renderClaudeCodePluginModule();
    expect(text).not.toMatch(/^\s*import\s/m);
    expect(text).not.toMatch(/\brequire\(/);
  });

  test("the hooks module imports only relative paths", () => {
    const hooks = readFileSync(join(root, "claude-code-plugin/hooks/register.js"), "utf8");
    const specifiers = [...hooks.matchAll(/\bfrom\s+"([^"]+)"/g)].map((m) => m[1]);
    expect(specifiers.length).toBeGreaterThan(0);
    for (const specifier of specifiers) expect(specifier).toMatch(/^\.\.?\//);
  });
});

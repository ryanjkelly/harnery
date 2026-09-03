import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHarneryProgram, type EmitContext } from "../commander.ts";
import { createArtifact } from "../core/artifacts/index.ts";
import { finalizePageReviewPack } from "../lib/browser/page-review-pack.ts";

for (const enabled of [false, true]) {
  test(`artifact cleanup previews expired packs and honors auto_clean=${enabled}`, async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "artifact-pack-clean-"));
    Bun.spawnSync(["git", "init", "-q"], { cwd: repoRoot });
    try {
      mkdirSync(join(repoRoot, ".harnery"), { recursive: true });
      writeFileSync(
        join(repoRoot, ".harnery", "config.jsonc"),
        JSON.stringify({ review_pack: { auto_clean: enabled } }),
      );
      const packs = [
        { name: "expired", expires_at: "2000-01-01T00:00:00Z", managed: true },
        { name: "future", expires_at: "2999-01-01T00:00:00Z", managed: true },
        { name: "unmanaged", expires_at: "2000-01-01T00:00:00Z", managed: false },
      ].map((pack) => ({
        ...pack,
        dir: createArtifact(repoRoot, {
          slug: pack.name,
          purpose: "Review pack cleanup test",
          retentionDays: 7,
        }).path,
      }));
      for (const pack of packs) {
        finalizePageReviewPack({
          packDir: pack.dir,
          target: "https://example.test/page",
          contexts: [],
          retention: { expires_at: pack.expires_at, managed: pack.managed },
        });
      }
      async function clean(yes: boolean) {
        const errors: unknown[] = [];
        const exits: number[] = [];
        const data: unknown[] = [];
        const emit: EmitContext = {
          config() {},
          data: (value) => {
            data.push(value);
          },
          rows() {},
          text() {},
          file() {},
          error: (value) => {
            errors.push(value);
          },
          log() {},
          setExitCode: (value) => {
            exits.push(value);
          },
        };
        const program = createHarneryProgram({ context: { repoRoot }, emit });
        await program.parseAsync(["artifacts", "clean", ...(yes ? ["--yes"] : [])], {
          from: "user",
        });
        expect(errors).toEqual([]);
        expect(exits).not.toContain(1);
        return data[0] as { review_packs?: unknown };
      }
      const preview = await clean(false);
      expect(preview.review_packs !== undefined).toBe(enabled);
      for (const pack of packs) expect(existsSync(join(pack.dir, "manifest.json"))).toBe(true);
      await clean(true);
      expect(existsSync(join(packs[0]!.dir, "pack-expired.json"))).toBe(enabled);
      expect(existsSync(join(packs[0]!.dir, "manifest.json"))).toBe(!enabled);
      for (const pack of packs.slice(1))
        expect(existsSync(join(pack.dir, "manifest.json"))).toBe(true);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
}

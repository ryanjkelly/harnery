import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Browser } from "../../src/lib/browser/client.ts";
import {
  buildQaManifest,
  classifySignatures,
  type QaSignature,
} from "../../src/lib/browser/qa-plan.ts";

const fixtureRoot = resolve(import.meta.dir, "../fixtures/qa-plan");
const profiles: string[] = [];
let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const pathname = new URL(request.url).pathname;
      const file = pathname === "/" ? "index.html" : pathname.slice(1);
      return new Response(Bun.file(resolve(fixtureRoot, file)));
    },
  });
});

afterAll(() => server.stop(true));

function profile(): string {
  const path = mkdtempSync(join(tmpdir(), "harnery-qa-plan-"));
  profiles.push(path);
  return path;
}

afterEach(() => {
  for (const path of profiles.splice(0)) rmSync(path, { recursive: true, force: true });
});

function signature(
  captured: Awaited<ReturnType<Browser["qaSignature"]>>,
  url: string,
): QaSignature {
  return {
    url,
    capturedAt: "2026-08-17T00:00:00Z",
    nodes: captured.nodes,
    stylesheets: captured.stylesheets,
    ...(captured.truncated ? { truncated: true } : {}),
  };
}

describe("fixture-backed QA classification", () => {
  test("text/data edits skip vision while visual evidence always reviews", async () => {
    const browser = new Browser({ profileDir: profile(), viewport: { width: 800, height: 900 } });
    try {
      await browser.open();
      const capture = async (variant: string): Promise<QaSignature> => {
        const url = new URL(`http://127.0.0.1:${server.port}/`);
        url.searchParams.set("variant", variant);
        await browser.navigate(url.href);
        return signature(await browser.qaSignature(), url.href);
      };

      const baseline = await capture("baseline");
      for (const variant of ["prose", "number", "date", "table-value"]) {
        const classification = classifySignatures(baseline, await capture(variant));
        expect(classification.change_class, variant).toBe("text-data-only");
        const manifest = buildQaManifest(classification, { baselineSource: "qa-snapshot:fixture" });
        expect(manifest.predicted.model_calls_ceiling, variant).toBe(0);
      }

      for (const variant of [
        "class",
        "style",
        "layout-attribute",
        "component-markup",
        "media",
        "svg",
        "canvas",
        "interaction",
      ]) {
        const classification = classifySignatures(baseline, await capture(variant));
        expect(classification.change_class, variant).not.toBe("text-data-only");
        expect(classification.scopes.length, variant).toBe(1);
      }

      for (const variant of ["inline-css", "external-css"]) {
        const current = await capture(variant);
        expect(current.nodes, `${variant} DOM signature`).toEqual(baseline.nodes);
        expect(classifySignatures(baseline, current).change_class, variant).toBe(
          "large-structural",
        );
      }
    } finally {
      await browser.close();
    }
  });
});

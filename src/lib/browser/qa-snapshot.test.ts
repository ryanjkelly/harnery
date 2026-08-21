import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { QaContext, QaSignature } from "./qa-plan.ts";
import {
  listQaSnapshotTargets,
  loadQaSnapshot,
  qaSnapshotKey,
  resolveQaBaseline,
  saveQaSnapshot,
} from "./qa-snapshot.ts";

const CTX: QaContext = { viewport: "desktop", theme: "light", state: "default" };

function sig(capturedAt = "2026-08-17T00:00:00Z"): QaSignature {
  return {
    url: "http://example.test/page",
    capturedAt,
    nodes: [{ path: "body>p:0", tag: "p", attrs: "" }],
    stylesheets: [{ key: "inline:0", kind: "inline", digest: "aa-1" }],
  };
}

const roots: string[] = [];
function tmpRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "qa-snap-"));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("qaSnapshotKey", () => {
  test("is filesystem-safe and disambiguated by digest", () => {
    const a = qaSnapshotKey("https://example.test/page?x=1");
    const b = qaSnapshotKey("https://example.test/page?x=2");
    expect(a).toMatch(/^[a-zA-Z0-9-]+$/);
    expect(a).not.toBe(b);
  });

  test("bounds separator-heavy targets without a backtracking trim", () => {
    const key = qaSnapshotKey(`https://${"-".repeat(100_000)}`);
    expect(key).toMatch(/^target-[0-9a-f]{8}$/);
  });
});

describe("save/load", () => {
  test("roundtrips signature, dom, and screenshot", () => {
    const root = tmpRoot();
    const saved = saveQaSnapshot(
      "http://example.test/page",
      CTX,
      { signature: sig(), domHtml: "<html></html>", screenshotPng: Buffer.from([1, 2, 3]) },
      { root },
    );
    const loaded = loadQaSnapshot("http://example.test/page", CTX, { root });
    expect(loaded?.signature.capturedAt).toBe("2026-08-17T00:00:00Z");
    expect(loaded?.domHtmlPath).toBe(saved.domHtmlPath);
    expect(readFileSync(loaded!.screenshotPath!)).toEqual(Buffer.from([1, 2, 3]));
  });

  test("re-save replaces the prior snapshot atomically", () => {
    const root = tmpRoot();
    saveQaSnapshot("t", CTX, { signature: sig("2026-08-16T00:00:00Z"), domHtml: "old" }, { root });
    saveQaSnapshot("t", CTX, { signature: sig("2026-08-17T09:00:00Z") }, { root });
    const loaded = loadQaSnapshot("t", CTX, { root });
    expect(loaded?.signature.capturedAt).toBe("2026-08-17T09:00:00Z");
    expect(loaded?.domHtmlPath).toBeUndefined(); // old dom.html did not survive
  });

  test("contexts are stored independently", () => {
    const root = tmpRoot();
    saveQaSnapshot("t", CTX, { signature: sig("A") }, { root });
    saveQaSnapshot("t", { ...CTX, theme: "dark" }, { signature: sig("B") }, { root });
    expect(loadQaSnapshot("t", CTX, { root })?.signature.capturedAt).toBe("A");
    expect(loadQaSnapshot("t", { ...CTX, theme: "dark" }, { root })?.signature.capturedAt).toBe(
      "B",
    );
  });

  test("a corrupt signature file loads as null, never throws", () => {
    const root = tmpRoot();
    const saved = saveQaSnapshot("t", CTX, { signature: sig() }, { root });
    writeFileSync(resolve(saved.path, "signature.json"), "{not json");
    expect(loadQaSnapshot("t", CTX, { root })).toBeNull();
  });

  test("a corrupt critique degrades to a reuse miss without losing the baseline", () => {
    const root = tmpRoot();
    const saved = saveQaSnapshot("t", CTX, { signature: sig() }, { root });
    writeFileSync(resolve(saved.path, "critique.json"), "{not json");
    const loaded = loadQaSnapshot("t", CTX, { root });
    expect(loaded?.signature).toEqual(sig());
    expect(loaded?.critique).toBeUndefined();
  });

  test("an interrupted staging directory is ignored by readers and listings", () => {
    const root = tmpRoot();
    saveQaSnapshot("t", CTX, { signature: sig("complete") }, { root });
    mkdirSync(resolve(root, "interrupted.tmp-999"), { recursive: true });
    writeFileSync(resolve(root, "interrupted.tmp-999", "signature.json"), "{");
    expect(loadQaSnapshot("t", CTX, { root })?.signature.capturedAt).toBe("complete");
    expect(listQaSnapshotTargets({ root })).not.toContain("interrupted.tmp-999");
  });

  test("missing snapshot is null and listing shows saved targets", () => {
    const root = tmpRoot();
    expect(loadQaSnapshot("never-saved", CTX, { root })).toBeNull();
    saveQaSnapshot("http://example.test/x", CTX, { signature: sig() }, { root });
    expect(listQaSnapshotTargets({ root }).length).toBe(1);
  });
});

describe("resolveQaBaseline", () => {
  test("persisted snapshot wins and labels its capture time", async () => {
    const root = tmpRoot();
    saveQaSnapshot("t", CTX, { signature: sig("2026-08-17T05:00:00Z") }, { root });
    const res = await resolveQaBaseline({
      target: "t",
      context: CTX,
      store: { root },
      renderProduction: async () => {
        throw new Error("must not be called");
      },
    });
    expect(res.source).toBe("qa-snapshot:2026-08-17T05:00:00Z");
    expect(res.signature).not.toBeNull();
  });

  test("falls through snapshot -> production -> revision -> none", async () => {
    const root = tmpRoot();
    const viaProduction = await resolveQaBaseline({
      target: "t",
      context: CTX,
      store: { root },
      renderProduction: async () => sig("P"),
    });
    expect(viaProduction.source).toBe("production-render:P");

    const viaRevision = await resolveQaBaseline({
      target: "t",
      context: CTX,
      store: { root },
      renderProduction: async () => null,
      renderRevision: { label: "git:abc123", render: async () => sig("R") },
    });
    expect(viaRevision.source).toBe("revision-render:git:abc123");

    const none = await resolveQaBaseline({ target: "t", context: CTX, store: { root } });
    expect(none).toEqual({ source: "none", signature: null });
  });

  test("a throwing fallback falls through instead of failing resolution", async () => {
    const root = tmpRoot();
    const res = await resolveQaBaseline({
      target: "t",
      context: CTX,
      store: { root },
      renderProduction: async () => {
        throw new Error("network down");
      },
      renderRevision: { label: "git:abc", render: async () => sig("R") },
    });
    expect(res.source).toBe("revision-render:git:abc");
  });
});

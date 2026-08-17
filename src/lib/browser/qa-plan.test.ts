import { describe, expect, test } from "bun:test";
import {
  buildQaManifest,
  classifySignatures,
  fnv1a32,
  type QaNodeSignature,
  type QaSignature,
  type QaStylesheetSignature,
} from "./qa-plan.ts";

function node(path: string, overrides: Partial<QaNodeSignature> = {}): QaNodeSignature {
  const tag = path.split(">").pop()?.split(":")[0] ?? "div";
  return { path, tag, attrs: "", ...overrides };
}

function sig(
  nodes: QaNodeSignature[],
  stylesheets: QaStylesheetSignature[] = [{ key: "inline:0", kind: "inline", digest: "abc-10" }],
): QaSignature {
  return { url: "http://example.test/", capturedAt: "2026-08-17T00:00:00Z", nodes, stylesheets };
}

const TRACKER = { selector: "#tracker", path: "body>div:0" };

describe("fnv1a32", () => {
  test("is stable and length-suffixed", () => {
    expect(fnv1a32("hello")).toBe(fnv1a32("hello"));
    expect(fnv1a32("hello")).toMatch(/^[0-9a-f]{8}-5$/);
    expect(fnv1a32("hello")).not.toBe(fnv1a32("hellp"));
  });
});

describe("classifySignatures", () => {
  test("missing baseline is unknown, never text-only", () => {
    const res = classifySignatures(null, sig([node("body>p:0")]));
    expect(res.change_class).toBe("unknown");
  });

  test("a truncated capture widens to unknown", () => {
    const nodes = [node("body>p:0")];
    const res = classifySignatures(sig(nodes), { ...sig(nodes), truncated: true });
    expect(res.change_class).toBe("unknown");
    expect(res.reasons[0]).toContain("truncated");
  });

  test("unavailable stylesheet digest widens to unknown", () => {
    const base = sig([node("body>p:0")], [{ key: "x.css", kind: "external", digest: "aa-5" }]);
    const cur = sig(
      [node("body>p:0")],
      [{ key: "x.css", kind: "external", digest: "unavailable" }],
    );
    expect(classifySignatures(base, cur).change_class).toBe("unknown");
  });

  test("stylesheet-only change with identical DOM is large-structural, never text-only", () => {
    const nodes = [node("body>p:0", { text: "t-1" })];
    const base = sig(nodes, [{ key: "site.css", kind: "external", digest: "aa-100" }]);
    const cur = sig(nodes, [{ key: "site.css", kind: "external", digest: "bb-101" }]);
    const res = classifySignatures(base, cur);
    expect(res.change_class).toBe("large-structural");
    expect(res.stylesheets_changed).toEqual(["site.css"]);
  });

  test("opaque visual digest changes are structural and unavailable evidence widens", () => {
    const anchor = { selector: "#graphic", path: "body>section:0" };
    const base = sig([node("body>section:0>svg:0", { visual: "a-10", anchor })]);
    const changed = sig([node("body>section:0>svg:0", { visual: "b-10", anchor })]);
    const unavailable = sig([node("body>section:0>canvas:0", { visual: "unavailable", anchor })]);
    expect(classifySignatures(base, changed).change_class).toBe("local-visual");
    expect(classifySignatures(unavailable, unavailable).change_class).toBe("unknown");
  });

  test("identical signatures are text-data-only and flagged identical", () => {
    const nodes = [node("body>p:0", { text: "t-1" })];
    const res = classifySignatures(sig(nodes), sig(nodes));
    expect(res.change_class).toBe("text-data-only");
    expect(res.identical).toBe(true);
  });

  test("text-only edits classify as text-data-only with the changed paths", () => {
    const base = sig([node("body>p:0", { text: "old-3" }), node("body>p:1", { text: "same" })]);
    const cur = sig([node("body>p:0", { text: "new-3" }), node("body>p:1", { text: "same" })]);
    const res = classifySignatures(base, cur);
    expect(res.change_class).toBe("text-data-only");
    expect(res.text_changed_paths).toEqual(["body>p:0"]);
    expect(res.scopes).toEqual([]);
  });

  test("attribute change under a stable anchor is local-visual scoped to the anchor", () => {
    const base = sig([node("body>div:0>td:0", { attrs: "class=a", anchor: TRACKER })]);
    const cur = sig([node("body>div:0>td:0", { attrs: "class=b", anchor: TRACKER })]);
    const res = classifySignatures(base, cur);
    expect(res.change_class).toBe("local-visual");
    expect(res.scopes).toEqual([
      { selector: "#tracker", reason: "nearest stable ancestor of 1 changed node", matches: 1 },
    ]);
  });

  test("added and removed nodes under one anchor share one scope", () => {
    const base = sig([node("body>div:0>tr:0", { anchor: TRACKER })]);
    const cur = sig([
      node("body>div:0>tr:0", { anchor: TRACKER }),
      node("body>div:0>tr:1", { anchor: TRACKER }),
    ]);
    const res = classifySignatures(base, cur);
    expect(res.change_class).toBe("local-visual");
    expect(res.scopes.length).toBe(1);
    expect(res.structural_changed_paths).toEqual(["body>div:0>tr:1"]);
  });

  test("a changed node without a stable ancestor widens to large-structural", () => {
    const base = sig([node("body>section:0")]);
    const cur = sig([node("body>section:0", { attrs: "class=x" })]);
    const res = classifySignatures(base, cur);
    expect(res.change_class).toBe("large-structural");
    expect(res.reasons[0]).toContain("without a stable ancestor");
  });

  test("nested anchors dedupe to the outermost root", () => {
    const outer = { selector: "#card", path: "body>div:0" };
    const inner = { selector: "#card-title", path: "body>div:0>h2:0" };
    const base = sig([
      node("body>div:0>h2:0>span:0", { attrs: "class=a", anchor: inner }),
      node("body>div:0>p:0", { attrs: "class=a", anchor: outer }),
    ]);
    const cur = sig([
      node("body>div:0>h2:0>span:0", { attrs: "class=b", anchor: inner }),
      node("body>div:0>p:0", { attrs: "class=b", anchor: outer }),
    ]);
    const res = classifySignatures(base, cur);
    expect(res.change_class).toBe("local-visual");
    expect(res.scopes.map((s) => s.selector)).toEqual(["#card"]);
    expect(res.scopes[0].reason).toContain("2 changed nodes");
  });

  test("more scope roots than maxScopes widens to large-structural", () => {
    const mk = (i: number) =>
      node(`body>div:${i}>p:0`, {
        attrs: "class=x",
        anchor: { selector: `#s${i}`, path: `body>div:${i}` },
      });
    const base = sig(
      [0, 1, 2].map((i) =>
        node(`body>div:${i}>p:0`, {
          anchor: { selector: `#s${i}`, path: `body>div:${i}` },
        }),
      ),
    );
    const cur = sig([0, 1, 2].map(mk));
    expect(classifySignatures(base, cur, { maxScopes: 2 }).change_class).toBe("large-structural");
    expect(classifySignatures(base, cur, { maxScopes: 3 }).change_class).toBe("local-visual");
  });
});

describe("buildQaManifest", () => {
  const textOnly = classifySignatures(
    sig([node("body>p:0", { text: "a-1" })]),
    sig([node("body>p:0", { text: "b-1" })]),
  );
  const local = classifySignatures(
    sig([node("body>div:0>td:0", { attrs: "class=a", anchor: TRACKER })]),
    sig([node("body>div:0>td:0", { attrs: "class=b", anchor: TRACKER })]),
  );
  const unknown = classifySignatures(null, sig([node("body>p:0")]));

  test("text-data-only has no contexts and a zero call ceiling", () => {
    const m = buildQaManifest(textOnly, { baselineSource: "qa-snapshot:t" });
    expect(m.change_class).toBe("text-data-only");
    expect(m.contexts).toEqual([]);
    expect(m.checks.visual).toBe("none");
    expect(m.predicted.model_calls_ceiling).toBe(0);
    expect(m.checks.deterministic.length).toBeGreaterThan(0);
  });

  test("local-visual reviews scopes across light viewports only", () => {
    const m = buildQaManifest(local, { baselineSource: "qa-snapshot:t" });
    expect(m.change_class).toBe("local-visual");
    expect(m.contexts).toEqual([
      { viewport: "desktop", theme: "light", state: "default" },
      { viewport: "mobile", theme: "light", state: "default" },
    ]);
    expect(m.checks.visual).toBe("scoped");
    expect(m.scopes.map((s) => s.selector)).toEqual(["#tracker"]);
    expect(m.predicted.model_calls_ceiling).toBe(2); // 1 scope x 2 contexts
  });

  test("explicit states promote to interaction-state and add state contexts", () => {
    const m = buildQaManifest(local, {
      baselineSource: "qa-snapshot:t",
      states: ["modal-open"],
      outcomeAssertions: ["exists [role=dialog]", "text #status => Saved"],
    });
    expect(m.change_class).toBe("interaction-state");
    expect(m.contexts).toEqual([
      { viewport: "desktop", theme: "light", state: "default" },
      { viewport: "desktop", theme: "light", state: "modal-open" },
    ]);
    expect(m.checks.interaction).toEqual(["exists [role=dialog]", "text #status => Saved"]);
  });

  test("a missing explicit selector marks the manifest incomplete", () => {
    const m = buildQaManifest(local, {
      baselineSource: "qa-snapshot:t",
      explicitScopes: [{ selector: "#missing", reason: "explicit input", matches: 0 }],
    });
    expect(m.incomplete?.reason).toContain("#missing");
    expect(m.contexts).toEqual([]);
    expect(m.predicted.model_calls_ceiling).toBe(0);
  });

  test("an explicit component boundary scopes a stylesheet-only change", () => {
    const stylesheetOnly = classifySignatures(
      sig([node("body>main:0")], [{ key: "card.css", kind: "external", digest: "a-1" }]),
      sig([node("body>main:0")], [{ key: "card.css", kind: "external", digest: "b-1" }]),
    );
    const m = buildQaManifest(stylesheetOnly, {
      baselineSource: "qa-snapshot:t",
      explicitScopes: [{ selector: "#card", reason: "component stylesheet owner", matches: 1 }],
    });
    expect(m.change_class).toBe("local-visual");
    expect(m.scopes.map((scope) => scope.selector)).toEqual(["#card"]);
    expect(m.checks.visual).toBe("scoped");
  });

  test("unknown widens to the full four-context matrix by default", () => {
    const m = buildQaManifest(unknown, {
      baselineSource: "none",
      estimatedFullPageTiles: 6,
    });
    expect(m.change_class).toBe("unknown");
    expect(m.contexts.length).toBe(4); // desktop/mobile x light/dark
    expect(m.checks.visual).toBe("full-page");
    expect(m.predicted.model_calls_ceiling).toBe(24); // 6 tiles x 4 contexts
    expect(m.incomplete).toBeUndefined();
  });

  test("unknown with stopOnUnknown marks the manifest incomplete instead", () => {
    const m = buildQaManifest(unknown, { baselineSource: "none", stopOnUnknown: true });
    expect(m.incomplete?.reason).toContain("no baseline");
    expect(m.contexts).toEqual([]);
    expect(m.predicted.model_calls_ceiling).toBe(0);
  });

  test("explicit scopes override unknown into local-visual (resolution rung 1)", () => {
    const m = buildQaManifest(unknown, {
      baselineSource: "none",
      explicitScopes: [{ selector: "#hero", reason: "explicit input", matches: 1 }],
    });
    expect(m.change_class).toBe("local-visual");
    expect(m.scopes.map((s) => s.selector)).toEqual(["#hero"]);
  });

  test("large-structural keeps the full matrix and full-page review", () => {
    const largeSig = classifySignatures(
      sig([node("body>p:0")], [{ key: "s.css", kind: "external", digest: "a-1" }]),
      sig([node("body>p:0")], [{ key: "s.css", kind: "external", digest: "b-1" }]),
    );
    const m = buildQaManifest(largeSig, {
      baselineSource: "production-render:t",
      estimatedFullPageTiles: 10,
    });
    expect(m.change_class).toBe("large-structural");
    expect(m.contexts.length).toBe(4);
    expect(m.predicted.tiles_ceiling).toBe(40);
  });
});

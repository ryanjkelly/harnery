import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

mock.module("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
  usePathname: () => "/devtools",
  useSearchParams: () => new URLSearchParams(),
}));

import { helperLimitReportFixture } from "@/lib/helper-limit-fixture";
import { HelperLimitControl, pairFromSelection, saveHelperLimit } from "./HelperLimitControl";

const ladders = helperLimitReportFixture().ladders;

function fakeFetch(status: number, body: unknown) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const impl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("HelperLimitControl", () => {
  test("each dropdown starts with No limit, then the ladder with capitals", () => {
    const html = renderToStaticMarkup(
      <HelperLimitControl
        ladders={ladders}
        user={{ max_model: "opus" }}
        hasProjectDefault={false}
      />,
    );
    expect(html).toContain(
      '<option value="">No limit</option><option value="haiku">Haiku</option><option value="sonnet">Sonnet</option><option value="opus" selected="">Opus</option><option value="fable">Fable</option>',
    );
    expect(html).toContain(
      '<option value="" selected="">No limit</option><option value="low">Low</option>',
    );
    expect(html).not.toContain("Use project default");
  });

  test("offers Use project default only with a saved choice and a project default", () => {
    const withBoth = renderToStaticMarkup(
      <HelperLimitControl ladders={ladders} user={{}} hasProjectDefault />,
    );
    expect(withBoth).toContain("Use project default");
    const noChoice = renderToStaticMarkup(
      <HelperLimitControl ladders={ladders} user={null} hasProjectDefault />,
    );
    expect(noChoice).not.toContain("Use project default");
    expect(noChoice).toContain("Not set. The project default applies.");
  });

  test("pairFromSelection drops No limit sides", () => {
    expect(pairFromSelection("opus", "")).toEqual({ max_model: "opus" });
    expect(pairFromSelection("", "")).toEqual({});
    expect(pairFromSelection("sonnet", "low")).toEqual({ max_model: "sonnet", max_effort: "low" });
  });
});

describe("saveHelperLimit", () => {
  test("posts the pair and returns the fresh report", async () => {
    const report = helperLimitReportFixture();
    const { impl, calls } = fakeFetch(200, report);
    const result = await saveHelperLimit({ max_model: "opus", max_effort: "medium" }, impl);
    expect(result).toEqual({ ok: true, report });
    expect(calls[0]?.url).toBe("/api/devtools/helper-limit");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      limit: { max_model: "opus", max_effort: "medium" },
    });
  });

  test("posts null to clear", async () => {
    const { impl, calls } = fakeFetch(200, { ok: true });
    expect(await saveHelperLimit(null, impl)).toEqual({ ok: true, report: null });
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ limit: null });
  });

  test("returns the route's plain-words error, or a fallback", async () => {
    const refused = fakeFetch(403, { ok: false, error: "Not changed: not from this computer." });
    expect(await saveHelperLimit({}, refused.impl)).toEqual({
      ok: false,
      error: "Not changed: not from this computer.",
    });
    const broken = fakeFetch(500, "oops");
    expect(await saveHelperLimit({}, broken.impl)).toEqual({
      ok: false,
      error: "The helper limit could not be saved.",
    });
    const down = (async () => {
      throw new Error("network");
    }) as unknown as typeof fetch;
    const result = await saveHelperLimit({}, down);
    expect(result.ok).toBe(false);
  });
});

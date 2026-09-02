import { describe, expect, test } from "bun:test";
import { isBenignNextRscAbort } from "./request-diagnostics.ts";

describe("isBenignNextRscAbort", () => {
  const observedAbort = {
    url: "https://example.com/?_rsc=wkpkl",
    method: "GET",
    failure: "net::ERR_ABORTED",
    resourceType: "fetch",
  };

  test("recognizes canceled Next.js RSC fetches", () => {
    expect(isBenignNextRscAbort(observedAbort)).toBe(true);
    expect(
      isBenignNextRscAbort({
        ...observedAbort,
        url: "https://example.com/path?view=queue&_rsc=abc123",
      }),
    ).toBe(true);
  });

  test("keeps actionable network failures", () => {
    expect(isBenignNextRscAbort({ ...observedAbort, url: "https://example.com/api/orders" })).toBe(
      false,
    );
    expect(isBenignNextRscAbort({ ...observedAbort, failure: "net::ERR_FAILED" })).toBe(false);
    expect(isBenignNextRscAbort({ ...observedAbort, method: "POST" })).toBe(false);
    expect(isBenignNextRscAbort({ ...observedAbort, resourceType: "script" })).toBe(false);
    expect(isBenignNextRscAbort({ ...observedAbort, url: "not a url" })).toBe(false);
  });
});

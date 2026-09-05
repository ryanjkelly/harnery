import { describe, expect, test } from "bun:test";
import {
  type BrowsePerformanceSample,
  checkBrowseSample,
  positiveBudget,
} from "./browse-performance-budgets";

const sample: BrowsePerformanceSample = {
  name: "cold",
  listingMs: 50,
  firstDecodedMs: 100,
  allDecodedMs: 300,
  visible: 15,
  decoded: 15,
  thumbnailRequests: 24,
  workspaceRequests: 0,
  uniqueRequestedFiles: 20,
  errors: [],
};
describe("Browse regression gates", () => {
  test("passes decoded images within explicit budgets", () =>
    expect(checkBrowseSample(sample)).toEqual([]));
  test("generic icons and partial completion cannot pass", () => {
    expect(checkBrowseSample({ ...sample, decoded: 14 })).toHaveLength(1);
    expect(checkBrowseSample({ ...sample, visible: 0, decoded: 0 })).toHaveLength(1);
  });
  test("bounds offscreen work independently of elapsed time", () => {
    expect(
      checkBrowseSample({ ...sample, thumbnailRequests: 241, uniqueRequestedFiles: 101 }),
    ).toHaveLength(2);
  });
  test("missing timings and runtime errors fail", () => {
    expect(
      checkBrowseSample({ ...sample, listingMs: null, allDecodedMs: null, errors: ["crashed"] }),
    ).toHaveLength(3);
  });
  test("Back navigation keeps completed previews without network work", () => {
    expect(
      checkBrowseSample({ ...sample, name: "same-document-back", thumbnailRequests: 4 }),
    ).toEqual([]);
    expect(
      checkBrowseSample({ ...sample, name: "same-document-back", thumbnailRequests: 5 }),
    ).toHaveLength(1);
  });
  test("rejects invalid configurable latency budgets", () => {
    for (const value of ["0", "-1", "NaN", "Infinity"])
      expect(() => positiveBudget(value, 10)).toThrow();
    expect(positiveBudget("12000", 10)).toBe(12000);
    expect(positiveBudget(undefined, 10)).toBe(10);
  });
  test("folder navigation never requests the workspace catalog", () => {
    expect(checkBrowseSample({ ...sample, workspaceRequests: 1 })).toHaveLength(1);
  });
  test("first decoded preview has an independent smoke ceiling", () => {
    expect(checkBrowseSample({ ...sample, firstDecodedMs: null })).toHaveLength(1);
    expect(checkBrowseSample({ ...sample, firstDecodedMs: 5001 })).toHaveLength(1);
  });
});

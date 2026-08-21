import { describe, expect, test } from "bun:test";

import { parseIdInput } from "./id-parser";

describe("parseIdInput", () => {
  test("workflow run ids route to the run page", () => {
    const [s] = parseIdInput("wf-2026-08-04T09-42-58-146Z-458566");
    expect(s?.kind).toBe("workflow");
    expect(s?.target).toBe("/workflows/wf-2026-08-04T09-42-58-146Z-458566");
  });

  test("instance UUIDs route to the agent page", () => {
    const [s] = parseIdInput("01a0172d-46f4-7f73-8066-17d9f995cf27");
    expect(s?.kind).toBe("agent");
    expect(s?.target).toBe("/agents/01a0172d-46f4-7f73-8066-17d9f995cf27");
  });

  test("repo paths become file suggestions with the raw path as target", () => {
    const [s] = parseIdInput("docs/plans/foo.md");
    expect(s?.kind).toBe("file");
    expect(s?.target).toBe("docs/plans/foo.md");
  });

  test("leading ./ is stripped from file targets", () => {
    expect(parseIdInput("./web/app/page.tsx")[0]?.target).toBe("web/app/page.tsx");
  });

  test("bare filenames with a known extension are files", () => {
    expect(parseIdInput("README.md")[0]?.kind).toBe("file");
  });

  test("plain words and URLs parse to nothing", () => {
    expect(parseIdInput("governors")).toEqual([]);
    expect(parseIdInput("http://localhost:4276/live")).toEqual([]);
    expect(parseIdInput("")).toEqual([]);
  });
});

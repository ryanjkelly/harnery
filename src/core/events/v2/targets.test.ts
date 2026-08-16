import { describe, expect, test } from "bun:test";
import type { FingerprintContextV2 } from "./canonical.ts";
import { exactToolInputFingerprintV2, extractTargetsV2 } from "./targets.ts";

const context: FingerprintContextV2 = {
  epochId: "pep_fixture",
  epochKey: Buffer.alloc(32, 0x42),
  rootId: "root_fixture",
  generationId: "gen_018f22b8-7dd3-7cc7-98c7-84c7fd6fdb5d",
};

describe("event ledger V2 target extractor registry", () => {
  test("keeps repository-relative displays and hides external path values", () => {
    const workspace = extractTargetsV2({
      coordRoot: "/workspace/project",
      toolNamespace: "claude",
      toolName: "Edit",
      toolInput: { file_path: "/workspace/project/src/index.ts" },
      fingerprintContext: context,
    });
    expect(workspace[0]?.kind).toBe("workspace_path");
    expect(workspace[0]?.display).toBe("src/index.ts");

    const external = extractTargetsV2({
      coordRoot: "/workspace/project",
      toolNamespace: "claude",
      toolName: "Read",
      toolInput: { file_path: "/home/person/account.json" },
      fingerprintContext: context,
    });
    expect(external[0]?.kind).toBe("external_path");
    expect(external[0]?.display).toBeUndefined();
    expect(JSON.stringify(external)).not.toContain("/home/person");

    const foreignWindowsPath = extractTargetsV2({
      coordRoot: "/workspace/project",
      toolNamespace: "codex",
      toolName: "Read",
      toolInput: { file_path: "C:\\Users\\person\\account.json" },
      fingerprintContext: context,
    });
    expect(foreignWindowsPath[0]?.kind).toBe("external_path");
    expect(foreignWindowsPath[0]?.display).toBeUndefined();
    expect(JSON.stringify(foreignWindowsPath)).not.toContain("Users");
  });

  test("extracts every explicit patch target without retaining patch content", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/a.ts",
      "+const secret = 'API_SECRET_12345';",
      "*** Add File: src/b.ts",
      "*** End Patch",
    ].join("\n");
    const targets = extractTargetsV2({
      coordRoot: "/workspace/project",
      toolNamespace: "codex",
      toolName: "apply_patch",
      toolInput: { patch },
      fingerprintContext: context,
    });
    expect(targets.map((target) => target.display)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(JSON.stringify(targets)).not.toContain("API_SECRET_12345");
  });

  test("does not guess targets for unknown tools and never displays queries", () => {
    expect(
      extractTargetsV2({
        coordRoot: "/workspace/project",
        toolNamespace: "vendor",
        toolName: "Mystery",
        toolInput: { path: "/workspace/project/secret.ts" },
        fingerprintContext: context,
      }),
    ).toEqual([]);
    const search = extractTargetsV2({
      coordRoot: "/workspace/project",
      toolNamespace: "web",
      toolName: "web_search",
      toolInput: { query: "private customer health data" },
      fingerprintContext: context,
    });
    expect(search[0]?.kind).toBe("query");
    expect(search[0]?.display).toBeUndefined();
    expect(JSON.stringify(search)).not.toContain("customer health data");
  });

  test("domain-separates exact input by tool identity", () => {
    const value = { path: "src/index.ts" };
    expect(exactToolInputFingerprintV2(context, "claude", "Read", value).digest).not.toBe(
      exactToolInputFingerprintV2(context, "claude", "Write", value).digest,
    );
  });
});

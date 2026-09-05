import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { listBrowseDir, listWorkspaces, workspaceEntry } from "./browse-catalog";

const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "browse-catalog-"));
  roots.push(root);
  const dir = ".harnery/artifacts/2026-01-01_example_123";
  const write = (rel: string, value: string) => {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), value);
  };
  write(
    `${dir}/.harnery-artifact.json`,
    JSON.stringify({
      schema_version: 2,
      artifact_id: "123",
      slug: "example-work",
      purpose: "Review outputs",
      created_by: { name: "Ada" },
    }),
  );
  write(`${dir}/report.txt`, "Report");
  write(`${dir}/frames/a.txt`, "Frame");
  const delivery = (items: unknown[]) =>
    write(
      `${dir}/.harnery-delivery.json`,
      JSON.stringify({ schema_version: 1, title: "Finished work", items }),
    );
  return { root, dir, write, delivery };
}
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe("workspace catalog", () => {
  test("shows friendly titles, owners, and normalized file/folder deliveries", async () => {
    const { root, dir, delivery } = fixture();
    delivery([
      { kind: "path", path: "./report.txt", label: "Report" },
      { kind: "path", path: "frames", label: "Frames" },
    ]);
    const result = await listWorkspaces({ root });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entries[0]).toMatchObject({
      relPath: dir,
      title: "Finished work",
      owner: "Ada",
      purpose: "Review outputs",
    });
    expect(result.entries[0].deliveryItems).toEqual([
      { relPath: `${dir}/report.txt`, kind: "file", label: "Report" },
      { relPath: `${dir}/frames`, kind: "dir", label: "Frames" },
    ]);
    const listing = await listBrowseDir(dir, { root });
    expect(listing.ok && listing.workspace?.title).toBe("Finished work");
  });

  test("rejects lexical, canonical, denied, and URL delivery escapes", async () => {
    const { root, dir, write, delivery } = fixture();
    write("outside.txt", "Outside workspace");
    write(`${dir}/.env`, "PRIVATE=1");
    symlinkSync(path.join(root, "outside.txt"), path.join(root, dir, "alias.txt"));
    symlinkSync(path.join(root, dir, ".env"), path.join(root, dir, "env-alias.txt"));
    delivery(
      [
        "../outside.txt",
        "/outside.txt",
        "https://example.com/",
        "alias.txt",
        "env-alias.txt",
        ".env",
        "report.txt",
      ].map((value) => ({ kind: "path", path: value })),
    );
    expect(
      (await workspaceEntry(dir, { root }))?.deliveryItems?.map((item) => item.relPath),
    ).toEqual([`${dir}/report.txt`]);
  });

  test("ignores missing, malformed, oversized, or unsupported manifests", async () => {
    const { root, dir, write } = fixture();
    write(`${dir}/.harnery-delivery.json`, `{${" ".repeat(70_000)}`);
    expect((await workspaceEntry(dir, { root }))?.deliveryItems).toEqual([]);
    write(`${dir}/.harnery-artifact.json`, JSON.stringify({ schema_version: 9, artifact_id: "x" }));
    expect(await listWorkspaces({ root })).toMatchObject({ ok: true, entries: [] });
    expect(await workspaceEntry("", { root })).toBeUndefined();
  });

  test("does not read manifests through aliases to denied or external content", async () => {
    const { root, dir, write } = fixture();
    write(
      ".credentials/catalog.json",
      JSON.stringify({ schema_version: 1, title: "Private metadata", items: [] }),
    );
    symlinkSync(
      path.join(root, ".credentials/catalog.json"),
      path.join(root, dir, ".harnery-delivery.json"),
    );
    expect((await workspaceEntry(dir, { root }))?.title).toBe("example work");
  });

  test("scans metadata beyond the descriptor's initial sniff", async () => {
    const { root, dir, write } = fixture();
    write(
      `${dir}/.harnery-delivery.json`,
      JSON.stringify({
        schema_version: 1,
        padding: "x".repeat(5000),
        title: "-----BEGIN RSA PRIVATE KEY-----",
        items: [],
      }),
    );
    expect((await workspaceEntry(dir, { root }))?.title).toBe("example work");
  });
});

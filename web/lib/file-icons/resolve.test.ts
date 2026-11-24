import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import path from "node:path";
import { iconPackRoot, loadIconMap, readIconSvg } from "./pack";
import {
  compactIconMap,
  fileIconUrl,
  type IconPackManifest,
  normalizeFolderName,
  resolveFileIcon,
} from "./resolve";

const manifest: IconPackManifest = {
  file: "file",
  folder: "folder",
  fileExtensions: { ts: "typescript", "test.ts": "test-ts", md: "markdown", j2: "jinja" },
  fileNames: { "README.md": "readme", ".env": "tune", "package.json": "nodejs" },
  folderNames: { docs: "folder-docs", ".github": "folder-github", __tests__: "folder-test" },
  light: { fileExtensions: { j2: "jinja_light" }, folderNames: { docs: "folder-docs_light" } },
};
const map = compactIconMap(manifest, "1.2.3");

describe("file icon resolution", () => {
  test("an exact file name wins over its extension, case-insensitively", () => {
    expect(resolveFileIcon(map, "README.md", "file")).toBe("readme");
    expect(resolveFileIcon(map, "readme.MD", "file")).toBe("readme");
    expect(resolveFileIcon(map, "notes.md", "file")).toBe("markdown");
  });

  test("the longest dotted extension wins", () => {
    expect(resolveFileIcon(map, "browse.test.ts", "file")).toBe("test-ts");
    expect(resolveFileIcon(map, "browse.ts", "file")).toBe("typescript");
  });

  test("dotfiles match by name and unknown files get the default", () => {
    expect(resolveFileIcon(map, ".env", "file")).toBe("tune");
    expect(resolveFileIcon(map, "Makefile.unknown", "file")).toBe("file");
    expect(resolveFileIcon(map, "noext", "file")).toBe("file");
  });

  test("folders ignore the pack's decoration spellings", () => {
    expect(normalizeFolderName("__Tests__")).toBe("tests");
    expect(resolveFileIcon(map, "tests", "dir")).toBe("folder-test");
    expect(resolveFileIcon(map, ".docs", "dir")).toBe("folder-docs");
    expect(resolveFileIcon(map, "github", "dir")).toBe("folder-github");
    expect(resolveFileIcon(map, "2026-11-21_launch", "dir")).toBe("folder");
  });

  test("a folder name never matches as a file and vice versa", () => {
    expect(resolveFileIcon(map, "docs", "file")).toBe("file");
    expect(resolveFileIcon(map, "README.md", "dir")).toBe("folder");
  });

  test("light theme prefers the darker variants and falls back to the shared icon", () => {
    expect(resolveFileIcon(map, "page.j2", "file", "light")).toBe("jinja_light");
    expect(resolveFileIcon(map, "page.j2", "file", "dark")).toBe("jinja");
    expect(resolveFileIcon(map, "docs", "dir", "light")).toBe("folder-docs_light");
    expect(resolveFileIcon(map, "notes.md", "file", "light")).toBe("markdown");
  });

  test("icon URLs carry the pack version", () => {
    expect(fileIconUrl("markdown", map.v)).toBe("/api/file/icons/svg/markdown?v=1.2.3");
  });
});

describe("installed icon pack", () => {
  const webRoot = path.resolve(import.meta.dir, "..", "..");
  const installed = iconPackRoot(webRoot) !== null;

  test.if(installed)("every icon a common name resolves to exists as an SVG", async () => {
    const cwd = process.cwd();
    process.chdir(webRoot);
    try {
      const real = await loadIconMap();
      expect(real).not.toBeNull();
      if (!real) return;
      const root = iconPackRoot(webRoot) as string;
      const names: [string, "file" | "dir"][] = [
        ["state.md", "file"],
        ["README.md", "file"],
        ["dbt-deploy-kits.log", "file"],
        ["v4m.png", "file"],
        ["browse.test.tsx", "file"],
        ["bun.lock", "file"],
        ["docs", "dir"],
        ["artifacts", "dir"],
        ["node_modules", "dir"],
      ];
      for (const [name, kind] of names) {
        for (const theme of ["light", "dark"] as const) {
          const id = resolveFileIcon(real, name, kind, theme);
          expect(existsSync(path.join(root, "icons", `${id}.svg`))).toBe(true);
        }
      }
      expect(resolveFileIcon(real, "state.md", "file")).toBe("markdown");
      expect(resolveFileIcon(real, "artifacts", "dir")).toBe(real.folder);
      expect(await readIconSvg("markdown")).toContain("<svg");
    } finally {
      process.chdir(cwd);
    }
  });

  test("icon reads reject anything that is not a plain icon id", async () => {
    for (const id of ["../package", "a/b", "Markdown", "", "x.svg"]) {
      expect(await readIconSvg(id)).toBeNull();
    }
  });
});

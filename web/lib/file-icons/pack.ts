/**
 * Server side of the file icon pack: locates the installed `material-icon-theme`
 * package, compacts its manifest once per process, and reads single SVGs.
 *
 * The package is a dashboard dependency, so it sits in `web/node_modules`. The
 * dashboard runs with `web/` as its working directory, and some hosts start it
 * from the Harnery root, so both are checked (the thumbnail helpers do the same).
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { compactIconMap, type FileIconMap, ICON_ID, type IconPackManifest } from "./resolve";

const PACKAGE = "material-icon-theme";

export function iconPackRoot(cwd = process.cwd()): string | null {
  for (const candidate of [
    path.join(cwd, "node_modules", PACKAGE),
    path.join(cwd, "web", "node_modules", PACKAGE),
  ]) {
    if (existsSync(path.join(candidate, "package.json"))) return candidate;
  }
  return null;
}

let mapPromise: Promise<FileIconMap | null> | null = null;

/** The compact map, built once per server process; null when the pack is missing. */
export function loadIconMap(): Promise<FileIconMap | null> {
  mapPromise ??= (async () => {
    const root = iconPackRoot();
    if (!root) return null;
    const [manifest, pkg] = await Promise.all([
      readFile(path.join(root, "dist", "material-icons.json"), "utf8"),
      readFile(path.join(root, "package.json"), "utf8"),
    ]);
    const version = (JSON.parse(pkg) as { version?: string }).version ?? "0";
    return compactIconMap(JSON.parse(manifest) as IconPackManifest, version);
  })().catch(() => {
    mapPromise = null;
    return null;
  });
  return mapPromise;
}

/** One icon's SVG source, or null for an unknown or malformed id. */
export async function readIconSvg(id: string): Promise<string | null> {
  if (!ICON_ID.test(id)) return null;
  const root = iconPackRoot();
  if (!root) return null;
  try {
    return await readFile(path.join(root, "icons", `${id}.svg`), "utf8");
  } catch {
    return null;
  }
}

/**
 * Name → icon resolution for the bundled file icon pack (Material Icon Theme).
 *
 * Shared by the server, which compacts the pack's VS Code manifest once
 * (`compactIconMap`), and the browser, which resolves names against that
 * compact map (`resolveFileIcon`). Matching follows the VS Code icon-theme
 * rules the pack is written for, case-insensitively: an exact file name wins,
 * then the longest dotted extension ("foo.test.ts" tries "test.ts", then
 * "ts"), then the generic file icon. Folders match by name, ignoring the
 * leading and trailing `.`, `_` and `-` decorations the pack lists as
 * separate spellings (".github", "_docs", "__tests__").
 */

/** The parts of the pack's `material-icons.json` this module reads. */
export interface IconPackManifest {
  file: string;
  folder: string;
  fileExtensions: Record<string, string>;
  fileNames: Record<string, string>;
  folderNames: Record<string, string>;
  light?: {
    fileExtensions?: Record<string, string>;
    fileNames?: Record<string, string>;
    folderNames?: Record<string, string>;
  };
}

interface IconLookups {
  /** File extension (no leading dot) → icon id. */
  e: Record<string, string>;
  /** Exact file name → icon id. */
  n: Record<string, string>;
  /** Normalized folder name → icon id. */
  d: Record<string, string>;
}

/** The compact, lower-cased map the browser downloads once. */
export interface FileIconMap extends IconLookups {
  /** Pack version, used to version icon URLs for long-lived caching. */
  v: string;
  /** Default file and folder icon ids. */
  file: string;
  folder: string;
  /** Light-theme overrides for icons that would vanish on a light background. */
  l: IconLookups;
}

export type IconTheme = "light" | "dark";

/** Strip the decorations the pack spells out separately (".x", "_x", "__x__"). */
export function normalizeFolderName(name: string): string {
  return name.toLowerCase().replace(/^[._-]+|[._-]+$/g, "");
}

function lower(source: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(source ?? {})) {
    const k = key.toLowerCase();
    if (!(k in out)) out[k] = value;
  }
  return out;
}

function folders(source: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(source ?? {})) {
    const k = normalizeFolderName(key);
    if (k && !(k in out)) out[k] = value;
  }
  return out;
}

export function compactIconMap(manifest: IconPackManifest, version: string): FileIconMap {
  return {
    v: version,
    file: manifest.file,
    folder: manifest.folder,
    e: lower(manifest.fileExtensions),
    n: lower(manifest.fileNames),
    d: folders(manifest.folderNames),
    l: {
      e: lower(manifest.light?.fileExtensions),
      n: lower(manifest.light?.fileNames),
      d: folders(manifest.light?.folderNames),
    },
  };
}

function lookupFile(maps: IconLookups, name: string): string | undefined {
  const exact = maps.n[name];
  if (exact) return exact;
  // Longest compound extension first; a leading dot is part of a dotfile's name.
  for (let dot = name.indexOf(".", 1); dot !== -1; dot = name.indexOf(".", dot + 1)) {
    const hit = maps.e[name.slice(dot + 1)];
    if (hit) return hit;
  }
  return undefined;
}

/** Icon id for an entry. Light theme prefers the pack's darker `_light` variants. */
export function resolveFileIcon(
  map: FileIconMap,
  name: string,
  kind: "file" | "dir",
  theme: IconTheme = "dark",
): string {
  if (kind === "dir") {
    const key = normalizeFolderName(name);
    return (theme === "light" ? map.l.d[key] : undefined) ?? map.d[key] ?? map.folder;
  }
  const key = name.toLowerCase();
  return (
    (theme === "light" ? lookupFile(map.l, key) : undefined) ?? lookupFile(map, key) ?? map.file
  );
}

/** Icon ids are plain slugs; anything else never reaches the filesystem. */
export const ICON_ID = /^[a-z0-9][a-z0-9_-]*$/;

export function fileIconUrl(id: string, version: string): string {
  return `/api/file/icons/svg/${id}?v=${encodeURIComponent(version)}`;
}

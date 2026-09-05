import type { BrowseEntry } from "../../lib/browse-types";

export type BrowserEntry = BrowseEntry;

export type BrowseView = "recent" | "deliverables" | "pinned" | "repository" | "folder";
export interface BrowseLocation {
  view: BrowseView;
  dir: string;
  file: string | null;
}
export type FileFilter = "all" | "dir" | "image" | "video" | "document" | "code";
export type BrowseSort = "name" | "date" | "type";

export function parentDirectory(path: string): string {
  return path.split("/").slice(0, -1).join("/");
}

export function readBrowseLocation(
  search: string,
  initialFile: string | null = null,
): BrowseLocation {
  const params = new URLSearchParams(search);
  const file = params.get("file") || initialFile;
  const dir = params.get("dir");
  const requested = params.get("view");
  const view: BrowseView =
    requested === "recent" ||
    requested === "deliverables" ||
    requested === "pinned" ||
    requested === "repository"
      ? requested
      : file || dir !== null
        ? "folder"
        : "recent";
  return { view, dir: dir ?? (file ? parentDirectory(file) : ""), file };
}

export function browseHref(current: string, location: BrowseLocation): string {
  const url = new URL(current, "http://localhost");
  for (const key of ["file", "dir", "view", "path"]) url.searchParams.delete(key);
  if (location.view === "folder") url.searchParams.set("dir", location.dir);
  else if (location.view !== "recent") url.searchParams.set("view", location.view);
  if (location.file) url.searchParams.set("file", location.file);
  return `${url.pathname}${url.search}${url.hash}`;
}

export function fileCategory(entry: Pick<BrowserEntry, "kind" | "name">): FileFilter {
  if (entry.kind === "dir") return "dir";
  const ext = entry.name.split(".").pop()?.toLowerCase() ?? "";
  if (["png", "jpg", "jpeg", "webp", "gif", "svg", "avif", "bmp"].includes(ext)) return "image";
  if (["mp4", "webm", "mov", "m4v"].includes(ext)) return "video";
  if (["md", "mdx", "txt", "pdf", "doc", "docx", "csv", "xlsx", "pptx", "html"].includes(ext))
    return "document";
  return "code";
}

export function displayName(entry: BrowserEntry): string {
  if (entry.title) return entry.title;
  if (entry.relPath.startsWith(".harnery/artifacts/") && entry.relPath.split("/").length === 3) {
    const readable = entry.name
      .replace(/^\d{4}-\d{2}-\d{2}_/, "")
      .replace(/_[a-f0-9]{8,}$/i, "")
      .replace(/[-_]+/g, " ");
    return readable.charAt(0).toUpperCase() + readable.slice(1);
  }
  return entry.name;
}

export function filterEntries(
  entries: BrowserEntry[],
  query: string,
  filter: FileFilter,
  sort: BrowseSort,
): BrowserEntry[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return entries
    .filter((entry) => {
      const text =
        `${displayName(entry)} ${entry.name} ${entry.relPath} ${entry.owner ?? ""} ${entry.purpose ?? ""}`.toLowerCase();
      return (
        words.every((word) => text.includes(word)) &&
        (filter === "all" || fileCategory(entry) === filter)
      );
    })
    .sort((left, right) => {
      if (left.kind !== right.kind) return left.kind === "dir" ? -1 : 1;
      if (sort === "date")
        return (
          (right.mtime ?? "").localeCompare(left.mtime ?? "") ||
          displayName(left).localeCompare(displayName(right))
        );
      if (sort === "type") {
        const category = fileCategory(left).localeCompare(fileCategory(right));
        if (category) return category;
      }
      return displayName(left).localeCompare(displayName(right), undefined, { numeric: true });
    });
}

export function inBrowseScope(path: string, roots: string[] | undefined): boolean {
  return !roots || roots.some((root) => path === root || path.startsWith(`${root}/`));
}

export function addRecent(paths: string[], path: string): string[] {
  return [path, ...paths.filter((candidate) => candidate !== path)].slice(0, 12);
}

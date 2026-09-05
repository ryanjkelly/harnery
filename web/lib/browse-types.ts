import type { DirEntry } from "./file-viewer/types";

export interface BrowseDeliveryItem {
  label: string;
  relPath: string;
  kind: "file" | "dir";
}

export interface BrowseEntry extends DirEntry {
  mtime?: string;
  title?: string;
  owner?: string;
  purpose?: string;
  deliveryItems?: BrowseDeliveryItem[];
}

export interface BrowseWorkspaces {
  entries: BrowseEntry[];
  partial: boolean;
}

export interface BrowseSearchResult {
  query: string;
  matches: { relPath: string; kind: "file" | "dir" }[];
  total: number;
  truncated: boolean;
  indexing?: boolean;
}

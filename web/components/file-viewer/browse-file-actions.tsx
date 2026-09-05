"use client";

import { Copy, Download, ExternalLink, Folder, FolderOpen, Pin, RefreshCw } from "lucide-react";
import { rawUrl, revealInFileManager } from "@/lib/file-viewer/client";
import {
  type BrowseLocation,
  type BrowserEntry,
  browseHref,
  parentDirectory,
} from "./browse-model";
import type { FileAction } from "./FileActionsMenu";

export function fileBrowseLink(entry: BrowserEntry, current: string): string {
  const url = new URL(current);
  url.searchParams.delete("q");
  url.searchParams.delete("search");
  return new URL(
    browseHref(url.href, {
      view: "folder",
      dir: entry.kind === "dir" ? entry.relPath : parentDirectory(entry.relPath),
      file: entry.kind === "dir" ? null : entry.relPath,
    }),
    url.origin,
  ).href;
}

export function browseFileActions(options: {
  entry: BrowserEntry;
  selectedPath: string | null;
  pins: string[];
  onOpen: (entry: BrowserEntry) => void;
  onNavigate: (location: BrowseLocation) => void;
  onPin: (path: string) => void;
  onRefresh: (path: string) => void;
  notify: (message: string) => void;
}): FileAction[] {
  const { entry, notify } = options;
  const folder = entry.kind === "dir" ? entry.relPath : parentDirectory(entry.relPath);
  const copy = async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value);
      notify(`${label} copied.`);
    } catch {
      notify(`Could not copy ${label.toLowerCase()}. Check clipboard permission.`);
    }
  };
  const actions: FileAction[] = [
    {
      id: "open",
      label:
        entry.kind === "dir"
          ? "Open folder"
          : options.selectedPath === entry.relPath && /\.(mp4|webm|mov|m4v)$/i.test(entry.name)
            ? "Pause video"
            : "Preview",
      icon: <FolderOpen className="size-4" />,
      onSelect: () => options.onOpen(entry),
    },
    {
      id: "tab",
      label: "Open in new tab",
      icon: <ExternalLink className="size-4" />,
      onSelect: () => {
        window.open(fileBrowseLink(entry, window.location.href), "_blank", "noopener,noreferrer");
      },
    },
  ];
  if (entry.kind === "file")
    actions.push(
      {
        id: "download",
        label: "Download",
        icon: <Download className="size-4" />,
        onSelect: () => {
          const link = document.createElement("a");
          link.href = rawUrl(entry.relPath, { download: entry.name });
          link.download = entry.name;
          document.body.append(link);
          link.click();
          link.remove();
        },
      },
      {
        id: "containing",
        label: "Show containing folder",
        icon: <Folder className="size-4" />,
        onSelect: () => options.onNavigate({ view: "folder", dir: folder, file: null }),
      },
      {
        id: "reveal",
        label: "Show in file manager",
        icon: <FolderOpen className="size-4" />,
        onSelect: () => {
          void revealInFileManager(entry.relPath).then((result) =>
            notify(
              result.ok
                ? "Folder open requested."
                : `Could not open folder: ${result.detail ?? result.code}`,
            ),
          );
        },
      },
    );
  actions.push(
    {
      id: "copy-path",
      label: "Copy path",
      icon: <Copy className="size-4" />,
      onSelect: () => {
        void copy(entry.relPath, "Path");
      },
    },
    {
      id: "copy-name",
      label: entry.kind === "dir" ? "Copy folder name" : "Copy filename",
      icon: <Copy className="size-4" />,
      onSelect: () => {
        void copy(entry.name, "Name");
      },
    },
    {
      id: "copy-link",
      label: "Copy link",
      icon: <Copy className="size-4" />,
      onSelect: () => {
        void copy(fileBrowseLink(entry, window.location.href), "Link");
      },
    },
    {
      id: "pin",
      label: options.pins.includes(folder)
        ? "Unpin folder"
        : entry.kind === "dir"
          ? "Pin folder"
          : "Pin containing folder",
      disabled: !folder,
      icon: <Pin className="size-4" />,
      onSelect: () => options.onPin(folder),
    },
    {
      id: "refresh",
      label: "Refresh",
      icon: <RefreshCw className="size-4" />,
      onSelect: () => options.onRefresh(entry.relPath),
    },
  );
  return actions;
}

/**
 * Extension → lucide glyph mapping for file rows in the tree + search palette.
 * Glyph-only differentiation (no per-type colour) to stay within the dashboard's
 * state-colour grammar (sky=act / emerald=done / …); type is conveyed by shape.
 * Falls back to a generic File for unknown extensions.
 */

import {
  File,
  FileArchive,
  FileAudio,
  FileCode,
  FileCog,
  FileImage,
  FileJson,
  FileSpreadsheet,
  FileTerminal,
  FileText,
  FileType,
  FileVideo,
  type LucideIcon,
} from "lucide-react";

const EXT_ICON: Record<string, LucideIcon> = {
  // shell scripts
  sh: FileTerminal,
  bash: FileTerminal,
  zsh: FileTerminal,
  fish: FileTerminal,
  // code
  ts: FileCode,
  tsx: FileCode,
  js: FileCode,
  jsx: FileCode,
  mjs: FileCode,
  cjs: FileCode,
  php: FileCode,
  py: FileCode,
  rb: FileCode,
  go: FileCode,
  rs: FileCode,
  c: FileCode,
  h: FileCode,
  cpp: FileCode,
  hpp: FileCode,
  java: FileCode,
  kt: FileCode,
  swift: FileCode,
  lua: FileCode,
  pl: FileCode,
  r: FileCode,
  vue: FileCode,
  svelte: FileCode,
  astro: FileCode,
  graphql: FileCode,
  proto: FileCode,
  sql: FileCode,
  css: FileCode,
  scss: FileCode,
  less: FileCode,
  html: FileCode,
  htm: FileCode,
  xml: FileCode,
  // structured data
  json: FileJson,
  jsonl: FileJson,
  ndjson: FileJson,
  jsonc: FileJson,
  // config-ish
  yaml: FileCog,
  yml: FileCog,
  toml: FileCog,
  ini: FileCog,
  conf: FileCog,
  env: FileCog,
  // tabular
  csv: FileSpreadsheet,
  tsv: FileSpreadsheet,
  // images
  png: FileImage,
  jpg: FileImage,
  jpeg: FileImage,
  gif: FileImage,
  webp: FileImage,
  bmp: FileImage,
  avif: FileImage,
  ico: FileImage,
  svg: FileImage,
  // docs
  md: FileText,
  mdx: FileText,
  markdown: FileText,
  txt: FileText,
  log: FileText,
  pdf: FileType,
  // media
  mp3: FileAudio,
  wav: FileAudio,
  ogg: FileAudio,
  m4a: FileAudio,
  flac: FileAudio,
  mp4: FileVideo,
  webm: FileVideo,
  mov: FileVideo,
  // archives
  zip: FileArchive,
  tar: FileArchive,
  tgz: FileArchive,
  gz: FileArchive,
};

/** Pick the lucide icon for a file by its name's extension. */
export function iconForFile(name: string): LucideIcon {
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  return EXT_ICON[ext] ?? File;
}

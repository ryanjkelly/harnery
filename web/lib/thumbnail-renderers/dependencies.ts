import { createHash } from "node:crypto";
import { closeSync, fstatSync, read, realpathSync, type Stats } from "node:fs";
import path from "node:path";
import { parseHTML } from "linkedom";
import { type FileCategory, resolveFile, scanChunk } from "../files";

export const THUMBNAIL_ORIGIN = "https://thumbnail.invalid";
const MAX_HTML_BYTES = 2 * 1024 * 1024;
const MAX_ASSET_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;
const MAX_ASSETS = 32;
interface DependencyProbe {
  relative: string;
  pathname: string;
  signature: string;
}
interface CachedGraph {
  key: string;
  allowedPaths: Set<string>;
  probes: DependencyProbe[];
  bytes: number;
}
const graphCache = new Map<string, CachedGraph>();
let graphCacheBytes = 0;
interface DependencyInput {
  fd: number;
  relPath: string;
  category: FileCategory;
}

function statSignature(stat: Stats): string {
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
}

function cachedGraphIsCurrent(graph: CachedGraph, root: string): boolean {
  for (const probe of graph.probes) {
    const file = resolveFile(probe.relative, { root });
    if (!file.ok) {
      if (`${probe.pathname}:${file.code}` !== probe.signature) return false;
      continue;
    }
    try {
      const signature = `${probe.pathname}:${file.relPath}:${statSignature(fstatSync(file.fd))}`;
      if (signature !== probe.signature) return false;
    } finally {
      closeSync(file.fd);
    }
  }
  return true;
}

function rememberGraph(cacheKey: string, graph: Omit<CachedGraph, "bytes">): void {
  const previous = graphCache.get(cacheKey);
  if (previous) {
    graphCacheBytes -= previous.bytes;
    graphCache.delete(cacheKey);
  }
  const bytes =
    2 *
    (cacheKey.length +
      graph.probes.reduce(
        (sum, probe) =>
          sum + probe.relative.length + probe.pathname.length + probe.signature.length,
        0,
      ) +
      [...graph.allowedPaths].reduce((sum, value) => sum + value.length, 0));
  if (bytes > 1024 * 1024) return;
  graphCache.set(cacheKey, { ...graph, bytes });
  graphCacheBytes += bytes;
  while (graphCache.size > 32 || graphCacheBytes > 1024 * 1024) {
    const oldest = graphCache.keys().next().value;
    if (oldest === undefined) break;
    graphCacheBytes -= graphCache.get(oldest)!.bytes;
    graphCache.delete(oldest);
  }
}

export function thumbnailDocumentUrl(relPath: string): string {
  return `${THUMBNAIL_ORIGIN}/${relPath.split("/").map(encodeURIComponent).join("/")}`;
}

async function readDescriptor(fd: number, limit: number): Promise<Buffer> {
  const bytes = Buffer.alloc(Math.min(fstatSync(fd).size, limit));
  let offset = 0;
  while (offset < bytes.length) {
    const count = await new Promise<number>((resolve, reject) =>
      read(fd, bytes, offset, bytes.length - offset, offset, (error, count) =>
        error ? reject(error) : resolve(count),
      ),
    );
    if (!count) break;
    offset += count;
  }
  return bytes.subarray(0, offset);
}

function cssReferences(css: string): string[] {
  // Decoding CSS escapes also recognizes escaped spellings of url/import.
  const decoded = css.replace(
    /\\([0-9a-f]{1,6})\s?|\\([^\r\n])/gi,
    (_match, hex: string | undefined, literal: string | undefined) =>
      hex ? String.fromCodePoint(Math.min(Number.parseInt(hex, 16), 0x10ffff)) : (literal ?? ""),
  );
  const references: string[] = [];
  for (const match of decoded.matchAll(
    /url\(\s*(?:"([^"]*)"|'([^']*)'|([^\s)]*))\s*\)|@import\s+(?:"([^"]*)"|'([^']*)')/gi,
  )) {
    references.push(match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5] ?? "");
  }
  return references;
}

function htmlReferences(html: string): string[] {
  const { document } = parseHTML(html);
  const references: string[] = [];
  for (const node of document.querySelectorAll("img,source,input,video,link,image,use")) {
    if (
      node.localName === "link" &&
      !/\b(stylesheet|preload|icon)\b/i.test(node.getAttribute("rel") ?? "")
    )
      continue;
    for (const name of ["src", "href", "xlink:href", "poster"]) {
      const value = node.getAttribute(name);
      if (value) references.push(value);
    }
    for (const candidate of (node.getAttribute("srcset") ?? "").split(",")) {
      const value = candidate.trim().split(/\s+/)[0];
      if (value) references.push(value);
    }
  }
  for (const node of document.querySelectorAll("style"))
    references.push(...cssReferences(node.textContent ?? ""));
  for (const node of document.querySelectorAll("[style]"))
    references.push(...cssReferences(node.getAttribute("style") ?? ""));
  return references;
}

function localUrl(reference: string, base: string): URL | undefined {
  if (!reference || reference.length > 8192 || reference.startsWith("#")) return undefined;
  try {
    const url = new URL(reference, base);
    if (url.origin !== THUMBNAIL_ORIGIN) return undefined;
    url.hash = "";
    url.search = "";
    return url;
  } catch {
    return undefined;
  }
}

/** The same graph controls cache invalidation and the browser's asset allowlist. */
export async function thumbnailDependencyGraph(
  input: DependencyInput,
  root: string,
): Promise<{ key: string; allowedPaths: Set<string> }> {
  const allowedPaths = new Set<string>();
  if (input.category !== "html") return { key: "", allowedPaths };
  const mainStat = fstatSync(input.fd);
  if (mainStat.size > MAX_HTML_BYTES) throw new Error("thumbnail_source_limit");
  const canonicalRoot = realpathSync(root);
  const cacheKey = `${canonicalRoot}\n${input.relPath}\n${statSignature(mainStat)}`;
  const cached = graphCache.get(cacheKey);
  if (cached && cachedGraphIsCurrent(cached, canonicalRoot)) {
    graphCache.delete(cacheKey);
    graphCache.set(cacheKey, cached);
    return { key: cached.key, allowedPaths: new Set(cached.allowedPaths) };
  }
  const bytes = await readDescriptor(input.fd, MAX_HTML_BYTES);
  if (scanChunk(bytes).secret) throw new Error("denied");
  const base = thumbnailDocumentUrl(input.relPath);
  const queue = htmlReferences(bytes.toString("utf8")).map((reference) => ({ reference, base }));
  const seen = new Set<string>();
  const signatures: string[] = ["html-dependencies-v1"];
  const probes: DependencyProbe[] = [];
  let totalBytes = 0;
  for (let index = 0; index < queue.length; index++) {
    const candidate = queue[index];
    const url = localUrl(candidate.reference, candidate.base);
    if (!url || seen.has(url.pathname)) continue;
    if (seen.size >= MAX_ASSETS) {
      signatures.push("asset-count-limit");
      break;
    }
    seen.add(url.pathname);
    let relative: string;
    try {
      relative = decodeURIComponent(url.pathname.slice(1));
    } catch {
      signatures.push(`${url.pathname}:invalid_path`);
      continue;
    }
    const file = resolveFile(relative, { root: canonicalRoot });
    if (!file.ok) {
      const signature = `${url.pathname}:${file.code}`;
      signatures.push(signature);
      probes.push({ relative, pathname: url.pathname, signature });
      continue;
    }
    try {
      const stat = fstatSync(file.fd);
      const signature = `${url.pathname}:${file.relPath}:${statSignature(stat)}`;
      signatures.push(signature);
      probes.push({ relative, pathname: url.pathname, signature });
      if (file.size > MAX_ASSET_BYTES || totalBytes + file.size > MAX_TOTAL_BYTES) {
        signatures.push(`${url.pathname}:asset-size-limit`);
        continue;
      }
      totalBytes += file.size;
      allowedPaths.add(url.pathname);
      if (path.extname(file.relPath).toLowerCase() === ".css") {
        const css = await readDescriptor(file.fd, MAX_ASSET_BYTES);
        if (scanChunk(css).secret) {
          allowedPaths.delete(url.pathname);
          signatures.push(`${url.pathname}:denied`);
          continue;
        }
        for (const reference of cssReferences(css.toString("utf8")))
          queue.push({ reference, base: url.href });
      }
    } finally {
      closeSync(file.fd);
    }
  }
  const key = createHash("sha256").update(signatures.join("\n")).digest("hex");
  rememberGraph(cacheKey, { key, allowedPaths, probes });
  return { key, allowedPaths: new Set(allowedPaths) };
}

export async function thumbnailDependencyKey(
  input: DependencyInput,
  root: string,
): Promise<string> {
  return (await thumbnailDependencyGraph(input, root)).key;
}

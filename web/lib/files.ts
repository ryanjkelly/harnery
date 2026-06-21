/**
 * Resolution + security layer for the universal file viewer.
 *
 * !! NORMATIVE ORDER !!
 * The pipeline below is an ORDERED, fail-closed sequence ratified by council.
 * The step order IS the security property and TypeScript will not enforce it,
 * so do not reorder, merge, or short-circuit steps. In particular:
 *
 *   0. canonicalize input (reject residual %XX / NUL / control / `\` / `~`; NFC)
 *   2. `..`-segment pre-filter
 *   2.5 LEXICAL containment + denylist pre-check, no filesystem access. Closes
 *      the 403-vs-404 existence oracle inside denied trees: a lexically-denied
 *      path rejects `denied` whether or not the file exists (review note,
 *      2026-06-11; additive hardening). Runs BEFORE classification
 *      so denied names can't leak first-segment existence via
 *      ambiguous_path-vs-denied.
 *   1. classify input form (absolute, or repo-relative with known first segment;
 *      anything ambiguous → reject, never stat-probe, that's an existence oracle)
 *   3. containment via realpath against the memoized realpath'd root
 *   3.5 check-time stat: {dev, ino} captured for the macOS fd re-verify
 *   4. canonical relPath = path.relative(ROOT, real), the only value later
 *      layers match and the only path ever echoed back to callers
 *   5. secret denylist (two-tier floor + additive host config) + allow-override
 *      (soft-tier denies only)
 *   6. category assignment by extension (positive render allowlist is by
 *      category, not by root)
 *   7. open with O_NOFOLLOW | O_NONBLOCK, then fstat is-regular-file gate
 *      IMMEDIATELY, before any read (a FIFO would have hung at open without
 *      O_NONBLOCK; a directory fd throws the moment you read it)
 *   8. fd re-verify. Linux: realpath('/proc/self/fd/N') must equal the
 *      canonical path (derives from the FD, never re-traverses the request
 *      path); all platforms: {dev, ino} must match the check-time stat
 *   9. magic-byte scan on the first 4 KB READ FROM THE FD (binary sniff →
 *      download-only; secret signatures → refuse entirely)
 *  10. size guard / category finalize
 *
 * resolveFile returns an OPEN FILE DESCRIPTOR, not a path string (TOCTOU).
 * Every read the routes perform (magic scan already done here, body,
 * Range 206 chunks) must come from this fd; a re-open by path is a fresh race
 * window and is the vulnerability this module exists to close.
 */

import {
  closeSync,
  existsSync,
  constants as fsConstants,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { coordRoot } from "./coord-reader";

// ---------------------------------------------------------------------------
// Categories + extension map
// ---------------------------------------------------------------------------

export type FileCategory =
  | "markdown"
  | "code"
  | "json"
  | "yaml"
  | "html"
  | "csv"
  | "image"
  | "svg"
  | "pdf"
  | "audio"
  | "video"
  | "archive"
  | "text"
  | "binary";

/** Categories whose bytes are text: these get the binary sniff + secret-signature
 * scan and are eligible for the /api/file/text endpoint. */
const TEXT_CATEGORIES: ReadonlySet<FileCategory> = new Set([
  "markdown",
  "code",
  "json",
  "yaml",
  "html",
  "csv",
  "text",
]);

const EXT_TO_CATEGORY: Record<string, FileCategory> = {
  // markdown
  md: "markdown",
  mdx: "markdown",
  markdown: "markdown",
  // code
  ts: "code",
  tsx: "code",
  js: "code",
  jsx: "code",
  mjs: "code",
  cjs: "code",
  php: "code",
  py: "code",
  sql: "code",
  sh: "code",
  bash: "code",
  zsh: "code",
  rb: "code",
  go: "code",
  rs: "code",
  css: "code",
  scss: "code",
  less: "code",
  toml: "code",
  ini: "code",
  c: "code",
  h: "code",
  cpp: "code",
  hpp: "code",
  java: "code",
  kt: "code",
  swift: "code",
  lua: "code",
  pl: "code",
  r: "code",
  vue: "code",
  svelte: "code",
  astro: "code",
  graphql: "code",
  proto: "code",
  // json
  json: "json",
  jsonl: "json",
  ndjson: "json",
  jsonc: "json",
  // yaml
  yaml: "yaml",
  yml: "yaml",
  // html / xml (source view; never served navigable)
  html: "html",
  htm: "html",
  xml: "html",
  // csv
  csv: "csv",
  tsv: "csv",
  // image
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  bmp: "image",
  avif: "image",
  ico: "image",
  // svg (own category: `<img>` preview + source toggle, never inline DOM)
  svg: "svg",
  // pdf
  pdf: "pdf",
  // audio
  mp3: "audio",
  wav: "audio",
  ogg: "audio",
  m4a: "audio",
  flac: "audio",
  // video
  mp4: "video",
  webm: "video",
  mov: "video",
  // archive
  zip: "archive",
  tar: "archive",
  tgz: "archive",
  gz: "archive",
  // text / log
  txt: "text",
  log: "text",
  conf: "text",
  lock: "text",
};

/** MIME by category. Text-family categories are served as text/plain so a repo
 * HTML/JS file can never become a same-origin navigable document; the
 * HTML preview path builds its own sandboxed-iframe blob client-side. */
function mimeFor(category: FileCategory, ext: string): string {
  switch (category) {
    case "json":
      return "application/json; charset=utf-8";
    case "image":
      return (
        {
          png: "image/png",
          jpg: "image/jpeg",
          jpeg: "image/jpeg",
          gif: "image/gif",
          webp: "image/webp",
          bmp: "image/bmp",
          avif: "image/avif",
          ico: "image/x-icon",
        }[ext] ?? "application/octet-stream"
      );
    case "svg":
      return "image/svg+xml";
    case "pdf":
      return "application/pdf";
    case "audio":
      return (
        {
          mp3: "audio/mpeg",
          wav: "audio/wav",
          ogg: "audio/ogg",
          m4a: "audio/mp4",
          flac: "audio/flac",
        }[ext] ?? "application/octet-stream"
      );
    case "video":
      return (
        { mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime" }[ext] ??
        "application/octet-stream"
      );
    case "archive":
    case "binary":
      return "application/octet-stream";
    default:
      // markdown / code / yaml / html / csv / text: never navigable.
      return "text/plain; charset=utf-8";
  }
}

// ---------------------------------------------------------------------------
// Size caps
// ---------------------------------------------------------------------------

/** Text-family files larger than this are not inlineable: the viewer shows the
 * too-large card and the /text endpoint serves a capped preview. */
export const TEXT_INLINE_CAP_BYTES = 5 * 1024 * 1024;
/** Hard caps for the /api/file/text endpoint so a 200 MB log can't OOM the tab
 * (or the server, since we never read more than this into memory). */
export const TEXT_ENDPOINT_MAX_BYTES = 2 * 1024 * 1024;
export const TEXT_ENDPOINT_MAX_LINES = 5_000;

// ---------------------------------------------------------------------------
// Deny glob matcher
// ---------------------------------------------------------------------------
//
// Narrow, hand-rolled glob dialect: every pattern is `**/`-anchored and the
// segment pattern supports only `*` and one level of `{a,b}` alternation.
// Matching is case-insensitive with trailing dots/spaces stripped per segment
// (Windows-style smuggling), `{ dot: true }` semantics (dotfiles match `*`).
//
// DELIBERATE WIDENING over minimatch: `**/X` matches when ANY segment matches
// X (minimatch: last segment only). This is strictly more denials, never fewer:
// a directory literally named `.env/` or `secrets.json/` has its contents
// denied too. Allow-overrides match the LAST segment only (rescue is narrow
// where deny is wide; fail-closed in both directions).

interface CompiledGlob {
  source: string;
  // "any" = any segment may match (from a `**/X` pattern); "non-last" = any
  // segment except the final one (from a `**/X/**` pattern).
  scope: "any" | "non-last";
  re: RegExp;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Compile one segment pattern (`*` wildcards + `{a,b}` alternation) to a
 * case-insensitive anchored RegExp. Throws on unsupported syntax. */
function compileSegment(seg: string): RegExp {
  if (seg.length === 0) throw new Error("empty segment");
  let out = "";
  let i = 0;
  while (i < seg.length) {
    const ch = seg[i];
    if (ch === "*") {
      out += "[^/]*";
      i++;
    } else if (ch === "{") {
      const close = seg.indexOf("}", i);
      if (close < 0) throw new Error(`unclosed brace in segment: ${seg}`);
      const body = seg.slice(i + 1, close);
      if (body.includes("{")) throw new Error(`nested braces unsupported: ${seg}`);
      const alts = body.split(",").map((a) => {
        if (a.includes("*")) throw new Error(`wildcards inside braces unsupported: ${seg}`);
        return escapeRegex(a);
      });
      out += `(?:${alts.join("|")})`;
      i = close + 1;
    } else if (ch === "}" || ch === "[" || ch === "]" || ch === "?" || ch === "/") {
      // `?` single-char and `[...]` classes are NOT part of this dialect:
      // reject rather than silently treating them as literals a config author
      // believed were wildcards.
      throw new Error(`unsupported glob syntax '${ch}' in segment: ${seg}`);
    } else {
      out += escapeRegex(ch);
      i++;
    }
  }
  return new RegExp(`^${out}$`, "i");
}

// Compile a `**/`-anchored deny/override glob. Accepted shapes (only):
// `**/SEG` and `**/SEG/**`. Throws on anything else; the caller decides
// whether a compile failure is fatal (deny patterns) or droppable (overrides).
export function compileGlob(pattern: string): CompiledGlob {
  if (!pattern.startsWith("**/")) {
    throw new Error(`pattern must be \`**/\`-anchored: ${pattern}`);
  }
  const rest = pattern.slice(3);
  if (rest.endsWith("/**")) {
    const seg = rest.slice(0, -3);
    if (seg.includes("/")) throw new Error(`only **/SEG and **/SEG/** supported: ${pattern}`);
    return { source: pattern, scope: "non-last", re: compileSegment(seg) };
  }
  if (rest.includes("/")) throw new Error(`only **/SEG and **/SEG/** supported: ${pattern}`);
  return { source: pattern, scope: "any", re: compileSegment(rest) };
}

/** Normalize relPath segments for deny matching: strip trailing dots/spaces
 * (Windows-style equivalence smuggling); case-folding lives in the regex. */
function matchSegments(relPath: string): string[] {
  return relPath.split("/").map((s) => s.replace(/[. ]+$/, ""));
}

function globMatches(g: CompiledGlob, segments: string[]): boolean {
  const limit = g.scope === "non-last" ? segments.length - 1 : segments.length;
  for (let i = 0; i < limit; i++) {
    if (g.re.test(segments[i])) return true;
  }
  return false;
}

/** Overrides rescue narrowly: the LAST segment only. */
function overrideMatches(g: CompiledGlob, segments: string[]): boolean {
  if (g.scope !== "any") return false;
  return segments.length > 0 && g.re.test(segments[segments.length - 1]);
}

// ---------------------------------------------------------------------------
// The denylist floor: baked-in, non-removable. Host config
// (`files.deny_globs`) is ADDITIVE ONLY; it can extend this floor, never
// shrink it. Tiering: hard = secret families, never overridable; soft =
// deliberately over-broad nets, rescuable via allow-overrides.
// ---------------------------------------------------------------------------

const HARD_DENY_PATTERNS: readonly string[] = [
  "**/.credentials",
  "**/.credentials/**",
  "**/*.{pem,key,ppk,p8,p12,pfx,crt,cer,jks,keystore,kdbx,asc,gpg}",
  "**/id_rsa*",
  "**/id_ed25519*",
  "**/id_ecdsa*",
  "**/*service-account*.json",
  "**/gcp-sa-key.json",
  "**/*-token.json",
  "**/*oauth*client*.json",
  "**/client_secret*.json",
  "**/.git-credentials",
  "**/.git",
  "**/.git/**",
  "**/.npmrc",
  "**/.netrc",
  "**/.pgpass",
  "**/.htpasswd",
  "**/.aws/**",
  "**/.ssh/**",
  "**/.gnupg/**",
  "**/*.tfstate*",
];

const SOFT_DENY_PATTERNS: readonly string[] = [
  "**/.env",
  "**/.env.*",
  "**/*.env",
  "**/*secret*.json",
  "**/node_modules/**",
];

/** Shipped allow-overrides: readmit public scaffolding caught by the soft
 * `.env` nets. Host config (`files.allow_overrides`) extends this list, but an
 * override is consulted ONLY when every matching deny is soft-tier. */
const FLOOR_ALLOW_OVERRIDES: readonly string[] = [
  "**/.env.example",
  "**/.env.sample",
  "**/.env.template",
];

/** Representative paths for each hard family. A config allow-override that
 * matches ANY of these is loudly dropped at config load; glob-vs-glob
 * intersection is undecidable, so this canary check is best-effort and the
 * runtime tiering above is the real enforcement (council round 3). */
const HARD_FAMILY_CANARIES: readonly string[] = [
  "x/.credentials/acme.env",
  "x/.credentials",
  "x/server.pem",
  "x/private.key",
  "x/.ssh/id_rsa",
  "x/id_rsa",
  "x/id_ed25519",
  "x/.aws/credentials",
  "x/.gnupg/secring.gpg",
  "x/gcp-sa-key.json",
  "x/my-service-account.json",
  "x/refresh-token.json",
  "x/oauth_client_secret.json",
  "x/client_secret_123.apps.googleusercontent.com.json",
  "x/.git/config",
  "x/.git",
  "x/.git-credentials",
  "x/.npmrc",
  "x/.netrc",
  "x/.pgpass",
  "x/.htpasswd",
  "x/prod.tfstate",
  "x/keys.keystore",
];

const compiledHardFloor = HARD_DENY_PATTERNS.map(compileGlob);
const compiledSoftFloor = SOFT_DENY_PATTERNS.map(compileGlob);
const compiledFloorOverrides = FLOOR_ALLOW_OVERRIDES.map(compileGlob);

// ---------------------------------------------------------------------------
// Host config (`.harnery/config.jsonc` → `files` section)
// ---------------------------------------------------------------------------

export interface FilesConfig {
  /** Additive deny patterns from host config (all treated as HARD, since an
   * operator-added deny is an explicit decision, not an over-broad net). */
  extraDeny: CompiledGlob[];
  /** Additive allow-overrides from host config (soft-tier rescues only). */
  extraOverrides: CompiledGlob[];
  /** Overrides dropped at load (named a hard family / failed to compile). */
  droppedOverrides: { pattern: string; reason: string }[];
}

export class FilesConfigError extends Error {}

/** Strip // and /* *​/ comments from JSONC without corrupting string bodies. */
export function stripJsonComments(input: string): string {
  let out = "";
  let i = 0;
  let inString = false;
  while (i < input.length) {
    const ch = input[i];
    if (inString) {
      out += ch;
      if (ch === "\\" && i + 1 < input.length) {
        out += input[i + 1];
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      i++;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      i++;
      continue;
    }
    if (ch === "/" && input[i + 1] === "/") {
      while (i < input.length && input[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && input[i + 1] === "*") {
      i += 2;
      while (i < input.length && !(input[i] === "*" && input[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * Parse the `files` section out of `<root>/.harnery/config.jsonc`.
 *
 * Failure semantics are asymmetric on purpose:
 *  - missing file → floor defaults (fine);
 *  - unparseable file, or a DENY pattern that fails to compile → throws
 *    FilesConfigError. Dropping an operator's deny would be fail-OPEN for
 *    whatever it was meant to deny, so the whole resolver refuses to serve
 *    until the config is fixed;
 *  - an OVERRIDE that fails to compile or names a hard family → dropped
 *    (fail-closed: the deny stands) and recorded in droppedOverrides.
 */
export function loadFilesConfig(root: string): FilesConfig {
  const cfg: FilesConfig = { extraDeny: [], extraOverrides: [], droppedOverrides: [] };
  const p = path.join(root, ".harnery", "config.jsonc");
  let raw: string;
  try {
    raw = readFileSync(p, "utf-8");
  } catch {
    return cfg; // no config file → floor defaults
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonComments(raw));
  } catch (err) {
    throw new FilesConfigError(`config.jsonc is unparseable: ${(err as Error).message}`);
  }
  const files = (parsed as { files?: Record<string, unknown> } | null)?.files;
  if (!files || typeof files !== "object") return cfg;

  const denyRaw = files.deny_globs;
  if (denyRaw !== undefined) {
    if (!Array.isArray(denyRaw) || denyRaw.some((d) => typeof d !== "string")) {
      throw new FilesConfigError("files.deny_globs must be an array of strings");
    }
    for (const d of denyRaw as string[]) {
      try {
        cfg.extraDeny.push(compileGlob(d));
      } catch (err) {
        // A deny that doesn't compile is fail-open if dropped, so refuse to serve.
        throw new FilesConfigError(`files.deny_globs entry invalid: ${(err as Error).message}`);
      }
    }
  }

  const overridesRaw = files.allow_overrides;
  if (overridesRaw !== undefined) {
    if (!Array.isArray(overridesRaw) || overridesRaw.some((d) => typeof d !== "string")) {
      throw new FilesConfigError("files.allow_overrides must be an array of strings");
    }
    for (const o of overridesRaw as string[]) {
      let compiled: CompiledGlob;
      try {
        compiled = compileGlob(o);
      } catch (err) {
        cfg.droppedOverrides.push({ pattern: o, reason: (err as Error).message });
        continue;
      }
      // Intent detection is deliberately WIDE (deny-style matching): an
      // override like `**/.credentials/**` or an over-broad `**/*.json` must
      // be caught here even though runtime override matching is last-segment
      // narrow: the runtime tiering is the real enforcement, this check is
      // the loud early warning (council round 3).
      const hitCanary = HARD_FAMILY_CANARIES.find((c) => globMatches(compiled, matchSegments(c)));
      if (hitCanary) {
        cfg.droppedOverrides.push({
          pattern: o,
          reason: `names a hard secret family (matches canary ${hitCanary}); hard denies are never overridable`,
        });
        continue;
      }
      cfg.extraOverrides.push(compiled);
    }
  }
  for (const d of cfg.droppedOverrides) {
    console.error(`[files] DROPPED allow-override "${d.pattern}": ${d.reason}`);
  }
  return cfg;
}

/** mtime-keyed per-process config cache (config.jsonc is read per resolve
 * otherwise; a stat is cheap, a parse is not). */
let configCache: { root: string; mtimeMs: number; cfg: FilesConfig } | null = null;

function filesConfig(root: string): FilesConfig {
  const p = path.join(root, ".harnery", "config.jsonc");
  let mtimeMs = -1;
  try {
    mtimeMs = statSync(p).mtimeMs;
  } catch {
    // missing config → mtime stays -1, cached empty config is fine
  }
  if (configCache && configCache.root === root && configCache.mtimeMs === mtimeMs) {
    return configCache.cfg;
  }
  const cfg = loadFilesConfig(root); // may throw FilesConfigError; callers map to config_error
  configCache = { root, mtimeMs, cfg };
  return cfg;
}

// ---------------------------------------------------------------------------
// Deny evaluation
// ---------------------------------------------------------------------------

export type DenyVerdict =
  | { denied: false }
  | { denied: true; pattern: string; tier: "hard" | "soft" };

/** Exported for the test matrix + fuzz invariants; production callers go
 * through resolveFile only. */
export function evaluateDeny(relPath: string, cfg: FilesConfig): DenyVerdict {
  const segments = matchSegments(relPath);
  // Hard tier first, never overridable.
  for (const g of compiledHardFloor) {
    if (globMatches(g, segments)) return { denied: true, pattern: g.source, tier: "hard" };
  }
  // Operator-added denies are explicit decisions → hard.
  for (const g of cfg.extraDeny) {
    if (globMatches(g, segments)) return { denied: true, pattern: g.source, tier: "hard" };
  }
  // Soft tier, rescuable by allow-overrides.
  for (const g of compiledSoftFloor) {
    if (globMatches(g, segments)) {
      for (const o of [...compiledFloorOverrides, ...cfg.extraOverrides]) {
        if (overrideMatches(o, segments)) return { denied: false };
      }
      return { denied: true, pattern: g.source, tier: "soft" };
    }
  }
  return { denied: false };
}

// ---------------------------------------------------------------------------
// Magic-byte scan
// ---------------------------------------------------------------------------

/** Token-shaped secret signatures. The token-signature list (`-----BEGIN`, `PRIVATE KEY`,
 * `AKIA`, `sk-`, `ghp_`, `xoxb-`, `AIza`) is implemented as bounded token
 * patterns rather than bare substrings: bare `sk-` matches "task-list" and
 * would block half the repo's prose; the token forms keep every true positive
 * (real keys always carry their tails) while killing the absurd FPs. */
const SECRET_SIGNATURES: readonly RegExp[] = [
  /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY( BLOCK)?-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bsk-[A-Za-z0-9_-]{20,}/,
  /\bghp_[A-Za-z0-9]{30,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{30,}\b/,
  /\bxox[bpoas]-[0-9A-Za-z-]{10,}/,
  /\bAIza[0-9A-Za-z_-]{30,}/,
];

export function scanChunk(buf: Buffer): { binary: boolean; secret: boolean } {
  let suspicious = 0;
  let binary = false;
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    if (b === 0) {
      binary = true;
      break;
    }
    // C0 controls except \t \n \r \f; bytes ≥ 0x80 are fine (UTF-8).
    if (b < 32 && b !== 9 && b !== 10 && b !== 13 && b !== 12) suspicious++;
  }
  if (!binary && buf.length > 0 && suspicious / buf.length > 0.1) binary = true;
  if (binary) return { binary, secret: false };
  const text = buf.toString("utf-8");
  return { binary: false, secret: SECRET_SIGNATURES.some((re) => re.test(text)) };
}

// ---------------------------------------------------------------------------
// Root resolution
// ---------------------------------------------------------------------------

/** ROOT = realpathSync(coordRoot()), memoized once. coordRoot() itself returns
 * the raw env/cwd string and is never realpath'd; under a symlinked root that
 * breaks anchored containment ([PROVEN]), so we canonicalize here. */
let cachedRealRoot: string | null = null;

function realRoot(): string {
  if (cachedRealRoot) return cachedRealRoot;
  cachedRealRoot = realpathSync(coordRoot());
  return cachedRealRoot;
}

const PROC_FD_AVAILABLE = existsSync("/proc/self/fd");

// ---------------------------------------------------------------------------
// resolveFile
// ---------------------------------------------------------------------------

export type RejectCode =
  | "invalid_path"
  | "ambiguous_path"
  | "unresolvable"
  | "not_found"
  | "not_file"
  | "denied"
  | "secret_signature"
  | "config_error";

export interface ResolveReject {
  ok: false;
  code: RejectCode;
  /** HTTP status the routes should map this to. */
  status: 400 | 403 | 404 | 500;
  detail?: string;
}

export interface ResolvedFile {
  ok: true;
  /** OPEN read-only fd: caller owns it and MUST close it (or hand it to a
   * stream with autoClose). Every byte served must come from this fd. */
  fd: number;
  relPath: string;
  size: number;
  mtimeMs: number;
  mime: string;
  category: FileCategory;
  /** True for text-family files small enough to inline-render (too-large card otherwise). */
  inlineable: boolean;
}

export type ResolveResult = ResolvedFile | ResolveReject;

function reject(code: RejectCode, status: ResolveReject["status"], detail?: string): ResolveReject {
  return { ok: false, code, status, detail };
}

/** Test-only seam: lets the TOCTOU tests deterministically mutate the
 * filesystem at the exact race points (check≠serve inode race matrix: route-
 * layer no-reopen). Never set outside tests; zero cost when null. */
export interface ResolveTestHooks {
  afterRealpath?: (canonical: string) => void;
  /** Fires between the check-time stat and the open: the window the
   * {dev, ino} re-verify exists for (the only catcher on macOS, where
   * /proc/self/fd is unavailable). */
  afterCheckStat?: (canonical: string) => void;
  afterOpen?: (fd: number, canonical: string) => void;
}
let testHooks: ResolveTestHooks | null = null;
export function __setResolveTestHooks(hooks: ResolveTestHooks | null): void {
  testHooks = hooks;
}

export interface ResolveOptions {
  /** Override the containment root (tests use temp dirs). Defaults to
   * realpath(coordRoot()). */
  root?: string;
}

/**
 * Resolve a user-supplied path reference to an open fd + metadata, or a
 * fail-closed rejection. See the normative-order comment at the top of this
 * file; do not reorder steps.
 */
export function resolveFile(rawInput: string, opts: ResolveOptions = {}): ResolveResult {
  let ROOT: string;
  try {
    ROOT = opts.root ? realpathSync(opts.root) : realRoot();
  } catch (err) {
    return reject("config_error", 500, `root unresolvable: ${(err as Error).message}`);
  }

  // -- Step 0: canonicalize input -------------------------------------------
  if (typeof rawInput !== "string" || rawInput.length === 0) {
    return reject("invalid_path", 400, "empty path");
  }
  if (rawInput.length > 4096) return reject("invalid_path", 400, "path too long");
  // URLSearchParams already decoded exactly once; residual %XX means the
  // caller double-encoded (the `%252e` → `..` laundering shape). Reject.
  if (/%[0-9A-Fa-f]{2}/.test(rawInput)) {
    return reject("invalid_path", 400, "residual percent-encoding");
  }
  // NUL / control bytes: a swallowed realpath throw must never fall through.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control-byte rejection is the point
  if (/[\u0000-\u001f\u007f]/.test(rawInput)) {
    return reject("invalid_path", 400, "control bytes in path");
  }
  if (rawInput.includes("\\")) return reject("invalid_path", 400, "backslash in path");
  if (rawInput.startsWith("~")) return reject("invalid_path", 400, "~-forms are not accepted");
  const input = rawInput.normalize("NFC");

  // -- Step 2: `..`-segment pre-filter (cheap, before everything else) -------
  const inputSegments = input.split("/");
  if (inputSegments.includes("..")) return reject("invalid_path", 400, "`..` segment");

  // -- Step 2.5 (runs BEFORE classification): lexical containment + denylist
  // pre-check, no filesystem access. Closes the 403-vs-404 existence oracle:
  // a lexically-denied path rejects `denied` whether or not the file exists,
  // and an outside-root path rejects `unresolvable` without ever touching the
  // filesystem. This must precede the readdir-based classification below;
  // otherwise `.credentials/x` answers `ambiguous_path` when no top-level
  // `.credentials` exists and `denied` when one does, which is itself an
  // existence oracle on top-level secret dirs (caught by the Phase-0 suite).
  const lexAbs = path.resolve(ROOT, input);
  const lexRel = path.relative(ROOT, lexAbs);
  if (lexRel === "") return reject("invalid_path", 400, "path resolves to the root itself");
  if (lexRel.startsWith("..") || path.isAbsolute(lexRel)) {
    return reject("unresolvable", 400, "path is outside the repo root");
  }
  let cfg: FilesConfig;
  try {
    cfg = filesConfig(ROOT);
  } catch (err) {
    return reject("config_error", 500, (err as Error).message);
  }
  const lexVerdict = evaluateDeny(lexRel, cfg);
  if (lexVerdict.denied) {
    return reject("denied", 403, `blocked by policy (${lexVerdict.pattern})`);
  }

  // -- Step 1: classify input form -------------------------------------------
  const isAbsolute = path.isAbsolute(input);
  if (!isAbsolute) {
    // Repo-relative: first segment must be a known top-level child of ROOT.
    // Never guess a prefix, never stat-probe per submodule (existence oracle):
    // one readdir of OUR OWN root is the entire check.
    const first = inputSegments.find((s) => s !== "." && s !== "");
    if (!first) return reject("invalid_path", 400, "no path segments");
    let topLevel: Set<string>;
    try {
      topLevel = new Set(readdirSync(ROOT));
    } catch (err) {
      return reject("config_error", 500, `root unreadable: ${(err as Error).message}`);
    }
    if (!topLevel.has(first)) {
      return reject(
        "ambiguous_path",
        400,
        `first segment "${first}" is not a top-level child of the repo root`,
      );
    }
  }

  // -- Step 3: containment via realpath --------------------------------------
  let real: string;
  try {
    real = realpathSync(lexAbs);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return reject("not_found", 404);
    if (code === "EACCES" || code === "EPERM") return reject("denied", 403, "permission denied");
    return reject("unresolvable", 400, `realpath failed: ${code}`);
  }
  testHooks?.afterRealpath?.(real);
  const relFromRoot = path.relative(ROOT, real);
  if (relFromRoot === "" || relFromRoot.startsWith("..") || path.isAbsolute(relFromRoot)) {
    return reject("unresolvable", 400, "canonical path is outside the repo root");
  }

  // -- Step 4: canonical relPath, the only value later layers match ----------
  const relPath = relFromRoot.split(path.sep).join("/");

  // -- Step 3.5: check-time stat ({dev, ino} for the fd re-verify) -----------
  let checkStat: ReturnType<typeof statSync>;
  try {
    checkStat = statSync(real);
  } catch {
    return reject("not_found", 404);
  }
  testHooks?.afterCheckStat?.(real);

  // -- Step 5: secret denylist on the canonical relPath ----------------------
  const verdict = evaluateDeny(relPath, cfg);
  if (verdict.denied) {
    return reject("denied", 403, `blocked by policy (${verdict.pattern})`);
  }

  // -- Step 6: category by extension (positive allowlist is by category) -----
  const base = path.posix.basename(relPath);
  const dot = base.lastIndexOf(".");
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
  let category: FileCategory | undefined = EXT_TO_CATEGORY[ext];

  // -- Step 7: open O_NOFOLLOW | O_NONBLOCK, is-regular-file gate ------------
  // O_NOFOLLOW: realpath left no symlinks, so a symlink at the final component
  // now means a swap inside the race window (fail). O_NONBLOCK: openSync on a
  // FIFO with no writer otherwise BLOCKS at open (unauth DoS on the single
  // Next server).
  let fd: number;
  try {
    fd = openSync(real, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ELOOP" || code === "EMLINK") {
      return reject("denied", 403, "final component changed to a symlink (race detected)");
    }
    if (code === "ENOENT" || code === "ENOTDIR") return reject("not_found", 404);
    if (code === "EACCES" || code === "EPERM") return reject("denied", 403, "permission denied");
    return reject("unresolvable", 400, `open failed: ${code}`);
  }

  try {
    testHooks?.afterOpen?.(fd, real);

    // Is-regular-file IMMEDIATELY after open, before any read: a directory fd
    // throws EISDIR the moment you read it,
    // a FIFO would have hung at open without O_NONBLOCK; block dirs, FIFOs,
    // sockets, device files here.
    const fstat = fstatSync(fd);
    if (!fstat.isFile()) {
      return closeAndReject(fd, reject("not_file", 404, "not a regular file"));
    }

    // -- Step 8: fd re-verify: derives from the FD, never the request path ---
    // Re-running realpath(originalPath) would validate whatever inode the path
    // points at NOW while the fd is pinned to what we opened; you'd validate
    // inode B and serve inode A.
    if (fstat.dev !== checkStat.dev || fstat.ino !== checkStat.ino) {
      return closeAndReject(fd, reject("denied", 403, "inode changed between check and open"));
    }
    if (PROC_FD_AVAILABLE) {
      let fdPath: string;
      try {
        fdPath = realpathSync(`/proc/self/fd/${fd}`);
      } catch {
        return closeAndReject(fd, reject("denied", 403, "fd re-verify failed"));
      }
      if (fdPath !== real) {
        return closeAndReject(
          fd,
          reject("denied", 403, "fd resolves outside the validated path (race detected)"),
        );
      }
    }

    // -- Step 9: magic-byte scan on the first 4 KB, read from the fd ---------
    const head = Buffer.alloc(Math.min(4096, fstat.size));
    if (head.length > 0) {
      let got = 0;
      while (got < head.length) {
        const n = readSync(fd, head, got, head.length - got, got);
        if (n === 0) break;
        got += n;
      }
    }
    const sniff = scanChunk(head);
    if (category === undefined) {
      category = sniff.binary ? "binary" : "text";
    } else if (TEXT_CATEGORIES.has(category) && sniff.binary) {
      // Extension lied: bytes are binary. Download-only, never inline.
      category = "binary";
    }
    if (TEXT_CATEGORIES.has(category) && sniff.secret) {
      return closeAndReject(
        fd,
        reject("secret_signature", 403, "content carries a secret-shaped signature"),
      );
    }

    // -- Step 10: size guard / finalize ---------------------------------------
    const inlineable = TEXT_CATEGORIES.has(category)
      ? fstat.size <= TEXT_INLINE_CAP_BYTES
      : category !== "binary" && category !== "archive";

    return {
      ok: true,
      fd,
      relPath,
      size: fstat.size,
      mtimeMs: fstat.mtimeMs,
      mime: mimeFor(category, ext),
      category,
      inlineable,
    };
  } catch (err) {
    // Any unexpected throw after open: never leak the fd, never fall through open.
    return closeAndReject(fd, reject("unresolvable", 400, (err as Error).message));
  }
}

function closeAndReject(fd: number, r: ResolveReject): ResolveReject {
  try {
    closeSync(fd);
  } catch {
    // already closed, nothing to do
  }
  return r;
}

/** Reset module caches (tests only; config + root are memoized per process). */
export function __resetFilesCaches(): void {
  configCache = null;
  cachedRealRoot = null;
}

/** Whether a category's bytes are text (eligible for /api/file/text). */
export function isTextCategory(category: FileCategory): boolean {
  return TEXT_CATEGORIES.has(category);
}

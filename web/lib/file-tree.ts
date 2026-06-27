/**
 * Directory listing for the file-browser tree (/api/file/list). The single-file
 * viewer resolves ONE path to an fd (lib/files.ts `resolveFile`); this resolves
 * ONE directory to a flat list of its immediate children, reusing the SAME
 * security primitives so the tree can never escape the repo root or surface a
 * file the viewer itself would refuse to serve:
 *
 *   - identical input canonicalization + `..`/backslash/control-byte/`~`
 *     rejection as resolveFile Step 0–2;
 *   - lexical containment then realpath containment (Step 2.5 + Step 3), so a
 *     symlinked directory pointing outside the root is rejected, not followed;
 *   - the SAME `evaluateDeny` verdict (lib/files.ts) decides visibility, so
 *     `.git`, `.credentials`, `.env`, key/secret files, etc. are HIDDEN from the
 *     listing entirely (not merely blocked on open) — hiding the name too, so
 *     the tree is not an existence oracle for secret files.
 *
 * It does NOT open fds or read bytes (no TOCTOU surface): a name + kind is all
 * the tree needs, and the right-pane viewer re-resolves through the fd-returning
 * `resolveFile` when a file is actually opened.
 */

import { type Dirent, readdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { coordRoot } from "./coord-reader";
import type { DirEntry, DirListing } from "./file-viewer/types";
import {
  evaluateDeny,
  type FilesConfig,
  loadFilesConfig,
  type RejectCode,
  type ResolveReject,
} from "./files";

export type ListResult = ({ ok: true } & DirListing) | ResolveReject;

export interface ListOptions {
  /** Override the containment root (tests use temp dirs). Defaults to
   * realpath(coordRoot()). */
  root?: string;
}

function reject(code: RejectCode, status: ResolveReject["status"], detail?: string): ResolveReject {
  return { ok: false, code, status, detail };
}

/** Probe segment used to ask "are this directory's CONTENTS categorically
 * denied?" (e.g. `node_modules`, whose name alone isn't denied but whose every
 * child is, via the `**​/node_modules/**` non-last pattern). A neutral token no
 * floor/secret glob targets, so it only ever matches dir-scoped deny rules. */
const CONTENTS_PROBE = "_";

/**
 * List the immediate children of `rawInput` (repo-relative; "" / "." = the repo
 * root). Mirrors resolveFile's containment + deny model; returns a fail-closed
 * rejection on any violation, mappable to a Response via
 * `fileErrorResponse` (lib/file-routes.ts).
 */
export function listDir(rawInput: string, opts: ListOptions = {}): ListResult {
  let ROOT: string;
  try {
    ROOT = realpathSync(opts.root ?? coordRoot());
  } catch (err) {
    return reject("config_error", 500, `root unresolvable: ${(err as Error).message}`);
  }

  // -- Canonicalize input. Empty / "." → list ROOT itself (the viewer rejects
  // the bare root for a *file* open; for a tree it is the entry point). --------
  const raw = rawInput ?? "";
  if (typeof raw !== "string") return reject("invalid_path", 400, "bad dir param");
  if (raw.length > 4096) return reject("invalid_path", 400, "path too long");
  if (/%[0-9A-Fa-f]{2}/.test(raw)) {
    return reject("invalid_path", 400, "residual percent-encoding");
  }
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control-byte rejection is the point
  if (/[\u0000-\u001f\u007f]/.test(raw)) {
    return reject("invalid_path", 400, "control bytes in path");
  }
  if (raw.includes("\\")) return reject("invalid_path", 400, "backslash in path");
  if (raw.startsWith("~")) return reject("invalid_path", 400, "~-forms are not accepted");
  const input = raw.normalize("NFC");
  if (input.split("/").includes("..")) return reject("invalid_path", 400, "`..` segment");

  // -- Lexical containment (no filesystem access yet). -------------------------
  const lexAbs = path.resolve(ROOT, input);
  const lexRel = path.relative(ROOT, lexAbs);
  const inputIsRoot = lexRel === "";
  if (!inputIsRoot && (lexRel.startsWith("..") || path.isAbsolute(lexRel))) {
    return reject("unresolvable", 400, "path is outside the repo root");
  }

  // -- Config + deny precheck: a denied directory is never listable. -----------
  let cfg: FilesConfig;
  try {
    cfg = loadFilesConfig(ROOT);
  } catch (err) {
    return reject("config_error", 500, (err as Error).message);
  }
  if (!inputIsRoot && evaluateDeny(lexRel, cfg).denied) {
    return reject("denied", 403, "blocked by policy");
  }

  // -- Canonical containment via realpath (catches symlinked-out directories). -
  let real: string;
  try {
    real = realpathSync(lexAbs);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return reject("not_found", 404);
    if (code === "EACCES" || code === "EPERM") return reject("denied", 403, "permission denied");
    return reject("unresolvable", 400, `realpath failed: ${code}`);
  }
  const relFromRoot = path.relative(ROOT, real);
  const realIsRoot = relFromRoot === "";
  if (!realIsRoot && (relFromRoot.startsWith("..") || path.isAbsolute(relFromRoot))) {
    return reject("unresolvable", 400, "canonical path is outside the repo root");
  }
  const baseRel = realIsRoot ? "" : relFromRoot.split(path.sep).join("/");

  // -- Must be a directory. ----------------------------------------------------
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(real);
  } catch {
    return reject("not_found", 404);
  }
  if (!st.isDirectory()) return reject("not_file", 404, "not a directory");

  let dirents: Dirent[];
  try {
    dirents = readdirSync(real, { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM") return reject("denied", 403, "permission denied");
    return reject("unresolvable", 400, `readdir failed: ${code}`);
  }

  const entries: DirEntry[] = [];
  for (const d of dirents) {
    const name = d.name;
    if (name === "." || name === "..") continue;
    const childRel = baseRel ? `${baseRel}/${name}` : name;

    // Classify kind, resolving symlinks WITH containment (a symlink whose
    // target escapes the root, or is broken, is skipped — never followed out).
    let kind: "dir" | "file";
    if (d.isSymbolicLink()) {
      let target: string;
      try {
        target = realpathSync(path.join(real, name));
      } catch {
        continue; // broken symlink
      }
      const tRel = path.relative(ROOT, target);
      if (tRel !== "" && (tRel.startsWith("..") || path.isAbsolute(tRel))) continue; // escapes root
      let tst: ReturnType<typeof statSync>;
      try {
        tst = statSync(target);
      } catch {
        continue;
      }
      if (tst.isDirectory()) kind = "dir";
      else if (tst.isFile()) kind = "file";
      else continue; // socket / fifo / device
    } else if (d.isDirectory()) {
      kind = "dir";
    } else if (d.isFile()) {
      kind = "file";
    } else {
      continue; // fifo / socket / device / etc.
    }

    // Deny filter: hide denied entries entirely (don't leak the name). For
    // directories, also hide when their CONTENTS are categorically denied
    // (e.g. node_modules), so the tree never shows a dead, unexpandable folder.
    if (evaluateDeny(childRel, cfg).denied) continue;
    if (kind === "dir" && evaluateDeny(`${childRel}/${CONTENTS_PROBE}`, cfg).denied) continue;

    entries.push({ name, relPath: childRel, kind });
  }

  // Directories first, then files; case-insensitive name order within each.
  entries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
    return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  });

  return { ok: true, dir: baseRel, entries };
}

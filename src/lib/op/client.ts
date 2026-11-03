/**
 * The 1Password CLI client: field reads, item writes, discovery, OTP, and
 * documents, bound to one host's configuration by `createOpClient`.
 *
 * Two platform facts shape it:
 *
 * 1. Reads must never wait on stdin, so every read runs `op` with stdin
 *    ignored.
 * 2. Writes are a trap on WSL. The Windows `op.exe` treats any piped stdin as
 *    an item template, so an assignment edit (`op item edit ITEM
 *    field=value`) fails with "invalid JSON in piped input". The reliable
 *    write is: get the item JSON, change it in memory, and hand `op` the whole
 *    item back, on stdin for `op.exe` or through a private template file for
 *    the native `op`. Every field the caller did not touch round-trips intact,
 *    and no secret appears in argv.
 */

import {
  lstatSync,
  mkdtempSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  detectOp,
  isWindowsOp,
  opEnvironment,
  wslPathToWindows,
  wslPathToWindowsVerified,
} from "./detect.ts";
import { runProcess, runProcessSync } from "./process.ts";
import type {
  OpField,
  OpFieldUpdate,
  OpFieldUpdateResult,
  OpHostConfig,
  OpItem,
  OpItemSummary,
  OpItemView,
  OpLabelDrift,
  OpSection,
  OpTarget,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Pure helpers (no process, no host configuration)
// ---------------------------------------------------------------------------

/**
 * True for fields whose value grants access: concealed and password fields,
 * one-time-password fields, and any value that is an OTP setup URI
 * (`otpauth://`, which carries the seed) even in a plain text field. Other
 * secrets kept in plain text fields are not detected.
 */
export function isConcealed(f: { type?: string; purpose?: string; value?: string }): boolean {
  const type = (f.type ?? "").toUpperCase();
  const purpose = (f.purpose ?? "").toUpperCase();
  return (
    type === "CONCEALED" ||
    type === "OTP" ||
    type === "TOTP" ||
    purpose === "PASSWORD" ||
    purpose === "OTP" ||
    purpose === "TOTP" ||
    (f.value ?? "").toLowerCase().startsWith("otpauth://")
  );
}

/** The mask shown in place of a concealed value. */
export const MASK = "••••••";

/**
 * Item fields as a label-to-value map with concealed values masked unless
 * `reveal`. `duplicate_fields` counts labels used more than once, because
 * only one of each can appear in `fields`.
 */
export function summarizeItem(item: OpItem, opts: { reveal?: boolean } = {}): OpItemView {
  const fields: Record<string, string> = {};
  const counts = new Map<string, number>();
  for (const f of item.fields ?? []) {
    if (f.label) counts.set(f.label, (counts.get(f.label) ?? 0) + 1);
    if (f.label && f.value !== undefined && f.value !== "") {
      fields[f.label] = !opts.reveal && isConcealed(f) ? MASK : f.value;
    }
  }
  return {
    id: item.id,
    title: item.title,
    category: item.category,
    vault: item.vault?.name,
    fields,
    duplicate_fields: Object.fromEntries([...counts].filter(([, n]) => n > 1)),
  };
}

/** How an edited item template reaches `op`: on stdin for `op.exe`, by file otherwise. */
export function opTemplateTransport(op: string): {
  stdin: "pipe" | "ignore";
  templateFile: boolean;
} {
  return isWindowsOp(op)
    ? { stdin: "pipe", templateFile: false }
    : { stdin: "ignore", templateFile: true };
}

/** Fields whose label `op` changed between the requested template and its response. */
export function detectLabelDrift(requested: OpItem, actual: OpItem): OpLabelDrift[] {
  const after = new Map<string, string>();
  for (const field of actual.fields ?? []) {
    if (field.id && typeof field.label === "string") after.set(field.id, field.label);
  }
  const drift: OpLabelDrift[] = [];
  for (const field of requested.fields ?? []) {
    if (!field.id || typeof field.label !== "string") continue;
    const got = after.get(field.id);
    if (got !== undefined && got !== field.label) {
      drift.push({ id: field.id, requested: field.label, actual: got });
    }
  }
  return drift;
}

const EDIT_DIR_STALE_MS = 60 * 60 * 1000;

/** Remove abandoned item-template directories with `prefix` older than one hour. */
export function sweepStaleEditDirs(
  prefix: string,
  root: string = tmpdir(),
  now: number = Date.now(),
): number {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return 0;
  }
  let removed = 0;
  const cutoff = now - EDIT_DIR_STALE_MS;
  for (const name of entries) {
    if (!name.startsWith(prefix)) continue;
    const dir = join(root, name);
    try {
      if (statSync(dir).mtimeMs > cutoff) continue;
      rmSync(dir, { recursive: true, force: true });
      removed++;
    } catch {
      // Another process may own it, or it may have vanished. Leave it.
    }
  }
  return removed;
}

/**
 * What a Password item's built-in password holds when nothing else does. The
 * 1Password CLI refuses every edit and create of a Password item whose
 * password is empty ("Password item requires ps value"), although the desktop
 * app makes such items. Not a secret, and says so.
 */
export const PASSWORD_PLACEHOLDER = "placeholder-not-a-password";

/** The item with its built-in password filled if it is a Password item and has none. */
export function withRequiredPassword<T extends { category?: string; fields?: OpField[] }>(
  item: T,
): T {
  if ((item.category ?? "").toUpperCase() !== "PASSWORD") return item;
  const fields = [...(item.fields ?? [])];
  const i = fields.findIndex((f) => f.purpose === "PASSWORD");
  const current = i >= 0 ? fields[i] : undefined;
  if (current?.value) return item;
  if (current) fields[i] = { ...current, value: PASSWORD_PLACEHOLDER };
  else {
    fields.unshift({
      id: "password",
      type: "CONCEALED",
      purpose: "PASSWORD",
      label: "password",
      value: PASSWORD_PLACEHOLDER,
    });
  }
  return { ...item, fields };
}

/**
 * The error for a failed `op item edit`. The empty-password refusal gets an
 * explanation, because `op`'s own words do not say what to do.
 */
export function explainEditFailure(code: number, stderr: string, binName = "this CLI"): string {
  const raw = `op item edit failed (exit ${code}): ${stderr.trim() || "unknown error"}`;
  if (!/Password item requires ps value/.test(stderr)) return raw;
  return (
    "1Password's CLI refuses every edit to a Password item whose password is empty, although the " +
    `desktop app allows it. ${binName} op fills one in, so reaching this means the item changed ` +
    `shape; give it a password in the app. ${raw}`
  );
}

/**
 * The error for a failed `op` call. `op` refuses an `--account` that matches
 * two signed-in accounts; the account ID is unambiguous and `op` accepts it.
 */
export function explainFailure(
  label: string,
  code: number,
  stderr: string,
  binName = "this CLI",
): string {
  const raw = `${label} failed (exit ${code}): ${stderr.trim() || "unknown error"}`;
  if (!/multiple accounts/i.test(stderr)) return raw;
  return `${raw}. More than one signed-in account matches; pass --account with the account_uuid from ${binName} op accounts.`;
}

function fieldsWithLabel(item: OpItem, label: string): OpField[] {
  return (item.fields ?? []).filter((field) => field.label === label);
}

function inSection(field: OpField, section: OpSection): boolean {
  return (
    (section.id !== undefined && field.section?.id === section.id) ||
    (section.label !== undefined && field.section?.label === section.label)
  );
}

/**
 * Fields carrying `label`, scoped to `section` when one is given. A sectioned
 * write must never match a same-named field elsewhere on the item: a Login's
 * built-in `password` and a `password` in another section are different
 * secrets.
 */
export function fieldsInScope(item: OpItem, label: string, section?: OpSection): OpField[] {
  const matches = fieldsWithLabel(item, label);
  return section ? matches.filter((field) => inSection(field, section)) : matches;
}

/**
 * Find a section by label. With `create`, a missing section is added to the
 * item in memory (written by the caller's single edit); without it, a
 * missing section fails closed rather than silently creating a top-level
 * field.
 */
export function resolveSection(
  item: OpItem,
  label?: string,
  opts: { create?: boolean } = {},
): OpSection | undefined {
  if (!label) return undefined;
  const section =
    (item.sections ?? []).find((candidate) => candidate.label === label) ??
    (item.fields ?? []).find((candidate) => candidate.section?.label === label)?.section;
  if (section) return section;
  if (!opts.create)
    throw new Error(`section not found on item: ${label} (pass --create to add it)`);
  const slug =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || "section";
  const taken = new Set((item.sections ?? []).map((candidate) => candidate.id));
  let id = `add_${slug}`;
  for (let n = 2; taken.has(id); n++) id = `add_${slug}_${n}`;
  const created: OpSection = { id, label };
  if (!item.sections) item.sections = [];
  item.sections.push(created);
  return created;
}

function normalizedFieldValue(value: string, minify = false): string {
  if (!minify) return value;
  const candidate = value.trim();
  if (!candidate.startsWith("{") && !candidate.startsWith("[")) return value;
  try {
    return JSON.stringify(JSON.parse(candidate));
  } catch {
    return value;
  }
}

function verifyReturnedField(
  item: OpItem,
  label: string,
  expectedValue: string,
  sectionLabel?: string,
): void {
  const matches = sectionLabel
    ? fieldsWithLabel(item, label).filter((field) => field.section?.label === sectionLabel)
    : fieldsWithLabel(item, label);
  if (matches.length !== 1 || matches[0]?.value !== expectedValue) {
    throw new Error(
      `1Password edit response did not verify '${label}' (${matches.length} matching fields returned)`,
    );
  }
}

/**
 * The real path of `path`, following every symlink, including a dangling one
 * whose target does not exist yet. For a path that does not exist, the
 * deepest existing ancestor is resolved and the rest appended. Throws on a
 * symlink loop, so the caller refuses the path.
 */
function canonicalPath(path: string, hops = 0): string {
  if (hops > 40) throw new Error(`too many symbolic links while resolving ${path}`);
  const abs = resolve(path);
  const rest: string[] = [];
  let current = abs;
  for (;;) {
    try {
      return join(realpathSync.native(current), ...[...rest].reverse());
    } catch {
      let target: string | undefined;
      try {
        if (lstatSync(current).isSymbolicLink()) target = readlinkSync(current);
      } catch {
        // current does not exist; climb to its parent.
      }
      if (target !== undefined) {
        // Interpret the target against the link's physical parent, so ".."
        // means what the filesystem will do, not what the alias path says.
        const parent = realpathSync.native(dirname(current));
        return canonicalPath(join(resolve(parent, target), ...[...rest].reverse()), hops + 1);
      }
      const parent = dirname(current);
      if (parent === current) return abs;
      rest.push(basename(current));
      current = parent;
    }
  }
}

// ---------------------------------------------------------------------------
// Host-bound client
// ---------------------------------------------------------------------------

/** Thrown when a host whose write policy is `"refused"` attempts a vault change. */
export class OpWriteRefusedError extends Error {
  constructor(operation: string) {
    super(
      `${operation} refused: this CLI is read-only for 1Password; change the vault in the 1Password app`,
    );
    this.name = "OpWriteRefusedError";
  }
}

export interface SetFieldOptions {
  minify?: boolean;
  create?: boolean;
  type?: string;
  title?: string;
  section?: string;
  dedupe?: boolean;
  dryRun?: boolean;
}

export interface SetFieldResult {
  created: boolean;
  changed: boolean;
  before?: string;
  after: string;
  concealed: boolean;
  deduplicated: number;
}

export interface OpAccount {
  url: string;
  email: string;
  user_uuid: string;
  account_uuid: string;
}

/** Bind the 1Password client to one host's configuration. */
export function createOpClient(config: OpHostConfig) {
  const binName = config.binName;
  const accountIds = Object.fromEntries(
    Object.entries(config.accountIds ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
  );
  const writesAllowed = config.writes === "allowed";
  const requireIgnoredOutput = config.requireIgnoredOutput ?? true;
  const onLabelDrift =
    config.onLabelDrift ??
    ((drift: OpLabelDrift, item: string) =>
      console.error(
        `warning: 1Password renamed field "${drift.requested}" to "${drift.actual}" on "${item}". op resets custom labels on username/password/notes fields and erases them again on the next write, so do not bother restoring it; the value is untouched.`,
      ));

  function resolveOp(): string | null {
    return detectOp({ locateBridge: config.bridge ?? (() => null) });
  }

  function requireOp(): string {
    const op = resolveOp();
    if (!op) throw new Error("no 1Password CLI found (op / op.exe). Install it or set $OP_BIN.");
    return op;
  }

  function assertWritable(operation: string): void {
    if (!writesAllowed) throw new OpWriteRefusedError(operation);
  }

  /** The `--account` value op should receive: an aliased address becomes its account ID. */
  function accountArg(account: string): string {
    return accountIds[account.toLowerCase()] ?? account;
  }

  function accountFlag(account?: string): string[] {
    const chosen = account ?? config.defaultAccount;
    return chosen ? ["--account", accountArg(chosen)] : [];
  }

  function targetArgs(t: { account?: string; vault?: string }): string[] {
    const args = accountFlag(t.account);
    if (t.vault) args.push("--vault", t.vault);
    return args;
  }

  async function run(args: string[], label: string, input?: string): Promise<string> {
    const result = await runProcess([requireOp(), ...args], { env: opEnvironment(), input });
    if (result.exitCode !== 0)
      throw new Error(explainFailure(label, result.exitCode, result.stderr, binName));
    return result.stdout;
  }

  function requireUniqueField(
    item: OpItem,
    label: string,
    section?: OpSection,
  ): OpField | undefined {
    const matches = fieldsInScope(item, label, section);
    if (matches.length > 1) {
      throw new Error(
        `duplicate field label '${label}' (${matches.length} fields); use ${binName} op set --dedupe for an intentional repair`,
      );
    }
    return matches[0];
  }

  /**
   * Refuse to write a secret to a path inside the host repository that Git
   * would not ignore, so a key cannot be committed by accident. Returns the
   * real destination with every symlink resolved. Callers must write to that
   * returned path, so the place checked and the place written are the same.
   */
  function assertIgnoredOutput(path: string): string {
    const destination = canonicalPath(path);
    if (!requireIgnoredOutput) return destination;
    const repo = canonicalPath(config.repoRoot);
    const rel = relative(repo, destination);
    const outside = rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
    if (outside) return destination;
    // Without --no-index, check-ignore treats a tracked file as not ignored
    // even when a rule matches it, because Git keeps tracking its changes.
    const check = runProcessSync(["git", "-C", repo, "check-ignore", "-q", "--", rel || "."]);
    if (check.exitCode !== 0) {
      throw new Error(
        `${rel || "."} is tracked or not ignored by Git, so a secret written there could be committed. Write it to an ignored, untracked path instead.`,
      );
    }
    return destination;
  }

  async function getItem(t: OpTarget): Promise<OpItem> {
    const out = await run(
      ["item", "get", t.item, ...targetArgs(t), "--format", "json", "--reveal"],
      "op item get",
    );
    return JSON.parse(out) as OpItem;
  }

  /** Apply a changed item template with `op item edit` and return the resulting item. */
  async function pipeItemEdit(t: OpTarget, original: OpItem, dryRun = false): Promise<OpItem> {
    const item = withRequiredPassword(original);
    const op = requireOp();
    const transport = opTemplateTransport(op);
    // --reveal applies only to the JSON captured in this process; the client
    // needs the returned plaintext to verify the edit landed.
    const args = ["item", "edit", t.item, ...targetArgs(t), "--format", "json", "--reveal"];
    sweepStaleEditDirs(config.editDirPrefix);
    const editDir = transport.templateFile
      ? mkdtempSync(join(tmpdir(), config.editDirPrefix))
      : null;
    if (editDir) {
      const templatePath = join(editDir, "item.json");
      writeFileSync(templatePath, JSON.stringify(item), { mode: 0o600 });
      args.push(`--template=${templatePath}`);
    }
    if (dryRun) args.push("--dry-run");
    let result: Awaited<ReturnType<typeof runProcess>>;
    try {
      result = await runProcess([op, ...args], {
        env: opEnvironment(),
        input: transport.stdin === "pipe" ? JSON.stringify(item) : undefined,
      });
    } finally {
      if (editDir) rmSync(editDir, { recursive: true, force: true });
    }
    if (result.exitCode !== 0)
      throw new Error(explainEditFailure(result.exitCode, result.stderr, binName));
    const edited = JSON.parse(result.stdout || "{}") as OpItem;
    for (const drift of detectLabelDrift(item, edited)) onLabelDrift(drift, t.item);
    return edited;
  }

  /** Read one field's value by label. Returns "" when the field is absent. */
  async function getField(t: OpTarget, field: string): Promise<string> {
    return requireUniqueField(await getItem(t), field)?.value ?? "";
  }

  /** Several fields from one item in one fetch; absent labels map to "". */
  async function getFields(t: OpTarget, fields: string[]): Promise<Record<string, string>> {
    const item = await getItem(t);
    const out: Record<string, string> = {};
    for (const label of fields) out[label] = requireUniqueField(item, label)?.value ?? "";
    return out;
  }

  /** The whole item as a label-to-value map, concealed values masked unless `reveal`. */
  async function getItemFields(t: OpTarget, opts: { reveal?: boolean } = {}): Promise<OpItemView> {
    return summarizeItem(await getItem(t), opts);
  }

  /**
   * Edit several fields through one get, change, and template write. Every
   * update is validated and applied in memory before the single `op item
   * edit`, which keeps approval prompts to one and prevents a partial write.
   * Values are omitted from the result so it can be logged.
   */
  async function setFields(
    t: OpTarget,
    updates: OpFieldUpdate[],
    opts: { create?: boolean; title?: string; dryRun?: boolean } = {},
  ): Promise<{ fields: OpFieldUpdateResult[]; titleChanged: boolean }> {
    assertWritable("op item edit");
    if (updates.length === 0 && opts.title === undefined) {
      throw new Error("batch update requires at least one field or a title");
    }
    const labels = new Set<string>();
    for (const update of updates) {
      if (!update.field.trim()) throw new Error("batch update field labels cannot be empty");
      const key = `${update.section ?? ""}\u0000${update.field}`;
      if (labels.has(key)) throw new Error(`duplicate batch update field: ${update.field}`);
      labels.add(key);
    }

    const item = await getItem(t);
    const results: OpFieldUpdateResult[] = [];
    for (const update of updates) {
      const section = resolveSection(item, update.section, {
        create: update.create ?? opts.create,
      });
      const value = normalizedFieldValue(update.value, update.minify);
      const requestedType = update.type?.toUpperCase();
      const field = requireUniqueField(item, update.field, section);
      if (field) {
        const beforeValue = field.value;
        const beforeType = field.type;
        const beforeSection = field.section?.id ?? field.section?.label;
        field.value = value;
        if (requestedType) field.type = requestedType;
        if (section) field.section = section;
        results.push({
          field: update.field,
          created: false,
          changed:
            beforeValue !== value ||
            beforeType !== field.type ||
            beforeSection !== (field.section?.id ?? field.section?.label),
          concealed: isConcealed(field),
        });
        continue;
      }
      if (!(update.create ?? opts.create)) {
        throw new Error(`field not found on item: ${update.field} (pass --create to add it)`);
      }
      const created: OpField = {
        label: update.field,
        type: requestedType ?? "STRING",
        value,
        ...(section ? { section } : {}),
      };
      if (!item.fields) item.fields = [];
      item.fields.push(created);
      results.push({
        field: update.field,
        created: true,
        changed: true,
        concealed: isConcealed(created),
      });
    }

    const titleChanged = opts.title !== undefined && item.title !== opts.title;
    if (opts.title !== undefined) item.title = opts.title;
    const edited = await pipeItemEdit(t, item, opts.dryRun);
    for (const update of updates) {
      verifyReturnedField(
        edited,
        update.field,
        normalizedFieldValue(update.value, update.minify),
        update.section,
      );
    }
    if (opts.title !== undefined && edited.title !== opts.title) {
      throw new Error("1Password edit response did not verify the requested title");
    }
    return { fields: results, titleChanged };
  }

  /**
   * Write one field's value by label through the template path. With
   * `create`, a missing field is added (type defaults to STRING). With
   * `section`, the field is placed in that section; a missing section is
   * created only with `create`. With `dedupe`, duplicate labels collapse to
   * one. With `dryRun`, `op` previews the result without writing.
   */
  async function setField(
    t: OpTarget,
    field: string,
    value: string,
    opts: SetFieldOptions = {},
  ): Promise<SetFieldResult> {
    assertWritable("op item edit");
    const item = await getItem(t);
    const section = resolveSection(item, opts.section, { create: opts.create });
    const val = normalizedFieldValue(value, opts.minify);

    let created = false;
    let before: string | undefined;
    let concealed = false;
    let deduplicated = 0;
    const matching = fieldsWithLabel(item, field);
    if (matching.length > 1 && !opts.dedupe) {
      throw new Error(
        `duplicate field label '${field}' (${matching.length} fields); pass --dedupe to keep one and remove the duplicates`,
      );
    }
    const f = matching[0];
    if (f) {
      before = f.value;
      concealed = isConcealed(f);
      f.value = val;
      if (section) f.section = section;
      if (matching.length > 1) {
        let kept = false;
        item.fields = (item.fields ?? []).filter((candidate) => {
          if (candidate.label !== field) return true;
          if (!kept) {
            kept = true;
            return true;
          }
          deduplicated += 1;
          return false;
        });
      }
    } else if (opts.create) {
      concealed = (opts.type ?? "STRING").toUpperCase() === "CONCEALED";
      if (!item.fields) item.fields = [];
      item.fields.push({
        label: field,
        type: (opts.type ?? "STRING").toUpperCase(),
        value: val,
        ...(section ? { section } : {}),
      });
      created = true;
    } else {
      throw new Error(`field not found on item: ${field} (pass --create to add it)`);
    }

    if (opts.title !== undefined) item.title = opts.title;
    const edited = await pipeItemEdit(t, item, opts.dryRun);
    verifyReturnedField(edited, field, val);
    if (opts.title !== undefined && edited.title !== opts.title) {
      throw new Error("1Password edit response did not verify the requested title");
    }
    return {
      created,
      changed: before !== val || deduplicated > 0,
      before,
      after: val,
      concealed,
      deduplicated,
    };
  }

  /** Rename an item. Every field and a document's files round-trip untouched. */
  async function setTitle(
    t: OpTarget,
    title: string,
    opts: { dryRun?: boolean } = {},
  ): Promise<void> {
    assertWritable("op item edit");
    const item = await getItem(t);
    item.title = title;
    await pipeItemEdit(t, item, opts.dryRun);
  }

  /** Move an item to another vault without exposing its fields. */
  async function moveItem(t: OpTarget, destinationVault: string): Promise<void> {
    assertWritable("op item move");
    if (!t.vault) throw new Error("source vault is required for an item move");
    if (!destinationVault.trim()) throw new Error("destination vault is required for an item move");
    if (t.vault === destinationVault) throw new Error("source and destination vaults must differ");
    await run(
      [
        "item",
        "move",
        t.item,
        "--current-vault",
        t.vault,
        "--destination-vault",
        destinationVault,
        ...accountFlag(t.account),
      ],
      "op item move",
    );
  }

  /**
   * Delete one custom field by label by omitting it from the template. Throws
   * when the field is absent or survives. Built-in fields can only be blanked.
   */
  async function deleteField(
    t: OpTarget,
    field: string,
    opts: { dryRun?: boolean } = {},
  ): Promise<void> {
    assertWritable("op item edit");
    const item = await getItem(t);
    const fields = item.fields ?? [];
    const idx = fields.findIndex((x) => x.label === field);
    if (idx < 0) throw new Error(`field not found on item: ${field}`);
    fields.splice(idx, 1);
    item.fields = fields;
    const after = await pipeItemEdit(t, item, opts.dryRun);
    if (!opts.dryRun && (after.fields ?? []).some((x) => x.label === field)) {
      throw new Error(
        `field '${field}' survived deletion; is it a built-in field, or a malformed item? Try the 1Password app`,
      );
    }
  }

  /** Current one-time password for an item. */
  async function getOtp(t: OpTarget): Promise<string> {
    return (
      await run(["item", "get", t.item, ...targetArgs(t), "--otp"], "op item get --otp")
    ).trim();
  }

  /** Resolve a secret reference (`op://vault/item/field`) to its raw value. */
  async function readReference(uri: string, account?: string): Promise<string> {
    return run(["read", uri, ...accountFlag(account)], "op read");
  }

  /**
   * Fetch a document item's file. Returns its content, or writes it to `out`
   * (which must be ignored by Git when inside the host repository) and
   * returns the path.
   */
  async function getDocument(
    t: OpTarget,
    out?: string,
  ): Promise<{ content?: string; path?: string }> {
    const args = ["document", "get", t.item, ...targetArgs(t)];
    if (out) {
      const destination = assertIgnoredOutput(out);
      // The Windows op.exe (or a helper forwarding to it) cannot read a Linux
      // path, so translate the checked destination on WSL.
      let outFile = destination;
      if (isWindowsOp(requireOp()) && destination.startsWith("/")) {
        const windows = wslPathToWindowsVerified(destination);
        if (!windows) {
          throw new Error(
            `cannot hand ${destination} to the Windows op.exe unchanged; choose a simpler output path`,
          );
        }
        outFile = windows;
      }
      // --force: op would otherwise prompt before overwriting, which cannot be
      // answered with stdin ignored.
      args.push("--out-file", outFile, "--force");
      await run(args, "op document get");
      return { path: out };
    }
    return { content: await run(args, "op document get") };
  }

  /**
   * Create a document item from a local file. On WSL the Windows `op.exe`
   * cannot read a Linux path, so the path is translated first.
   */
  async function createDocument(
    t: { account?: string; vault?: string },
    filePath: string,
    opts: { title?: string; fileName?: string } = {},
  ): Promise<{ id?: string; title?: string }> {
    assertWritable("op document create");
    let p = filePath;
    if (isWindowsOp(requireOp()) && p.startsWith("/")) p = wslPathToWindows(p) ?? p;
    const args = ["document", "create", p, ...targetArgs(t), "--format", "json"];
    if (opts.title) args.push("--title", opts.title);
    if (opts.fileName) args.push("--file-name", opts.fileName);
    const r = JSON.parse(await run(args, "op document create")) as { id?: string; title?: string };
    return { id: r.id, title: r.title };
  }

  /**
   * Create an item from a JSON template on stdin. `category` defaults to
   * LOGIN; each field's type defaults to STRING (use CONCEALED for secrets).
   */
  async function createItem(
    t: { account?: string; vault?: string },
    spec: {
      title: string;
      category?: string;
      fields?: Array<{ label: string; value: string; type?: string }>;
      tags?: string[];
    },
  ): Promise<{ id?: string; title?: string }> {
    assertWritable("op item create");
    const template: Record<string, unknown> & { category?: string; fields?: OpField[] } = {
      title: spec.title,
      category: (spec.category ?? "LOGIN").toUpperCase(),
      fields: (spec.fields ?? []).map((f) => ({
        label: f.label,
        type: (f.type ?? "STRING").toUpperCase(),
        value: f.value,
      })),
    };
    if (spec.tags?.length) template.tags = spec.tags;
    const out = await run(
      ["item", "create", ...targetArgs(t), "--format", "json"],
      "op item create",
      JSON.stringify(withRequiredPassword(template)),
    );
    const r = JSON.parse(out || "{}") as { id?: string; title?: string };
    return { id: r.id, title: r.title };
  }

  /** Create a share link for an item. Refused under a read-only policy. */
  async function shareItem(
    t: OpTarget,
    opts: { expiresIn?: string; emails?: string[]; viewOnce?: boolean } = {},
  ): Promise<string> {
    assertWritable("op item share");
    const args = ["item", "share", t.item, ...targetArgs(t)];
    if (opts.expiresIn) args.push("--expires-in", opts.expiresIn);
    if (opts.emails?.length) args.push("--emails", opts.emails.join(","));
    if (opts.viewOnce) args.push("--view-once");
    return (await run(args, "op item share")).trim();
  }

  /** List items, optionally within one vault. */
  async function listItems(t: { account?: string; vault?: string } = {}): Promise<OpItemSummary[]> {
    const rows = JSON.parse(
      await run(["item", "list", ...targetArgs(t), "--format", "json"], "op item list"),
    ) as Array<{
      id: string;
      title: string;
      vault?: { name?: string };
      category?: string;
      updated_at?: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      vault: r.vault?.name ?? "",
      category: r.category,
      updated_at: r.updated_at,
    }));
  }

  /** Items whose title contains `query`, case-insensitively. */
  async function searchItems(
    t: { account?: string; vault?: string },
    query: string,
  ): Promise<OpItemSummary[]> {
    const q = query.toLowerCase();
    return (await listItems(t)).filter((r) => r.title.toLowerCase().includes(q));
  }

  /** Vaults visible to the account. */
  async function listVaults(account?: string): Promise<Array<{ id: string; name: string }>> {
    const rows = JSON.parse(
      await run(["vault", "list", "--format", "json", ...accountFlag(account)], "op vault list"),
    ) as Array<{ id: string; name: string }>;
    return rows.map((r) => ({ id: r.id, name: r.name }));
  }

  /** Accounts configured on this machine. `account_uuid` works for `--account`. */
  async function listAccounts(): Promise<OpAccount[]> {
    return JSON.parse(
      await run(["account", "list", "--format", "json"], "op account list"),
    ) as OpAccount[];
  }

  /**
   * Current sign-in for an account. With desktop-app integration, `op whoami`
   * can say "not signed in" while reads still work, so this reports instead
   * of throwing.
   */
  async function whoami(
    account?: string,
  ): Promise<{ signed_in: boolean; url?: string; email?: string; user_uuid?: string }> {
    try {
      const out = await run(["whoami", "--format", "json", ...accountFlag(account)], "op whoami");
      const w = JSON.parse(out) as { url?: string; email?: string; user_uuid?: string };
      return { signed_in: true, ...w };
    } catch {
      return { signed_in: false };
    }
  }

  return {
    config,
    detectOp: resolveOp,
    accountArg,
    assertIgnoredOutput,
    getField,
    getFields,
    getItemFields,
    setField,
    setFields,
    setTitle,
    moveItem,
    deleteField,
    getOtp,
    readReference,
    getDocument,
    createDocument,
    createItem,
    shareItem,
    listItems,
    searchItems,
    listVaults,
    listAccounts,
    whoami,
    sweepStaleEditDirs: (root?: string, now?: number) =>
      sweepStaleEditDirs(config.editDirPrefix, root, now),
  };
}

export type OpClient = ReturnType<typeof createOpClient>;

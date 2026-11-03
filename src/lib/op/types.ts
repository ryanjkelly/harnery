/**
 * Contracts for the 1Password CLI toolkit (`harnery/lib/op`).
 *
 * The toolkit owns how `op` is found and run, how items are read and
 * written, and how secrets are masked. The embedding host owns everything
 * that names a real account, vault, item, file, or brand, and passes it in
 * through `OpHostConfig`.
 */

/** Which 1Password item an operation addresses. */
export interface OpTarget {
  /** Sign-in address or account ID. Falls back to the host's default account. */
  account?: string;
  vault?: string;
  item: string;
}

/**
 * Whether this host may change a vault.
 *
 * `"refused"` is enforced inside the client before any process starts, not
 * only by leaving write subcommands unregistered, so a library caller cannot
 * reach a write by importing the function directly.
 */
export type OpWritePolicy = "allowed" | "refused";

/**
 * Returns the absolute path of a host-installed helper that forwards `op`
 * calls (for example, one that gives the desktop approval prompt a stable
 * name), or null when none is installed. `detectOp` asks it first on WSL and
 * macOS. It must not start, build, or install anything.
 */
export type BridgeResolver = () => string | null;

/**
 * One 1Password item mirrored to a machine-local file, so ordinary reads do
 * not open a live 1Password session.
 */
export interface LocalCredentialSource {
  account: string;
  vault: string;
  item: string;
  /** Path of the mirror file, relative to `OpHostConfig.repoRoot`. */
  path: string;
  /** Key of the host pull script that refreshes this file. */
  pullKey: string;
  /** Field labels the mirror must contain. */
  fields: string[];
  description: string;
  /** Fields that must parse as a private key before the mirror is trusted. */
  privateKeyFields?: string[];
}

/** On-disk shape of a mirror file. */
export interface LocalCredentialFile {
  version: 1;
  account: string;
  vault: string;
  item: string;
  category?: string;
  fields: Record<string, string>;
  concealed_fields: string[];
}

/** Everything host-specific the op toolkit needs. */
export interface OpHostConfig {
  /** CLI name used in messages that tell someone what to run, such as `"harn"`. */
  binName: string;
  /** Absolute path of the host repository; relative credential paths resolve here. */
  repoRoot: string;
  /** Default account for calls that do not name one. */
  defaultAccount?: string;
  /**
   * Sign-in address to account ID, for an address that two accounts share.
   * `op` refuses `--account <address>` when it matches more than one account.
   */
  accountIds?: Record<string, string>;
  writes: OpWritePolicy;
  /** Prefix for private temporary item-edit directories, so stale ones can be swept. */
  editDirPrefix: string;
  /** The host's installed forwarding helper, if it has one. */
  bridge?: BridgeResolver;
  /** Mirrors read before a live call. Empty or absent disables local-first reads. */
  localCredentials?: LocalCredentialSource[];
  /**
   * Refuse to write a secret to a path inside `repoRoot` that Git would not
   * ignore. Defaults to true.
   */
  requireIgnoredOutput?: boolean;
}

/** Field metadata as `op item get --format json` returns it. */
export interface OpField {
  id?: string;
  label?: string;
  value?: string;
  type?: string;
  purpose?: string;
  section?: { id?: string; label?: string };
}

export interface OpSection {
  id?: string;
  label?: string;
}

/** An item as `op item get --format json` returns it. */
export interface OpItem {
  id?: string;
  title?: string;
  category?: string;
  vault?: { id?: string; name?: string };
  fields?: OpField[];
  sections?: OpSection[];
  [k: string]: unknown;
}

/** One field change in a batched edit. */
export interface OpFieldUpdate {
  /** Field label or ID. */
  field: string;
  value: string;
  /** Add the field when no field matches. */
  create?: boolean;
  /** Field type for a created field, such as `"CONCEALED"`. */
  type?: string;
  /** Re-serialize a JSON value without whitespace before storing it. */
  minify?: boolean;
  /** Limit matching to this section label, creating the section when absent. */
  section?: string;
}

export interface OpFieldUpdateResult {
  field: string;
  created: boolean;
  changed: boolean;
  concealed: boolean;
}

/** A matched field whose stored label differs from the requested one. */
export interface OpLabelDrift {
  id: string;
  requested: string;
  actual: string;
}

export interface OpItemSummary {
  id: string;
  title: string;
  vault: string;
  category?: string;
  updated_at?: string;
}

/** Item view with secrets masked unless revealed. */
export interface OpItemView {
  id?: string;
  title?: string;
  category?: string;
  vault?: string;
  fields: Record<string, string>;
  /** Labels used more than once; only one of each can appear in `fields`. */
  duplicate_fields: Record<string, number>;
}

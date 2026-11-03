/**
 * `<bin> op`: a Commander builder for the 1Password client, so every host
 * offers the same subcommands with its own account, policy, and output.
 *
 * Write subcommands are registered only when the client's write policy is
 * `"allowed"`; the client also refuses writes itself, so an unregistered
 * command is not the only guard. With `secretOutput: "masked"`, value
 * commands mask what they print unless `--reveal` is passed, and `--out`
 * writes the value to a file Git ignores instead.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Command } from "commander";
import { MASK, type OpClient } from "./client.ts";
import type { LocalCredentials } from "./local-credentials.ts";
import { readStdinText } from "./process.ts";
import type { OpTarget } from "./types.ts";

/**
 * The output methods the builder calls. A host's Harnery `EmitContext`
 * satisfies it, so output goes through the host's renderers.
 */
export interface OpCommandIO {
  data(payload: unknown): void;
  error(err: { code: string; message: string; hint?: string }): void;
  setExitCode(n: number): void;
}

export interface OpCommandOptions {
  client: OpClient;
  io: OpCommandIO;
  /** Registered local mirrors that `get` and `item` read before a live call. */
  local?: LocalCredentials;
  /** Environment variables consulted, in order, when `--account` is absent. Default `["OP_ACCOUNT"]`. */
  accountEnv?: string[];
  /** Environment variables consulted, in order, when `--vault` is absent. */
  vaultEnv?: string[];
  /** `"raw"` prints secret values verbatim for piping; `"masked"` hides them unless `--reveal`. */
  secretOutput?: "raw" | "masked";
}

interface SetManyFieldSpec {
  value: string;
  create?: boolean;
  type?: string;
  minify?: boolean;
  section?: string;
}

export interface SetManyPayload {
  fields: Record<string, string | SetManyFieldSpec>;
  title?: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parse and validate a `set-many` JSON batch before any 1Password call. */
export function parseSetManyPayload(raw: string): SetManyPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("set-many stdin must be valid JSON");
  }
  if (!record(parsed)) throw new Error("set-many stdin must be a JSON object");
  const unknownTopLevel = Object.keys(parsed).filter((key) => key !== "fields" && key !== "title");
  if (unknownTopLevel.length) {
    throw new Error(`set-many stdin has unknown top-level key(s): ${unknownTopLevel.join(", ")}`);
  }
  if (!record(parsed.fields) || Object.keys(parsed.fields).length === 0) {
    throw new Error("set-many stdin requires a non-empty 'fields' object");
  }
  if (parsed.title !== undefined && typeof parsed.title !== "string") {
    throw new Error("set-many title must be a string");
  }
  const allowed = new Set(["value", "create", "type", "minify", "section"]);
  const entries: Array<[string, string | SetManyFieldSpec]> = [];
  for (const [label, input] of Object.entries(parsed.fields)) {
    if (!label.trim()) throw new Error("set-many field labels cannot be empty");
    if (typeof input === "string") {
      entries.push([label, input]);
      continue;
    }
    if (!record(input))
      throw new Error(`set-many field '${label}' must be a string or field specification`);
    const unknown = Object.keys(input).filter((key) => !allowed.has(key));
    if (unknown.length)
      throw new Error(`set-many field '${label}' has unknown key(s): ${unknown.join(", ")}`);
    if (typeof input.value !== "string")
      throw new Error(`set-many field '${label}' requires a string value`);
    for (const key of ["create", "minify"] as const) {
      if (input[key] !== undefined && typeof input[key] !== "boolean") {
        throw new Error(`set-many field '${label}' ${key} must be boolean`);
      }
    }
    for (const key of ["type", "section"] as const) {
      if (input[key] !== undefined && typeof input[key] !== "string") {
        throw new Error(`set-many field '${label}' ${key} must be a string`);
      }
    }
    entries.push([label, input as unknown as SetManyFieldSpec]);
  }
  return {
    fields: Object.fromEntries(entries),
    ...(parsed.title !== undefined ? { title: parsed.title } : {}),
  };
}

class CommandFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function collect(value: string, acc: string[]): string[] {
  acc.push(value);
  return acc;
}

/** Register `op` on `program` and return it, so a host can add its own subcommands. */
export function registerOpCommand(program: Command, options: OpCommandOptions): Command {
  const { client, io, local } = options;
  const accountEnv = options.accountEnv ?? ["OP_ACCOUNT"];
  const vaultEnv = options.vaultEnv ?? [];
  const masked = options.secretOutput === "masked";
  const writes = client.config.writes === "allowed";
  const defaultAccount = client.config.defaultAccount;

  const fromEnv = (names: string[]): string | undefined => {
    for (const name of names) {
      const value = process.env[name];
      if (value) return value;
    }
    return undefined;
  };
  const resolveAccount = (account?: string): string | undefined =>
    account || fromEnv(accountEnv) || defaultAccount;
  const resolveVault = (vault?: string): string | undefined => vault || fromEnv(vaultEnv);
  const target = (o: { account?: string; vault?: string; item: string }): OpTarget => ({
    account: resolveAccount(o.account),
    vault: resolveVault(o.vault),
    item: o.item,
  });
  const scope = (o: { account?: string; vault?: string }) => ({
    account: resolveAccount(o.account),
    vault: resolveVault(o.vault),
  });

  const guarded =
    <A extends unknown[]>(code: string, fn: (...args: A) => Promise<void> | void) =>
    async (...args: A): Promise<void> => {
      try {
        await fn(...args);
      } catch (e) {
        const failure = e instanceof CommandFailure ? e : undefined;
        io.error({
          code: failure?.code ?? code,
          message: e instanceof Error ? e.message : String(e),
        });
        io.setExitCode(1);
      }
    };
  const fail = (code: string, message: string): never => {
    throw new CommandFailure(code, message);
  };

  const accountHelp = `1Password account (default: ${[...accountEnv.map((n) => `$${n}`), defaultAccount ?? "op's default"].join(", then ")})`;
  const accountFlags = (cmd: Command): Command =>
    cmd.option("--account <name>", accountHelp).option("--vault <name>", "Vault name");
  const itemFlags = (cmd: Command): Command =>
    accountFlags(cmd).requiredOption(
      "--item <name|id>",
      "1Password item (name, ID, or share link)",
    );
  const secretFlags = (cmd: Command): Command =>
    masked
      ? cmd
          .option("--reveal", "Print secret values (they will appear in the transcript)")
          .option("--out <file>", "Write the value to this file instead; it must be ignored by Git")
      : cmd;

  /** Print a secret value under the host's output policy. */
  const emitSecret = (
    values: Record<string, string>,
    single: boolean,
    o: { reveal?: boolean; out?: string; raw?: boolean },
  ): void => {
    if (masked) {
      if (o.out) {
        const abs = client.assertIgnoredOutput(o.out);
        mkdirSync(dirname(abs), { recursive: true });
        const body = single
          ? (Object.values(values)[0] ?? "")
          : Object.entries(values)
              .map(([k, v]) => `${k.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}=${v}`)
              .join("\n");
        writeFileSync(abs, body.endsWith("\n") ? body : `${body}\n`, { mode: 0o600 });
        io.data({ ok: true, written: o.out, fields: Object.keys(values) });
        return;
      }
      const shown = Object.fromEntries(
        Object.entries(values).map(([k, v]) => [
          k,
          o.reveal ? v : v ? `${MASK} (${v.length} characters)` : "(empty)",
        ]),
      );
      io.data(single ? { ok: true, value: Object.values(shown)[0] } : { ok: true, fields: shown });
      return;
    }
    if (single) process.stdout.write(Object.values(values)[0] ?? "");
    else if (o.raw) process.stdout.write(JSON.stringify(values));
    else io.data(values);
  };

  const op = program.command("op").description("1Password access (op.exe on WSL, op elsewhere)");

  op.command("detect")
    .description(
      "Print the resolved 1Password CLI binary and the account and vault in use (honors $OP_BIN)",
    )
    .action(
      guarded("op_not_found", () => {
        const bin = client.detectOp();
        if (!bin) {
          fail(
            "op_not_found",
            "no 1Password CLI found (op / op.exe). Install it and turn on 'Integrate with 1Password CLI' in the 1Password app (Settings > Developer), or set $OP_BIN.",
          );
        }
        io.data({
          op: bin,
          account: resolveAccount() ?? "(op default)",
          vault: resolveVault() ?? null,
        });
      }),
    );

  secretFlags(
    itemFlags(
      op
        .command("get")
        .description(
          local
            ? "Read field value(s), preferring a registered local credential cache"
            : "Read field value(s)",
        ),
    ),
  )
    .requiredOption(
      "--field <label>",
      "Field label (repeatable; one gives the value, several give JSON)",
      collect,
      [],
    )
    .option("--live", "Bypass local credentials and read from 1Password")
    .option(
      "--raw",
      "Write multi-field JSON directly without redaction or history (for pull scripts)",
    )
    .action(
      guarded(
        "op_get_failed",
        async (o: {
          account?: string;
          vault?: string;
          item: string;
          field: string[];
          live?: boolean;
          raw?: boolean;
          reveal?: boolean;
          out?: string;
        }) => {
          const t = target(o);
          const cached = o.live || !local ? null : local.getLocalOpFields(t, o.field);
          const first = o.field[0] ?? "";
          const values =
            cached ??
            (o.field.length <= 1
              ? { [first]: await client.getField(t, first) }
              : await client.getFields(t, o.field));
          emitSecret(values, o.field.length <= 1, o);
        },
      ),
    );

  itemFlags(
    op
      .command("item")
      .description(
        local
          ? "Read a whole item, preferring a registered local credential cache"
          : "Read a whole item with secret values masked",
      )
      .option("--reveal", "Show concealed values instead of masking them")
      .option("--live", "Bypass local credentials and read from 1Password"),
  ).action(
    guarded(
      "op_item_failed",
      async (o: {
        account?: string;
        vault?: string;
        item: string;
        reveal?: boolean;
        live?: boolean;
      }) => {
        const t = target(o);
        const cached = o.live || !local ? null : local.getLocalOpItem(t);
        if (!cached) {
          io.data(await client.getItemFields(t, { reveal: o.reveal }));
          return;
        }
        const concealed = new Set(cached.concealed_fields);
        io.data({
          title: cached.item,
          category: cached.category,
          vault: cached.vault,
          fields: Object.fromEntries(
            Object.entries(cached.fields).map(([label, value]) => [
              label,
              !o.reveal && concealed.has(label) ? MASK : value,
            ]),
          ),
        });
      },
    ),
  );

  secretFlags(
    op
      .command("read")
      .description("Resolve a secret reference (op://vault/item/field) to its value")
      .argument("<reference>", "op://vault/item/field")
      .option("--account <name>", accountHelp),
  ).action(
    guarded(
      "op_read_failed",
      async (reference: string, o: { account?: string; reveal?: boolean; out?: string }) => {
        const value = await client.readReference(reference, resolveAccount(o.account));
        emitSecret({ value: masked ? value.replace(/\r?\n$/, "") : value }, true, o);
      },
    ),
  );

  itemFlags(op.command("otp").description("Current one-time password for an item")).action(
    guarded("op_otp_failed", async (o: { account?: string; vault?: string; item: string }) => {
      const code = await client.getOtp(target(o));
      if (masked) io.data({ ok: true, otp: code });
      else process.stdout.write(code);
    }),
  );

  const doc = op.command("document").description("Document item access");
  itemFlags(doc.command("get").description("Fetch a document's file (to stdout, or --out FILE)"))
    .option(
      "--out <path>",
      "Write to this file instead of stdout; inside the repository it must be ignored by Git",
    )
    .action(
      guarded(
        "op_document_failed",
        async (o: { account?: string; vault?: string; item: string; out?: string }) => {
          if (masked && !o.out)
            fail("missing_out", "pass --out <file>; this CLI does not print documents");
          if (o.out) mkdirSync(dirname(client.assertIgnoredOutput(o.out)), { recursive: true });
          const r = await client.getDocument(target(o), o.out);
          if (r.path) io.data({ ok: true, path: r.path });
          else process.stdout.write(r.content ?? "");
        },
      ),
    );

  accountFlags(op.command("items").description("List items (optionally within --vault)")).action(
    guarded("op_items_failed", async (o: { account?: string; vault?: string }) => {
      io.data({ rows: await client.listItems(scope(o)) });
    }),
  );

  accountFlags(
    op.command("search").description("Search items by title substring (case-insensitive)"),
  )
    .argument("<query>", "Title substring to match")
    .action(
      guarded(
        "op_search_failed",
        async (query: string, o: { account?: string; vault?: string }) => {
          io.data({ rows: await client.searchItems(scope(o), query) });
        },
      ),
    );

  op.command("vaults")
    .description("List vaults visible to the account")
    .option("--account <name>", accountHelp)
    .action(
      guarded("op_vaults_failed", async (o: { account?: string }) => {
        io.data({ rows: await client.listVaults(resolveAccount(o.account)) });
      }),
    );

  op.command("accounts")
    .description("List accounts configured on this machine (account_uuid works for --account)")
    .action(
      guarded("op_accounts_failed", async () => {
        io.data({ rows: await client.listAccounts() });
      }),
    );

  op.command("whoami")
    .description(
      "Current sign-in (signed_in: false is normal with desktop-app integration; reads still work)",
    )
    .option("--account <name>", accountHelp)
    .action(
      guarded("op_whoami_failed", async (o: { account?: string }) => {
        io.data(await client.whoami(resolveAccount(o.account)));
      }),
    );

  if (!writes) return op;

  itemFlags(
    op
      .command("set")
      .description(
        "Edit an item: set a field (--field with --value or --stdin), the title (--title), or both",
      )
      .option("--field <label>", "Field label to write")
      .option("--value <v>", "Value to store (omit with --stdin)")
      .option("--stdin", "Read the value from stdin (keeps secrets out of argv)")
      .option("--create", "Create the field if it does not exist")
      .option("--type <type>", "Field type when creating (text|concealed|email|url|...)", "text")
      .option("--minify", "If the value is JSON, store it compact")
      .option("--section <label>", "Place the field in this section (created only with --create)")
      .option("--dedupe", "Keep one matching field and remove duplicate labels during this write")
      .option("--title <title>", "Set the item title (alone, or alongside a field edit)")
      .option("--dry-run", "Preview the resulting item without writing"),
  ).action(
    guarded(
      "op_set_failed",
      async (o: {
        account?: string;
        vault?: string;
        item: string;
        field?: string;
        value?: string;
        stdin?: boolean;
        create?: boolean;
        type?: string;
        minify?: boolean;
        section?: string;
        dedupe?: boolean;
        title?: string;
        dryRun?: boolean;
      }) => {
        if (!o.field && o.title === undefined)
          fail("missing_change", "provide --field (with --value/--stdin) and/or --title");
        if (!o.field) {
          await client.setTitle(target(o), o.title as string, { dryRun: o.dryRun });
          io.data({ ok: true, item: o.item, title: o.title, dryRun: !!o.dryRun });
          return;
        }
        const value = o.stdin ? await readStdinText() : o.value;
        if (value === undefined)
          fail("missing_value", "provide --value <v> or --stdin (or --title alone)");
        const r = await client.setField(target(o), o.field, value as string, {
          minify: o.minify,
          create: o.create,
          type: o.type,
          section: o.section,
          dedupe: o.dedupe,
          title: o.title,
          dryRun: o.dryRun,
        });
        const mask = (v?: string) => (v === undefined ? undefined : r.concealed ? MASK : v);
        io.data({
          ok: true,
          item: o.item,
          field: o.field,
          created: r.created,
          changed: r.changed,
          deduplicated: r.deduplicated,
          before: mask(r.before),
          after: mask(r.after),
          title: o.title,
          dryRun: !!o.dryRun,
        });
      },
    ),
  );

  itemFlags(
    op
      .command("set-many")
      .description(
        "Batch-edit fields with one item fetch and one edit, to minimize approval prompts",
      )
      .option("--stdin", "Read the JSON batch from stdin so secrets stay out of argv")
      .option("--file <path>", "Read the JSON batch from an owner-only file")
      .option("--create", "Create every missing field unless its specification overrides this")
      .option("--dry-run", "Validate and preview through 1Password without writing"),
  ).action(
    guarded(
      "op_set_many_failed",
      async (o: {
        account?: string;
        vault?: string;
        item: string;
        stdin?: boolean;
        file?: string;
        create?: boolean;
        dryRun?: boolean;
      }) => {
        if (!!o.stdin === !!o.file) fail("bad_input", "pass exactly one of --stdin or --file");
        const payload = parseSetManyPayload(
          o.file ? readFileSync(o.file, "utf8") : await readStdinText(),
        );
        const updates = Object.entries(payload.fields).map(([field, input]) => ({
          field,
          ...(typeof input === "string" ? { value: input } : input),
        }));
        const result = await client.setFields(target(o), updates, {
          create: o.create,
          title: payload.title,
          dryRun: o.dryRun,
        });
        io.data({
          ok: true,
          item: o.item,
          fields: result.fields,
          created: result.fields.filter((f) => f.created).length,
          changed: result.fields.filter((f) => f.changed).length,
          title_changed: result.titleChanged,
          dryRun: !!o.dryRun,
        });
      },
    ),
  );

  accountFlags(doc.command("create").description("Create a document item from a local file"))
    .requiredOption("--file <path>", "Local file to upload as the document")
    .option("--title <title>", "Item title")
    .option("--file-name <name>", "Stored file name")
    .action(
      guarded(
        "op_document_create_failed",
        async (o: {
          account?: string;
          vault?: string;
          file: string;
          title?: string;
          fileName?: string;
        }) => {
          io.data({
            ok: true,
            ...(await client.createDocument(scope(o), o.file, {
              title: o.title,
              fileName: o.fileName,
            })),
          });
        },
      ),
    );

  accountFlags(
    op
      .command("create")
      .description(
        "Create an item. Repeat --field label=value; prefix the label with 'concealed:' for a secret",
      )
      .requiredOption("--title <title>", "Item title")
      .option(
        "--category <cat>",
        "Category (LOGIN, PASSWORD, API_CREDENTIAL, SECURE_NOTE, ...)",
        "LOGIN",
      )
      .option("--field <label=value>", "Field label=value (repeatable)", collect, [])
      .option("--tag <tag>", "Tag (repeatable)", collect, []),
  ).action(
    guarded(
      "op_create_failed",
      async (o: {
        account?: string;
        vault?: string;
        title: string;
        category?: string;
        field: string[];
        tag: string[];
      }) => {
        const fields = o.field.map((spec) => {
          const eq = spec.indexOf("=");
          if (eq < 0) fail("bad_field", `--field must be label=value (got: ${spec})`);
          let label = spec.slice(0, eq);
          let type = "STRING";
          if (label.startsWith("concealed:")) {
            label = label.slice("concealed:".length);
            type = "CONCEALED";
          }
          return { label, value: spec.slice(eq + 1), type };
        });
        io.data({
          ok: true,
          ...(await client.createItem(scope(o), {
            title: o.title,
            category: o.category,
            fields,
            tags: o.tag,
          })),
        });
      },
    ),
  );

  itemFlags(op.command("rename").description("Rename an item's title"))
    .requiredOption("--title <title>", "New item title")
    .option("--dry-run", "Preview without writing")
    .action(
      guarded(
        "op_rename_failed",
        async (o: {
          account?: string;
          vault?: string;
          item: string;
          title: string;
          dryRun?: boolean;
        }) => {
          await client.setTitle(target(o), o.title, { dryRun: o.dryRun });
          io.data({ ok: true, item: o.item, title: o.title, dryRun: !!o.dryRun });
        },
      ),
    );

  itemFlags(
    op.command("move").description("Move an item to another vault without revealing its fields"),
  )
    .requiredOption("--destination-vault <name>", "Vault that will receive the item")
    .action(
      guarded(
        "op_move_failed",
        async (o: { account?: string; vault?: string; item: string; destinationVault: string }) => {
          const t = target(o);
          await client.moveItem(t, o.destinationVault);
          io.data({ ok: true, item: o.item, from: t.vault, to: o.destinationVault });
        },
      ),
    );

  itemFlags(
    op
      .command("delete-field")
      .description("Delete a custom field; other fields are untouched")
      .requiredOption("--field <label>", "Field label to delete")
      .option("--dry-run", "Preview without writing")
      .option("--yes", "Confirm the delete (required unless --dry-run)"),
  ).action(
    guarded(
      "op_delete_field_failed",
      async (o: {
        account?: string;
        vault?: string;
        item: string;
        field: string;
        dryRun?: boolean;
        yes?: boolean;
      }) => {
        if (!o.yes && !o.dryRun) {
          fail(
            "confirmation_required",
            "refusing to delete a field without --yes (or use --dry-run to preview)",
          );
        }
        await client.deleteField(target(o), o.field, { dryRun: o.dryRun });
        io.data({ ok: true, item: o.item, field: o.field, deleted: !o.dryRun, dryRun: !!o.dryRun });
      },
    ),
  );

  itemFlags(op.command("share").description("Create a share link for an item"))
    .option("--expires-in <dur>", "Link lifetime, e.g. 1h / 7d / 30d")
    .option("--emails <csv>", "Restrict to these emails (comma-separated)")
    .option("--view-once", "Single-view link")
    .action(
      guarded(
        "op_share_failed",
        async (o: {
          account?: string;
          vault?: string;
          item: string;
          expiresIn?: string;
          emails?: string;
          viewOnce?: boolean;
        }) => {
          const url = await client.shareItem(target(o), {
            expiresIn: o.expiresIn,
            emails: o.emails
              ? o.emails
                  .split(",")
                  .map((e) => e.trim())
                  .filter(Boolean)
              : undefined,
            viewOnce: o.viewOnce,
          });
          io.data({ ok: true, item: o.item, url });
        },
      ),
    );

  return op;
}

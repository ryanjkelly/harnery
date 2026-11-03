import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectLabelDrift,
  explainEditFailure,
  fieldsInScope,
  isConcealed,
  opTemplateTransport,
  PASSWORD_PLACEHOLDER,
  resolveSection,
  sweepStaleEditDirs,
  withRequiredPassword,
} from "./client.ts";

describe("opTemplateTransport", () => {
  test("feeds op.exe the template on stdin and writes no temp file", () => {
    for (const op of [
      "op.exe",
      "/mnt/c/Program Files/1Password CLI/op.exe",
      "OP.EXE",
      "/mnt/c/Example/op-helper.exe",
    ]) {
      expect(opTemplateTransport(op)).toEqual({ stdin: "pipe", templateFile: false });
    }
  });

  test("gives native op a template file and ignores stdin", () => {
    for (const op of ["op", "/usr/bin/op", "/opt/homebrew/bin/op"]) {
      expect(opTemplateTransport(op)).toEqual({ stdin: "ignore", templateFile: true });
    }
  });

  test("does not mistake an op-suffixed path for the Windows binary", () => {
    expect(opTemplateTransport("/usr/bin/myop").templateFile).toBe(true);
    expect(opTemplateTransport("/usr/bin/opex").templateFile).toBe(true);
  });
});

describe("detectLabelDrift", () => {
  test("reports every label 1Password rewrote", () => {
    const requested = {
      fields: [
        { id: "username", label: "email" },
        { id: "password", label: "login password" },
      ],
    };
    const actual = {
      fields: [
        { id: "username", label: "username" },
        { id: "password", label: "password" },
      ],
    };
    expect(detectLabelDrift(requested, actual)).toEqual([
      { id: "username", requested: "email", actual: "username" },
      { id: "password", requested: "login password", actual: "password" },
    ]);
  });

  test("stays quiet when labels survive or fields disappear", () => {
    const item = { fields: [{ id: "abc123", label: "cli_config" }] };
    expect(detectLabelDrift(item, item)).toEqual([]);
    expect(detectLabelDrift(item, { fields: [] })).toEqual([]);
    expect(detectLabelDrift({}, {})).toEqual([]);
  });
});

describe("sweepStaleEditDirs", () => {
  const hour = 60 * 60 * 1000;
  const now = 1_756_500_000_000;

  function withRoot(fn: (root: string) => void): void {
    const root = mkdtempSync(join(tmpdir(), "op-sweep-test-"));
    try {
      fn(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  function makeDir(root: string, name: string, ageMs: number): string {
    const dir = join(root, name);
    mkdirSync(dir);
    writeFileSync(join(dir, "item.json"), "{}");
    const when = new Date(now - ageMs);
    utimesSync(dir, when, when);
    return dir;
  }

  test("removes an abandoned template directory", () => {
    withRoot((root) => {
      const stale = makeDir(root, "host-op-edit-old", 3 * hour);
      expect(sweepStaleEditDirs("host-op-edit-", root, now)).toBe(1);
      expect(existsSync(stale)).toBe(false);
    });
  });

  test("keeps recent and unrelated directories", () => {
    withRoot((root) => {
      const fresh = makeDir(root, "host-op-edit-live", 5 * 60 * 1000);
      const other = makeDir(root, "some-other-tool-cache", 3 * hour);
      expect(sweepStaleEditDirs("host-op-edit-", root, now)).toBe(0);
      expect(existsSync(fresh)).toBe(true);
      expect(existsSync(other)).toBe(true);
    });
  });

  test("keeps a just-created directory with no template yet", () => {
    withRoot((root) => {
      const dir = join(root, "host-op-edit-empty");
      mkdirSync(dir);
      const when = new Date(now);
      utimesSync(dir, when, when);
      expect(sweepStaleEditDirs("host-op-edit-", root, now)).toBe(0);
      expect(existsSync(dir)).toBe(true);
    });
  });

  test("returns zero for a missing root", () => {
    expect(sweepStaleEditDirs("host-op-edit-", join(tmpdir(), "op-sweep-absent-dir"), now)).toBe(0);
  });
});

describe("explainEditFailure", () => {
  test("explains the empty-password refusal and keeps op's own words", () => {
    const err =
      "[ERROR] Validation: Couldn't validate the item: Errors:{1. Password item requires ps value}";
    const msg = explainEditFailure(1, err);
    expect(msg).toContain("refuses every edit to a Password item whose password is empty");
    expect(msg).toContain(err);
    expect(explainEditFailure(1, err, "harn")).toContain("harn op fills one in");
  });
  test("passes any other failure through unchanged", () => {
    expect(explainEditFailure(1, "some other error\n")).toBe(
      "op item edit failed (exit 1): some other error",
    );
  });
});

describe("withRequiredPassword", () => {
  test("fills a Password item's empty built-in password, and nothing else", () => {
    const item = {
      category: "PASSWORD",
      fields: [
        { id: "password", type: "CONCEALED", purpose: "PASSWORD", label: "password" },
        { id: "k", type: "STRING", label: "cloudflare_account_id", value: "abc" },
      ],
    };
    const out = withRequiredPassword(item);
    expect(out.fields?.[0]?.value).toBe(PASSWORD_PLACEHOLDER);
    expect(out.fields?.[1]).toEqual(item.fields[1]!);
    expect("value" in item.fields[0]!).toBe(false); // the caller's item is left alone
  });
  test("adds the password to a new Password item that has none, and leaves a real one", () => {
    expect(withRequiredPassword({ category: "password", fields: [] }).fields?.[0]).toMatchObject({
      purpose: "PASSWORD",
      value: PASSWORD_PLACEHOLDER,
    });
    const real = {
      category: "PASSWORD",
      fields: [{ id: "password", purpose: "PASSWORD", value: "hunter2" }],
    };
    expect(withRequiredPassword(real)).toBe(real);
  });
  test("leaves other categories alone", () => {
    const login = { category: "LOGIN", fields: [{ id: "password", purpose: "PASSWORD" }] };
    expect(withRequiredPassword(login)).toBe(login);
  });
});

describe("OTP setup secret protection", () => {
  test("conceals OTP types, purposes and mislabeled setup URIs", () => {
    for (const field of [
      { type: "OTP" },
      { type: "TOTP" },
      { purpose: "OTP" },
      { purpose: "TOTP" },
      { type: "STRING", value: "otpauth://totp/Test?secret=FAKE" },
    ])
      expect(isConcealed(field)).toBe(true);
    expect(isConcealed({ type: "STRING", value: "ordinary text" })).toBe(false);
  });
});

describe("resolveSection", () => {
  const login = () => ({
    sections: [{ id: "add_more", label: "More" }],
    fields: [
      { id: "password", label: "password", purpose: "PASSWORD", value: "web-login" },
      { id: "f1", label: "note", value: "x", section: { id: "add_more", label: "More" } },
    ],
  });

  test("finds an existing section by label", () => {
    expect(resolveSection(login(), "More")).toEqual({ id: "add_more", label: "More" });
  });

  test("fails closed on a missing section without create", () => {
    expect(() => resolveSection(login(), "SFTP drop")).toThrow(
      /section not found on item: SFTP drop/,
    );
  });

  test("adds a missing section with create, with a fresh id", () => {
    const item = login();
    const created = resolveSection(item, "SFTP drop", { create: true });
    expect(created).toEqual({ id: "add_sftp_drop", label: "SFTP drop" });
    expect(item.sections as Array<{ id?: string; label?: string }>).toContainEqual(created!);
    expect(resolveSection(item, "SFTP drop", { create: true })).toBe(created);
  });

  test("never reuses a taken section id", () => {
    const item = { sections: [{ id: "add_sftp_drop", label: "Old" }], fields: [] };
    expect(resolveSection(item, "SFTP drop", { create: true })?.id).toBe("add_sftp_drop_2");
  });
});

describe("fieldsInScope", () => {
  const item = {
    sections: [{ id: "s1", label: "SFTP drop" }],
    fields: [
      { id: "password", label: "password", purpose: "PASSWORD", value: "web-login" },
      { id: "f2", label: "password", value: "sftp", section: { id: "s1", label: "SFTP drop" } },
    ],
  };

  test("a sectioned lookup ignores the same label elsewhere on the item", () => {
    const matches = fieldsInScope(item, "password", { id: "s1", label: "SFTP drop" });
    expect(matches.map((f) => f.value)).toEqual(["sftp"]);
  });

  test("a new section matches nothing, so a write creates instead of overwriting", () => {
    expect(fieldsInScope(item, "password", { id: "add_new", label: "New" })).toEqual([]);
  });

  test("an unsectioned lookup keeps the item-wide behavior", () => {
    expect(fieldsInScope(item, "password")).toHaveLength(2);
  });
});

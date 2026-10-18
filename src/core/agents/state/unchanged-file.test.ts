import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { resetStorageSharing, stateFileMode } from "../../storage/modes.ts";
import {
  captureFileRevision,
  deleteFileIfUnchanged,
  fileRevisionMatches,
  recoverInterruptedFileDeletions,
} from "./unchanged-file.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "harnery-unchanged-file-"));
  roots.push(root);
  const path = join(root, "heartbeat.json");
  writeFileSync(path, "stale");
  const revision = captureFileRevision(path);
  if (!revision) throw new Error("fixture_revision_missing");
  return { root, path, revision };
}

function publish(path: string, content: string) {
  const temp = `${path}.new`;
  writeFileSync(temp, content);
  renameSync(temp, path);
}

function pinIn(root: string): string {
  const name = readdirSync(root).find((name) => name.startsWith(".harnery-delete-"));
  if (!name) throw new Error("fixture_pin_missing");
  return join(root, name, "pinned");
}

describe("stable file revisions", () => {
  test("captures exact raw bytes and detects a same-byte replacement revision", () => {
    const { path, revision } = fixture();
    expect(revision.bytes.toString()).toBe("stale");
    expect(fileRevisionMatches(path, revision)).toBeTrue();
    publish(path, "stale");
    expect(fileRevisionMatches(path, revision)).toBeFalse();
    expect(deleteFileIfUnchanged(path, revision, () => true).state).toBe("changed");
    expect(readFileSync(path, "utf8")).toBe("stale");
  });

  test("detects changed bytes and a metadata-only revision", () => {
    const { path, revision } = fixture();
    writeFileSync(path, "fresh");
    expect(fileRevisionMatches(path, revision)).toBeFalse();
    const fresh = captureFileRevision(path);
    if (!fresh) throw new Error("fixture_revision_missing");
    const timestamp = new Date("2020-01-01T00:00:00Z");
    utimesSync(path, timestamp, timestamp);
    expect(fileRevisionMatches(path, fresh)).toBeFalse();
    expect(deleteFileIfUnchanged(path, fresh, () => true).state).toBe("changed");
  });

  test("rejects a pathname replacement during descriptor reading", () => {
    const { path } = fixture();
    const original = fs.readFileSync;
    let injected = false;
    const read = spyOn(fs, "readFileSync").mockImplementation(((...args: unknown[]) => {
      const result = Reflect.apply(original, fs, args);
      if (!injected && typeof args[0] === "number") {
        injected = true;
        publish(path, "fresh");
      }
      return result;
    }) as typeof fs.readFileSync);
    try {
      expect(captureFileRevision(path)).toBeNull();
    } finally {
      read.mockRestore();
    }
    expect(injected).toBeTrue();
    expect(readFileSync(path, "utf8")).toBe("fresh");
  });
});

describe("conditional file deletion custody", () => {
  test.skipIf(process.platform === "win32")(
    "takes manifest mode from state policy inside an owner-only pin directory",
    () => {
      const previousSharing = process.env.HARNERY_STORAGE_SHARING;
      const previousUmask = process.umask();
      process.env.HARNERY_STORAGE_SHARING = "group";
      resetStorageSharing();
      try {
        const { root, path, revision } = fixture();
        expect(
          deleteFileIfUnchanged(path, revision, () => {
            const pin = pinIn(root);
            expect(fs.statSync(join(pin, "..", "intent.json")).mode & 0o777).toBe(stateFileMode());
            expect(fs.statSync(join(pin, "..")).mode & 0o777).toBe(0o700);
            return false;
          }).state,
        ).toBe("rejected");
        expect(readFileSync(path, "utf8")).toBe("stale");
      } finally {
        if (previousSharing === undefined) delete process.env.HARNERY_STORAGE_SHARING;
        else process.env.HARNERY_STORAGE_SHARING = previousSharing;
        process.umask(previousUmask);
        resetStorageSharing();
      }
    },
  );

  test("deletes only an unchanged regular file and removes its private directory", () => {
    const { root, path, revision } = fixture();
    let validated = false;
    const result = deleteFileIfUnchanged(path, revision, (pinned) => {
      validated = true;
      expect(existsSync(path)).toBeFalse();
      expect(pinned.bytes).toEqual(revision.bytes);
      return true;
    });
    expect(result.state).toBe("deleted");
    expect(validated).toBeTrue();
    expect(readdirSync(root)).toEqual([]);
  });

  test("restores a fresh publication moved at the final rename boundary", () => {
    const { root, path, revision } = fixture();
    const original = fs.renameSync;
    let injected = false;
    let validated = false;
    const rename = spyOn(fs, "renameSync").mockImplementation((source, target) => {
      if (source === path) {
        injected = true;
        writeFileSync(`${path}.new`, "fresh");
        original(`${path}.new`, path);
      }
      return original(source, target);
    });
    try {
      expect(
        deleteFileIfUnchanged(path, revision, () => {
          validated = true;
          return true;
        }).state,
      ).toBe("changed");
    } finally {
      rename.mockRestore();
    }
    expect(injected).toBeTrue();
    expect(validated).toBeFalse();
    expect(readFileSync(path, "utf8")).toBe("fresh");
    expect(readdirSync(root)).toEqual(["heartbeat.json"]);
  });

  test("preserves a later live replacement and keeps the collided pin as evidence", () => {
    const { root, path, revision } = fixture();
    const result = deleteFileIfUnchanged(path, revision, () => {
      publish(path, "fresh");
      return true;
    });
    expect(result.state).toBe("recovery-required");
    expect(readFileSync(path, "utf8")).toBe("fresh");
    expect(readFileSync(pinIn(root), "utf8")).toBe("stale");
    const recovered = recoverInterruptedFileDeletions(root, (source) => source === path);
    expect(recovered[0]?.state).toBe("retained");
    expect(recovered[0]?.sourcePath).toBe(path);
    expect(readFileSync(path, "utf8")).toBe("fresh");
  });

  test("keeps a live publication injected immediately before private unlink", () => {
    const { root, path, revision } = fixture();
    const original = fs.unlinkSync;
    let injected = false;
    const unlink = spyOn(fs, "unlinkSync").mockImplementation((target) => {
      if (basename(String(target)) === "pinned") {
        injected = true;
        publish(path, "fresh");
      }
      return original(target);
    });
    try {
      expect(deleteFileIfUnchanged(path, revision, () => true).state).toBe("changed");
    } finally {
      unlink.mockRestore();
    }
    expect(injected).toBeTrue();
    expect(readFileSync(path, "utf8")).toBe("fresh");
    expect(readdirSync(root)).toEqual(["heartbeat.json"]);
  });

  test("restores a pin when required authority refuses or throws", () => {
    const { root, path, revision } = fixture();
    expect(deleteFileIfUnchanged(path, revision, () => false).state).toBe("rejected");
    const nextRevision = captureFileRevision(path);
    if (!nextRevision) throw new Error("fixture_revision_missing");
    expect(
      deleteFileIfUnchanged(path, nextRevision, () => {
        throw new Error("authority_unavailable");
      }),
    ).toEqual({ state: "error", error: "authority_unavailable" });
    expect(readFileSync(path, "utf8")).toBe("stale");
    expect(readdirSync(root)).toEqual(["heartbeat.json"]);
  });

  test("restores changed pinned bytes instead of deleting them", () => {
    const { root, path, revision } = fixture();
    expect(
      deleteFileIfUnchanged(path, revision, () => {
        writeFileSync(pinIn(root), "changed pin");
        return true;
      }).state,
    ).toBe("changed");
    expect(readFileSync(path, "utf8")).toBe("changed pin");
  });

  test("restores after a private unlink error", () => {
    const { path, revision } = fixture();
    const original = fs.unlinkSync;
    let injected = false;
    const unlink = spyOn(fs, "unlinkSync").mockImplementation((target) => {
      if (!injected && basename(String(target)) === "pinned") {
        injected = true;
        throw Object.assign(new Error("unlink_denied"), { code: "EACCES" });
      }
      return original(target);
    });
    try {
      expect(deleteFileIfUnchanged(path, revision, () => true)).toEqual({
        state: "error",
        error: "unlink_denied",
      });
    } finally {
      unlink.mockRestore();
    }
    expect(injected).toBeTrue();
    expect(readFileSync(path, "utf8")).toBe("stale");
  });

  test("retains a failed restoration and recovers it on the next authorized pass", () => {
    const { root, path, revision } = fixture();
    const link = spyOn(fs, "linkSync").mockImplementation(() => {
      throw Object.assign(new Error("link_denied"), { code: "EACCES" });
    });
    try {
      expect(deleteFileIfUnchanged(path, revision, () => false).state).toBe("recovery-required");
    } finally {
      link.mockRestore();
    }
    expect(existsSync(path)).toBeFalse();
    expect(readFileSync(pinIn(root), "utf8")).toBe("stale");
    expect(recoverInterruptedFileDeletions(root, () => false)[0]?.state).toBe("retained");
    expect(existsSync(path)).toBeFalse();
    expect(recoverInterruptedFileDeletions(root, (source) => source === path)[0]?.state).toBe(
      "restored",
    );
    expect(readFileSync(path, "utf8")).toBe("stale");
    expect(readdirSync(root)).toEqual(["heartbeat.json"]);
  });

  test("reports an active owner without restoring its in-flight pin", () => {
    const { root, path, revision } = fixture();
    const result = deleteFileIfUnchanged(path, revision, () => {
      const recovered = recoverInterruptedFileDeletions(root, () => true);
      expect(recovered).toEqual([
        {
          state: "retained",
          sourcePath: path,
          recoveryPath: pinIn(root),
          error: "file_deletion_owner_alive",
        },
      ]);
      expect(existsSync(path)).toBeFalse();
      return false;
    });
    expect(result.state).toBe("rejected");
    expect(readFileSync(path, "utf8")).toBe("stale");
  });

  test("reports unknown owner liveness without trying to recover its pin", () => {
    const { root, path, revision } = fixture();
    const result = deleteFileIfUnchanged(path, revision, () => {
      const kill = spyOn(process, "kill").mockImplementation(() => {
        throw Object.assign(new Error("owner_denied"), { code: "EPERM" });
      });
      try {
        expect(recoverInterruptedFileDeletions(root, () => true)).toEqual([
          {
            state: "retained",
            sourcePath: path,
            recoveryPath: pinIn(root),
            error: "file_deletion_owner_unknown",
          },
        ]);
        expect(existsSync(path)).toBeFalse();
      } finally {
        kill.mockRestore();
      }
      return false;
    });
    expect(result.state).toBe("rejected");
    expect(readFileSync(path, "utf8")).toBe("stale");
  });

  for (const provenance of ["host", "platform", "namespace", "missing"] as const) {
    test(`retains ${provenance} owner provenance without probing a local PID`, () => {
      const { root, path, revision } = fixture();
      const link = spyOn(fs, "linkSync").mockImplementation(() => {
        throw new Error("retain_for_test");
      });
      try {
        expect(deleteFileIfUnchanged(path, revision, () => false).state).toBe("recovery-required");
      } finally {
        link.mockRestore();
      }
      const pin = pinIn(root);
      const manifest = join(pin, "..", "intent.json");
      const intent = JSON.parse(readFileSync(manifest, "utf8"));
      intent.state = "active";
      if (provenance === "host") intent.ownerHost = `${intent.ownerHost}-other`;
      if (provenance === "platform") intent.ownerPlatform = `${intent.ownerPlatform}-other`;
      if (provenance === "namespace") intent.ownerProcessNamespace = "other-namespace";
      if (provenance === "missing") delete intent.ownerHost;
      writeFileSync(manifest, JSON.stringify(intent));
      const kill = spyOn(process, "kill");
      try {
        expect(recoverInterruptedFileDeletions(root, () => true)).toEqual([
          {
            state: "retained",
            sourcePath: path,
            recoveryPath: pin,
            error:
              provenance === "missing"
                ? "file_deletion_owner_unknown"
                : "file_deletion_owner_foreign",
          },
        ]);
        expect(kill).not.toHaveBeenCalled();
      } finally {
        kill.mockRestore();
      }
      expect(existsSync(path)).toBeFalse();
      expect(readFileSync(pin, "utf8")).toBe("stale");
    });
  }

  test("finishes a recovery interrupted after linking the original name", () => {
    const { root, path, revision } = fixture();
    const original = fs.unlinkSync;
    const unlink = spyOn(fs, "unlinkSync").mockImplementation((target) => {
      if (basename(String(target)) === "pinned") {
        throw Object.assign(new Error("cleanup_denied"), { code: "EACCES" });
      }
      return original(target);
    });
    try {
      expect(deleteFileIfUnchanged(path, revision, () => false).state).toBe("recovery-required");
    } finally {
      unlink.mockRestore();
    }
    expect(readFileSync(path, "utf8")).toBe("stale");
    expect(readFileSync(pinIn(root), "utf8")).toBe("stale");
    expect(recoverInterruptedFileDeletions(root, (source) => source === path)[0]?.state).toBe(
      "restored",
    );
    expect(readdirSync(root)).toEqual(["heartbeat.json"]);
  });

  test("recovers a pin after its process is killed at the custody boundary", async () => {
    const { root, path } = fixture();
    const moduleUrl = new URL("./unchanged-file.ts", import.meta.url).href;
    const source = `
      const { captureFileRevision, deleteFileIfUnchanged } = await import(${JSON.stringify(moduleUrl)});
      const path = ${JSON.stringify(path)};
      deleteFileIfUnchanged(path, captureFileRevision(path), () => {
        console.log("pin-ready");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
        return true;
      });
    `;
    const child = spawn(process.execPath, ["--eval", source], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      await new Promise<void>((resolve, reject) => {
        child.stdout.once("data", (data) => {
          if (data.toString().includes("pin-ready")) resolve();
          else reject(new Error(data.toString()));
        });
        child.once("error", reject);
        child.once("exit", (code) => reject(new Error(`fixture_exited_before_pin:${code}`)));
      });
      expect(existsSync(path)).toBeFalse();
      expect(recoverInterruptedFileDeletions(root, () => true)[0]?.state).toBe("retained");
      const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
      child.kill("SIGKILL");
      await closed;
      expect(recoverInterruptedFileDeletions(root, (source) => source === path)[0]?.state).toBe(
        "restored",
      );
      expect(readFileSync(path, "utf8")).toBe("stale");
      expect(readdirSync(root)).toEqual(["heartbeat.json"]);
    } finally {
      child.kill("SIGKILL");
    }
  });
});

describe("file deletion path boundaries", () => {
  test("requires a validation callback at runtime as well as in its type", () => {
    const { root, path, revision } = fixture();
    expect(deleteFileIfUnchanged(path, revision, undefined as never).state).toBe("rejected");
    expect(readFileSync(path, "utf8")).toBe("stale");
    expect(recoverInterruptedFileDeletions(root, undefined as never)).toEqual([]);
  });

  test("rejects symlinks without touching their targets", () => {
    const { root, path, revision } = fixture();
    const link = join(root, "link.json");
    symlinkSync(path, link);
    expect(captureFileRevision(link)).toBeNull();
    expect(deleteFileIfUnchanged(link, revision, () => true).state).toBe("rejected");
    expect(readFileSync(path, "utf8")).toBe("stale");
    expect(existsSync(link)).toBeTrue();
  });

  test("rejects symlink parents and protocol-private deletion paths", () => {
    const { root, path, revision } = fixture();
    const alias = join(root, "alias");
    symlinkSync(root, alias, "dir");
    expect(deleteFileIfUnchanged(join(alias, "heartbeat.json"), revision, () => true).state).toBe(
      "rejected",
    );
    deleteFileIfUnchanged(path, revision, () => {
      const pin = pinIn(root);
      const pinned = captureFileRevision(pin);
      if (!pinned) throw new Error("fixture_pin_missing");
      expect(deleteFileIfUnchanged(pin, pinned, () => true).state).toBe("rejected");
      return false;
    });
    expect(readFileSync(path, "utf8")).toBe("stale");
  });

  test("does not follow a symlink substituted for its pinned inode", () => {
    const { root, path, revision } = fixture();
    const target = join(root, "target");
    writeFileSync(target, "keep target");
    const result = deleteFileIfUnchanged(path, revision, () => {
      const pin = pinIn(root);
      fs.unlinkSync(pin);
      symlinkSync(target, pin);
      return true;
    });
    expect(result.state).toBe("recovery-required");
    expect(readFileSync(target, "utf8")).toBe("keep target");
    const recovery = recoverInterruptedFileDeletions(root, () => true);
    expect(recovery[0]?.state).toBe("retained");
    expect(recovery[0]?.sourcePath).toBe(path);
    expect(readFileSync(target, "utf8")).toBe("keep target");
  });

  test("refuses a replacement private directory with the same protocol name", () => {
    const { root, path, revision } = fixture();
    let movedPin = "";
    let replacementPin = "";
    const result = deleteFileIfUnchanged(path, revision, () => {
      const pin = pinIn(root);
      const directory = join(pin, "..");
      const moved = `${directory}.saved`;
      renameSync(directory, moved);
      movedPin = join(moved, "pinned");
      mkdirSync(directory, { mode: 0o700 });
      replacementPin = join(directory, "pinned");
      writeFileSync(replacementPin, "keep replacement");
      writeFileSync(join(directory, "intent.json"), "keep manifest");
      return true;
    });
    expect(result.state).toBe("recovery-required");
    expect(readFileSync(replacementPin, "utf8")).toBe("keep replacement");
    expect(readFileSync(join(replacementPin, "..", "intent.json"), "utf8")).toBe("keep manifest");
    expect(readFileSync(movedPin, "utf8")).toBe("stale");
    expect(existsSync(path)).toBeFalse();
  });

  test("does not trust manifest path traversal or a symlinked private directory", () => {
    const { root, path, revision } = fixture();
    const link = spyOn(fs, "linkSync").mockImplementation(() => {
      throw new Error("retain_for_test");
    });
    try {
      deleteFileIfUnchanged(path, revision, () => false);
    } finally {
      link.mockRestore();
    }
    const pin = pinIn(root);
    const manifest = join(pin, "..", "intent.json");
    const intent = JSON.parse(readFileSync(manifest, "utf8"));
    writeFileSync(manifest, JSON.stringify({ ...intent, source: "../outside" }));
    expect(recoverInterruptedFileDeletions(root, () => true)).toEqual([
      { state: "error", recoveryPath: pin, error: "file_deletion_manifest_invalid" },
    ]);
    expect(readFileSync(pin, "utf8")).toBe("stale");
    const alias = join(root, ".harnery-delete-ABC123");
    symlinkSync(join(pin, ".."), alias, "dir");
    expect(recoverInterruptedFileDeletions(root, () => true)).toEqual([
      { state: "error", recoveryPath: pin, error: "file_deletion_manifest_invalid" },
    ]);
    expect(existsSync(alias)).toBeTrue();
  });
});

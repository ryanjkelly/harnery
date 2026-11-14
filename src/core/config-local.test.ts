import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeDir } from "../../tests/helpers/remove-dir.ts";
import {
  coordFreshnessSeconds,
  inspectTimeZone,
  localConfigExists,
  pinnedBinName,
  presenceRemoteDetail,
  readAdmissionConfig,
  readLocalConfig,
  resolveBinName,
  storageSharing,
} from "./config.ts";

const dirs: string[] = [];
const saved = {
  xdg: process.env.XDG_CONFIG_HOME,
  bin: process.env.HARNERY_BIN,
  tz: process.env.HARNERY_TIME_ZONE,
  fresh: process.env.HARNERY_AGENT_COORD_FRESHNESS,
  detail: process.env.HARNERY_PRESENCE_REMOTE_DETAIL,
  sharing: process.env.HARNERY_STORAGE_SHARING,
};
let userHome: string;

function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

beforeEach(() => {
  userHome = mkdtempSync(join(tmpdir(), "harnery-local-user-"));
  dirs.push(userHome);
  process.env.XDG_CONFIG_HOME = userHome;
  for (const key of [
    "HARNERY_BIN",
    "HARNERY_TIME_ZONE",
    "HARNERY_AGENT_COORD_FRESHNESS",
    "HARNERY_PRESENCE_REMOTE_DETAIL",
    "HARNERY_STORAGE_SHARING",
  ]) {
    delete process.env[key];
  }
});

afterEach(() => {
  for (const d of dirs.splice(0)) removeDir(d);
  restore("XDG_CONFIG_HOME", saved.xdg);
  restore("HARNERY_BIN", saved.bin);
  restore("HARNERY_TIME_ZONE", saved.tz);
  restore("HARNERY_AGENT_COORD_FRESHNESS", saved.fresh);
  restore("HARNERY_PRESENCE_REMOTE_DETAIL", saved.detail);
  restore("HARNERY_STORAGE_SHARING", saved.sharing);
});

function makeRoot(files: { project?: string; local?: string; user?: string }): string {
  const root = mkdtempSync(join(tmpdir(), "harnery-local-"));
  dirs.push(root);
  mkdirSync(join(root, ".harnery"), { recursive: true });
  if (files.project !== undefined) {
    writeFileSync(join(root, ".harnery", "config.jsonc"), files.project);
  }
  if (files.local !== undefined) {
    writeFileSync(join(root, ".harnery", "config.local.jsonc"), files.local);
  }
  if (files.user !== undefined) {
    mkdirSync(join(userHome, "harnery"), { recursive: true });
    writeFileSync(join(userHome, "harnery", "config.jsonc"), files.user);
  }
  return root;
}

describe("machine-local config layer", () => {
  test("local wins over project, which wins over user, field by field", () => {
    const root = makeRoot({
      user: `{ "coord": { "freshness_seconds": 100 }, "presence": { "remote_detail": "off" } }`,
      project: `{ "coord": { "freshness_seconds": 200 }, "presence": { "remote_detail": "full" } }`,
      local: `// this laptop\n{ "presence": { "remote_detail": "summary" } }`,
    });
    expect(presenceRemoteDetail(root)).toBe("summary");
    // Local sets nothing under coord, so the project value survives the merge.
    expect(coordFreshnessSeconds(root)).toBe(200);
  });

  test("a project binName pin ignores the local file", () => {
    const root = makeRoot({
      project: `{ "binName": "proj" }`,
      local: `{ "binName": "mine" }`,
    });
    expect(pinnedBinName(root)).toBe("proj");
    // The ordinary resolver still sees the merged value.
    expect(resolveBinName(root)).toBe("mine");
  });

  test("trust-boundary readers stay project-only", () => {
    const root = makeRoot({ project: `{}`, local: `{ "storage": { "sharing": "group" } }` });
    expect(storageSharing(root)).toBe("private");
  });

  test("admission reads project plus local and ignores the user file", () => {
    const root = makeRoot({
      user: `{ "admission": { "resources": { "build": { "capacity": 9 } } } }`,
      project: `{ "admission": {
        "resources": { "build": { "capacity": 2, "timeout_minutes": 30,
          "defer_on_pressure": { "psi_full_avg10": 40, "max_wait_seconds": 300 } } },
        "guard": { "resource": "build" } } }`,
      local: `{ "admission": { "resources": { "build": { "capacity": 1 } } } }`,
    });
    expect(readAdmissionConfig(root)).toEqual({
      resources: {
        build: {
          capacity: 1,
          timeout_minutes: 30,
          defer_on_pressure: { psi_full_avg10: 40, max_wait_seconds: 300 },
        },
      },
      guard: { resource: "build" },
    });
  });

  test("admission comes from the user file never, even with no project block", () => {
    const root = makeRoot({
      user: `{ "admission": { "resources": { "build": { "capacity": 9 } } } }`,
      project: `{}`,
    });
    expect(readAdmissionConfig(root)).toBeUndefined();
  });

  test("time zone: local beats project", () => {
    const root = makeRoot({
      project: `{ "timeZone": "Europe/Berlin" }`,
      local: `{ "timeZone": "Asia/Tokyo" }`,
    });
    const tz = inspectTimeZone(root);
    expect(tz.zone).toBe("Asia/Tokyo");
    expect(tz.source).toBe("local");
  });

  test("readLocalConfig and localConfigExists", () => {
    const none = makeRoot({ project: `{}` });
    expect(localConfigExists(none)).toBe(false);
    expect(readLocalConfig(none)).toEqual({});
    const broken = makeRoot({ project: `{}`, local: `{ not json` });
    expect(localConfigExists(broken)).toBe(true);
    expect(readLocalConfig(broken)).toEqual({});
  });
});

describe("presenceRemoteDetail", () => {
  test("defaults to full and rejects unknown values", () => {
    expect(presenceRemoteDetail(makeRoot({ project: `{}` }))).toBe("full");
    expect(
      presenceRemoteDetail(makeRoot({ project: `{ "presence": { "remote_detail": "loud" } }` })),
    ).toBe("full");
  });

  test("the environment variable wins", () => {
    const root = makeRoot({ project: `{ "presence": { "remote_detail": "summary" } }` });
    process.env.HARNERY_PRESENCE_REMOTE_DETAIL = "off";
    expect(presenceRemoteDetail(root)).toBe("off");
  });
});

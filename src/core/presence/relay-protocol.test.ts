import { describe, expect, test } from "bun:test";
import {
  computeSenderId,
  decryptPayload,
  deriveRoomCredentials,
  encryptPayload,
  isValidRoomId,
  MAX_FRAME_BYTES,
  normalizeOriginUrl,
  parseRelayFrame,
} from "./relay-protocol.ts";

const REPO = {
  rootCommitSha: "a94a8fe5ccb19ba61c4c0873d391e987982fbbd3",
  originUrl: "git@github.com:SomeOrg/some-repo.git",
};

describe("normalizeOriginUrl", () => {
  test("ssh scp-form, ssh url, and https all normalize identically", () => {
    const expected = "github.com/someorg/some-repo";
    expect(normalizeOriginUrl("git@github.com:SomeOrg/some-repo.git")).toBe(expected);
    expect(normalizeOriginUrl("ssh://git@github.com/SomeOrg/some-repo.git")).toBe(expected);
    expect(normalizeOriginUrl("https://github.com/SomeOrg/some-repo")).toBe(expected);
    expect(normalizeOriginUrl("https://user@github.com/SomeOrg/some-repo.git/")).toBe(expected);
  });

  test("explicit ports are dropped", () => {
    expect(normalizeOriginUrl("ssh://git@example.com:2222/org/repo.git")).toBe(
      "example.com/org/repo",
    );
  });
});

describe("deriveRoomCredentials", () => {
  test("deterministic: same inputs → same room id", async () => {
    const a = await deriveRoomCredentials(REPO);
    const b = await deriveRoomCredentials({
      ...REPO,
      originUrl: "https://github.com/someorg/some-repo",
    });
    expect(a.roomId).toBe(b.roomId);
    expect(isValidRoomId(a.roomId)).toBe(true);
  });

  test("different salt → different room", async () => {
    const a = await deriveRoomCredentials(REPO);
    const b = await deriveRoomCredentials({ ...REPO, salt: "rotated-2026" });
    expect(a.roomId).not.toBe(b.roomId);
  });

  test("different repo → different room", async () => {
    const a = await deriveRoomCredentials(REPO);
    const b = await deriveRoomCredentials({
      ...REPO,
      rootCommitSha: "b94a8fe5ccb19ba61c4c0873d391e987982fbbd3",
    });
    expect(a.roomId).not.toBe(b.roomId);
  });
});

describe("payload encryption", () => {
  test("round-trips through encrypt/decrypt", async () => {
    const creds = await deriveRoomCredentials(REPO);
    const frame = await encryptPayload(creds, '{"machine":"m-a","agents":[]}');
    expect(await decryptPayload(creds, frame)).toBe('{"machine":"m-a","agents":[]}');
  });

  test("wrong room key fails closed (null, no throw)", async () => {
    const creds = await deriveRoomCredentials(REPO);
    const other = await deriveRoomCredentials({ ...REPO, salt: "other" });
    const frame = await encryptPayload(creds, "secret");
    expect(await decryptPayload(other, frame)).toBeNull();
  });

  test("tampered ciphertext fails closed", async () => {
    const creds = await deriveRoomCredentials(REPO);
    const frame = await encryptPayload(creds, "secret");
    const tampered = { ...frame, ct: `${frame.ct.slice(0, -4)}AAAA` };
    expect(await decryptPayload(creds, tampered)).toBeNull();
  });
});

describe("computeSenderId", () => {
  test("stable per machine, opaque, differs across rooms", async () => {
    const creds = await deriveRoomCredentials(REPO);
    const a1 = await computeSenderId(creds, "machine-a");
    const a2 = await computeSenderId(creds, "machine-a");
    const b = await computeSenderId(creds, "machine-b");
    expect(a1).toBe(a2);
    expect(a1).not.toBe(b);
    expect(a1).not.toContain("machine");
    const otherRoom = await deriveRoomCredentials({ ...REPO, salt: "other" });
    expect(await computeSenderId(otherRoom, "machine-a")).not.toBe(a1);
  });
});

describe("parseRelayFrame", () => {
  test("accepts a valid pub frame", () => {
    const f = parseRelayFrame(JSON.stringify({ t: "pub", sender: "ab12", iv: "aXY=", ct: "bZ0=" }));
    expect(f).toEqual({ t: "pub", sender: "ab12", iv: "aXY=", ct: "bZ0=" });
  });

  test("rejects junk, oversize, and missing fields", () => {
    expect(parseRelayFrame("not json")).toBeNull();
    expect(parseRelayFrame(JSON.stringify({ t: "pub", sender: "x" }))).toBeNull();
    expect(parseRelayFrame(JSON.stringify({ t: "nope" }))).toBeNull();
    expect(
      parseRelayFrame(`{"t":"pub","sender":"x","iv":"a","ct":"${"A".repeat(MAX_FRAME_BYTES)}"}`),
    ).toBeNull();
  });

  test("accepts hello", () => {
    expect(parseRelayFrame(JSON.stringify({ t: "hello", peers: 2 }))).toEqual({
      t: "hello",
      peers: 2,
    });
  });
});

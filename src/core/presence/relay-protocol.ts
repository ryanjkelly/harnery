/**
 * Relay protocol for cross-machine presence (ADR 0016, phase 2): the shared,
 * host-agnostic logic both relay hosts (the Cloudflare Durable Objects worker
 * and `harn relay serve`) and the client transport build on.
 *
 * Capability-based rooms: the room id and the E2E symmetric key are BOTH
 * derived client-side via HKDF-SHA256 from (repo root-commit SHA, normalized
 * origin URL, a rotatable salt). Anyone who can read the repo can derive them;
 * nobody else can — including the relay operator, who sees only an opaque
 * room id, opaque sender ids, and AES-GCM ciphertext. Rotating the salt
 * rotates the room.
 *
 * The committed salt is NOT a secret and must never be treated as one: the
 * derivation needs the root-commit SHA + origin URL too, which only
 * repo-readers have. Repo access is the trust boundary (same as the git-refs
 * transport).
 *
 * Wire format (JSON text frames over WebSocket):
 *   client → relay:  { t: "pub", sender, iv, ct }        broadcast + cache
 *   relay  → client: { t: "pub", sender, iv, ct }        live or warm-join replay
 *   relay  → client: { t: "hello", peers }               on join (peer count)
 * The relay never sees plaintext: `ct` is AES-GCM over the presence-blob JSON,
 * `sender` is an HMAC-derived opaque id, `iv` is the per-message nonce.
 *
 * Uses WebCrypto only (globalThis.crypto.subtle) so the same module runs on
 * Bun, Node ≥ 20, and Cloudflare Workers.
 */

const ROOM_INFO = "harnery-presence/room-id/v1";
const KEY_INFO = "harnery-presence/room-key/v1";
const SENDER_INFO = "harnery-presence/sender-id/v1";
const HKDF_SALT = "harnery-presence/hkdf-salt/v1";

/** Default derivation salt when a repo hasn't minted `.harnery/presence-salt`.
 * Public by design (see module docs); committing a random per-repo salt just
 * rotates the room away from anything derived before. */
export const DEFAULT_ROOM_SALT = "harnery-presence-salt/v1";

export interface RoomInputs {
  /** SHA of the repo's root commit (`git rev-list --max-parents=0 HEAD`,
   * first line). Stable for the repo's whole life. */
  rootCommitSha: string;
  /** The origin remote URL, any format — normalized internally so ssh and
   * https clones of the same repo land in the same room. */
  originUrl: string;
  /** Rotatable room salt (default DEFAULT_ROOM_SALT). */
  salt?: string;
}

export interface RoomCredentials {
  /** Opaque 32-hex-char room id — the only room identity the relay sees. */
  roomId: string;
  /** AES-GCM-256 key for payload E2E encryption. Never leaves the client. */
  key: CryptoKey;
  /** Raw bytes for deriving per-machine opaque sender ids. */
  senderKeyBytes: Uint8Array;
}

/**
 * Normalize a git remote URL so every clone shape of the same repo derives
 * the same room: `git@github.com:Org/Repo.git`, `ssh://git@github.com/org/repo`,
 * and `https://github.com/org/repo.git` all → `github.com/org/repo`.
 */
export function normalizeOriginUrl(raw: string): string {
  let s = raw.trim();
  // scp-like syntax: [user@]host:path
  const scp = /^(?:[^@/]+@)?([^:/]+):(?!\/\/)(.+)$/.exec(s);
  if (scp) {
    s = `${scp[1]}/${scp[2]}`;
  } else {
    // URL syntax: strip scheme, then credentials.
    s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
    s = s.replace(/^[^@/]+@/, "");
  }
  // Drop an explicit port, trailing slashes, trailing .git; lowercase.
  // (Slashes first so `…/repo.git/` still sheds its .git suffix.)
  s = s.replace(/^([^/:]+):\d+\//, "$1/");
  s = s.replace(/\/+$/, "");
  s = s.replace(/\.git$/i, "");
  return s.toLowerCase();
}

async function hkdfBits(ikm: Uint8Array, info: string, bits: number): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey("raw", ikm as BufferSource, "HKDF", false, [
    "deriveBits",
  ]);
  return crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new TextEncoder().encode(HKDF_SALT),
      info: new TextEncoder().encode(info),
    },
    key,
    bits,
  );
}

function hex(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Derive the room id, E2E key, and sender-id key from the repo identity. */
export async function deriveRoomCredentials(inputs: RoomInputs): Promise<RoomCredentials> {
  const ikm = new TextEncoder().encode(
    [
      inputs.rootCommitSha.trim().toLowerCase(),
      normalizeOriginUrl(inputs.originUrl),
      inputs.salt ?? DEFAULT_ROOM_SALT,
    ].join("\n"),
  );
  const roomBits = await hkdfBits(ikm, ROOM_INFO, 128);
  const keyBits = await hkdfBits(ikm, KEY_INFO, 256);
  const senderBits = await hkdfBits(ikm, SENDER_INFO, 256);
  const key = await crypto.subtle.importKey("raw", keyBits, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
  return { roomId: hex(roomBits), key, senderKeyBytes: new Uint8Array(senderBits) };
}

/** Opaque, stable per-machine sender id: HMAC(senderKey, machineLabel). The
 * relay caches last-message-per-sender by this without learning the label. */
export async function computeSenderId(
  creds: RoomCredentials,
  machineLabel: string,
): Promise<string> {
  const hmacKey = await crypto.subtle.importKey(
    "raw",
    creds.senderKeyBytes as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", hmacKey, new TextEncoder().encode(machineLabel));
  return hex(sig).slice(0, 32);
}

function toB64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** AES-GCM-encrypt a plaintext payload → { iv, ct } base64 pair. */
export async function encryptPayload(
  creds: RoomCredentials,
  plaintext: string,
): Promise<{ iv: string; ct: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    creds.key,
    new TextEncoder().encode(plaintext),
  );
  return { iv: toB64(iv), ct: toB64(new Uint8Array(ct)) };
}

/** Decrypt an { iv, ct } pair. Returns null on any failure (wrong room key,
 * tampered frame) — callers drop the frame silently. */
export async function decryptPayload(
  creds: RoomCredentials,
  frame: { iv: string; ct: string },
): Promise<string | null> {
  try {
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromB64(frame.iv) as BufferSource },
      creds.key,
      fromB64(frame.ct) as BufferSource,
    );
    return new TextDecoder().decode(pt);
  } catch {
    return null;
  }
}

/* ---------- wire envelope ---------- */

/** Client → relay and relay → client publication frame. */
export interface PubFrame {
  t: "pub";
  /** Opaque sender id (computeSenderId). The relay keys its warm-join cache on this. */
  sender: string;
  iv: string;
  ct: string;
}

/** Relay → client greeting on join. */
export interface HelloFrame {
  t: "hello";
  /** Live sockets in the room at join time (including the joiner). */
  peers: number;
}

export type RelayFrame = PubFrame | HelloFrame;

/** Hard cap a relay enforces per text frame (ciphertext of a ~2KB blob is far
 * smaller; anything bigger is abuse or a bug). */
export const MAX_FRAME_BYTES = 16 * 1024;

/** Parse + shape-validate an incoming relay frame. Null on anything off. */
export function parseRelayFrame(raw: string): RelayFrame | null {
  if (raw.length > MAX_FRAME_BYTES) return null;
  let j: unknown;
  try {
    j = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!j || typeof j !== "object") return null;
  const f = j as Record<string, unknown>;
  if (f.t === "pub") {
    if (
      typeof f.sender !== "string" ||
      f.sender.length === 0 ||
      f.sender.length > 64 ||
      typeof f.iv !== "string" ||
      typeof f.ct !== "string" ||
      f.iv.length > 64 ||
      f.ct.length > MAX_FRAME_BYTES
    ) {
      return null;
    }
    return { t: "pub", sender: f.sender, iv: f.iv, ct: f.ct };
  }
  if (f.t === "hello") {
    if (typeof f.peers !== "number") return null;
    return { t: "hello", peers: f.peers };
  }
  return null;
}

/** Room ids are 32 lowercase hex chars; relays reject anything else. */
export function isValidRoomId(roomId: string): boolean {
  return /^[0-9a-f]{32}$/.test(roomId);
}

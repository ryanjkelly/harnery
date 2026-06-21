/**
 * Tiny ULID generator. Crockford-base32, 10-char timestamp (48-bit ms epoch)
 * + 16-char random (80-bit). 26 chars total, monotonically-sortable.
 *
 * Intentionally duplicated from the agent-hooks ULID generator: agent-hooks
 * and agent-coord stay strictly-separated packages, sharing only event/schema
 * types. The writer side reimplements per-module so neither depends on the
 * other's runtime code.
 */

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function ulid(): string {
  const ts = encodeTime(Date.now());
  const rnd = encodeRandom();
  return ts + rnd;
}

function encodeTime(ms: number): string {
  let out = "";
  let n = BigInt(ms);
  const base = BigInt(32);
  for (let i = 0; i < 10; i++) {
    const mod = Number(n % base);
    out = ALPHABET[mod] + out;
    n = n / base;
  }
  return out;
}

function encodeRandom(): string {
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  let out = "";
  let buf = 0n;
  let bits = 0;
  for (const b of bytes) {
    buf = (buf << 8n) | BigInt(b);
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      const idx = Number((buf >> BigInt(bits)) & 0x1fn);
      out += ALPHABET[idx];
    }
  }
  if (bits > 0) {
    const idx = Number((buf << BigInt(5 - bits)) & 0x1fn);
    out += ALPHABET[idx];
  }
  return out.slice(0, 16);
}

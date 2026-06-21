/**
 * Tiny ULID generator. Crockford-base32, 10-char timestamp (48-bit ms epoch)
 * + 16-char random (80-bit). 26 chars total, monotonically-sortable.
 *
 * Library-free so the module stays dep-free (no `ulid` package). Quality is
 * sufficient for event_id uniqueness: the kth event in a millisecond uses a
 * fresh 80-bit random, collision probability negligible.
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
  // Map each pair of bytes to 3 alphabet chars (5 bits per char, 16 chars).
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

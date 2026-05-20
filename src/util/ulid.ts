// Minimal ULID-style id: 10-char time prefix (base32-ish, ms resolution)
// + 14-char random. Lexicographically sortable, URL-safe, no deps.

const ALPHA = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function encode(num: number, len: number): string {
  let s = "";
  for (let i = 0; i < len; i++) {
    s = ALPHA[num % 32] + s;
    num = Math.floor(num / 32);
  }
  return s;
}

export function ulid(now: number = Date.now()): string {
  // Time portion: encode milliseconds. Math.floor(ms/1) gives an int that
  // fits in 48 bits, plenty for the next 8000 years. Split into two 24-bit
  // chunks to avoid JS bitwise truncation at 32 bits.
  const high = Math.floor(now / 0x1000000); // top 24 bits
  const low = now & 0xffffff; // bottom 24 bits
  const timePart = encode(high, 5) + encode(low, 5);

  let randPart = "";
  for (let i = 0; i < 14; i++) {
    randPart += ALPHA[Math.floor(Math.random() * 32)];
  }
  return timePart + randPart;
}

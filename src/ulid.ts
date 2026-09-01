/**
 * ULID — run identifiers.
 *
 * Hand-rolled (no dependency): 48-bit millisecond timestamp + 80 bits of
 * cryptographic randomness, Crockford base32, 26 chars. Sorts by time across
 * runs; NOT monotonic within the same millisecond (we don't need it — one
 * run per process).
 */
import { randomBytes } from "node:crypto";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function encode(value: bigint, length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) {
    out = ALPHABET[Number(value % 32n)] + out;
    value /= 32n;
  }
  return out;
}

/** Generate a ULID (e.g. `01J4Z3K9XQ8V0M2N4P6R8T0W2B`). */
export function ulid(now: number = Date.now()): string {
  const time = encode(BigInt(now), 10);
  const rand = randomBytes(10);
  let entropy = 0n;
  for (const b of rand) entropy = (entropy << 8n) | BigInt(b);
  return time + encode(entropy, 16);
}

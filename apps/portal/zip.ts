/**
 * Deterministic STORE-method ZIP writer for the monthly invoice pack.
 *
 * The portal serves whatever this produces byte-for-byte, and
 * `fixtures/invoices.sha256` pins those bytes. Determinism comes from:
 *   - entries sorted by filename,
 *   - a FIXED DOS timestamp (2026-06-30 12:00:00) — disk mtimes are ignored,
 *   - STORE method (no compression, so no deflate-level variance),
 *   - no extra fields, comments, or absolute paths.
 *
 * Zero dependencies: CRC32 and the header layout are hand-rolled.
 */
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Fixed DOS date for every entry: 2026-06-30. */
const DOS_DATE = ((2026 - 1980) << 9) | (6 << 5) | 30;
/** Fixed DOS time for every entry: 12:00:00. */
const DOS_TIME = (12 << 11) | (0 << 5) | (0 >> 1);

/** Default invoice fixture directory, resolved relative to this module. */
const DEFAULT_INVOICES_DIR = fileURLToPath(
  new URL("../../fixtures/invoices/", import.meta.url),
);

/** CRC32 lookup table (IEEE 802.3 polynomial, reflected). */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

/**
 * Standard CRC32 (as used by ZIP/PNG/gzip) over `data`.
 */
export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    const idx = ((crc ^ byte) & 0xff) as number;
    crc = (CRC_TABLE[idx] as number) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

interface ZipEntry {
  name: string;
  nameBytes: Uint8Array;
  data: Uint8Array;
  crc: number;
}

function u16(v: number): Uint8Array {
  return Uint8Array.of(v & 0xff, (v >>> 8) & 0xff);
}

function u32(v: number): Uint8Array {
  return Uint8Array.of(
    v & 0xff,
    (v >>> 8) & 0xff,
    (v >>> 16) & 0xff,
    (v >>> 24) & 0xff,
  );
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/**
 * Build the invoice zip from every `*.txt` file in `dir`, sorted by name.
 *
 * Entry names are bare filenames (no directory components). The returned
 * bytes are identical across runs and machines for identical inputs.
 */
export function buildInvoicesZip(dir: string = DEFAULT_INVOICES_DIR): Uint8Array {
  const encoder = new TextEncoder();
  const names = readdirSync(dir)
    .filter((name) => name.endsWith(".txt"))
    .sort();

  const entries: ZipEntry[] = names.map((file) => {
    const name = basename(file);
    const data = new Uint8Array(readFileSync(join(dir, file)));
    return { name, nameBytes: encoder.encode(name), data, crc: crc32(data) };
  });

  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const localHeader = concat([
      u32(0x04034b50), // local file header signature
      u16(20), // version needed
      u16(0), // flags
      u16(0), // method: STORE
      u16(DOS_TIME),
      u16(DOS_DATE),
      u32(entry.crc),
      u32(entry.data.length), // compressed size
      u32(entry.data.length), // uncompressed size
      u16(entry.nameBytes.length),
      u16(0), // extra field length
      entry.nameBytes,
    ]);
    chunks.push(localHeader, entry.data);

    central.push(
      concat([
        u32(0x02014b50), // central directory signature
        u16(20), // version made by
        u16(20), // version needed
        u16(0), // flags
        u16(0), // method: STORE
        u16(DOS_TIME),
        u16(DOS_DATE),
        u32(entry.crc),
        u32(entry.data.length),
        u32(entry.data.length),
        u16(entry.nameBytes.length),
        u16(0), // extra field length
        u16(0), // comment length
        u16(0), // disk number start
        u16(0), // internal attributes
        u32(0), // external attributes
        u32(offset), // local header offset
        entry.nameBytes,
      ]),
    );
    offset += localHeader.length + entry.data.length;
  }

  const centralBytes = concat(central);
  const end = concat([
    u32(0x06054b50), // end of central directory signature
    u16(0), // disk number
    u16(0), // disk with central directory
    u16(entries.length),
    u16(entries.length),
    u32(centralBytes.length),
    u32(offset), // central directory offset
    u16(0), // comment length
  ]);

  return concat([...chunks, centralBytes, end]);
}

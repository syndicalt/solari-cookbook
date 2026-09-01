/**
 * Zip test — the invoice pack must be byte-identical across builds (the
 * portal serves it and fixtures/invoices.sha256 pins it) and must be a
 * real zip that standard tooling accepts.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildInvoicesZip, crc32 } from "../apps/portal/zip.ts";

test("zip bytes are deterministic and match the golden", () => {
  const a = buildInvoicesZip();
  const b = buildInvoicesZip();
  assert.deepEqual(a, b);
  const golden = readFileSync("fixtures/invoices.sha256", "utf8").trim();
  assert.equal(createHash("sha256").update(a).digest("hex"), golden);
});

test("zip is valid per python3 -m zipfile -t and round-trips fixtures", () => {
  const dir = mkdtempSync(join(tmpdir(), "noapi-zip-"));
  try {
    const zipPath = join(dir, "inv.zip");
    writeFileSync(zipPath, buildInvoicesZip());
    execFileSync("python3", ["-m", "zipfile", "-t", zipPath]);

    const outDir = join(dir, "out");
    execFileSync("python3", ["-m", "zipfile", "-e", zipPath, outDir]);
    for (const n of [1, 2, 3, 4, 5]) {
      const name = `INV-2026-06-00${n}.txt`;
      assert.deepEqual(
        readFileSync(join(outDir, name)),
        readFileSync(join("fixtures/invoices", name)),
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("crc32 matches the reference value", () => {
  // CRC32 of the ASCII string "123456789" is 0xCBF43926 (classic check value).
  assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
});

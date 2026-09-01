/** Manifest tests — sha256 vectors, write/verify round-trip, tamper + missing detection. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { listFiles, MANIFEST_NAME, sha256, verifyManifest, writeManifest } from "../src/manifest.ts";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "noapi-manifest-"));
}

test("sha256 matches the published 'abc' vector", () => {
  assert.equal(
    sha256("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  // Uint8Array input hashes the same bytes.
  assert.equal(sha256(new TextEncoder().encode("abc")), sha256("abc"));
});

test("writeManifest + verifyManifest round-trip, including nested files", () => {
  const dir = tmpDir();
  try {
    writeFileSync(join(dir, "a.txt"), "alpha");
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "sub", "b.txt"), "beta");
    writeFileSync(join(dir, "eval.json"), '{"ok":true}\n');

    const manifestPath = writeManifest(dir);
    assert.ok(manifestPath.endsWith(MANIFEST_NAME));

    const lines = readFileSync(manifestPath, "utf8").trim().split("\n");
    assert.equal(lines.length, 3);
    assert.ok(lines.every((line) => /^[0-9a-f]{64}  .+/.test(line)), lines.join("\n"));
    // The manifest does not hash itself; paths are relative and sorted.
    const paths = lines.map((line) => line.slice(66));
    assert.deepEqual(paths, ["a.txt", "eval.json", join("sub", "b.txt")]);

    assert.deepEqual(verifyManifest(dir), { ok: true, mismatches: [] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verifyManifest detects tampering", () => {
  const dir = tmpDir();
  try {
    writeFileSync(join(dir, "a.txt"), "alpha");
    writeManifest(dir);
    writeFileSync(join(dir, "a.txt"), "tampered");
    const result = verifyManifest(dir);
    assert.equal(result.ok, false);
    assert.ok(result.mismatches.some((m) => m.includes("a.txt") && m.includes("hash mismatch")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verifyManifest detects missing files", () => {
  const dir = tmpDir();
  try {
    writeFileSync(join(dir, "a.txt"), "alpha");
    writeFileSync(join(dir, "b.txt"), "beta");
    writeManifest(dir);
    unlinkSync(join(dir, "b.txt"));
    const result = verifyManifest(dir);
    assert.equal(result.ok, false);
    assert.deepEqual(result.mismatches, ["b.txt (missing)"]);
    // The untouched file does not appear as a mismatch.
    assert.ok(!result.mismatches.some((m) => m.includes("a.txt")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("listFiles is recursive and sorted", () => {
  const dir = tmpDir();
  try {
    mkdirSync(join(dir, "z"));
    writeFileSync(join(dir, "z", "b.txt"), "x");
    writeFileSync(join(dir, "a.txt"), "x");
    const files = listFiles(dir).map((f) => f.slice(dir.length + 1));
    assert.deepEqual(files, ["a.txt", join("z", "b.txt")]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

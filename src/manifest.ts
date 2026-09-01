/**
 * Manifest — audit-grade hashing of the evidence pack.
 *
 * Every run ends with `artifacts/<runId>/MANIFEST.sha256`: one
 * `<sha256>  <relative-path>` line per artifact (the `sha256sum -c` format).
 * Finance and healthcare reviewers care about "what did the agent touch" —
 * this file is the answer.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export const MANIFEST_NAME = "MANIFEST.sha256";

/** SHA-256 hex digest of a byte array or string. */
export function sha256(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Recursively list files under `dir`, sorted for determinism. */
export function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listFiles(full));
    else out.push(full);
  }
  return out.sort();
}

/**
 * Write `MANIFEST.sha256` into `dir`, covering every file present except the
 * manifest itself. Returns the manifest's own path. Call this after all
 * other artifacts (including `eval.json` and a closed `journal.ndjson`)
 * have been written.
 */
export function writeManifest(dir: string): string {
  const lines = listFiles(dir)
    .filter((f) => relative(dir, f) !== MANIFEST_NAME)
    .map((f) => `${sha256(readFileSync(f))}  ${relative(dir, f)}`);
  const path = join(dir, MANIFEST_NAME);
  writeFileSync(path, lines.join("\n") + "\n");
  return path;
}

/** Verify a manifest written by {@link writeManifest}. Returns mismatches. */
export function verifyManifest(dir: string): { ok: boolean; mismatches: string[] } {
  const mismatches: string[] = [];
  const text = readFileSync(join(dir, MANIFEST_NAME), "utf8");
  for (const line of text.trim().split("\n")) {
    if (!line.trim()) continue;
    const sep = line.indexOf("  ");
    const [expected, path] = [line.slice(0, sep), line.slice(sep + 2)];
    let actual: string;
    try {
      actual = sha256(readFileSync(join(dir, path)));
    } catch {
      mismatches.push(`${path} (missing)`);
      continue;
    }
    if (actual !== expected) mismatches.push(`${path} (hash mismatch)`);
  }
  return { ok: mismatches.length === 0, mismatches };
}

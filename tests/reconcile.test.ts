/**
 * Reconcile test — runs fixtures/reconcile.py against a staged copy of the
 * seeded fixtures, the same way the Solari sandbox and offline-close.sh do.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("reconcile.py finds exactly the two seeded disagreements", () => {
  const work = mkdtempSync(join(tmpdir(), "noapi-reconcile-"));
  try {
    cpSync("fixtures/invoices", join(work, "invoices"), { recursive: true });
    copyFileSync("fixtures/ledger.csv", join(work, "ledger.csv"));
    copyFileSync("fixtures/policy.yaml", join(work, "policy.yaml"));

    const stdout = execFileSync("python3", ["fixtures/reconcile.py", work], {
      encoding: "utf8",
    });
    assert.match(stdout, /reconcile\.invoices n=5/);
    assert.match(stdout, /reconcile\.ledger n=4/);
    assert.match(stdout, /reconcile\.exceptions n=2/);
    assert.match(stdout, /reconcile\.ok/);

    const csv = readFileSync(join(work, "exceptions.csv"), "utf8")
      .trim()
      .split("\n");
    assert.equal(
      csv[0],
      "invoice,vendor,invoice_amount,ledger_amount,reason",
    );
    const rows = csv.slice(1);
    assert.equal(rows.length, 2);

    const byReason = new Map(rows.map((row) => [row.split(",").at(-1)!, row]));
    assert.ok(byReason.has("amount_mismatch"));
    assert.ok(byReason.has("missing_in_ledger"));
    assert.match(byReason.get("amount_mismatch")!, /^INV-2026-06-002,/);
    assert.match(byReason.get("amount_mismatch")!, /,845\.50,485\.50,/);
    assert.match(byReason.get("missing_in_ledger")!, /^INV-2026-06-005,/);

    const chart = readFileSync(join(work, "chart.png"));
    assert.deepEqual(
      [...chart.subarray(0, 8)],
      [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("reconcile.py exits 2 on missing inputs", () => {
  const work = mkdtempSync(join(tmpdir(), "noapi-reconcile-empty-"));
  try {
    const result = spawnSync("python3", ["fixtures/reconcile.py", work], {
      encoding: "utf8",
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /reconcile\.error/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

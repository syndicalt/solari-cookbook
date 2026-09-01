/** Score tests — ok is the AND of predicates; eval.json round-trips. */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildReport, EVAL_NAME, writeReport, type ScoreInput } from "../src/eval/score.ts";
import type { EvalReport } from "../src/types.ts";

function input(predicates: ScoreInput["predicates"]): ScoreInput {
  return {
    runId: "01TEST",
    scenario: "vendor-close",
    predicates,
    wallMs: 1234,
    costUsdEstimate: 0.0042,
    surfaces: { browserSec: 10, sandboxSec: 20, desktopSec: 30 },
    replayUrl: null,
    streamUrl: "vnc://fake",
    previewUrl: null,
    rewinds: 0,
  };
}

test("buildReport ok is the AND of every predicate", () => {
  const allGreen = buildReport(input([
    { name: "a", ok: true },
    { name: "b", ok: true },
  ]));
  assert.equal(allGreen.ok, true);

  const oneRed = buildReport(input([
    { name: "a", ok: true },
    { name: "b", ok: false, detail: "nope" },
  ]));
  assert.equal(oneRed.ok, false);

  // No exceptions to the AND rule — even one red predicate fails the run.
  const mostlyGreen = buildReport(input([
    { name: "a", ok: true },
    { name: "b", ok: true },
    { name: "c", ok: true },
    { name: "d", ok: false },
  ]));
  assert.equal(mostlyGreen.ok, false);

  // Vacuous truth: zero predicates → green (the planner forbids this, but
  // buildReport itself does not special-case it).
  assert.equal(buildReport(input([])).ok, true);
});

test("buildReport passes all scoreboard fields through", () => {
  const report = buildReport(input([{ name: "a", ok: true }]));
  assert.equal(report.runId, "01TEST");
  assert.equal(report.scenario, "vendor-close");
  assert.equal(report.wallMs, 1234);
  assert.equal(report.costUsdEstimate, 0.0042);
  assert.deepEqual(report.surfaces, { browserSec: 10, sandboxSec: 20, desktopSec: 30 });
  assert.equal(report.streamUrl, "vnc://fake");
  assert.equal(report.replayUrl, null);
  assert.equal(report.previewUrl, null);
  assert.equal(report.rewinds, 0);
});

test("writeReport writes parseable eval.json and returns the report", () => {
  const dir = mkdtempSync(join(tmpdir(), "noapi-score-"));
  try {
    const report = buildReport(input([{ name: "a", ok: true }]));
    const returned = writeReport(dir, report);
    assert.equal(returned, report);
    const parsed = JSON.parse(readFileSync(join(dir, EVAL_NAME), "utf8")) as EvalReport;
    assert.deepEqual(parsed, report);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

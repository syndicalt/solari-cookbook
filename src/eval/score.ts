/**
 * Score — assemble and write `eval.json`, the run's scoreboard.
 *
 * The README embeds this file; a scenario is not done until it is green.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EvalReport, PredicateResult } from "../types.ts";

export const EVAL_NAME = "eval.json";

/** Inputs the conductor knows at scoring time. */
export interface ScoreInput {
  runId: string;
  scenario: string;
  predicates: PredicateResult[];
  wallMs: number;
  costUsdEstimate: number;
  surfaces: { browserSec: number; sandboxSec: number; desktopSec: number };
  replayUrl: string | null;
  streamUrl: string | null;
  previewUrl: string | null;
  rewinds: number;
}

/** Build the report. `ok` is the AND of every predicate — no exceptions. */
export function buildReport(input: ScoreInput): EvalReport {
  return {
    ...input,
    ok: input.predicates.every((p) => p.ok),
  };
}

/** Write the report to `<dir>/eval.json` and return it. */
export function writeReport(dir: string, report: EvalReport): EvalReport {
  writeFileSync(join(dir, EVAL_NAME), JSON.stringify(report, null, 2) + "\n");
  return report;
}

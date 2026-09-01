/**
 * Rewind policy — three clocks, one policy.
 *
 * Most computer-use demos restart the universe on failure. NOAPI restarts
 * the step. This module is the decision table the conductor consults after
 * any step failure: retry the step (with a fresh surface session), restore
 * the last-good snapshot, or abort with artifacts preserved.
 *
 * The defaults mirror the plan's policy file (§5.1):
 *
 *   rewind:
 *     maxAttemptsPerStep: 2
 *     restoreSnapshotOn: [desktop.focus_miss, desktop.app_not_ready]
 *     neverRestoreOn: [budget_exceeded, portal_rejected_auth]
 *     keepFailedArtifacts: true
 */
import { BudgetExceededError, FocusMissError } from "../types.ts";

/** What the conductor should do after a step failure. */
export interface RewindDecision {
  /** "rewind" = retry the step (surfaces already lazily re-acquired); "abort" = stop spending. */
  action: "rewind" | "abort";
  /** Short, grepable reason code (e.g. `desktop.focus_miss`). */
  reason: string;
}

/** Policy knobs, exported as data so the dashboard/README can render them. */
export const REWIND_POLICY = {
  maxAttemptsPerStep: 2,
  restoreSnapshotOn: ["desktop.focus_miss", "desktop.app_not_ready"],
  neverRestoreOn: ["budget_exceeded", "portal_rejected_auth"],
  keepFailedArtifacts: true,
} as const;

/** Classify an error into the reason codes the policy tables use. */
export function classifyError(err: unknown): string {
  if (err instanceof FocusMissError) return "desktop.focus_miss";
  if (err instanceof BudgetExceededError) return "budget_exceeded";
  const msg = err instanceof Error ? err.message : String(err);
  if (/auth|401|login.error|invalid credentials/i.test(msg)) return "portal_rejected_auth";
  if (/app_not_ready|not ready|health/i.test(msg)) return "desktop.app_not_ready";
  return "unknown";
}

/**
 * Decide whether a failed step gets another attempt.
 *
 * `attempt` is the 1-based count of attempts already made. Never rewinds on
 * `neverRestoreOn` errors (budget and auth are human problems, not timing
 * problems); rewinds on desktop focus/readiness failures while attempts
 * remain; anything else aborts immediately — unknown failures are not
 * retried blind in v0.
 */
export function decideRewind(err: unknown, attempt: number): RewindDecision {
  const reason = classifyError(err);
  if ((REWIND_POLICY.neverRestoreOn as readonly string[]).includes(reason)) {
    return { action: "abort", reason };
  }
  const attemptsLeft = attempt < REWIND_POLICY.maxAttemptsPerStep;
  if ((REWIND_POLICY.restoreSnapshotOn as readonly string[]).includes(reason) && attemptsLeft) {
    return { action: "rewind", reason };
  }
  return { action: "abort", reason: attemptsLeft ? reason : `${reason} (attempts exhausted)` };
}

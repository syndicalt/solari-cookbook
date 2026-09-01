/**
 * NOAPI core types.
 *
 * The scenario schema is the API: `scenarios/*.json` files deserialize into
 * {@link Scenario}, and every surface action the conductor can execute is a
 * member of {@link StepAction}. Keep this file free of runtime dependencies.
 */

/** The three Solari surfaces NOAPI conducts. */
export type SurfaceName = "browser" | "sandbox" | "desktop";

/** Lifecycle status of a run, mirrored into `eval.json`. */
export type RunStatus = "queued" | "running" | "succeeded" | "failed" | "rewound";

/**
 * Every action the conductor knows how to execute. Actions are functions in
 * `src/surfaces/*`, dispatched by id — never a pile of conditionals in cli.ts.
 */
export type StepAction =
  | "loginPortal"
  | "downloadInvoices"
  | "reconcileLedger"
  | "snapshot"
  | "formatLibreOffice"
  | "uploadPack";

/** One step in a scenario's `steps[]` array. */
export interface ScenarioStep {
  /** Unique step id, used in the journal and rewind log. */
  id: string;
  /** Which Solari surface executes the step. */
  surface: SurfaceName;
  /** Action id dispatched to the surface implementation. */
  action: StepAction;
  /** Optional action argument (e.g. snapshot name). */
  name?: string;
}

/**
 * Success predicates — code, not vibes. Evaluated by `src/eval/predicates.ts`
 * against `artifacts/<runId>/` and the portal after the last step.
 */
export type SuccessPredicate =
  | { kind: "fileExists"; path: string }
  | { kind: "rowCount"; path: string; min: number }
  | { kind: "portalAccepted"; url: string }
  | { kind: "screenshotContainsText"; path: string; text: string };

/** A parsed and validated `scenarios/*.json` file. */
export interface Scenario {
  id: string;
  title: string;
  /** Hard credit ceiling. The conductor refuses the next surface past this. */
  budgetUsd: number;
  /** Wall-clock ceiling for the whole run (not a rolling idle window). */
  timeoutMs: number;
  fixtures: { ledger: string; policy: string };
  success: SuccessPredicate[];
  steps: ScenarioStep[];
}

/** Journal event shapes — the thing you grep when asked "what happened at 1:22". */
export type JournalEvent =
  | { t: number; type: "step.start"; id: string; surface: SurfaceName }
  | { t: number; type: "step.ok"; id: string; ms: number }
  | { t: number; type: "step.fail"; id: string; error: string; screenshot?: string }
  | { t: number; type: "rewind"; from: string; snapshot: string }
  | { t: number; type: "cost"; usd: number }
  | { t: number; type: "artifact"; path: string };

/** Result of evaluating one success predicate. */
export interface PredicateResult {
  name: string;
  ok: boolean;
  detail?: string;
}

/** The scoreboard written to `artifacts/<runId>/eval.json`. */
export interface EvalReport {
  runId: string;
  scenario: string;
  ok: boolean;
  predicates: PredicateResult[];
  wallMs: number;
  costUsdEstimate: number;
  surfaces: { browserSec: number; sandboxSec: number; desktopSec: number };
  replayUrl: string | null;
  streamUrl: string | null;
  previewUrl: string | null;
  rewinds: number;
}

/** Runtime configuration resolved from the environment (never logged). */
export interface NoapiConfig {
  /** Solari API key; empty string means "no key — offline paths only". */
  solariApiKey: string;
  portalOrigin: string;
  portalUser: string;
  portalPassword: string;
  /** Solari plan tier, used for pricing and feature degrade. */
  plan: "free" | "starter";
}

/** Thrown when the desktop focus sentinel does not confirm a click landed. */
export class FocusMissError extends Error {
  /** Path to the screenshot captured right after the failed click/type. */
  readonly screenshotPath: string | undefined;
  constructor(message: string, screenshotPath?: string) {
    super(message);
    this.name = "FocusMissError";
    this.screenshotPath = screenshotPath;
  }
}

/** Thrown when the projected cost of the next surface exceeds the scenario budget. */
export class BudgetExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BudgetExceededError";
  }
}

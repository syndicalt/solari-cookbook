/**
 * Static planner (v0, default).
 *
 * Reads a scenario JSON file and validates it against the schema in
 * `src/types.ts`. No LLM. The scenario file IS the plan; this module's job
 * is to reject malformed plans before any credits are spent.
 */
import { readFileSync } from "node:fs";
import type { Scenario, ScenarioStep, SuccessPredicate } from "../types.ts";

const SURFACES = new Set(["browser", "sandbox", "desktop"]);
const ACTIONS = new Set([
  "loginPortal",
  "downloadInvoices",
  "reconcileLedger",
  "snapshot",
  "formatLibreOffice",
  "uploadPack",
]);
const PREDICATE_KINDS = new Set(["fileExists", "rowCount", "portalAccepted", "screenshotContainsText"]);

/** Throw with a precise message when `value` fails a check. */
function fail(path: string, problem: string): never {
  throw new Error(`scenario invalid at ${path}: ${problem}`);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function validateStep(raw: unknown, i: number): ScenarioStep {
  const at = `steps[${i}]`;
  if (!isRecord(raw)) fail(at, "must be an object");
  if (typeof raw.id !== "string" || !raw.id) fail(`${at}.id`, "non-empty string required");
  if (typeof raw.surface !== "string" || !SURFACES.has(raw.surface))
    fail(`${at}.surface`, `must be one of ${[...SURFACES].join("|")}`);
  if (typeof raw.action !== "string" || !ACTIONS.has(raw.action))
    fail(`${at}.action`, `unknown action ${JSON.stringify(raw.action)}`);
  if (raw.name !== undefined && typeof raw.name !== "string") fail(`${at}.name`, "string when present");
  return { id: raw.id, surface: raw.surface as ScenarioStep["surface"], action: raw.action as ScenarioStep["action"], ...(raw.name !== undefined ? { name: raw.name as string } : {}) };
}

function validatePredicate(raw: unknown, i: number): SuccessPredicate {
  const at = `success[${i}]`;
  if (!isRecord(raw)) fail(at, "must be an object");
  if (typeof raw.kind !== "string" || !PREDICATE_KINDS.has(raw.kind))
    fail(`${at}.kind`, `must be one of ${[...PREDICATE_KINDS].join("|")}`);
  switch (raw.kind) {
    case "fileExists":
      if (typeof raw.path !== "string" || !raw.path) fail(`${at}.path`, "non-empty string required");
      return { kind: "fileExists", path: raw.path };
    case "rowCount":
      if (typeof raw.path !== "string" || !raw.path) fail(`${at}.path`, "non-empty string required");
      if (typeof raw.min !== "number" || raw.min < 0) fail(`${at}.min`, "non-negative number required");
      return { kind: "rowCount", path: raw.path, min: raw.min };
    case "portalAccepted":
      if (typeof raw.url !== "string" || !raw.url) fail(`${at}.url`, "non-empty string required");
      return { kind: "portalAccepted", url: raw.url };
    case "screenshotContainsText":
      if (typeof raw.path !== "string" || !raw.path) fail(`${at}.path`, "non-empty string required");
      if (typeof raw.text !== "string" || !raw.text) fail(`${at}.text`, "non-empty string required");
      return { kind: "screenshotContainsText", path: raw.path, text: raw.text };
    default:
      fail(`${at}.kind`, "unreachable");
  }
}

/**
 * Parse and validate a scenario from a JSON string. Throws with a path-precise
 * message on the first schema violation.
 */
export function parseScenario(json: string): Scenario {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (err) {
    fail("$", `not valid JSON (${(err as Error).message})`);
  }
  if (!isRecord(raw)) fail("$", "must be an object");
  if (typeof raw.id !== "string" || !raw.id) fail("id", "non-empty string required");
  if (typeof raw.title !== "string" || !raw.title) fail("title", "non-empty string required");
  if (typeof raw.budgetUsd !== "number" || raw.budgetUsd <= 0) fail("budgetUsd", "positive number required");
  if (typeof raw.timeoutMs !== "number" || raw.timeoutMs <= 0) fail("timeoutMs", "positive number required");
  if (!isRecord(raw.fixtures)) fail("fixtures", "object required");
  if (typeof raw.fixtures.ledger !== "string") fail("fixtures.ledger", "string required");
  if (typeof raw.fixtures.policy !== "string") fail("fixtures.policy", "string required");
  if (!Array.isArray(raw.success) || raw.success.length === 0) fail("success", "non-empty array required");
  if (!Array.isArray(raw.steps) || raw.steps.length === 0) fail("steps", "non-empty array required");

  const steps = raw.steps.map(validateStep);
  const ids = new Set(steps.map((s) => s.id));
  if (ids.size !== steps.length) fail("steps", "step ids must be unique");

  return {
    id: raw.id,
    title: raw.title,
    budgetUsd: raw.budgetUsd,
    timeoutMs: raw.timeoutMs,
    fixtures: { ledger: raw.fixtures.ledger, policy: raw.fixtures.policy },
    success: raw.success.map(validatePredicate),
    steps,
  };
}

/** Load a scenario from disk. */
export function loadScenario(path: string): Scenario {
  return parseScenario(readFileSync(path, "utf8"));
}

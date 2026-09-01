/** Budget tests — pricing math against the published rate sheet, ledger, guard. */
import assert from "node:assert/strict";
import test from "node:test";
import { Budget, hourlyRate, MACHINE, RATES, surfaceCost } from "../src/budget.ts";
import { BudgetExceededError } from "../src/types.ts";

const close = (actual: number, expected: number) =>
  assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);

test("hourlyRate matches the published Starter numbers", () => {
  close(hourlyRate("browser", "starter"), 0.1);
  // base sandbox: 1 vCPU ($0.035) + 2 GB ($0.011/hr each) = $0.057/hr.
  close(hourlyRate("sandbox", "starter"), 0.057);
  // desktop adds the $0.02/hr live-screen surcharge.
  close(hourlyRate("desktop", "starter"), 0.077);
});

test("hourlyRate matches the published Free numbers", () => {
  close(hourlyRate("browser", "free"), 0.15);
  close(hourlyRate("sandbox", "free"), 0.0525 + 2 * 0.0165);
  close(hourlyRate("desktop", "free"), 0.0525 + 2 * 0.0165 + 0.02);
});

test("RATES and MACHINE constants are the documented sheet values", () => {
  assert.deepEqual(MACHINE, { vcpu: 1, gb: 2 });
  assert.equal(RATES.starter.browserPerHour, 0.1);
  assert.equal(RATES.starter.vcpuPerHour, 0.035);
  assert.equal(RATES.starter.gbPerHour, 0.011);
  assert.equal(RATES.starter.desktopScreenPerHour, 0.02);
});

test("surfaceCost scales linearly with seconds", () => {
  close(surfaceCost("browser", 3600, "starter"), 0.1);
  close(surfaceCost("browser", 1800, "starter"), 0.05);
  close(surfaceCost("sandbox", 3600, "starter"), 0.057);
  close(surfaceCost("desktop", 0, "starter"), 0);
});

test("charge accumulates dollars and per-surface seconds", () => {
  const budget = new Budget(1, "starter");
  close(budget.charge("browser", 3600), 0.1);
  close(budget.charge("sandbox", 1800), 0.0285);
  close(budget.spentUsd, 0.1285);
  assert.deepEqual(budget.surfaceSeconds, { browser: 3600, sandbox: 1800, desktop: 0 });
  budget.charge("browser", 3600);
  close(budget.spentUsd, 0.2285);
  assert.equal(budget.surfaceSeconds.browser, 7200);
});

test("Budget defaults to the free plan", () => {
  const budget = new Budget(1);
  assert.equal(budget.plan, "free");
  assert.equal(budget.limitUsd, 1);
  assert.equal(budget.spentUsd, 0);
});

test("assertCanAfford passes under the limit", () => {
  const budget = new Budget(0.5, "starter");
  // Estimated 180s browser = $0.005, well under $0.50.
  budget.assertCanAfford("browser", 180);
  budget.assertCanAfford("sandbox", 180);
  budget.assertCanAfford("desktop", 240);
});

test("assertCanAfford throws BudgetExceededError past the limit", () => {
  const budget = new Budget(0.000001, "starter");
  assert.throws(() => budget.assertCanAfford("browser", 180), BudgetExceededError);
  assert.throws(() => budget.assertCanAfford("browser", 180), /budget_exceeded/);
  // Nothing was charged by the refusal.
  assert.equal(budget.spentUsd, 0);
});

test("assertCanAfford counts already-spent dollars toward the projection", () => {
  const budget = new Budget(0.01, "starter");
  budget.charge("browser", 3600); // spent $0.10 — already over
  assert.throws(() => budget.assertCanAfford("sandbox", 1), BudgetExceededError);
});

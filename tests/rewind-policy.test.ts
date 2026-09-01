/** Rewind policy tests — classification buckets and the decision matrix. */
import assert from "node:assert/strict";
import test from "node:test";
import { classifyError, decideRewind, REWIND_POLICY } from "../src/rewind/policy.ts";
import { BudgetExceededError, FocusMissError } from "../src/types.ts";

test("classifyError buckets each error kind", () => {
  assert.equal(classifyError(new FocusMissError("sentinel did not render")), "desktop.focus_miss");
  assert.equal(classifyError(new BudgetExceededError("budget_exceeded: ...")), "budget_exceeded");
  assert.equal(classifyError(new Error("portal login rejected: 401 invalid credentials")), "portal_rejected_auth");
  assert.equal(classifyError(new Error("auth failed")), "portal_rejected_auth");
  assert.equal(classifyError(new Error("login.error banner visible")), "portal_rejected_auth");
  assert.equal(classifyError(new Error("desktop.health not ready after 30s")), "desktop.app_not_ready");
  assert.equal(classifyError(new Error("app_not_ready: X11 down")), "desktop.app_not_ready");
  assert.equal(classifyError(new Error("disk full")), "unknown");
  // Non-Error values classify by their string form.
  assert.equal(classifyError("401 unauthorized"), "portal_rejected_auth");
  assert.equal(classifyError("weird string"), "unknown");
  assert.equal(classifyError(null), "unknown");
});

test("policy tables mirror the plan's policy file", () => {
  assert.equal(REWIND_POLICY.maxAttemptsPerStep, 2);
  assert.deepEqual(REWIND_POLICY.restoreSnapshotOn, ["desktop.focus_miss", "desktop.app_not_ready"]);
  assert.deepEqual(REWIND_POLICY.neverRestoreOn, ["budget_exceeded", "portal_rejected_auth"]);
  assert.equal(REWIND_POLICY.keepFailedArtifacts, true);
});

test("decideRewind rewinds a focus miss on attempt 1, aborts on attempt 2", () => {
  const miss = new FocusMissError("focus miss");
  assert.deepEqual(decideRewind(miss, 1), { action: "rewind", reason: "desktop.focus_miss" });
  const second = decideRewind(miss, 2);
  assert.equal(second.action, "abort");
  assert.match(second.reason, /attempts exhausted/);
});

test("decideRewind rewinds an app_not_ready while attempts remain", () => {
  const err = new Error("desktop.health not ready after 30s");
  assert.deepEqual(decideRewind(err, 1), { action: "rewind", reason: "desktop.app_not_ready" });
  assert.equal(decideRewind(err, 2).action, "abort");
});

test("decideRewind aborts immediately on budget and auth errors", () => {
  assert.deepEqual(decideRewind(new BudgetExceededError("x"), 1), {
    action: "abort",
    reason: "budget_exceeded",
  });
  assert.deepEqual(decideRewind(new Error("401 invalid credentials"), 1), {
    action: "abort",
    reason: "portal_rejected_auth",
  });
  // Even on the first attempt — these are human problems, not timing problems.
  assert.equal(decideRewind(new BudgetExceededError("x"), 1).action, "abort");
});

test("decideRewind aborts on unknown errors without retrying blind", () => {
  assert.deepEqual(decideRewind(new Error("disk full"), 1), { action: "abort", reason: "unknown" });
  const exhausted = decideRewind(new Error("disk full"), 5);
  assert.equal(exhausted.action, "abort");
  assert.match(exhausted.reason, /attempts exhausted/);
});

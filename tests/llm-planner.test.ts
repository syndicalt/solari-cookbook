/** LLM planner tests — off by default, not implemented when opted in. */
import assert from "node:assert/strict";
import test from "node:test";
import { planFromText, PlannerDisabledError } from "../src/planner/llm.ts";

test("planFromText throws PlannerDisabledError by default", async () => {
  await assert.rejects(planFromText("close the books", {}), PlannerDisabledError);
  await assert.rejects(planFromText("close the books", {}), /off by default/);
  // An explicit 0 is still off.
  await assert.rejects(planFromText("x", { NOAPI_LLM_PLANNER: "0" }), PlannerDisabledError);
});

test("planFromText with NOAPI_LLM_PLANNER=1 throws not-implemented", async () => {
  await assert.rejects(
    planFromText("close the books", { NOAPI_LLM_PLANNER: "1" }),
    /llm planner not implemented \(v1\)/,
  );
});

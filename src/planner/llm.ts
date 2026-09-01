/**
 * LLM planner (v1) — EXISTS, OFF BY DEFAULT.
 *
 * The scored demo is steered by the static JSON planner (`static.ts`); an
 * LLM loop at runtime is a lottery the reliability demo cannot afford.
 * This module is the seam for later work: every planned step must name a
 * surface and a success predicate before it may run (plan §6.8).
 *
 * Do not call this from the conductor without flipping the explicit opt-in.
 */
import type { Scenario } from "../types.ts";
import { parseScenario } from "./static.ts";

export class PlannerDisabledError extends Error {
  constructor() {
    super("llm planner is off by default; the static JSON planner steers the demo (ask before enabling)");
    this.name = "PlannerDisabledError";
  }
}

/**
 * Plan a scenario from natural language. Throws {@link PlannerDisabledError}
 * unless `NOAPI_LLM_PLANNER=1` is set — an intentional speed bump, per
 * AGENTS.md ("ask first" before turning on the LLM planner).
 */
export async function planFromText(_prompt: string, env: NodeJS.ProcessEnv = process.env): Promise<Scenario> {
  if (env.NOAPI_LLM_PLANNER !== "1") throw new PlannerDisabledError();
  // v1: one OpenAI-compatible call, response constrained to the scenario
  // schema, validated by parseScenario before anything executes.
  throw new Error("llm planner not implemented (v1)");
}

/** Re-export so a future LLM plan passes through the same validation gate. */
export { parseScenario };

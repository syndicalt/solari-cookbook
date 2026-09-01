/** Static planner tests — the scenario schema is the API; reject malformed plans precisely. */
import assert from "node:assert/strict";
import test from "node:test";
import { loadScenario, parseScenario } from "../src/planner/static.ts";

const VALID = {
  id: "mini",
  title: "minimal scenario",
  budgetUsd: 1,
  timeoutMs: 60_000,
  fixtures: { ledger: "fixtures/ledger.csv", policy: "fixtures/policy.yaml" },
  success: [{ kind: "fileExists", path: "exceptions.csv" }],
  steps: [{ id: "login", surface: "browser", action: "loginPortal" }],
};

function mutate(fn: (draft: Record<string, unknown>) => void): string {
  const draft = JSON.parse(JSON.stringify(VALID)) as Record<string, unknown>;
  fn(draft);
  return JSON.stringify(draft);
}

test("loadScenario parses scenarios/vendor-close.json", () => {
  const scenario = loadScenario("scenarios/vendor-close.json");
  assert.equal(scenario.id, "vendor-close");
  assert.equal(scenario.title, "June 2026 vendor close");
  assert.equal(scenario.budgetUsd, 0.5);
  assert.equal(scenario.steps.length, 6);
  assert.equal(scenario.success.length, 5);
  assert.deepEqual(
    scenario.steps.map((s) => s.id),
    ["login", "pull", "reconcile", "snapshot", "format", "file"],
  );
  assert.equal(scenario.steps[3]!.name, "close-numbers-ok");
});

test("parseScenario accepts a minimal valid scenario", () => {
  const scenario = parseScenario(JSON.stringify(VALID));
  assert.equal(scenario.id, "mini");
  assert.equal(scenario.steps.length, 1);
});

test("rejects bad JSON with a $ path", () => {
  assert.throws(() => parseScenario("{nope"), /scenario invalid at \$: not valid JSON/);
  assert.throws(() => parseScenario("[1,2]"), /scenario invalid at \$: must be an object/);
});

test("rejects missing/empty id and title", () => {
  assert.throws(
    () => parseScenario(mutate((d) => delete d.id)),
    /scenario invalid at id: non-empty string required/,
  );
  assert.throws(
    () => parseScenario(mutate((d) => (d.id = ""))),
    /scenario invalid at id/,
  );
  assert.throws(
    () => parseScenario(mutate((d) => delete d.title)),
    /scenario invalid at title/,
  );
});

test("rejects a bad surface and an unknown action, path-precise", () => {
  assert.throws(
    () =>
      parseScenario(
        mutate((d) => ((d.steps as Array<Record<string, unknown>>)[0]!.surface = "toaster")),
      ),
    /scenario invalid at steps\[0\]\.surface: must be one of browser\|sandbox\|desktop/,
  );
  assert.throws(
    () =>
      parseScenario(
        mutate((d) => ((d.steps as Array<Record<string, unknown>>)[0]!.action = "hackTheMainframe")),
      ),
    /scenario invalid at steps\[0\]\.action: unknown action "hackTheMainframe"/,
  );
});

test("rejects duplicate step ids", () => {
  assert.throws(
    () =>
      parseScenario(
        mutate((d) => {
          (d.steps as unknown[]).push({ id: "login", surface: "sandbox", action: "snapshot" });
        }),
      ),
    /scenario invalid at steps: step ids must be unique/,
  );
});

test("rejects bad predicate kinds and malformed predicate fields", () => {
  assert.throws(
    () =>
      parseScenario(
        mutate((d) => ((d.success as Array<Record<string, unknown>>)[0]!.kind = "vibes")),
      ),
    /scenario invalid at success\[0\]\.kind: must be one of/,
  );
  assert.throws(
    () =>
      parseScenario(
        mutate((d) => {
          (d.success as unknown[])[0] = { kind: "rowCount", path: "a.csv" };
        }),
      ),
    /scenario invalid at success\[0\]\.min: non-negative number required/,
  );
  assert.throws(
    () =>
      parseScenario(
        mutate((d) => {
          (d.success as unknown[])[0] = { kind: "portalAccepted" };
        }),
      ),
    /scenario invalid at success\[0\]\.url/,
  );
  assert.throws(
    () =>
      parseScenario(
        mutate((d) => {
          (d.success as unknown[])[0] = { kind: "screenshotContainsText", path: "s.png" };
        }),
      ),
    /scenario invalid at success\[0\]\.text/,
  );
});

test("rejects negative/zero budget and timeout", () => {
  assert.throws(
    () => parseScenario(mutate((d) => (d.budgetUsd = -1))),
    /scenario invalid at budgetUsd: positive number required/,
  );
  assert.throws(
    () => parseScenario(mutate((d) => (d.budgetUsd = 0))),
    /scenario invalid at budgetUsd/,
  );
  assert.throws(
    () => parseScenario(mutate((d) => (d.timeoutMs = 0))),
    /scenario invalid at timeoutMs/,
  );
});

test("rejects empty steps and empty success arrays", () => {
  assert.throws(
    () => parseScenario(mutate((d) => (d.steps = []))),
    /scenario invalid at steps: non-empty array required/,
  );
  assert.throws(
    () => parseScenario(mutate((d) => (d.success = []))),
    /scenario invalid at success: non-empty array required/,
  );
});

test("rejects malformed fixtures and step objects", () => {
  assert.throws(
    () => parseScenario(mutate((d) => (d.fixtures = {}))),
    /scenario invalid at fixtures\.ledger: string required/,
  );
  assert.throws(
    () => parseScenario(mutate((d) => ((d.steps as unknown[])[0] = "login"))),
    /scenario invalid at steps\[0\]: must be an object/,
  );
  assert.throws(
    () =>
      parseScenario(
        mutate((d) => ((d.steps as Array<Record<string, unknown>>)[0]!.name = 42)),
      ),
    /scenario invalid at steps\[0\]\.name: string when present/,
  );
});

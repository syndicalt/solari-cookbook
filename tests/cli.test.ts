/**
 * CLI tests — spawn `node src/cli.ts` variants in child processes with a
 * scrubbed environment. SOLARI_API_KEY is set to "" (not deleted) so a stray
 * .env file cannot re-inject a key: loadDotEnv only fills undefined vars.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

function runCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, SOLARI_API_KEY: "" };
  delete env.NOAPI_LLM_PLANNER;
  delete env.NOAPI_PORTAL_ORIGIN;
  delete env.NOAPI_PORTAL_USER;
  delete env.NOAPI_PORTAL_PASSWORD;
  const result = spawnSync(process.execPath, ["src/cli.ts", ...args], {
    cwd: ROOT,
    env,
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.ifError(result.error);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test("no args prints usage and exits 0", () => {
  const { status, stderr } = runCli([]);
  assert.equal(status, 0);
  assert.match(stderr, /usage:/);
  assert.match(stderr, /noapi doctor/);
});

test("help exits 0 with usage", () => {
  const { status, stderr } = runCli(["help"]);
  assert.equal(status, 0);
  assert.match(stderr, /usage:/);
});

test("doctor without a key exits 2 with a clear message", () => {
  const { status, stderr } = runCli(["doctor"]);
  assert.equal(status, 2);
  assert.match(stderr, /doctor: SOLARI_API_KEY is not set\./);
  assert.match(stderr, /demo-offline/);
});

test("run --dry validates the scenario and exits 0 without a key", () => {
  const { status, stdout } = runCli(["run", "scenarios/vendor-close.json", "--dry"]);
  assert.equal(status, 0);
  assert.match(stdout, /run\.start scenario=vendor-close/);
  assert.match(stdout, /run\.dry steps=6 predicates=5 budget=\$0\.5/);
  // The dry run never talks about disposing sessions — nothing was launched.
  assert.ok(!stdout.includes("run.done"));
});

test("run without a key exits 2 and refuses to fake a Solari run", () => {
  const { status, stderr } = runCli(["run", "scenarios/vendor-close.json"]);
  assert.equal(status, 2);
  assert.match(stderr, /refusing to fake a Solari run/);
  assert.match(stderr, /make demo-offline/);
});

test("run with a missing scenario file exits 1 with the planner error", () => {
  const { status, stderr } = runCli(["run", "scenarios/nope.json"]);
  assert.equal(status, 1);
  assert.match(stderr, /noapi:/);
});

test("unknown command exits 2 with usage", () => {
  const { status, stderr } = runCli(["frobnicate"]);
  assert.equal(status, 2);
  assert.match(stderr, /usage:/);
});

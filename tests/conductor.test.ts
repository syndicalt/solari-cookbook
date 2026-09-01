/**
 * Conductor integration tests — offline end-to-end runs of
 * `runScenario(scenarios/vendor-close.json)` against fake surfaces and a real
 * ephemeral portal. The portal traffic and reconciliation are real; only the
 * Solari session lifecycle is simulated (see tests/helpers/fake-surfaces.ts).
 *
 * These are not fake Solari runs: no test here claims a live browser,
 * sandbox, or desktop session existed.
 */
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createPortal, type PortalHandle } from "../apps/portal/server.ts";
import { runScenario } from "../src/conductor.ts";
import { csvDataRows } from "../src/eval/predicates.ts";
import { verifyManifest } from "../src/manifest.ts";
import { loadScenario } from "../src/planner/static.ts";
import type { EvalReport, JournalEvent, NoapiConfig, Scenario } from "../src/types.ts";
import { makeFakeFactory } from "./helpers/fake-surfaces.ts";

interface Boot {
  portal: PortalHandle;
  config: NoapiConfig;
  artifactsRoot: string;
  scenario: Scenario;
}

async function boot(t: test.TestContext): Promise<Boot> {
  const portal = await createPortal({ port: 0 });
  t.after(() => portal.close());
  const artifactsRoot = await mkdtemp(join(tmpdir(), "noapi-conductor-"));
  const config: NoapiConfig = {
    solariApiKey: "",
    portalOrigin: `http://127.0.0.1:${portal.port}`,
    portalUser: "reviewer@getsolari.com",
    portalPassword: "reviewer",
    plan: "starter",
  };
  return { portal, config, artifactsRoot, scenario: loadScenario("scenarios/vendor-close.json") };
}

function readJournal(dir: string): JournalEvent[] {
  return readFileSync(join(dir, "journal.ndjson"), "utf8")
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as JournalEvent);
}

function readEval(dir: string): EvalReport {
  return JSON.parse(readFileSync(join(dir, "eval.json"), "utf8")) as EvalReport;
}

/** OCR stub: the desktop-final frame "shows" the typed exceptions title. */
const predicateDeps = { ocr: async (_pngPath: string) => "EXCEPTIONS — JUNE 2026" };
const silentLogger = (_line: string) => {};

test("conductor happy path — green eval.json, full artifact pack", async (t) => {
  const { config, artifactsRoot, scenario } = await boot(t);
  const { factory, created } = makeFakeFactory(config);

  const report = await runScenario(scenario, config, {
    surfaces: factory,
    artifactsRoot,
    predicateDeps,
    logger: silentLogger,
  });
  const dir = join(artifactsRoot, report.runId);

  assert.equal(report.ok, true, `predicates: ${JSON.stringify(report.predicates)}`);
  assert.equal(report.predicates.length, 5);
  assert.ok(report.predicates.every((p) => p.ok), JSON.stringify(report.predicates));
  assert.equal(report.rewinds, 0);
  assert.equal(report.scenario, "vendor-close");

  // The evidence pack on disk.
  for (const name of [
    "journal.ndjson",
    "eval.json",
    "exceptions.csv",
    "close-pack.pdf",
    "chart.png",
    "desktop-final.png",
    "browser.ndjson",
    "dashboard.html",
    "MANIFEST.sha256",
  ]) {
    assert.ok(existsSync(join(dir, name)), `missing artifact ${name}`);
  }
  assert.equal(csvDataRows(join(dir, "exceptions.csv")), 2, "seeded ledger disagrees on two invoices");
  assert.equal(readFileSync(join(dir, "close-pack.pdf"), "utf8").slice(0, 4), "%PDF");
  assert.equal(readFileSync(join(dir, "chart.png")).subarray(1, 4).toString("latin1"), "PNG");
  // The rewind ring flushed at least one frame into the artifact dir.
  assert.ok(
    readdirSync(dir).some((name) => /^desktop-\d+-.+\.png$/.test(name)),
    "no ring frame flushed",
  );

  // Journal shows every step green.
  const events = readJournal(dir);
  const okIds = events.filter((e) => e.type === "step.ok").map((e) => (e as { id: string }).id);
  for (const id of ["login", "pull", "reconcile", "snapshot", "format", "file"]) {
    assert.ok(okIds.includes(id), `no step.ok for ${id}`);
  }
  assert.equal(events.filter((e) => e.type === "step.fail").length, 0);

  // Manifest verifies; cost and surface seconds are real numbers.
  assert.deepEqual(verifyManifest(dir), { ok: true, mismatches: [] });
  assert.ok(report.costUsdEstimate > 0, "cost must be > 0");
  assert.ok(report.surfaces.browserSec > 0);
  assert.ok(report.surfaces.sandboxSec > 0);
  assert.ok(report.surfaces.desktopSec > 0);
  assert.match(report.streamUrl ?? "", /^vnc:\/\//);
  assert.match(report.replayUrl ?? "", /browser\.ndjson$/);

  // eval.json on disk agrees with the returned report.
  const onDisk = readEval(dir);
  assert.equal(onDisk.ok, true);
  assert.equal(onDisk.rewinds, 0);

  // Every surface was disposed (reverse order, always).
  assert.equal(created.browsers.length, 1);
  assert.equal(created.sandboxes.length, 1);
  assert.equal(created.desktops.length, 1);
  assert.equal(created.browsers[0]!.disposeCalls, 1);
  assert.equal(created.sandboxes[0]!.disposeCalls, 1);
  assert.equal(created.desktops[0]!.disposeCalls, 1);
  // Scored browser sessions record.
  assert.equal(created.browsers[0]!.startOpts?.recording, true);
});

test("conductor rewind — focus miss rewinds the step, run still goes green", async (t) => {
  const { config, artifactsRoot, scenario } = await boot(t);
  const { factory, created } = makeFakeFactory(config, { failFirstFormat: "focus" });

  const report = await runScenario(scenario, config, {
    surfaces: factory,
    artifactsRoot,
    predicateDeps,
    logger: silentLogger,
  });
  const dir = join(artifactsRoot, report.runId);

  assert.equal(report.ok, true, `predicates: ${JSON.stringify(report.predicates)}`);
  assert.equal(report.rewinds, 1);

  // The journal tells the story: format failed once, rewound to the snapshot.
  const events = readJournal(dir);
  const rewinds = events.filter((e) => e.type === "rewind");
  assert.equal(rewinds.length, 1);
  assert.deepEqual(
    { from: (rewinds[0] as { from: string }).from, snapshot: (rewinds[0] as { snapshot: string }).snapshot },
    { from: "format", snapshot: "snap-fake-001" },
  );
  const formatFails = events.filter((e) => e.type === "step.fail" && (e as { id: string }).id === "format");
  assert.equal(formatFails.length, 1);
  assert.match((formatFails[0] as { error: string }).error, /focus/);

  // The sandbox snapshot was reverted, not the universe.
  assert.equal(created.sandboxes.length, 1);
  assert.deepEqual(created.sandboxes[0]!.reverts, ["snap-fake-001"]);

  // Two desktops: the poisoned GUI session was discarded, a fresh one retried.
  assert.equal(created.desktops.length, 2);
  assert.equal(created.desktops[0]!.disposeCalls, 1, "failed desktop must be disposed");
  assert.equal(created.desktops[0]!.formatCalls, 1);
  assert.equal(created.desktops[1]!.formatCalls, 1);
  assert.equal(created.desktops[1]!.disposeCalls, 1);

  // eval.json on disk is still green.
  const onDisk = readEval(dir);
  assert.equal(onDisk.ok, true);
  assert.equal(onDisk.rewinds, 1);
  assert.deepEqual(verifyManifest(dir), { ok: true, mismatches: [] });
});

test("conductor budget guard — microscopic budget aborts before any surface", async (t) => {
  const { config, artifactsRoot, scenario } = await boot(t);
  const { factory, created } = makeFakeFactory(config);
  const broke: Scenario = { ...scenario, budgetUsd: 0.000001 };

  const report = await runScenario(broke, config, {
    surfaces: factory,
    artifactsRoot,
    predicateDeps,
    logger: silentLogger,
  });
  const dir = join(artifactsRoot, report.runId);

  assert.equal(report.ok, false);
  assert.equal(report.rewinds, 0);

  // The budget error was journaled honestly — no fake "passed" run.
  const events = readJournal(dir);
  const fails = events.filter((e) => e.type === "step.fail");
  assert.ok(fails.length >= 1);
  assert.match((fails[0] as { error: string }).error, /budget_exceeded/);
  assert.equal(events.filter((e) => e.type === "step.ok").length, 0);

  // No surface was ever acquired (the guard fires before creation), so there
  // is nothing left alive — and the run still wrote its artifacts.
  assert.equal(created.browsers.length, 0);
  assert.equal(created.sandboxes.length, 0);
  assert.equal(created.desktops.length, 0);
  assert.equal(readEval(dir).ok, false);
  assert.ok(existsSync(join(dir, "MANIFEST.sha256")));
});

test("conductor portal-auth failure — aborts on step one, never rewinds", async (t) => {
  const { config, artifactsRoot, scenario } = await boot(t);
  const badConfig: NoapiConfig = { ...config, portalPassword: "wrong-password" };
  const { factory, created } = makeFakeFactory(badConfig);

  const report = await runScenario(scenario, badConfig, {
    surfaces: factory,
    artifactsRoot,
    predicateDeps,
    logger: silentLogger,
  });
  const dir = join(artifactsRoot, report.runId);

  assert.equal(report.ok, false);
  assert.equal(report.rewinds, 0, "neverRestoreOn: portal_rejected_auth");

  const events = readJournal(dir);
  // Failed on the FIRST step; nothing downstream ran.
  const fails = events.filter((e) => e.type === "step.fail");
  assert.equal(fails.length, 1);
  assert.equal((fails[0] as { id: string }).id, "login");
  assert.equal(events.filter((e) => e.type === "step.ok").length, 0);
  assert.equal(events.filter((e) => e.type === "rewind").length, 0);

  // The browser session was still disposed on the way out.
  assert.equal(created.browsers.length, 1);
  assert.equal(created.browsers[0]!.disposeCalls, 1);
  assert.equal(created.desktops.length, 0);
  assert.equal(readEval(dir).ok, false);
});

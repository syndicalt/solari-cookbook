/**
 * Conductor — plan, budget, timeout, journal, rewind.
 *
 * One Node process conducts all three Solari surfaces through the scenario's
 * steps. Surfaces are acquired lazily (the desktop does not boot until the
 * sandbox snapshot exists), every acquisition passes the budget guard, every
 * step goes through the rewind policy on failure, and every surface is
 * disposed — including on crash, via process signal handlers. A crashed
 * agent that leaves VMs running is an automatic no.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { EvalReport, JournalEvent, NoapiConfig, Scenario, ScenarioStep, SurfaceName } from "./types.ts";
import { Journal } from "./journal.ts";
import { Budget } from "./budget.ts";
import { ulid } from "./ulid.ts";
import { writeManifest } from "./manifest.ts";
import { decideRewind } from "./rewind/policy.ts";
import { evaluateAll, type PredicateDeps } from "./eval/predicates.ts";
import { buildReport, writeReport } from "./eval/score.ts";
import { writeDashboard } from "./dashboard.ts";
import { SolariBrowserSurface, type BrowserSurface } from "./surfaces/browser.ts";
import { SolariSandboxSurface, type SandboxSurface } from "./surfaces/sandbox.ts";
import { SolariDesktopSurface, type DesktopSurface } from "./surfaces/desktop.ts";
import type { ScreenshotRing } from "./rewind/screenshots.ts";

/** Creates fresh surface instances. Injected in tests; real Solari in prod. */
export interface SurfaceFactory {
  browser(): BrowserSurface;
  sandbox(): SandboxSurface;
  desktop(): DesktopSurface;
}

export interface ConductorDeps {
  surfaces?: SurfaceFactory;
  predicateDeps?: PredicateDeps;
  /** Root for artifact dirs. Default "artifacts". */
  artifactsRoot?: string;
  logger?: (line: string) => void;
  now?: () => number;
}

/** Upper-bound seconds used by the budget guard before acquiring a surface. */
const SURFACE_ESTIMATES: Record<SurfaceName, number> = { browser: 180, sandbox: 180, desktop: 240 };
const PROFILE_NAME = "noapi-vendor-close";

/** Default factory: real Solari surfaces driven by the resolved config. */
function solariFactory(config: NoapiConfig): SurfaceFactory {
  return {
    browser: () => new SolariBrowserSurface(config),
    sandbox: () => new SolariSandboxSurface(config),
    desktop: () => new SolariDesktopSurface(config),
  };
}

/** Run a scenario end-to-end and return the eval report (also written to disk). */
export async function runScenario(
  scenario: Scenario,
  config: NoapiConfig,
  deps: ConductorDeps = {},
): Promise<EvalReport> {
  const now = deps.now ?? Date.now;
  const log = deps.logger ?? ((line: string) => console.log(line));
  let factory = deps.surfaces ?? solariFactory(config);

  const runId = ulid(now());
  const dir = join(deps.artifactsRoot ?? "artifacts", runId);
  mkdirSync(dir, { recursive: true });

  const journal = new Journal(join(dir, "journal.ndjson"));
  const events: JournalEvent[] = [];
  const emit = (e: JournalEvent) => {
    events.push(e);
    journal.write(e);
  };

  const budget = new Budget(scenario.budgetUsd, config.plan);
  const deadline = now() + scenario.timeoutMs;
  const wallStart = now();

  // Live surfaces, disposed in reverse acquisition order — always.
  const live: Array<{
    name: SurfaceName;
    surface: BrowserSurface | SandboxSurface | DesktopSurface;
    /** Dollars reserved at acquire; released on dispose (see Budget.reserve). */
    reservation: number;
  }> = [];
  let browser: BrowserSurface | null = null;
  let sandbox: SandboxSurface | null = null;
  let desktop: DesktopSurface | null = null;
  let snapshotId: string | null = null;
  let streamUrl: string | null = null;
  let desktopRecordingUrl: string | null = null;
  let replayPath: string | null = null;
  /** Config the run actually uses — portalMode "sandbox" rewrites the origin. */
  let runConfig = config;
  let zipPath: string | null = null;
  let exceptionsCsvPath: string | null = null;
  let pdfPath: string | null = null;
  let failed = false;

  const acquire = <S extends BrowserSurface | SandboxSurface | DesktopSurface>(name: SurfaceName, make: () => S): S => {
    budget.assertCanAfford(name, SURFACE_ESTIMATES[name]);
    const reservation = budget.reserve(name, SURFACE_ESTIMATES[name]);
    const s = make();
    live.push({ name, surface: s, reservation });
    return s;
  };
  const getBrowser = () => (browser ??= acquire("browser", factory.browser));
  const getSandbox = () => (sandbox ??= acquire("sandbox", factory.sandbox));
  const getDesktop = () => (desktop ??= acquire("desktop", factory.desktop));

  /** A fresh desktop session for a retry — the failed GUI state is discarded. */
  const resetDesktop = async () => {
    if (!desktop) return;
    await flushRing(desktop);
    await desktop.dispose();
    const i = live.findIndex((l) => l.surface === desktop);
    if (i >= 0) {
      budget.releaseReserved(live[i]!.reservation);
      live.splice(i, 1);
    }
    budget.charge("desktop", desktop.secondsUsed());
    desktop = null;
  };

  const flushRing = async (d: DesktopSurface) => {
    const ring = (d as { ring?: ScreenshotRing }).ring;
    if (!ring) return;
    for (const p of await ring.flush(dir)) emit({ t: now(), type: "artifact", path: p });
  };

  // Dispose everything on SIGINT/SIGTERM too — credits are the budget.
  // Errors are LOGGED (a swallowed dispose failure is a billing leak), and a
  // watchdog caps the whole teardown so a hung dispose cannot pin the process.
  const onSignal = () => {
    void (async () => {
      const teardown = (async () => {
        for (const { name, surface } of [...live].reverse()) {
          await surface.dispose().catch((e) => log(`dispose.warn ${name} ${(e as Error).message}`));
        }
      })();
      const timeout = new Promise<void>((r) => setTimeout(r, 10_000));
      await Promise.race([teardown, timeout]);
      process.exit(130);
    })();
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  /** Step actions — dispatched by id, never a conditional pile. */
  const actions: Record<ScenarioStep["action"], (step: ScenarioStep) => Promise<void>> = {
    async loginPortal() {
      const b = getBrowser();
      await b.start({ recording: true, stealth: config.plan === "starter", profile: PROFILE_NAME });
      await b.loginPortal();
      await b.saveProfile();
    },
    async downloadInvoices() {
      zipPath = await getBrowser().downloadInvoices(dir);
      emit({ t: now(), type: "artifact", path: zipPath });
    },
    async reconcileLedger() {
      const sb = getSandbox();
      await sb.start({});
      if (!zipPath) throw new Error("reconcile requires the invoice zip (pull step first)");
      const result = await sb.reconcileLedger({ zipPath, fixturesDir: "fixtures" });
      exceptionsCsvPath = join(dir, "exceptions.csv");
      writeFileSync(exceptionsCsvPath, result.exceptionsCsv);
      writeFileSync(join(dir, "chart.png"), result.chartPng);
      emit({ t: now(), type: "artifact", path: exceptionsCsvPath });
      emit({ t: now(), type: "artifact", path: join(dir, "chart.png") });
    },
    async snapshot(step) {
      snapshotId = await getSandbox().snapshot(step.name ?? "close-numbers-ok");
    },
    async formatLibreOffice() {
      const d = getDesktop();
      streamUrl = await d.start({ record: true });
      log(`desktop.stream url=${streamUrl}`);
      if (!exceptionsCsvPath) throw new Error("format requires exceptions.csv (reconcile step first)");
      const { pdfBytes, finalShot } = await d.formatLibreOffice({ exceptionsCsvPath });
      pdfPath = join(dir, "close-pack.pdf");
      writeFileSync(pdfPath, pdfBytes);
      writeFileSync(join(dir, "desktop-final.png"), finalShot);
      await flushRing(d);
      emit({ t: now(), type: "artifact", path: pdfPath });
      emit({ t: now(), type: "artifact", path: join(dir, "desktop-final.png") });
    },
    async uploadPack() {
      if (!pdfPath) throw new Error("upload requires close-pack.pdf (format step first)");
      await getBrowser().uploadPack(pdfPath);
    },
  };

  try {
    // Portal-in-sandbox mode: a cloud browser cannot reach this machine's
    // localhost, and a 1-VM account cannot run a second sandbox just for the
    // portal — so the run's own sandbox serves it via previewUrl, and every
    // surface downstream uses the public URL. The same VM then also runs
    // reconciliation: one sandbox total, the entire world is Solari.
    if (runConfig.portalMode === "sandbox") {
      // Assign to the shared ref: reconciliation must reuse THIS VM, not
      // boot a second one (the whole point on 1-concurrent-VM accounts).
      const sb = (sandbox ??= acquire("sandbox", factory.sandbox));
      await sb.start({});
      const portalOrigin = await sb.servePortal(8787);
      log(`portal.sandbox url=${portalOrigin}`);
      runConfig = { ...config, portalOrigin };
      // Surfaces capture config at construction; rebind the production
      // factory so the browser surface sees the preview URL. Injected
      // factories (tests) manage their own config.
      if (!deps.surfaces) factory = solariFactory(runConfig);
    }

    for (const step of scenario.steps) {
      if (now() > deadline) throw new Error(`run.timeout exceeded ${scenario.timeoutMs}ms before step ${step.id}`);
      let attempt = 0;
      for (;;) {
        attempt += 1;
        const started = now();
        emit({ t: started, type: "step.start", id: step.id, surface: step.surface });
        try {
          await actions[step.action](step);
          emit({ t: now(), type: "step.ok", id: step.id, ms: now() - started });
          break;
        } catch (err) {
          const screenshot = err instanceof Error && "screenshotPath" in err ? (err as { screenshotPath?: string }).screenshotPath : undefined;
          emit({ t: now(), type: "step.fail", id: step.id, error: (err as Error).message, ...(screenshot ? { screenshot } : {}) });
          const decision = decideRewind(err, attempt);
          if (decision.action === "abort") throw err;
          // Rewind the step, not the universe: restore the last-good sandbox
          // snapshot (protects reconciled state) and retry with a fresh desktop.
          emit({ t: now(), type: "rewind", from: step.id, snapshot: snapshotId ?? "none" });
          log(`rewind step=${step.id} reason=${decision.reason} snapshot=${snapshotId ?? "none"}`);
          if (step.surface === "desktop") {
            const sb = sandbox as SandboxSurface | null; // CFA can't see closure assignments
            if (snapshotId && sb && process.env.NOAPI_REWIND_REVERT === "1") {
              // Opt-in only: on the current pool, revert reports "Not
              // revertable" AND the attempt itself disrupts the VM — twice
              // observed live: heartbeats fail right after the call, and the
              // previewUrl portal 404s (the upload step then dies).
              // TODO(solari-api): re-enable by default once revert is
              // non-destructive (https://docs.getsolari.com).
              try {
                await sb.revert(snapshotId);
              } catch (revertErr) {
                log(`sandbox.revert_failed ${(revertErr as Error).message} — continuing without restore`);
              }
            } else if (snapshotId) {
              // The revert is protective, not load-bearing: nothing writes
              // to the sandbox after the snapshot, so its state is already
              // last-good. The half of the rewind that matters is the fresh
              // desktop below.
              log(`rewind.norevert snapshot=${snapshotId} state=last-good`);
            }
            await resetDesktop();
          }
        }
      }
    }
  } catch (err) {
    failed = true;
    log(`run.fail ${(err as Error).message}`);
  }

  // Eval predicates run BEFORE dispose: in portal-sandbox mode the portal
  // dies with the sandbox, so portalAccepted must be checked while every
  // surface is still up. On abort, unmet predicates fail honestly.
  const predicateResults = await evaluateAll(scenario.success, dir, runConfig, deps.predicateDeps);

  // Dispose in reverse order, always — but stop the desktop recording first:
  // the guest uploads the mp4 on record.stop(), so disposing first loses it.
  for (const { name, surface, reservation } of [...live].reverse()) {
    if (name === "desktop") {
      const d = surface as DesktopSurface;
      await flushRing(d);
      const url = await d.stopRecording().catch(() => null);
      if (url) {
        desktopRecordingUrl ??= url;
        log(`desktop.recording url=${url}`);
      }
    }
    await surface.dispose().catch((e) => log(`dispose.warn ${name} ${(e as Error).message}`));
    budget.releaseReserved(reservation);
    budget.charge(name, surface.secondsUsed());
    emit({ t: now(), type: "cost", usd: budget.spentUsd });
  }
  if (browser) {
    replayPath = await browser.fetchReplay(join(dir, "browser.ndjson")).catch(() => null);
    if (replayPath) emit({ t: now(), type: "artifact", path: replayPath });
  }

  // Eval is the source of truth (predicates were evaluated pre-dispose).
  const report = buildReport({
    runId,
    scenario: scenario.id,
    predicates: predicateResults,
    wallMs: now() - wallStart,
    costUsdEstimate: budget.spentUsd,
    surfaces: {
      browserSec: Math.round(budget.surfaceSeconds.browser),
      sandboxSec: Math.round(budget.surfaceSeconds.sandbox),
      desktopSec: Math.round(budget.surfaceSeconds.desktop),
    },
    replayUrl: replayPath,
    streamUrl,
    // Free plan: one concurrent sandbox, already spent — dashboard is local.
    // Starter+: serve apps/dashboard from a sandbox and put previewUrl here.
    previewUrl: null,
    desktopRecordingUrl,
    rewinds: journal.rewinds,
  });
  if (failed) report.ok = false;

  writeDashboard(dir, report, events);
  writeReport(dir, report);
  await journal.close();
  writeManifest(dir);
  process.off("SIGINT", onSignal);
  process.off("SIGTERM", onSignal);
  log(`run.eval ok=${report.ok} dir=${resolve(dir)}`);
  return report;
}

/**
 * Fake surfaces — test doubles implementing our own surface interfaces
 * (`BrowserSurface`, `SandboxSurface`, `DesktopSurface`) so the conductor can
 * be integration-tested offline.
 *
 * These are NOT fake Solari runs: the fake browser really logs into the local
 * portal over HTTP, really downloads the invoice zip, and really uploads the
 * close-pack PDF; the fake sandbox really extracts the zip and really runs
 * `fixtures/reconcile.py` with the local python3. Only the Solari session
 * lifecycle (launch/kill/destroy, snapshot/revert, replay) is simulated —
 * exactly the parts that need an API key and a network.
 */
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { ROUTES } from "../../apps/portal/selectors.ts";
import { buildPdf } from "../../scripts/make-pack.ts";
import type { SurfaceFactory } from "../../src/conductor.ts";
import { ScreenshotRing } from "../../src/rewind/screenshots.ts";
import type { BrowserStartOptions, BrowserSurface, PageLike } from "../../src/surfaces/browser.ts";
import type {
  DesktopStartOpts,
  DesktopSurface,
  FormatLibreOfficeOpts,
  FormatLibreOfficeResult,
} from "../../src/surfaces/desktop.ts";
import type {
  ReconcileOptions,
  ReconcileResult,
  SandboxStartOptions,
  SandboxSurface,
} from "../../src/surfaces/sandbox.ts";
import { FocusMissError, type NoapiConfig } from "../../src/types.ts";

const execFileAsync = promisify(execFile);

/**
 * Seconds floor for the fakes. Real secondsUsed() is wall time and can
 * legitimately be ~0 in a fast test run, which would zero the cost line; the
 * fakes floor at half a second so the budget ledger is exercised for real.
 */
const MIN_SECONDS = 0.5;

/** A real, tiny PNG (1x1, libpng/leptonica-valid) — deterministic, no encoder needed. */
export const TINY_PNG: Uint8Array = new Uint8Array(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "base64",
  ),
);

function elapsedSeconds(startedAt: number | null, endedAt: number | null): number {
  if (startedAt === null) return 0;
  return Math.max(((endedAt ?? Date.now()) - startedAt) / 1000, MIN_SECONDS);
}

/* ------------------------------------------------------------------------ */
/* Browser.                                                                 */
/* ------------------------------------------------------------------------ */

/**
 * Fake browser surface. The portal traffic is real HTTP against the local
 * portal (form login, cookie, zip download, multipart upload); only the
 * Solari session around it is simulated.
 */
export class FakeBrowserSurface implements BrowserSurface {
  readonly config: NoapiConfig;
  readonly id: string;

  startOpts: BrowserStartOptions | null = null;
  loginCalls = 0;
  downloadCalls = 0;
  uploadCalls: string[] = [];
  saveProfileCalls = 0;
  disposeCalls = 0;
  replayPath: string | null = null;

  #cookie = "";
  #startedAt: number | null = null;
  #endedAt: number | null = null;

  constructor(config: NoapiConfig, id: string) {
    this.config = config;
    this.id = id;
  }

  async start(opts: BrowserStartOptions): Promise<void> {
    this.startOpts = opts;
    this.#startedAt = Date.now();
  }

  page(): PageLike {
    throw new Error("fake browser has no page — the conductor only calls actions");
  }

  /** Real form login against the portal; keeps the sid cookie. */
  async loginPortal(): Promise<void> {
    this.loginCalls += 1;
    const res = await fetch(`${this.config.portalOrigin}${ROUTES.login}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        email: this.config.portalUser,
        password: this.config.portalPassword,
      }).toString(),
      redirect: "manual",
    });
    const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0];
    if (!cookie) {
      throw new Error(`portal login rejected: auth failed (status ${res.status}, invalid credentials)`);
    }
    this.#cookie = cookie;
  }

  /** Real zip download with the session cookie. */
  async downloadInvoices(destDir: string): Promise<string> {
    this.downloadCalls += 1;
    await mkdir(destDir, { recursive: true });
    const res = await fetch(`${this.config.portalOrigin}${ROUTES.invoicesZip}`, {
      headers: { cookie: this.#cookie },
    });
    if (!res.ok) throw new Error(`browser.invoices failed status=${res.status}`);
    const path = resolve(destDir, "2026-06.zip");
    await writeFile(path, Buffer.from(await res.arrayBuffer()));
    return path;
  }

  /** Real multipart/form-data upload (hand-rolled, field name "file"). */
  async uploadPack(pdfPath: string): Promise<void> {
    this.uploadCalls.push(pdfPath);
    const pdf = await readFile(pdfPath);
    const boundary = "noapifakeboundary";
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\n` +
          'content-disposition: form-data; name="file"; filename="close-pack.pdf"\r\n' +
          "content-type: application/pdf\r\n\r\n",
      ),
      pdf,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const res = await fetch(`${this.config.portalOrigin}${ROUTES.closeSubmit}`, {
      method: "POST",
      headers: {
        "content-type": `multipart/form-data; boundary=${boundary}`,
        cookie: this.#cookie,
      },
      body,
    });
    const html = await res.text();
    if (res.status !== 200 || !html.includes("accepted")) {
      throw new Error(`browser.upload failed status=${res.status}`);
    }
  }

  /** Profiles are a Solari feature — recorded, no-op. */
  async saveProfile(): Promise<void> {
    this.saveProfileCalls += 1;
  }

  /** Writes a small fake rrweb NDJSON — the real replay poll needs Solari. */
  async fetchReplay(destPath: string): Promise<string | null> {
    const events = [
      { type: 2, source: "fake", note: "dom snapshot (fake replay)" },
      { type: 3, source: "fake", note: "incremental (fake replay)" },
    ];
    await writeFile(destPath, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
    this.replayPath = destPath;
    return destPath;
  }

  get sessionId(): string | null {
    return this.#startedAt === null ? null : this.id;
  }

  secondsUsed(): number {
    return elapsedSeconds(this.#startedAt, this.#endedAt);
  }

  async dispose(): Promise<void> {
    this.disposeCalls += 1;
    this.#endedAt = Date.now();
  }
}

/* ------------------------------------------------------------------------ */
/* Sandbox.                                                                 */
/* ------------------------------------------------------------------------ */

/**
 * Fake sandbox surface. Reconciliation really runs — the zip is extracted
 * with `python3 -m zipfile` and `fixtures/reconcile.py` is executed with the
 * local python3, exactly the way the Solari sandbox does it in-VM. Snapshot,
 * revert, and previewUrl are simulated.
 */
export class FakeSandboxSurface implements SandboxSurface {
  readonly id: string;

  startOpts: SandboxStartOptions | null = null;
  reconcileCalls: ReconcileOptions[] = [];
  snapshotCalls: Array<string | undefined> = [];
  reverts: string[] = [];
  previewCalls: number[] = [];
  disposeCalls = 0;
  /** Local tmp workdirs that played the role of the in-VM /work. */
  workdirs: string[] = [];

  #files = new Map<string, string | Uint8Array>();
  #startedAt: number | null = null;
  #endedAt: number | null = null;

  constructor(id: string) {
    this.id = id;
  }

  async start(opts: SandboxStartOptions = {}): Promise<void> {
    this.startOpts = opts;
    this.#startedAt = Date.now();
  }

  async write(path: string, data: string | Uint8Array): Promise<void> {
    this.#files.set(path, data);
  }

  async readText(path: string): Promise<string> {
    const data = this.#files.get(path);
    if (data === undefined) throw new Error(`no such file: ${path}`);
    return typeof data === "string" ? data : Buffer.from(data).toString("utf8");
  }

  async sh(script: string): Promise<{ stdout: string; exitCode: number }> {
    try {
      const { stdout } = await execFileAsync("sh", ["-c", script]);
      return { stdout, exitCode: 0 };
    } catch (err) {
      const e = err as { stdout?: string; code?: number };
      return { stdout: e.stdout ?? "", exitCode: typeof e.code === "number" ? e.code : 1 };
    }
  }

  /** Extract the zip, copy fixtures, run reconcile.py — for real, locally. */
  async reconcileLedger(opts: ReconcileOptions): Promise<ReconcileResult> {
    this.reconcileCalls.push(opts);
    const workdir = await mkdtemp(join(tmpdir(), "noapi-fake-sandbox-"));
    this.workdirs.push(workdir);

    await execFileAsync("python3", ["-m", "zipfile", "-e", opts.zipPath, join(workdir, "invoices")]);
    await Promise.all([
      copyFile(join(opts.fixturesDir, "reconcile.py"), join(workdir, "reconcile.py")),
      copyFile(join(opts.fixturesDir, "ledger.csv"), join(workdir, "ledger.csv")),
      copyFile(join(opts.fixturesDir, "policy.yaml"), join(workdir, "policy.yaml")),
    ]);

    const { stdout } = await execFileAsync("python3", [join(workdir, "reconcile.py"), workdir]);
    const match = stdout.match(/reconcile\.exceptions n=(\d+)/);
    const nStr = match?.[1];
    if (nStr === undefined) {
      throw new Error(`sandbox.reconcile missing exceptions line stdout=${stdout}`);
    }
    const exceptions = Number.parseInt(nStr, 10);
    const exceptionsCsv = await readFile(join(workdir, "exceptions.csv"), "utf8");
    const chartPng = new Uint8Array(await readFile(join(workdir, "chart.png")));
    return { exceptionsCsv, chartPng, exceptions };
  }

  /** Snapshots are a Solari feature — simulated with a stable id. */
  async snapshot(name?: string): Promise<string> {
    this.snapshotCalls.push(name);
    return "snap-fake-001";
  }

  async revert(snapshotId: string): Promise<void> {
    this.reverts.push(snapshotId);
  }

  async previewUrl(port: number): Promise<string> {
    this.previewCalls.push(port);
    return `https://fake.preview.getsolari.com/${this.id}/${port}`;
  }

  /** Simulated servePortal: records the call, returns the configured URL. */
  portalServes: number[] = [];
  portalUrl: string | null = null;
  async servePortal(port: number): Promise<string> {
    this.portalServes.push(port);
    return this.portalUrl ?? `https://fake.preview.getsolari.com/${this.id}/${port}`;
  }

  get sandboxId(): string | null {
    return this.#startedAt === null ? null : this.id;
  }

  secondsUsed(): number {
    return elapsedSeconds(this.#startedAt, this.#endedAt);
  }

  async dispose(): Promise<void> {
    this.disposeCalls += 1;
    this.#endedAt = Date.now();
    for (const dir of this.workdirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

/* ------------------------------------------------------------------------ */
/* Desktop.                                                                 */
/* ------------------------------------------------------------------------ */

export interface FakeDesktopOpts {
  /** "focus" makes the FIRST formatLibreOffice call throw FocusMissError. */
  failFirstFormat?: "focus";
}

/**
 * Fake desktop surface. The close-pack PDF is really built from the
 * exceptions CSV (`scripts/make-pack.ts`), screenshots are real PNG bytes
 * pushed through a real ScreenshotRing; the GUI/VNC session is simulated.
 */
export class FakeDesktopSurface implements DesktopSurface {
  readonly id: string;
  failFirstFormat: "focus" | null;

  startOpts: DesktopStartOpts | null = null;
  formatCalls = 0;
  screenshotCalls = 0;
  screenshots: string[] = [];
  disposeCalls = 0;

  #ring = new ScreenshotRing();
  #startedAt: number | null = null;
  #endedAt: number | null = null;
  #streamUrl: string | null = null;

  constructor(id: string, opts: FakeDesktopOpts = {}) {
    this.id = id;
    this.failFirstFormat = opts.failFirstFormat ?? null;
  }

  /** The rewind ring — the conductor flushes it into the artifact dir. */
  get ring(): ScreenshotRing {
    return this.#ring;
  }

  async start(opts: DesktopStartOpts = {}): Promise<string> {
    this.startOpts = opts;
    this.#startedAt = Date.now();
    this.#streamUrl = `vnc://fake-stream/${this.id}`;
    this.#ring.push("desktop-boot", TINY_PNG);
    return this.#streamUrl;
  }

  async openApp(name: string): Promise<number> {
    return 4321;
  }

  async exec(cmd: string, args: string[] = []): Promise<{ stdout: string; exitCode: number }> {
    return { stdout: "", exitCode: 0 };
  }

  async writeFile(path: string, data: Uint8Array | string): Promise<void> {}

  async readFile(path: string): Promise<Uint8Array> {
    return TINY_PNG;
  }

  async screenshot(label: string): Promise<Uint8Array> {
    this.screenshotCalls += 1;
    this.screenshots.push(label);
    this.#ring.push(label, TINY_PNG);
    return TINY_PNG;
  }

  /** Reads the real CSV and builds a real PDF; programmable focus miss. */
  async formatLibreOffice(opts: FormatLibreOfficeOpts): Promise<FormatLibreOfficeResult> {
    this.formatCalls += 1;
    if (this.failFirstFormat === "focus") {
      this.failFirstFormat = null;
      throw new FocusMissError("desktop.focus_miss: sentinel not confirmed");
    }
    const csv = await readFile(opts.exceptionsCsvPath, "utf8");
    const lines = csv.split("\n").filter((line) => line.length > 0);
    const pdfBytes = buildPdf(["EXCEPTIONS — JUNE 2026", "", ...lines]);
    const finalShot = await this.screenshot("desktop-final");
    return { pdfBytes, finalShot };
  }

  get sessionId(): string | null {
    return this.#startedAt === null ? null : this.id;
  }

  get streamUrl(): string | null {
    return this.#streamUrl;
  }

  secondsUsed(): number {
    return elapsedSeconds(this.#startedAt, this.#endedAt);
  }

  /** Mirrors the real surface: resolves a fake presigned mp4 URL when recording. */
  async stopRecording(): Promise<string | null> {
    if (this.startOpts?.record !== true) return null;
    return `https://rec.example/${this.id}.mp4`;
  }

  async dispose(): Promise<void> {
    this.disposeCalls += 1;
    this.#endedAt = Date.now();
  }
}

/* ------------------------------------------------------------------------ */
/* Factory.                                                                 */
/* ------------------------------------------------------------------------ */

export interface FakeFactoryOpts {
  /** Passed to the FIRST desktop instance the factory creates. */
  failFirstFormat?: "focus";
}

/** Every instance the factory produced, for lifecycle assertions. */
export interface CreatedSurfaces {
  browsers: FakeBrowserSurface[];
  sandboxes: FakeSandboxSurface[];
  desktops: FakeDesktopSurface[];
}

/**
 * A `SurfaceFactory` producing fakes, plus a `created` registry so tests can
 * assert things like "two desktops were created after a focus miss".
 */
export function makeFakeFactory(
  config: NoapiConfig,
  opts: FakeFactoryOpts = {},
): { factory: SurfaceFactory; created: CreatedSurfaces } {
  const created: CreatedSurfaces = { browsers: [], sandboxes: [], desktops: [] };
  const factory: SurfaceFactory = {
    browser() {
      const b = new FakeBrowserSurface(config, `fake-browser-${created.browsers.length + 1}`);
      created.browsers.push(b);
      return b;
    },
    sandbox() {
      const s = new FakeSandboxSurface(`fake-sandbox-${created.sandboxes.length + 1}`);
      // Portal-mode runs: the fake "preview URL" is just the real local
      // portal, so the fake browser's HTTP flow still works end to end.
      s.portalUrl = config.portalOrigin;
      created.sandboxes.push(s);
      return s;
    },
    desktop() {
      const d = new FakeDesktopSurface(`fake-desktop-${created.desktops.length + 1}`, {
        // Only the first desktop carries the scripted failure; the retry gets
        // a healthy session (fresh GUI state after the rewind).
        failFirstFormat: created.desktops.length === 0 ? opts.failFirstFormat : undefined,
      });
      created.desktops.push(d);
      return d;
    },
  };
  return { factory, created };
}

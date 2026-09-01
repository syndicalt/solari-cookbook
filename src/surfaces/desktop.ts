/**
 * Desktop surface — the Solari desktop wrapped for the conductor.
 *
 * Cookbook source of truth: `examples/desktop-computer-use-py/main.py`.
 * The TS SDK `@solarisdk/desktop` covers open / click / type / screenshot /
 * exec / streamUrl / destroy, so there is no Python sidecar (probe result:
 * `node_modules/@solarisdk/core/dist/desktop.d.ts`).
 *
 * Non-negotiables mirrored from the cookbook:
 *  - print `streamUrl` immediately after create — reviewers watch the VNC
 *  - poll `health()` until X11 is ready before driving the GUI
 *  - click INSIDE the app window (top-left quadrant, (320, 300)), never
 *    screen center (640, 360) — see `src/rewind/focus.ts` for the full quote
 *  - screenshot after every click/type; silent desktop input is a bug
 *  - `close()` drops only the local channel; `destroy(sessionId)` ends the
 *    session. Do both, or the VM leaks.
 */
import { readFile } from "node:fs/promises";
import type { NoapiConfig } from "../types.ts";
import {
  CALIBRATED_CLICK,
  SCREEN_CENTER,
  clickAndConfirm,
  typeConfirmed,
} from "../rewind/focus.ts";
import { ScreenshotRing } from "../rewind/screenshots.ts";

const BASE_URL = "https://api.getsolari.com";
const DEFAULT_RESOLUTION = "1280x720";
/** Rolling idle window — resets on each action (cookbook: 10 minutes). */
const DEFAULT_TIMEOUT_MS = 10 * 60_000;
/** Health poll: 30 × 1s, same as the cookbook's X11 wait loop. */
const HEALTH_POLLS = 30;
const HEALTH_INTERVAL_MS = 1_000;
/** Window-map settle after `open()` before clicking (cookbook sleeps 4s). */
const OPEN_SETTLE_MS = 4_000;

/**
 * Structural slice of the `@solarisdk/core` `Desktop` handle this surface
 * uses. The real handle satisfies it; tests inject fakes. Anything not
 * listed here (clipboard, pkg, …) is intentionally out of scope.
 */
export interface DesktopLike {
  readonly sessionId: string;
  readonly streamUrl: string;
  /**
   * Presigned mp4 playback URL — set at create time when `record: true`.
   * The guest uploads the mp4 on `record.stop()`, so the URL only resolves
   * once a recording has been started AND stopped (SDK docs, desktop.d.ts).
   */
  readonly recordingUrl?: string | undefined;
  health(): Promise<{ ready: boolean }>;
  exec(
    cmd: string,
    opts?: { args?: string[] },
  ): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  fs: {
    write(path: string, data: Uint8Array | string): Promise<void>;
    read(path: string): Promise<Uint8Array>;
  };
  mouse: {
    click(x: number, y: number, opts?: { humanize?: boolean }): Promise<void>;
  };
  keyboard: {
    type(text: string): Promise<void>;
    hotkey(...keys: string[]): Promise<void>;
  };
  screenshot(opts?: { format?: "png" | "jpeg" }): Promise<Uint8Array>;
  open(name: string, args?: string[]): Promise<number>;
  /** VM-side screen recording: mp4 is uploaded by the guest on stop(). */
  record: {
    start(opts?: { fps?: number; format?: string }): Promise<unknown>;
    stop(): Promise<unknown>;
  };
  /** Local channel close — sync in the real SDK, async-safe here. */
  close(): void | Promise<void>;
}

/** Structural slice of `DesktopClient` (`@solarisdk/desktop`). */
export interface DesktopClientLike {
  create(opts: {
    template: string;
    resolution: string;
    timeoutMs: number;
    record?: boolean;
  }): Promise<DesktopLike>;
  destroy(sessionId: string): Promise<unknown>;
}

export interface DesktopStartOpts {
  resolution?: string;
  timeoutMs?: number;
  record?: boolean;
}

export interface FormatLibreOfficeOpts {
  /** Local path to exceptions.csv; uploaded to the VM before opening. */
  exceptionsCsvPath: string;
  /** Remote workdir on the desktop VM. Defaults to "/work". */
  workdir?: string;
}

export interface FormatLibreOfficeResult {
  pdfBytes: Uint8Array;
  /** The "desktop-final" frame — the visible doc feeds screenshotContainsText. */
  finalShot: Uint8Array;
}

/** The desktop surface contract the conductor programs against. */
export interface DesktopSurface {
  start(opts?: DesktopStartOpts): Promise<string /* streamUrl */>;
  openApp(name: string): Promise<number>;
  exec(cmd: string, args?: string[]): Promise<{ stdout: string; exitCode: number }>;
  writeFile(path: string, data: Uint8Array | string): Promise<void>;
  readFile(path: string): Promise<Uint8Array>;
  /** Screenshot + push to the rewind ring. Label is short and grepable. */
  screenshot(label: string): Promise<Uint8Array>;
  formatLibreOffice(opts: FormatLibreOfficeOpts): Promise<FormatLibreOfficeResult>;
  /**
   * Stop the VM-side screen recording and return the presigned mp4 playback
   * URL (null when not recording). Call BEFORE dispose: the guest uploads
   * the mp4 on stop(), so a recording left running uploads nothing.
   */
  stopRecording(): Promise<string | null>;
  readonly sessionId: string | null;
  readonly streamUrl: string | null;
  secondsUsed(): number;
  dispose(): Promise<void>;
}

export interface SolariDesktopDeps {
  /** Injected client (tests). When absent, a real DesktopClient is built lazily in start(). */
  client?: DesktopClientLike;
  /** Injectable sleep for health polling and settle waits. */
  sleep?: (ms: number) => Promise<void>;
  /** Rewind ring; a fresh capacity-10 ring is created when omitted. */
  ring?: ScreenshotRing;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class SolariDesktopSurface implements DesktopSurface {
  #config: NoapiConfig;
  #client: DesktopClientLike | null;
  #sleep: (ms: number) => Promise<void>;
  #ring: ScreenshotRing;

  #desktop: DesktopLike | null = null;
  #sessionId: string | null = null;
  #streamUrl: string | null = null;
  #startedAt: number | null = null;
  #endedAt: number | null = null;
  #disposed = false;
  #firstClickUsed = false;
  #recording = false;

  constructor(config: NoapiConfig, deps: SolariDesktopDeps = {}) {
    this.#config = config;
    this.#client = deps.client ?? null;
    this.#sleep = deps.sleep ?? defaultSleep;
    this.#ring = deps.ring ?? new ScreenshotRing();
  }

  get sessionId(): string | null {
    return this.#sessionId;
  }

  get streamUrl(): string | null {
    return this.#streamUrl;
  }

  /** The rewind ring — the conductor flushes it into artifacts on failure. */
  get ring(): ScreenshotRing {
    return this.#ring;
  }

  async #makeClient(): Promise<DesktopClientLike> {
    // Lazily import so unit tests never load (or construct) the real client.
    const { DesktopClient } = await import("@solarisdk/desktop");
    // Compile-time check that the real client satisfies our structural slice.
    const client: DesktopClientLike = new DesktopClient({
      apiKey: this.#config.solariApiKey,
      baseUrl: BASE_URL,
    });
    return client;
  }

  async start(opts: DesktopStartOpts = {}): Promise<string> {
    if (this.#desktop && this.#streamUrl) return this.#streamUrl;
    this.#client ??= await this.#makeClient();

    let desktop: DesktopLike;
    try {
      desktop = await this.#client.create({
        template: "default",
        resolution: opts.resolution ?? DEFAULT_RESOLUTION,
        timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        ...(opts.record ? { record: true } : {}),
      });
    } catch (err) {
      // NoCapacityError (503): the desktop pool has no warm hosts. That is a
      // clean, diagnosable failure — name it, don't crash obscurely.
      if ((err as { name?: string }).name === "NoCapacityError") {
        throw new Error(
          "desktop.capacity pool has no warm hosts — retry later or check plan tier",
          { cause: err },
        );
      }
      throw err;
    }

    this.#desktop = desktop;
    this.#sessionId = desktop.sessionId;
    this.#streamUrl = desktop.streamUrl;
    this.#startedAt = Date.now();
    // Reviewers watch this — print before anything else can fail.
    console.log(`desktop.stream url=${desktop.streamUrl}`);

    // Wait for X11 before driving the GUI (cookbook: 30 × 1s health poll).
    for (let i = 0; i < HEALTH_POLLS; i++) {
      const health = await desktop.health();
      if (health.ready) {
        if (opts.record) {
          // VM-side mp4 capture of the LibreOffice moment — the footage the
          // reviewer pack is cut from. Upload happens on record.stop().
          await desktop.record.start();
          this.#recording = true;
          console.log(`desktop.record.start session=${desktop.sessionId}`);
        }
        return desktop.streamUrl;
      }
      await this.#sleep(HEALTH_INTERVAL_MS);
    }
    throw new Error(`desktop.health not ready after ${HEALTH_POLLS}s — X11 never came up`);
  }

  async stopRecording(): Promise<string | null> {
    if (!this.#recording || !this.#desktop) return null;
    // stop() triggers the guest-side mp4 upload; the presigned recordingUrl
    // only resolves after this. Never dispose first — that loses the footage.
    await this.#desktop.record.stop();
    this.#recording = false;
    const url = this.#desktop.recordingUrl ?? null;
    console.log(`desktop.record.stop url=${url ?? "pending"}`);
    return url;
  }

  #requireDesktop(): DesktopLike {
    if (!this.#desktop) throw new Error("desktop not started — call start() first");
    return this.#desktop;
  }

  /**
   * Probe before open: the cookbook warns `open()` fails when the binary is
   * not in the image, so check with `exec("command", args=["-v", name])`.
   * LibreOffice is probed under both of its common names.
   */
  async openApp(name: string): Promise<number> {
    const desktop = this.#requireDesktop();
    const candidates =
      name === "libreoffice" || name === "soffice" ? ["soffice", "libreoffice"] : [name];
    const probed: string[] = [];
    for (const candidate of candidates) {
      probed.push(candidate);
      const r = await desktop.exec("command", { args: ["-v", candidate] });
      if (r.exitCode === 0) {
        const pid = await desktop.open(candidate);
        console.log(`desktop.open app=${candidate} pid=${pid}`);
        return pid;
      }
    }
    throw new Error(
      `desktop.open failed — binary not in image (probed: ${probed.join(", ")})`,
    );
  }

  async exec(cmd: string, args: string[] = []): Promise<{ stdout: string; exitCode: number }> {
    const r = await this.#requireDesktop().exec(cmd, { args });
    return { stdout: r.stdout, exitCode: r.exitCode };
  }

  async writeFile(path: string, data: Uint8Array | string): Promise<void> {
    await this.#requireDesktop().fs.write(path, data);
  }

  async readFile(path: string): Promise<Uint8Array> {
    return this.#requireDesktop().fs.read(path);
  }

  async screenshot(label: string): Promise<Uint8Array> {
    const bytes = await this.#requireDesktop().screenshot({ format: "png" });
    this.#ring.push(label, bytes);
    return bytes;
  }

  /**
   * Where the first click of a step lands. The NOAPI_FORCE_FOCUS_MISS=1 hook
   * (`make demo-flaky`) sends the FIRST click to screen center (640, 360) —
   * the cookbook's known-bad point — so the focus sentinel fires and the
   * conductor's rewind path runs. Every subsequent click uses the calibrated
   * top-left-quadrant point.
   */
  #clickPoint(): { x: number; y: number } {
    if (!this.#firstClickUsed) {
      this.#firstClickUsed = true;
      if (process.env.NOAPI_FORCE_FOCUS_MISS === "1") {
        console.log("desktop.force_focus_miss first_click=center");
        return SCREEN_CENTER;
      }
    }
    return CALIBRATED_CLICK;
  }

  /**
   * The fragile step, isolated on purpose. Heavily commented because this is
   * where demos die. Cookbook rules in force:
   *  - never click (640, 360); click (320, 300) and confirm with a screenshot
   *  - GUI export-by-keystroke is flaky, so the PDF comes from the documented
   *    `soffice --headless --convert-to pdf` fallback while the GUI holds the
   *    visible document for the VNC moment and the proof screenshot.
   *    Headless-only is NOT acceptable — it loses the VNC bookmark (AGENTS.md).
   *
   * FocusMissError is rethrown untouched so the conductor can rewind the
   * step; we do not retry internally past the recapture in clickAndConfirm.
   */
  async formatLibreOffice(opts: FormatLibreOfficeOpts): Promise<FormatLibreOfficeResult> {
    const desktop = this.#requireDesktop();
    const workdir = opts.workdir ?? "/work";
    const csvRemote = `${workdir}/exceptions.csv`;
    const pdfRemote = `${workdir}/exceptions.pdf`;

    // 1. Ship the exceptions CSV to the VM. The artifact on disk stays clean;
    //    the visible title is typed into the sheet, not into the file.
    const csvBytes = await readFile(opts.exceptionsCsvPath);
    await desktop.fs.write(csvRemote, csvBytes);

    // 2. Probe the LibreOffice binary (cookbook: open() fails if it is not in
    //    the image, so check with exec("command", args=["-v", name])).
    let bin: string | null = null;
    for (const candidate of ["soffice", "libreoffice"]) {
      const r = await desktop.exec("command", { args: ["-v", candidate] });
      if (r.exitCode === 0) {
        bin = candidate;
        break;
      }
    }
    if (!bin) {
      throw new Error("desktop.libreoffice_missing — probed: soffice, libreoffice");
    }

    // 3. GUI open for the VNC moment. If the GUI open fails we still produce
    //    the PDF headless AND still open the result for the proof screenshot.
    let guiOk = true;
    try {
      const pid = await desktop.open(bin, ["--calc", csvRemote]);
      console.log(`desktop.open app=${bin} pid=${pid}`);
      await this.#sleep(OPEN_SETTLE_MS);
    } catch (err) {
      guiOk = false;
      console.log(`desktop.gui_fallback reason=${(err as Error).message}`);
    }

    if (guiOk) {
      // 4. Click inside the window (NEVER screen center), confirm with a
      //    screenshot, run the sentinel, then type the title for real. The
      //    typed "EXCEPTIONS" line is what the screenshotContainsText
      //    predicate OCRs later; the CSV artifact itself stays untouched.
      const point = this.#clickPoint();
      const shot = () => this.screenshot("focus-probe");
      await clickAndConfirm(desktop, point.x, point.y, { sleep: this.#sleep });
      await typeConfirmed(desktop, shot, "EXCEPTIONS\n", { sleep: this.#sleep });
      await this.screenshot("desktop-01-open");
    }

    // 5. The reliable PDF: headless convert. The GUI keeps the visible
    //    document on screen; this is the documented fallback for the file.
    const conv = await desktop.exec(bin, {
      args: ["--headless", "--convert-to", "pdf", "--outdir", workdir, csvRemote],
    });
    if (conv.exitCode !== 0) {
      throw new Error(
        `desktop.convert failed exit=${conv.exitCode} stderr=${conv.stderr.trim()}`,
      );
    }

    if (!guiOk) {
      // GUI open failed earlier — still put the produced PDF on screen so the
      // proof screenshot and the VNC bookmark exist (headless-only is a
      // cookbook remix and loses both). Best-effort.
      try {
        await desktop.open(bin, ["--view", pdfRemote]);
        await this.#sleep(2_000);
      } catch {
        // best-effort — the headless PDF already exists
      }
    }

    // 6. Read the PDF back and take the frame the OCR predicate consumes.
    const pdfBytes = await desktop.fs.read(pdfRemote);
    const finalShot = await this.screenshot("desktop-final");
    return { pdfBytes, finalShot };
  }

  /** Wall seconds since start() — feeds the budget ledger. */
  secondsUsed(): number {
    if (this.#startedAt === null) return 0;
    return ((this.#endedAt ?? Date.now()) - this.#startedAt) / 1000;
  }

  /**
   * Idempotent teardown. Cookbook: "close() drops only the local channel;
   * destroy() ends the session." Skipping destroy leaks the VM.
   */
  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    const desktop = this.#desktop;
    const sessionId = this.#sessionId;
    // Safety net: a recording left running uploads nothing. The conductor
    // calls stopRecording() explicitly first; this is the belt-and-braces.
    if (this.#recording) {
      try {
        await this.stopRecording();
      } catch {
        // best-effort — dispose must not throw over lost footage
      }
    }
    if (desktop) {
      try {
        await desktop.close();
      } catch {
        // best-effort local channel drop
      }
    }
    if (desktop && sessionId && this.#client) {
      await this.#client.destroy(sessionId);
    }
    this.#endedAt = Date.now();
    console.log(`desktop.disposed session=${sessionId ?? "none"}`);
  }
}

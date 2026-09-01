/**
 * Browser surface — the Solari cloud browser, driven through Playwright-shaped
 * calls against our fake vendor portal.
 *
 * Cookbook contract (examples/browser-quickstart-ts, browser-profiles-ts,
 * browser-stealth-proxy-ts, browser-session-recording-py):
 *  - `launch()` creates a session and returns a Playwright-compatible browser.
 *  - `recording: true` is OPT-IN PER SESSION — without it the replay endpoint
 *    404s forever. Scored sessions always launch with it.
 *  - Teardown is TWO calls: `browser.close()` releases the session slot, and
 *    `solari.close()` kills a loopback proxy that otherwise hangs the process.
 *  - Attaching a profile does NOT auto-save; `profiles.save` is explicit.
 *  - Free plan has no stealth/proxy/captcha — degrade by relaunching plain.
 *
 * Everything takes an injected `SolariLike` in tests so nothing here needs a
 * network or a real API key.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Solari, StorageState } from "@solarisdk/browser";
import { ROUTES, SELECTORS } from "../../apps/portal/selectors.ts";
import { portalUrl } from "../portal-url.ts";
import type { NoapiConfig } from "../types.ts";

/* ------------------------------------------------------------------------ */
/* Structural SDK types — the smallest slice of @solarisdk/browser we use.  */
/* ------------------------------------------------------------------------ */

export interface StorageStateLike {
  [k: string]: unknown;
}

export interface ContextLike {
  storageState(): Promise<StorageStateLike>;
}

export interface DownloadLike {
  suggestedFilename(): string;
  saveAs(path: string): Promise<void>;
}

/** Minimal Playwright page shape; the SDK's real Page satisfies this. */
export interface PageLike {
  goto(url: string): Promise<unknown>;
  fill(selector: string, value: string): Promise<void>;
  click(selector: string): Promise<void>;
  waitForSelector(selector: string, opts?: { state?: string }): Promise<unknown>;
  waitForEvent(event: "download"): Promise<DownloadLike>;
  setInputFiles(selector: string, files: string): Promise<void>;
  context(): ContextLike;
  /** Cheapest possible page touch — used by the idle-timeout heartbeat. */
  evaluate(script: string): Promise<unknown>;
}

export interface BrowserLike {
  readonly id: string;
  newPage(): Promise<PageLike>;
  close(): Promise<void>;
}

export interface ProfileLike {
  id: string;
  name: string;
}

/** Launch options we pass through — a subset of the SDK's LaunchOptions. */
export interface BrowserLaunchOptions {
  recording?: boolean;
  stealth?: boolean;
  profileId?: string;
}

/** Minimal structural view of the SDK's `Solari` client. */
export interface SolariLike {
  launch(options?: BrowserLaunchOptions): Promise<BrowserLike>;
  profiles: {
    list(): Promise<ProfileLike[]>;
    create(opts: { name: string }): Promise<ProfileLike>;
    save(id: string, state: unknown): Promise<unknown>;
  };
  sessions: {
    downloadReplay(id: string): Promise<Uint8Array>;
  };
  close(): Promise<void>;
}

/* ------------------------------------------------------------------------ */
/* Public surface interface.                                                */
/* ------------------------------------------------------------------------ */

export interface BrowserStartOptions {
  /** Session recording — scored runs must pass true (replay 404s without it). */
  recording: true;
  /** Request stealth; free plan degrades to a plain launch on failure. */
  stealth?: boolean;
  /** Profile name to find-or-create and attach. */
  profile?: string;
  /**
   * Heartbeat interval that keeps the session's idle timeout alive while
   * other surfaces work (a 9-minute desktop step killed the browser mid-run
   * in a live flaky test — the upload then failed with "browser has been
   * closed"). Default 60s; 0 disables.
   */
  heartbeatMs?: number;
}

export interface BrowserSurface {
  start(opts: BrowserStartOptions): Promise<void>;
  page(): PageLike;
  loginPortal(): Promise<void>;
  /** Download the invoice zip into `destDir`; returns the absolute zip path. */
  downloadInvoices(destDir: string): Promise<string>;
  uploadPack(pdfPath: string): Promise<void>;
  saveProfile(): Promise<void>;
  /** Poll the async replay upload; returns the written path or null on 404s. */
  fetchReplay(destPath: string): Promise<string | null>;
  readonly sessionId: string | null;
  /** Wall seconds between successful start() and dispose(). */
  secondsUsed(): number;
  dispose(): Promise<void>;
}

export interface BrowserDeps {
  /** Injected client for tests; production constructs the real SDK client. */
  solari?: SolariLike;
  /** Delay between replay polls (cookbook: ~30s = 10 x 3s). 0 in tests. */
  replayPollDelayMs?: number;
  /** Log sink; defaults to console.log. Lowercase, short, grepable lines. */
  logger?: (line: string) => void;
}

const REPLAY_ATTEMPTS = 10;
const REPLAY_POLL_DELAY_MS = 3_000;
const DEFAULT_HEARTBEAT_MS = 60_000;

/* ------------------------------------------------------------------------ */
/* Implementation.                                                          */
/* ------------------------------------------------------------------------ */

export class SolariBrowserSurface implements BrowserSurface {
  readonly #config: NoapiConfig;
  readonly #deps: BrowserDeps;
  #solari: SolariLike | null = null;
  #browser: BrowserLike | null = null;
  #page: PageLike | null = null;
  #profileId: string | null = null;
  #heartbeat: ReturnType<typeof setInterval> | null = null;
  #startedAt: number | null = null;
  #endedAt: number | null = null;
  #disposed = false;

  constructor(config: NoapiConfig, deps: BrowserDeps = {}) {
    this.#config = config;
    this.#deps = deps;
  }

  async start(opts: BrowserStartOptions): Promise<void> {
    const solari = await this.#client();

    let profileId: string | undefined;
    if (opts.profile) {
      // Cookbook (browser-profiles-ts): reuse the profile across runs;
      // create it the first time only.
      const existing = (await solari.profiles.list()).find((p) => p.name === opts.profile);
      const profile = existing ?? (await solari.profiles.create({ name: opts.profile }));
      profileId = profile.id;
      this.#profileId = profile.id;
      this.#log(`browser.profile ${existing ? "reuse" : "create"} id=${profile.id}`);
    }

    const wantStealth = opts.stealth ?? this.#config.plan === "starter";
    const launchOpts: BrowserLaunchOptions = { recording: true };
    if (wantStealth) launchOpts.stealth = true;
    if (profileId) launchOpts.profileId = profileId;

    let stealthUsed = wantStealth;
    try {
      this.#browser = await solari.launch(launchOpts);
    } catch (err) {
      if (!wantStealth) throw err;
      // Free-plan degrade: stealth/proxy/captcha are paid features. Relaunch
      // plain and continue; do not flip config.plan (config is immutable).
      this.#log(`browser.degrade reason=stealth plan=${this.#config.plan}`);
      const plain: BrowserLaunchOptions = { recording: true };
      if (profileId) plain.profileId = profileId;
      this.#browser = await solari.launch(plain);
      stealthUsed = false;
    }

    this.#page = await this.#browser.newPage();
    this.#startedAt = Date.now();
    this.#log(`browser.start session=${this.#browser.id} recording=true stealth=${stealthUsed}`);

    const heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    if (heartbeatMs > 0) {
      // The browser sits idle while the sandbox/desktop steps run — a long
      // desktop step outlives the session's idle timeout (observed live:
      // "browser has been closed" at the upload step). The cheapest page
      // touch resets it. Failures are logged, never thrown.
      this.#heartbeat = setInterval(() => void this.#beat(), heartbeatMs);
      this.#heartbeat.unref();
    }
  }

  async #beat(): Promise<void> {
    try {
      await this.#page?.evaluate("1");
    } catch {
      this.#log("browser.heartbeat fail");
    }
  }

  page(): PageLike {
    if (!this.#page) throw new Error("browser.page called before start()");
    return this.#page;
  }

  async loginPortal(): Promise<void> {
    const page = this.page();
    await page.goto(portalUrl(this.#config.portalOrigin, ROUTES.login));
    await page.fill(SELECTORS.loginEmail, this.#config.portalUser);
    await page.fill(SELECTORS.loginPassword, this.#config.portalPassword);
    await page.click(SELECTORS.loginSubmit);
    await page.waitForSelector(SELECTORS.portalBanner, { state: "visible" });
    this.#log("browser.login ok");
  }

  async downloadInvoices(destDir: string): Promise<string> {
    const page = this.page();
    await mkdir(destDir, { recursive: true });
    await page.goto(portalUrl(this.#config.portalOrigin, ROUTES.invoices));
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.click(SELECTORS.invoicesDownload),
    ]);
    const path = resolve(destDir, download.suggestedFilename());
    await download.saveAs(path);
    this.#log(`browser.invoices ok path=${path}`);
    return path;
  }

  async uploadPack(pdfPath: string): Promise<void> {
    const page = this.page();
    await page.goto(portalUrl(this.#config.portalOrigin, ROUTES.closeSubmit));
    await page.setInputFiles(SELECTORS.uploadFile, pdfPath);
    await page.click(SELECTORS.uploadSubmit);
    await page.waitForSelector(SELECTORS.uploadStatus, { state: "visible" });
    this.#log(`browser.upload ok path=${pdfPath}`);
  }

  async saveProfile(): Promise<void> {
    if (!this.#profileId) {
      this.#log("browser.profile skip reason=none-attached");
      return;
    }
    // Cookbook: without an explicit save the session's state is discarded on
    // release — attaching a profile does not auto-save it.
    const state = await this.page().context().storageState();
    await (await this.#client()).profiles.save(this.#profileId, state);
    this.#log(`browser.profile saved id=${this.#profileId}`);
  }

  async fetchReplay(destPath: string): Promise<string | null> {
    const id = this.sessionId;
    if (!id) {
      this.#log("browser.replay skip reason=no-session");
      return null;
    }
    const solari = await this.#client();
    const delay = this.#deps.replayPollDelayMs ?? REPLAY_POLL_DELAY_MS;
    // Cookbook (browser-session-recording-py): the replay upload happens
    // async AFTER release, so the first polls 404 — poll up to ~30s (10 x 3s)
    // before giving up.
    for (let attempt = 1; attempt <= REPLAY_ATTEMPTS; attempt++) {
      try {
        const bytes = await solari.sessions.downloadReplay(id);
        await writeFile(destPath, bytes);
        this.#log(`browser.replay ok path=${destPath} attempts=${attempt}`);
        return destPath;
      } catch (err) {
        if (!isNotFound(err)) throw err;
        if (attempt < REPLAY_ATTEMPTS && delay > 0) await sleep(delay);
      }
    }
    this.#log(`browser.replay 404 attempts=${REPLAY_ATTEMPTS}`);
    return null;
  }

  get sessionId(): string | null {
    return this.#browser?.id ?? null;
  }

  secondsUsed(): number {
    if (this.#startedAt === null) return 0;
    const end = this.#endedAt ?? Date.now();
    return (end - this.#startedAt) / 1000;
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    if (this.#heartbeat) {
      clearInterval(this.#heartbeat);
      this.#heartbeat = null;
    }
    const id = this.sessionId;
    try {
      // `browser.close()` also RELEASES the session. Closing the browser alone
      // would leave the slot held until the plan deadline.
      if (this.#browser) await this.#browser.close();
    } finally {
      // REQUIRED in Node, and easy to miss: the client keeps a loopback proxy
      // server open for the connection-retry path, and that handle keeps the
      // event loop alive. Skip this and your script prints its output and then
      // hangs forever instead of exiting.
      if (this.#solari) await this.#solari.close();
    }
    this.#endedAt = Date.now();
    this.#log(`browser.disposed session=${id ?? "none"}`);
  }

  /** Supports `await using surface = new SolariBrowserSurface(...)` (Node 22+). */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.dispose();
  }

  /* -- internals --------------------------------------------------------- */

  async #client(): Promise<SolariLike> {
    if (this.#solari) return this.#solari;
    if (this.#deps.solari) {
      this.#solari = this.#deps.solari;
    } else {
      // Production path only; tests always inject a fake and never load the
      // SDK (it pulls in a Playwright-compatible driver we don't need offline).
      const { Solari } = await import("@solarisdk/browser");
      this.#solari = adaptSolari(new Solari({ apiKey: this.#config.solariApiKey }));
    }
    return this.#solari;
  }

  #log(line: string): void {
    (this.#deps.logger ?? console.log)(line);
  }
}

/**
 * Adapt the real SDK client to {@link SolariLike}. The only friction is the
 * Playwright `Page`/`StorageState` types, which are structurally richer than
 * our minimal views — the casts live here, at the SDK edge, so the rest of
 * the surface stays strictly typed.
 */
function adaptSolari(solari: Solari): SolariLike {
  return {
    launch: async (options) => (await solari.launch(options)) as unknown as BrowserLike,
    profiles: {
      list: () => solari.profiles.list(),
      create: (opts) => solari.profiles.create(opts),
      save: (id, state) => solari.profiles.save(id, state as StorageState),
    },
    sessions: {
      downloadReplay: (id) => solari.sessions.downloadReplay(id),
    },
    close: () => solari.close(),
  };
}

/** Run `fn` against a started browser surface, disposing in `finally`. */
export async function withBrowser<T>(
  config: NoapiConfig,
  opts: BrowserStartOptions,
  fn: (surface: BrowserSurface) => Promise<T>,
  deps: BrowserDeps = {},
): Promise<T> {
  const surface = new SolariBrowserSurface(config, deps);
  await surface.start(opts);
  try {
    return await fn(surface);
  } finally {
    await surface.dispose();
  }
}

function isNotFound(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const status = (err as { status?: unknown }).status;
  return status === 404 || err.message.includes("404");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

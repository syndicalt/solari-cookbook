/**
 * Browser surface tests — node:test, no network, no real SDK.
 *
 * Fakes record every call so we can assert the cookbook rules structurally:
 * recording:true on launch, stealth degrade, explicit profile save, download
 * event wiring, replay polling, and the two-call dispose (browser.close THEN
 * solari.close, exactly once).
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ROUTES, SELECTORS } from "../apps/portal/selectors.ts";
import {
  SolariBrowserSurface,
  type BrowserLaunchOptions,
  type DownloadLike,
  type PageLike,
  type SolariLike,
  type StorageStateLike,
} from "../src/surfaces/browser.ts";
import type { NoapiConfig } from "../src/types.ts";

/* ------------------------------------------------------------------------ */
/* Fakes.                                                                    */
/* ------------------------------------------------------------------------ */

function config(overrides: Partial<NoapiConfig> = {}): NoapiConfig {
  return {
    solariApiKey: "slr_test_fake",
    portalOrigin: "http://127.0.0.1:8787",
    portalUser: "reviewer@getsolari.com",
    portalPassword: "reviewer",
    plan: "free",
    portalMode: "local",
    ...overrides,
  };
}

class FakeDownload implements DownloadLike {
  readonly name: string;
  savedTo: string | null = null;
  constructor(name: string) {
    this.name = name;
  }
  suggestedFilename(): string {
    return this.name;
  }
  async saveAs(path: string): Promise<void> {
    this.savedTo = path;
  }
}

type PageCall =
  | { m: "goto"; url: string }
  | { m: "fill"; selector: string; value: string }
  | { m: "click"; selector: string }
  | { m: "waitForSelector"; selector: string; state?: string }
  | { m: "waitForEvent"; event: string }
  | { m: "setInputFiles"; selector: string; files: string };

class FakePage implements PageLike {
  readonly calls: PageCall[] = [];
  readonly download = new FakeDownload("2026-06.zip");
  storageStateValue: StorageStateLike = { cookies: [{ name: "sid", value: "abc" }] };
  #downloadWaiter: ((d: DownloadLike) => void) | null = null;

  async goto(url: string): Promise<unknown> {
    this.calls.push({ m: "goto", url });
    return null;
  }
  async fill(selector: string, value: string): Promise<void> {
    this.calls.push({ m: "fill", selector, value });
  }
  async click(selector: string): Promise<void> {
    this.calls.push({ m: "click", selector });
    // The portal triggers the download on click; resolve any pending waiter.
    if (this.#downloadWaiter) {
      const waiter = this.#downloadWaiter;
      this.#downloadWaiter = null;
      waiter(this.download);
    }
  }
  async waitForSelector(selector: string, opts?: { state?: string }): Promise<unknown> {
    this.calls.push({ m: "waitForSelector", selector, state: opts?.state });
    return null;
  }
  waitForEvent(event: "download"): Promise<DownloadLike> {
    this.calls.push({ m: "waitForEvent", event });
    return new Promise((res) => {
      this.#downloadWaiter = res;
    });
  }
  async setInputFiles(selector: string, files: string): Promise<void> {
    this.calls.push({ m: "setInputFiles", selector, files });
  }
  evaluateCalls = 0;
  async evaluate(_script: string): Promise<unknown> {
    this.evaluateCalls += 1;
    return 1;
  }
  context(): { storageState(): Promise<StorageStateLike> } {
    return { storageState: async () => this.storageStateValue };
  }
}

class FakeBrowser {
  readonly id: string;
  readonly page = new FakePage();
  closeCalls = 0;
  constructor(id: string) {
    this.id = id;
  }
  async newPage(): Promise<PageLike> {
    return this.page;
  }
  async close(): Promise<void> {
    this.closeCalls += 1;
  }
}

class FakeSolari implements SolariLike {
  launchCalls: BrowserLaunchOptions[] = [];
  /** When true, a launch with stealth throws (simulates free-plan 402). */
  failOnStealth = false;
  /** Profile data store; the `profiles` getter below is the SDK resource. */
  profileStore: { id: string; name: string }[] = [];
  profileCreateCalls: { name: string }[] = [];
  profileSaveCalls: { id: string; state: unknown }[] = [];
  replayBehavior: Array<"404" | Uint8Array> = [];
  replayCalls = 0;
  closeCalls = 0;
  /** Ordered teardown trace shared with FakeBrowser via onClose hook. */
  readonly order: string[] = [];
  #nextId = 1;
  #browsers: FakeBrowser[] = [];

  async launch(options?: BrowserLaunchOptions): Promise<FakeBrowser> {
    this.launchCalls.push(options ?? {});
    if (this.failOnStealth && options?.stealth) {
      const err = new Error("stealth requires a paid plan (HTTP 402)");
      (err as { status?: number }).status = 402;
      throw err;
    }
    const browser = new FakeBrowser(`sess-${this.#nextId++}`);
    browser.close = async () => {
      browser.closeCalls += 1;
      this.order.push("browser.close");
    };
    this.#browsers.push(browser);
    return browser;
  }

  get lastBrowser(): FakeBrowser {
    const b = this.#browsers[this.#browsers.length - 1];
    if (!b) throw new Error("no browser launched");
    return b;
  }

  readonly profilesResource = {
    list: async (): Promise<{ id: string; name: string }[]> => this.profileStore,
    create: async (opts: { name: string }): Promise<{ id: string; name: string }> => {
      this.profileCreateCalls.push(opts);
      const p = { id: `prof-${this.profileStore.length + 1}`, name: opts.name };
      this.profileStore.push(p);
      return p;
    },
    save: async (id: string, state: unknown): Promise<unknown> => {
      this.profileSaveCalls.push({ id, state });
      return { version: 1, sizeBytes: 42 };
    },
  };
  get profiles() {
    return this.profilesResource;
  }

  readonly sessionsResource = {
    downloadReplay: async (_id: string): Promise<Uint8Array> => {
      this.replayCalls += 1;
      const next = this.replayBehavior.shift() ?? "404";
      if (next === "404") {
        const err = new Error("replay not found (HTTP 404)");
        (err as { status?: number }).status = 404;
        throw err;
      }
      return next;
    },
  };
  get sessions() {
    return this.sessionsResource;
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
    this.order.push("solari.close");
  }
}

function harness(cfg = config()) {
  const solari = new FakeSolari();
  const logs: string[] = [];
  const surface = new SolariBrowserSurface(cfg, {
    solari,
    replayPollDelayMs: 0,
    logger: (line) => logs.push(line),
  });
  return { solari, logs, surface };
}

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), "noapi-browser-test-"));
}

/* ------------------------------------------------------------------------ */
/* Tests.                                                                    */
/* ------------------------------------------------------------------------ */

test("start launches with recording:true", async () => {
  const { solari, surface } = harness();
  await surface.start({ recording: true });
  assert.equal(solari.launchCalls.length, 1);
  assert.equal(solari.launchCalls[0]?.recording, true);
  assert.equal(solari.launchCalls[0]?.stealth, undefined);
  assert.equal(surface.sessionId, "sess-1");
  assert.ok(surface.secondsUsed() >= 0);
  await surface.dispose();
});

test("heartbeat touches the page on an interval and stops at dispose", async () => {
  const { solari, surface } = harness();
  await surface.start({ recording: true, heartbeatMs: 5 });
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(solari.lastBrowser.page.evaluateCalls >= 2, "idle-timeout heartbeat must fire");
  await surface.dispose();
  const stopped = solari.lastBrowser.page.evaluateCalls;
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(solari.lastBrowser.page.evaluateCalls, stopped, "heartbeat must stop after dispose");
});

test("starter plan requests stealth; failure degrades to a plain relaunch", async () => {
  const { solari, logs, surface } = harness(config({ plan: "starter" }));
  solari.failOnStealth = true;
  await surface.start({ recording: true });
  assert.equal(solari.launchCalls.length, 2);
  assert.equal(solari.launchCalls[0]?.stealth, true);
  assert.equal(solari.launchCalls[0]?.recording, true);
  assert.equal(solari.launchCalls[1]?.stealth, undefined);
  assert.equal(solari.launchCalls[1]?.recording, true);
  assert.ok(logs.some((l) => l === "browser.degrade reason=stealth plan=starter"));
  assert.equal(surface.sessionId, "sess-1");
  await surface.dispose();
});

test("profile find-or-create: reuses existing, creates when missing, saves explicitly", async () => {
  // Existing profile is reused — no create call.
  {
    const { solari, surface } = harness();
    solari.profileStore.push({ id: "prof-9", name: "vendor-close" });
    await surface.start({ recording: true, profile: "vendor-close" });
    assert.equal(solari.profileCreateCalls.length, 0);
    assert.equal(solari.launchCalls[0]?.profileId, "prof-9");
    await surface.saveProfile();
    assert.equal(solari.profileSaveCalls.length, 1);
    assert.equal(solari.profileSaveCalls[0]?.id, "prof-9");
    await surface.dispose();
  }
  // Missing profile is created, then attached.
  {
    const { solari, surface } = harness();
    await surface.start({ recording: true, profile: "vendor-close" });
    assert.deepEqual(solari.profileCreateCalls, [{ name: "vendor-close" }]);
    assert.equal(solari.launchCalls[0]?.profileId, "prof-1");
    await surface.dispose();
  }
});

test("saveProfile without an attached profile is a logged no-op", async () => {
  const { solari, logs, surface } = harness();
  await surface.start({ recording: true });
  await surface.saveProfile();
  assert.equal(solari.profileSaveCalls.length, 0);
  assert.ok(logs.some((l) => l === "browser.profile skip reason=none-attached"));
  await surface.dispose();
});

test("loginPortal drives the shared selectors and waits for the banner", async () => {
  const { solari, surface } = harness();
  await surface.start({ recording: true });
  await surface.loginPortal();
  const calls = solari.lastBrowser.page.calls;
  assert.deepEqual(calls[0], { m: "goto", url: "http://127.0.0.1:8787" + ROUTES.login });
  assert.deepEqual(calls[1], { m: "fill", selector: SELECTORS.loginEmail, value: "reviewer@getsolari.com" });
  assert.deepEqual(calls[2], { m: "fill", selector: SELECTORS.loginPassword, value: "reviewer" });
  assert.deepEqual(calls[3], { m: "click", selector: SELECTORS.loginSubmit });
  assert.deepEqual(calls[4], { m: "waitForSelector", selector: SELECTORS.portalBanner, state: "visible" });
  await surface.dispose();
});

test("downloadInvoices wires waitForEvent('download') around the click", async () => {
  const dir = await tmp();
  try {
    const { solari, surface } = harness();
    await surface.start({ recording: true });
    const path = await surface.downloadInvoices(dir);
    const page = solari.lastBrowser.page;
    const waitIdx = page.calls.findIndex((c) => c.m === "waitForEvent" && c.event === "download");
    const clickIdx = page.calls.findIndex((c) => c.m === "click" && c.selector === SELECTORS.invoicesDownload);
    assert.ok(waitIdx !== -1 && clickIdx !== -1);
    // waitForEvent must be registered before the click triggers the download.
    assert.ok(waitIdx < clickIdx);
    assert.equal(page.download.savedTo, path);
    assert.ok(path.endsWith("2026-06.zip"));
    await surface.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("uploadPack sets the file input, submits, and waits for the status", async () => {
  const { solari, surface } = harness();
  await surface.start({ recording: true });
  await surface.uploadPack("/tmp/close-pack.pdf");
  const calls = solari.lastBrowser.page.calls;
  assert.deepEqual(calls[0], { m: "goto", url: "http://127.0.0.1:8787" + ROUTES.closeSubmit });
  assert.deepEqual(calls[1], { m: "setInputFiles", selector: SELECTORS.uploadFile, files: "/tmp/close-pack.pdf" });
  assert.deepEqual(calls[2], { m: "click", selector: SELECTORS.uploadSubmit });
  assert.deepEqual(calls[3], { m: "waitForSelector", selector: SELECTORS.uploadStatus, state: "visible" });
  await surface.dispose();
});

test("fetchReplay tolerates 404s and succeeds on the 3rd attempt", async () => {
  const dir = await tmp();
  try {
    const { solari, logs, surface } = harness();
    await surface.start({ recording: true });
    solari.replayBehavior = ["404", "404", new Uint8Array([123, 10])];
    const dest = join(dir, "replay.ndjson");
    const out = await surface.fetchReplay(dest);
    assert.equal(out, dest);
    assert.equal(solari.replayCalls, 3);
    assert.deepEqual([...(await readFile(dest))], [123, 10]);
    assert.ok(logs.some((l) => l.startsWith("browser.replay ok")));
    await surface.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("fetchReplay gives up after 10 x 404 and returns null", async () => {
  const dir = await tmp();
  try {
    const { solari, logs, surface } = harness();
    await surface.start({ recording: true });
    solari.replayBehavior = Array.from({ length: 12 }, () => "404" as const);
    const out = await surface.fetchReplay(join(dir, "replay.ndjson"));
    assert.equal(out, null);
    assert.equal(solari.replayCalls, 10);
    assert.ok(logs.some((l) => l === "browser.replay 404 attempts=10"));
    await surface.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("dispose closes browser THEN solari, exactly once, and is idempotent", async () => {
  const { solari, logs, surface } = harness();
  await surface.start({ recording: true });
  await surface.dispose();
  await surface.dispose();
  assert.equal(solari.lastBrowser.closeCalls, 1);
  assert.equal(solari.closeCalls, 1);
  assert.deepEqual(solari.order, ["browser.close", "solari.close"]);
  assert.ok(logs.some((l) => l === "browser.disposed session=sess-1"));
});

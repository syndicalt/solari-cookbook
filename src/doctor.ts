/**
 * `noapi doctor` — the cheapest possible live check.
 *
 * With a key: launch a plain browser session (no stealth/proxy — those are
 * Starter+ features and doctor must pass on Free), print the session id,
 * then dispose cleanly. This exercises the two cookbook rules that sink
 * demos: `browser.close()` releases the session, and `solari.close()` drops
 * the loopback proxy handle that would otherwise keep the event loop alive
 * forever (see examples/browser-quickstart-ts).
 *
 * Without a key: exit 2 with a clear message. Never fake a passing run.
 */
import type { NoapiConfig } from "./types.ts";
import { hasSolariKey, resolveConfig } from "./config.ts";

/** Hard watchdog: if dispose hangs, doctor still exits (loudly) instead of pinning CI. */
const DOCTOR_TIMEOUT_MS = 60_000;

export async function doctor(config: NoapiConfig): Promise<number> {
  if (!hasSolariKey(config)) {
    console.error("doctor: SOLARI_API_KEY is not set.");
    console.error("doctor: export SOLARI_API_KEY=slr_live_... (https://console.getsolari.com), then re-run `make doctor`.");
    console.error("doctor: no key? `make demo-offline` exercises the portal + fixtures without Solari.");
    return 2;
  }

  // Imported lazily so offline paths never load the SDK (or pay its import cost).
  const { Solari } = await import("@solarisdk/browser");
  const solari = new Solari({ apiKey: config.solariApiKey });

  const watchdog = setTimeout(() => {
    console.error(`doctor: timed out after ${DOCTOR_TIMEOUT_MS}ms — a dispose call hung.`);
    process.exit(3);
  }, DOCTOR_TIMEOUT_MS);

  try {
    const browser = await solari.launch();
    console.log(`doctor: session id ${browser.id}`);
    try {
      const page = await browser.newPage();
      await page.goto(`${config.portalOrigin}/login`);
      console.log(`doctor: portal reachable (${await page.title()})`);
    } finally {
      await browser.close(); // releases the session slot
    }
    await solari.close(); // drops the loopback proxy — skip this and the process hangs
    console.log("doctor: ok — launched, reached portal, disposed cleanly");
    return 0;
  } catch (err) {
    console.error(`doctor: failed: ${(err as Error).message}`);
    try {
      await solari.close();
    } catch {
      /* best effort on the way out */
    }
    return 1;
  } finally {
    clearTimeout(watchdog);
  }
}

/** CLI entry: load env, resolve config, run doctor, return its exit code. */
export async function doctorMain(): Promise<number> {
  const { loadDotEnv } = await import("./config.ts");
  loadDotEnv();
  return doctor(resolveConfig());
}

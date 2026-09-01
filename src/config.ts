/**
 * Runtime configuration.
 *
 * Secrets come from the environment (optionally via a local `.env` file that
 * is never committed). The key is never printed; `describe()` redacts it.
 */
import { readFileSync, existsSync } from "node:fs";
import type { NoapiConfig } from "./types.ts";

/**
 * Minimal `.env` loader — KEY=VALUE lines, `#` comments, no interpolation.
 * Real environment variables always win over file values. We deliberately do
 * not add a dotenv dependency for eight lines of code.
 */
export function loadDotEnv(path = ".env"): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

/** Resolve the active configuration from `process.env`. */
export function resolveConfig(env: NodeJS.ProcessEnv = process.env): NoapiConfig {
  const key = env.SOLARI_API_KEY ?? "";
  return {
    solariApiKey: key,
    portalOrigin: env.NOAPI_PORTAL_ORIGIN ?? "http://127.0.0.1:8787",
    portalUser: env.NOAPI_PORTAL_USER ?? "reviewer@getsolari.com",
    portalPassword: env.NOAPI_PORTAL_PASSWORD ?? "reviewer",
    // Free-plan degrade is the safe default until a paid feature succeeds;
    // surfaces flip this to "starter" on the first stealth-capable launch.
    plan: env.NOAPI_PLAN === "starter" ? "starter" : "free",
  };
}

/** True when a usable-looking Solari key is configured. */
export function hasSolariKey(config: NoapiConfig): boolean {
  return config.solariApiKey.length > 0;
}

/** One-line, secret-free description safe to print at run start. */
export function describe(config: NoapiConfig): string {
  return `portal=${config.portalOrigin} user=${config.portalUser} plan=${config.plan} key=${hasSolariKey(config) ? "set" : "unset"}`;
}

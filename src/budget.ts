/**
 * Budget — cost accounting against the public Solari price sheet.
 *
 * Rates are constants copied from https://docs.getsolari.com/pricing
 * (retrieved 2026-09). One credit balance pays for browsers, sandboxes,
 * desktops, proxies, and captcha solves. VMs (desktops) add $0.02/hour for
 * the live screen on top of the sandbox compute rate.
 *
 * The conductor uses {@link Budget} to refuse the next surface when the
 * projected run total would exceed `scenario.budgetUsd`.
 */
import { BudgetExceededError, type SurfaceName } from "./types.ts";

/** Per-plan pricing, straight from the price sheet. */
export interface PlanRates {
  /** Dollars per browser-hour while a session is open. */
  browserPerHour: number;
  /** Dollars per vCPU-hour of sandbox compute. */
  vcpuPerHour: number;
  /** Dollars per GB-hour of sandbox memory. */
  gbPerHour: number;
  /** Live-screen surcharge for desktops, per hour. */
  desktopScreenPerHour: number;
}

/** Published rates. Free has no stealth/proxy/captcha; Starter is the demo target. */
export const RATES: Record<"free" | "starter", PlanRates> = {
  free: {
    browserPerHour: 0.15,
    vcpuPerHour: 0.0525,
    gbPerHour: 0.0165,
    desktopScreenPerHour: 0.02,
  },
  starter: {
    browserPerHour: 0.1,
    vcpuPerHour: 0.035,
    gbPerHour: 0.011,
    desktopScreenPerHour: 0.02,
  },
};

/**
 * Assumed machine shape of the `base` sandbox / `default` desktop template:
 * 1 vCPU / 2 GB — the smallest size on the price sheet. Works out to
 * $0.086/hr on Free and $0.057/hr on Starter before the screen surcharge.
 */
export const MACHINE = { vcpu: 1, gb: 2 } as const;

/** Hourly cost of one surface on a plan, in dollars. */
export function hourlyRate(surface: SurfaceName, plan: keyof typeof RATES): number {
  const r = RATES[plan];
  if (surface === "browser") return r.browserPerHour;
  const compute = MACHINE.vcpu * r.vcpuPerHour + MACHINE.gb * r.gbPerHour;
  return surface === "desktop" ? compute + r.desktopScreenPerHour : compute;
}

/** Cost of running `surface` for `seconds` on `plan`, in dollars. */
export function surfaceCost(surface: SurfaceName, seconds: number, plan: keyof typeof RATES): number {
  return (hourlyRate(surface, plan) * seconds) / 3600;
}

/**
 * Running cost ledger with a hard ceiling. Tracks per-surface seconds and
 * accumulated dollars; {@link charge} is called when a surface is disposed,
 * {@link assertCanAfford} before a new one is acquired.
 */
export class Budget {
  readonly limitUsd: number;
  readonly plan: keyof typeof RATES;
  #spentUsd = 0;
  #seconds: Record<SurfaceName, number> = { browser: 0, sandbox: 0, desktop: 0 };

  constructor(limitUsd: number, plan: keyof typeof RATES = "free") {
    this.limitUsd = limitUsd;
    this.plan = plan;
  }

  /** Record `seconds` of usage on `surface` and add its cost to the ledger. */
  charge(surface: SurfaceName, seconds: number): number {
    this.#seconds[surface] += seconds;
    const usd = surfaceCost(surface, seconds, this.plan);
    this.#spentUsd += usd;
    return usd;
  }

  /**
   * Throw {@link BudgetExceededError} if starting `surface` for an estimated
   * `seconds` would push the projected total past the limit. Never restore a
   * snapshot on this error — the run stops spending.
   */
  assertCanAfford(surface: SurfaceName, estimatedSeconds: number): void {
    const projected = this.#spentUsd + surfaceCost(surface, estimatedSeconds, this.plan);
    if (projected > this.limitUsd) {
      throw new BudgetExceededError(
        `budget_exceeded: projected $${projected.toFixed(4)} > limit $${this.limitUsd.toFixed(2)} (next surface: ${surface})`,
      );
    }
  }

  /** Dollars spent so far (estimate, using public rates). */
  get spentUsd(): number {
    return this.#spentUsd;
  }

  /** Per-surface seconds, for the `surfaces` block of `eval.json`. */
  get surfaceSeconds(): Record<SurfaceName, number> {
    return { ...this.#seconds };
  }
}

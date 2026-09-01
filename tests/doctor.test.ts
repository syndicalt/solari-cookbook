/**
 * Doctor tests — the offline path is reachable in-process (no key → exit 2).
 * The with-key path constructs the real @solarisdk/browser client and hits
 * api.getsolari.com; it is deliberately untested here (no key, no network).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { doctor } from "../src/doctor.ts";
import type { NoapiConfig } from "../src/types.ts";

const CONFIG: NoapiConfig = {
  solariApiKey: "",
  portalOrigin: "http://127.0.0.1:8787",
  portalUser: "reviewer@getsolari.com",
  portalPassword: "reviewer",
  plan: "free",
    portalMode: "local",
};

test("doctor without a key returns 2 and never fakes a passing run", async () => {
  const errors: string[] = [];
  const origError = console.error;
  console.error = (...args: unknown[]) => errors.push(args.join(" "));
  try {
    const code = await doctor(CONFIG);
    assert.equal(code, 2);
  } finally {
    console.error = origError;
  }
  assert.ok(errors.some((line) => line.includes("SOLARI_API_KEY is not set")));
  assert.ok(errors.some((line) => line.includes("demo-offline")));
  // Honest messaging: no claim of a launch or a clean dispose happened.
  assert.ok(!errors.some((line) => line.includes("disposed cleanly")));
});

/** Config tests — .env parsing, env precedence, defaults, key redaction. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { describe, hasSolariKey, loadDotEnv, resolveConfig } from "../src/config.ts";
import type { NoapiConfig } from "../src/types.ts";

/** Save/restore process.env around loadDotEnv, which mutates it. */
function withSavedEnv(keys: string[], fn: () => void): void {
  const saved = new Map<string, string | undefined>(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) delete process.env[k];
  try {
    fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("loadDotEnv parses KEY=VALUE lines and skips comments/blanks/garbage", () => {
  const dir = mkdtempSync(join(tmpdir(), "noapi-dotenv-"));
  const path = join(dir, ".env");
  writeFileSync(
    path,
    [
      "# a comment",
      "",
      "NOAPI_TEST_DOTENV_A=one",
      "NOAPI_TEST_DOTENV_B= two words ",
      "garbage line without equals",
      "=no-key",
      "   ",
    ].join("\n"),
  );
  try {
    withSavedEnv(["NOAPI_TEST_DOTENV_A", "NOAPI_TEST_DOTENV_B"], () => {
      loadDotEnv(path);
      assert.equal(process.env.NOAPI_TEST_DOTENV_A, "one");
      assert.equal(process.env.NOAPI_TEST_DOTENV_B, "two words");
      assert.equal(process.env[""], undefined);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadDotEnv lets the real environment win over file values", () => {
  const dir = mkdtempSync(join(tmpdir(), "noapi-dotenv-"));
  const path = join(dir, ".env");
  writeFileSync(path, "NOAPI_TEST_DOTENV_C=from-file\n");
  try {
    withSavedEnv(["NOAPI_TEST_DOTENV_C"], () => {
      process.env.NOAPI_TEST_DOTENV_C = "from-env";
      loadDotEnv(path);
      assert.equal(process.env.NOAPI_TEST_DOTENV_C, "from-env");
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadDotEnv on a missing file is a no-op", () => {
  loadDotEnv(join(tmpdir(), "noapi-definitely-missing-.env"));
});

test("resolveConfig applies documented defaults", () => {
  const config = resolveConfig({});
  assert.deepEqual(config, {
    solariApiKey: "",
    portalOrigin: "http://127.0.0.1:8787",
    portalUser: "reviewer@getsolari.com",
    portalPassword: "reviewer",
    plan: "free",
    portalMode: "local",
  });
});

test("resolveConfig reads the environment", () => {
  const config = resolveConfig({
    SOLARI_API_KEY: "slr_live_test",
    NOAPI_PORTAL_ORIGIN: "http://127.0.0.1:9999",
    NOAPI_PORTAL_USER: "u@x.com",
    NOAPI_PORTAL_PASSWORD: "pw",
    NOAPI_PLAN: "starter",
    NOAPI_PORTAL: "sandbox",
  });
  assert.equal(config.solariApiKey, "slr_live_test");
  assert.equal(config.portalOrigin, "http://127.0.0.1:9999");
  assert.equal(config.portalUser, "u@x.com");
  assert.equal(config.portalPassword, "pw");
  assert.equal(config.plan, "starter");
  assert.equal(config.portalMode, "sandbox");
  // Anything but "sandbox" keeps the local portal mode.
  assert.equal(resolveConfig({ NOAPI_PORTAL: "remote" }).portalMode, "local");
  // Anything but "starter" degrades to free.
  assert.equal(resolveConfig({ NOAPI_PLAN: "enterprise" }).plan, "free");
});

test("hasSolariKey is true only with a non-empty key", () => {
  const base: NoapiConfig = resolveConfig({});
  assert.equal(hasSolariKey(base), false);
  assert.equal(hasSolariKey({ ...base, solariApiKey: "slr_live_x" }), true);
});

test("describe never leaks key material", () => {
  const config: NoapiConfig = {
    ...resolveConfig({}),
    solariApiKey: "slr_live_SUPERSECRET",
    portalPassword: "hunter2",
  };
  const text = describe(config);
  assert.match(text, /key=set/);
  assert.match(text, /portal=http:\/\/127\.0\.0\.1:8787/);
  assert.match(text, /plan=free/);
  assert.ok(!text.includes("slr_live_SUPERSECRET"));
  assert.ok(!text.includes("hunter2"));
  // And with no key it says so.
  assert.match(describe(resolveConfig({})), /key=unset/);
});

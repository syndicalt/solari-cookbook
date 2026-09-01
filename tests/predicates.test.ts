/**
 * Predicate tests — file/CSV predicates against tmp dirs, portal predicates
 * against a real ephemeral portal, OCR predicate with an injected ocr stub.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createPortal } from "../apps/portal/server.ts";
import { ROUTES } from "../apps/portal/selectors.ts";
import { buildPdf } from "../scripts/make-pack.ts";
import {
  csvDataRows,
  evaluateAll,
  evaluatePredicate,
  portalGetAuthed,
  predicateName,
} from "../src/eval/predicates.ts";
import type { NoapiConfig } from "../src/types.ts";
import { TINY_PNG } from "./helpers/fake-surfaces.ts";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "noapi-predicates-"));
}

const CONFIG: NoapiConfig = {
  solariApiKey: "",
  portalOrigin: "http://127.0.0.1:1", // replaced per-portal in portal tests
  portalUser: "reviewer@getsolari.com",
  portalPassword: "reviewer",
  plan: "free",
};

test("predicateName renders every kind", () => {
  assert.equal(predicateName({ kind: "fileExists", path: "a" }), "fileExists:a");
  assert.equal(predicateName({ kind: "rowCount", path: "b", min: 2 }), "rowCount:b>=2");
  assert.equal(predicateName({ kind: "portalAccepted", url: "/x" }), "portalAccepted:/x");
  assert.equal(
    predicateName({ kind: "screenshotContainsText", path: "s.png", text: "HI" }),
    "screenshotContainsText:HI",
  );
});

test("csvDataRows counts data rows, ignoring blanks and trailing newline", () => {
  const dir = tmpDir();
  try {
    const p = join(dir, "d.csv");
    writeFileSync(p, "h1,h2\na,b\nc,d\n");
    assert.equal(csvDataRows(p), 2);
    writeFileSync(p, "h1,h2\na,b\n\n\nc,d\n\n");
    assert.equal(csvDataRows(p), 2);
    // Header only → zero data rows (never negative).
    writeFileSync(p, "h1,h2\n");
    assert.equal(csvDataRows(p), 0);
    writeFileSync(p, "h1,h2");
    assert.equal(csvDataRows(p), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fileExists and rowCount against a tmp artifact dir", async () => {
  const dir = tmpDir();
  try {
    writeFileSync(join(dir, "exceptions.csv"), "h\nr1\nr2\n");

    const exists = await evaluatePredicate({ kind: "fileExists", path: "exceptions.csv" }, dir, CONFIG);
    assert.equal(exists.ok, true);
    assert.equal(exists.detail, undefined);

    const missing = await evaluatePredicate({ kind: "fileExists", path: "nope.pdf" }, dir, CONFIG);
    assert.equal(missing.ok, false);
    assert.match(missing.detail ?? "", /nope\.pdf/);

    const rows = await evaluatePredicate({ kind: "rowCount", path: "exceptions.csv", min: 2 }, dir, CONFIG);
    assert.equal(rows.ok, true);
    assert.match(rows.detail ?? "", /2 data rows/);

    const tooFew = await evaluatePredicate({ kind: "rowCount", path: "exceptions.csv", min: 3 }, dir, CONFIG);
    assert.equal(tooFew.ok, false);

    const rowsMissing = await evaluatePredicate({ kind: "rowCount", path: "gone.csv", min: 1 }, dir, CONFIG);
    assert.equal(rowsMissing.ok, false);
    assert.match(rowsMissing.detail ?? "", /missing/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("screenshotContainsText with an injected ocr", async () => {
  const dir = tmpDir();
  try {
    writeFileSync(join(dir, "desktop-final.png"), TINY_PNG);
    const p = { kind: "screenshotContainsText", path: "desktop-final.png", text: "EXCEPTIONS" } as const;

    const found = await evaluatePredicate(p, dir, CONFIG, { ocr: async () => "exceptions — june 2026" });
    assert.equal(found.ok, true, "match is case-insensitive");

    const notFound = await evaluatePredicate(p, dir, CONFIG, { ocr: async () => "blank screen" });
    assert.equal(notFound.ok, false);
    assert.match(notFound.detail ?? "", /did not find/);

    const ocrThrows = await evaluatePredicate(p, dir, CONFIG, {
      ocr: async () => {
        throw new Error("tesseract exploded");
      },
    });
    assert.equal(ocrThrows.ok, false);
    assert.match(ocrThrows.detail ?? "", /tesseract exploded/);

    const missing = await evaluatePredicate(
      { kind: "screenshotContainsText", path: "gone.png", text: "X" },
      dir,
      CONFIG,
      { ocr: async () => "X" },
    );
    assert.equal(missing.ok, false);
    assert.match(missing.detail ?? "", /missing/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("portalAccepted + portalGetAuthed against a real ephemeral portal", async (t) => {
  const portal = await createPortal({ port: 0 });
  t.after(() => portal.close());
  const config: NoapiConfig = { ...CONFIG, portalOrigin: `http://127.0.0.1:${portal.port}` };
  const dir = tmpDir();
  try {
    // Before any upload: /close/last is 404 → predicate red.
    const before = await evaluatePredicate({ kind: "portalAccepted", url: ROUTES.closeLast }, dir, config);
    assert.equal(before.ok, false);
    assert.match(before.detail ?? "", /status=404/);

    // Upload a real PDF via multipart, the way the browser surface does.
    const login = await fetch(`${config.portalOrigin}${ROUTES.login}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ email: config.portalUser, password: config.portalPassword }).toString(),
      redirect: "manual",
    });
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
    const pdf = Buffer.from(buildPdf(["test pack"]));
    const boundary = "predicateboundary";
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="close-pack.pdf"\r\ncontent-type: application/pdf\r\n\r\n`,
      ),
      pdf,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const upload = await fetch(`${config.portalOrigin}${ROUTES.closeSubmit}`, {
      method: "POST",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}`, cookie },
      body,
    });
    assert.equal(upload.status, 200);

    const after = await evaluatePredicate({ kind: "portalAccepted", url: ROUTES.closeLast }, dir, config);
    assert.equal(after.ok, true);
    assert.match(after.detail ?? "", /status=200/);

    // Wrong creds: portalGetAuthed reports the login failure honestly.
    const bad = await portalGetAuthed({ ...config, portalPassword: "nope" }, ROUTES.closeLast);
    assert.equal(bad.status, 401);
    assert.deepEqual(bad.body, { ok: false, error: "login failed" });

    const badPred = await evaluatePredicate(
      { kind: "portalAccepted", url: ROUTES.closeLast },
      dir,
      { ...config, portalPassword: "nope" },
    );
    assert.equal(badPred.ok, false);

    // Unreachable origin: the predicate fails with detail instead of throwing.
    const down = await evaluatePredicate(
      { kind: "portalAccepted", url: ROUTES.closeLast },
      dir,
      { ...config, portalOrigin: "http://127.0.0.1:1" },
    );
    assert.equal(down.ok, false);
    assert.ok(down.detail);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("evaluateAll evaluates every predicate in order", async () => {
  const dir = tmpDir();
  try {
    writeFileSync(join(dir, "a.txt"), "x\ny\n");
    const results = await evaluateAll(
      [
        { kind: "fileExists", path: "a.txt" },
        { kind: "rowCount", path: "a.txt", min: 1 },
        { kind: "fileExists", path: "missing.bin" },
      ],
      dir,
      CONFIG,
    );
    assert.equal(results.length, 3);
    assert.deepEqual(
      results.map((r) => r.ok),
      [true, true, false],
    );
    assert.deepEqual(
      results.map((r) => r.name),
      ["fileExists:a.txt", "rowCount:a.txt>=1", "fileExists:missing.bin"],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

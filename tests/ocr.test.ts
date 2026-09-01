/**
 * OCR tests — environment-agnostic. This machine has NO tesseract binary
 * (verified: `command -v tesseract` exits 1), so the tests pin the degraded
 * behavior: ocrAvailable() is false and ocrPng() throws OcrUnavailableError.
 * Both branches are asserted conditional on availability so the file also
 * passes on a machine that does have tesseract.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ocrAvailable, ocrPng, OcrUnavailableError } from "../src/eval/ocr.ts";
import { evaluatePredicate } from "../src/eval/predicates.ts";
import type { NoapiConfig } from "../src/types.ts";
import { TINY_PNG } from "./helpers/fake-surfaces.ts";

const CONFIG: NoapiConfig = {
  solariApiKey: "",
  portalOrigin: "http://127.0.0.1:1",
  portalUser: "u",
  portalPassword: "p",
  plan: "free",
};

test("ocrAvailable never throws and agrees with ocrPng", async () => {
  const available = await ocrAvailable();
  assert.equal(typeof available, "boolean");

  const dir = mkdtempSync(join(tmpdir(), "noapi-ocr-"));
  try {
    const png = join(dir, "tiny.png");
    writeFileSync(png, TINY_PNG);
    if (available) {
      // A 1x1 gray PNG has no glyphs — tesseract returns empty text.
      const text = await ocrPng(png);
      assert.equal(typeof text, "string");
      assert.equal(text.trim(), "");
    } else {
      // No binary (this machine): the clean, diagnosable error, not a crash.
      await assert.rejects(ocrPng(png), OcrUnavailableError);
      await assert.rejects(ocrPng(png), /tesseract binary not found/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("screenshotContainsText degrades when tesseract is unavailable", async () => {
  if (await ocrAvailable()) {
    // Nothing to assert on a tesseract machine — the injected-ocr paths are
    // covered in predicates.test.ts.
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "noapi-ocr-"));
  try {
    writeFileSync(join(dir, "desktop-final.png"), TINY_PNG);
    // No injected ocr → the predicate must degrade, not crash the run.
    const result = await evaluatePredicate(
      { kind: "screenshotContainsText", path: "desktop-final.png", text: "EXCEPTIONS" },
      dir,
      CONFIG,
    );
    assert.equal(result.ok, false);
    assert.match(result.detail ?? "", /tesseract unavailable/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("OcrUnavailableError has a stable name and message", () => {
  const err = new OcrUnavailableError();
  assert.equal(err.name, "OcrUnavailableError");
  assert.match(err.message, /tesseract binary not found/);
});

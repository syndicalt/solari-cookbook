/**
 * Focus sentinel + screenshot ring + OCR tests. No network, no real SDK —
 * fakes record calls and script screenshot bytes.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FocusMissError } from "../src/types.ts";
import {
  CALIBRATED_CLICK,
  FOCUS_SENTINEL,
  SCREEN_CENTER,
  clickAndConfirm,
  confirmFocus,
  typeWithSentinel,
  type DesktopLike,
} from "../src/rewind/focus.ts";
import { ScreenshotRing } from "../src/rewind/screenshots.ts";
import { OcrUnavailableError, ocrAvailable, ocrPng } from "../src/eval/ocr.ts";

const noSleep = async () => {};

interface FocusFake {
  desktop: DesktopLike;
  clicks: Array<{ x: number; y: number; opts?: { humanize?: boolean } }>;
  types: string[];
  hotkeys: string[][];
}

/** Fake whose screenshot() walks a scripted byte sequence (last one repeats). */
function makeFocusFake(shots: Uint8Array[]): FocusFake {
  const clicks: FocusFake["clicks"] = [];
  const types: string[] = [];
  const hotkeys: string[][] = [];
  let i = 0;
  const desktop: DesktopLike = {
    mouse: {
      click: async (x, y, opts) => {
        clicks.push({ x, y, ...(opts ? { opts } : {}) });
      },
    },
    keyboard: {
      type: async (text) => {
        types.push(text);
      },
      hotkey: async (...keys) => {
        hotkeys.push(keys);
      },
    },
    screenshot: async () => shots[Math.min(i++, shots.length - 1)]!,
  };
  return { desktop, clicks, types, hotkeys };
}

const PNG_A = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const PNG_B = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9, 9, 9]);

test("cookbook click points are the documented constants", () => {
  // (320, 300) top-left quadrant — never screen center (640, 360)
  assert.deepEqual(CALIBRATED_CLICK, { x: 320, y: 300 });
  assert.deepEqual(SCREEN_CENTER, { x: 640, y: 360 });
});

test("identical before/after screenshots → focus miss, FocusMissError, no chords sent", async () => {
  const fake = makeFocusFake([PNG_A, PNG_A]); // typing changed nothing
  const shot = () => fake.desktop.screenshot();

  const ok = await confirmFocus(fake.desktop, shot, { sleep: noSleep });
  assert.equal(ok, false);
  assert.deepEqual(fake.types, [FOCUS_SENTINEL]);
  // commit is a click on the neutral cell, not an Enter keypress
  assert.deepEqual(fake.clicks.map((c) => [c.x, c.y]), [[600, 450]]);

  await assert.rejects(
    typeWithSentinel(fake.desktop, shot, 320, 300, "real content", { sleep: noSleep }),
    (err: unknown) => {
      assert.ok(err instanceof FocusMissError);
      return true;
    },
  );
  // commit-and-overwrite flow: chords are never sent (live chord failure —
  // hotkey("ctrl","z") delivered a literal "z" on the real template)
  assert.deepEqual(fake.hotkeys, []);
});

test("differing screenshots → click, sentinel committed by click, re-click, overwrite", async () => {
  // The fake serves screenshots in order: clickAndConfirm consumes the
  // first; confirmFocus then diffs #2 vs #3 — differing → focus ok.
  const fake = makeFocusFake([PNG_A, PNG_A, PNG_B]);
  const shot = () => fake.desktop.screenshot();

  await typeWithSentinel(fake.desktop, shot, 320, 300, "EXCEPTIONS", { sleep: noSleep });

  assert.deepEqual(fake.types, [FOCUS_SENTINEL, "EXCEPTIONS"]);
  assert.deepEqual(fake.hotkeys, []);
  // focus click, commit click, reselect click, commit click
  assert.deepEqual(fake.clicks.map((c) => [c.x, c.y]), [
    [320, 300],
    [600, 450],
    [320, 300],
    [600, 450],
  ]);
});

test("FocusMissError carries the screenshot path when provided", async () => {
  const fake = makeFocusFake([PNG_A, PNG_A]);
  const shot = () => fake.desktop.screenshot();
  await assert.rejects(
    typeWithSentinel(fake.desktop, shot, 320, 300, "x", { sleep: noSleep, screenshotPath: "artifacts/r1/desktop-99.png" }),
    (err: unknown) => {
      assert.ok(err instanceof FocusMissError);
      assert.equal(err.screenshotPath, "artifacts/r1/desktop-99.png");
      return true;
    },
  );
});

test("clickAndConfirm clicks humanized, settles, and returns the screenshot", async () => {
  const fake = makeFocusFake([PNG_B]);
  const shot = await clickAndConfirm(fake.desktop, CALIBRATED_CLICK.x, CALIBRATED_CLICK.y, {
    sleep: noSleep,
  });
  assert.deepEqual(fake.clicks, [{ x: 320, y: 300, opts: { humanize: true } }]);
  assert.deepEqual(shot, PNG_B);
});

test("ocr verifier is authoritative when provided — sentinel string read back", async () => {
  // Identical PNG bytes would fail the byte-diff, but OCR read the sentinel.
  const fake = makeFocusFake([PNG_A, PNG_A]);
  const shot = () => fake.desktop.screenshot();
  const ok = await confirmFocus(fake.desktop, shot, {
    sleep: noSleep,
    ocr: async () => `cell c3: ${FOCUS_SENTINEL}`,
  });
  assert.equal(ok, true);
});

test("ocr match tolerates tesseract 0/O and 1/I confusion", async () => {
  const fake = makeFocusFake([PNG_A, PNG_A]);
  const shot = () => fake.desktop.screenshot();
  const ok = await confirmFocus(fake.desktop, shot, {
    sleep: noSleep,
    ocr: async () => "N0API_F0CUS_0K", // zeros where the O's are
  });
  assert.equal(ok, true);
});

test("ocr match survives the mangling seen on a real desktop", async () => {
  // Verbatim live tesseract output: "NOAPI_FOCUS_OK" → "NQAP| FOCUS_OK".
  const fake = makeFocusFake([PNG_A, PNG_A]);
  const shot = () => fake.desktop.screenshot();
  const ok = await confirmFocus(fake.desktop, shot, {
    sleep: noSleep,
    ocr: async () => "3__INV-2026-06-005 Umbrella Freight NQAP| FOCUS_OK missing_in_ ledger @",
  });
  assert.equal(ok, true);
});

test("ocr verifier catches the modal false-pass the byte-diff cannot see", async () => {
  // Bytes DIFFER (a modal's checkbox toggled) but the sentinel is not on
  // screen — the case the byte-diff gets wrong (observed live on the
  // Text Import dialog). OCR says miss.
  const fake = makeFocusFake([PNG_A, PNG_B]);
  const shot = () => fake.desktop.screenshot();
  await assert.rejects(
    typeWithSentinel(fake.desktop, shot, 320, 300, "real content", {
      sleep: noSleep,
      ocr: async () => "text import dialog, no sentinel here",
    }),
    FocusMissError,
  );
});

test("ocr failure falls back to the byte-diff", async () => {
  const fake = makeFocusFake([PNG_A, PNG_B]); // bytes differ → fallback passes
  const shot = () => fake.desktop.screenshot();
  const ok = await confirmFocus(fake.desktop, shot, {
    sleep: noSleep,
    ocr: async () => {
      throw new Error("tesseract exploded");
    },
  });
  assert.equal(ok, true, "byte-diff fallback when OCR tooling fails");
});

test("screenshot ring evicts oldest past capacity and keeps order", () => {
  const ring = new ScreenshotRing(3);
  ring.push("one", new Uint8Array([1]), 1);
  ring.push("two", new Uint8Array([2]), 2);
  ring.push("three", new Uint8Array([3]), 3);
  ring.push("four", new Uint8Array([4]), 4);

  const labels = ring.frames().map((f) => f.label);
  assert.deepEqual(labels, ["two", "three", "four"]);
  assert.equal(ring.latest()?.label, "four");
  assert.equal(ring.frames().length, 3);
});

test("screenshot ring flush writes desktop-NN-label.png files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "noapi-ring-"));
  try {
    const ring = new ScreenshotRing(10);
    ring.push("open", new Uint8Array([1, 2, 3]));
    ring.push("Final Shot!", new Uint8Array([4, 5]));

    const paths = await ring.flush(dir);
    assert.equal(paths.length, 2);
    assert.ok(paths[0]!.endsWith("desktop-01-open.png"), paths[0]);
    assert.ok(paths[1]!.endsWith("desktop-02-final-shot.png"), paths[1]);
    assert.deepEqual([...(await readFile(paths[0]!))], [1, 2, 3]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ocrAvailable resolves a boolean without crashing", async () => {
  const available = await ocrAvailable();
  assert.equal(typeof available, "boolean");
});

test("ocrPng runs tesseract when present, throws OcrUnavailableError when absent", async () => {
  const available = await ocrAvailable();
  if (!available) {
    await assert.rejects(ocrPng("/nonexistent.png"), OcrUnavailableError);
    return;
  }
  // tesseract exists: a 1x1 PNG yields little or no text, but must not crash
  const dir = await mkdtemp(join(tmpdir(), "noapi-ocr-"));
  try {
    // 1x1 transparent PNG
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
      "base64",
    );
    const path = join(dir, "tiny.png");
    await writeFile(path, png);
    const text = await ocrPng(path);
    assert.equal(typeof text, "string");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

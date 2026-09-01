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
  typeConfirmed,
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

test("identical before/after screenshots → focus miss, FocusMissError, undo attempted", async () => {
  const fake = makeFocusFake([PNG_A, PNG_A]); // typing changed nothing
  const shot = () => fake.desktop.screenshot();

  const ok = await confirmFocus(fake.desktop, shot, { sleep: noSleep });
  assert.equal(ok, false);
  assert.deepEqual(fake.types, [FOCUS_SENTINEL]);

  await assert.rejects(
    typeConfirmed(fake.desktop, shot, "real content", { sleep: noSleep }),
    (err: unknown) => {
      assert.ok(err instanceof FocusMissError);
      return true;
    },
  );
  // typeConfirmed attempts the best-effort undo on the failure path
  assert.deepEqual(fake.hotkeys, [["ctrl", "z"]]);
});

test("differing screenshots → focus ok, sentinel undone with ctrl+z, real text typed", async () => {
  const fake = makeFocusFake([PNG_A, PNG_B]);
  const shot = () => fake.desktop.screenshot();

  await typeConfirmed(fake.desktop, shot, "EXCEPTIONS\n", { sleep: noSleep });

  assert.deepEqual(fake.types, [FOCUS_SENTINEL, "EXCEPTIONS\n"]);
  assert.deepEqual(fake.hotkeys, [["ctrl", "z"]]);
});

test("FocusMissError carries the screenshot path when provided", async () => {
  const fake = makeFocusFake([PNG_A, PNG_A]);
  const shot = () => fake.desktop.screenshot();
  await assert.rejects(
    typeConfirmed(fake.desktop, shot, "x", { sleep: noSleep, screenshotPath: "artifacts/r1/desktop-99.png" }),
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

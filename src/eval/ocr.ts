/**
 * OCR probe — local `tesseract` only. No npm deps, no network.
 *
 * Feeds the `screenshotContainsText` eval predicate: the desktop-final PNG is
 * run through `tesseract <png> stdout` and the text is searched. When the
 * binary is missing the predicate degrades instead of crashing the run —
 * {@link ocrAvailable} returns false and {@link ocrPng} throws
 * {@link OcrUnavailableError}, both clean and diagnosable.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Thrown when `tesseract` is not installed on this machine. */
export class OcrUnavailableError extends Error {
  constructor(message = "tesseract binary not found — install tesseract-ocr or skip OCR predicates") {
    super(message);
    this.name = "OcrUnavailableError";
  }
}

/** True when a local `tesseract` binary is on PATH. Never throws. */
export async function ocrAvailable(): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("sh", ["-c", "command -v tesseract"]);
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Extract text from a PNG via `tesseract <png> stdout`. Throws
 * {@link OcrUnavailableError} when the binary is missing; other tesseract
 * failures propagate as-is.
 */
export async function ocrPng(pngPath: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("tesseract", [pngPath, "stdout"]);
    return stdout;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new OcrUnavailableError();
    }
    throw err;
  }
}

/**
 * Screenshot ring — the last N desktop frames, kept in memory and flushable
 * to `artifacts/<runId>/`.
 *
 * The rewind policy reads these frames after a focus miss: the tail of the
 * ring is what the screen looked like around the failed click, so the
 * conductor can recapture and replan the click instead of restarting the
 * whole run.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface ScreenshotFrame {
  /** Capture time (ms since epoch). */
  t: number;
  /** Short grepable label, e.g. "desktop-01-open". */
  label: string;
  bytes: Uint8Array;
}

export class ScreenshotRing {
  readonly capacity: number;
  #frames: ScreenshotFrame[] = [];

  constructor(capacity = 10) {
    if (capacity < 1) throw new Error("ScreenshotRing capacity must be >= 1");
    this.capacity = capacity;
  }

  /** Append a frame, evicting the oldest when at capacity. Returns the frame. */
  push(label: string, bytes: Uint8Array, t = Date.now()): ScreenshotFrame {
    const frame: ScreenshotFrame = { t, label, bytes };
    this.#frames.push(frame);
    if (this.#frames.length > this.capacity) {
      this.#frames.splice(0, this.#frames.length - this.capacity);
    }
    return frame;
  }

  /** Most recent frame, or undefined when empty. */
  latest(): ScreenshotFrame | undefined {
    return this.#frames[this.#frames.length - 1];
  }

  /** Oldest-to-newest copy of the ring's frames. */
  frames(): ScreenshotFrame[] {
    return [...this.#frames];
  }

  /**
   * Write every frame to `dir` as `desktop-NN-label.png` (NN is 01-based
   * ring order). Returns the written paths.
   */
  async flush(dir: string): Promise<string[]> {
    await mkdir(dir, { recursive: true });
    const paths: string[] = [];
    for (const [i, frame] of this.#frames.entries()) {
      const nn = String(i + 1).padStart(2, "0");
      const label = frame.label
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, "-")
        .replace(/^-+|-+$/g, "");
      const path = join(dir, `desktop-${nn}-${label}.png`);
      await writeFile(path, frame.bytes);
      paths.push(path);
    }
    return paths;
  }
}

/**
 * Focus sentinel — the dumb-reliable check that a desktop click actually
 * landed before we type real content.
 *
 * Cookbook gotcha (examples/desktop-computer-use-py/main.py), quoted because
 * it is the whole reason this file exists:
 *
 *   "Click INSIDE the editor's text area before typing. Mousepad opens in the
 *    top-left quadrant, so screen-centre (640, 360) is already past its right
 *    edge — clicking there focuses whatever is behind it and your keystrokes
 *    go to the wrong window, silently. Nothing errors; you just get an empty
 *    document."
 *
 * So: NEVER click (640, 360). {@link CALIBRATED_CLICK} is the cookbook point
 * (320, 300) — inside the top-left quadrant where apps open on 1280x720.
 *
 * v0 is allowed to be dumb (AGENTS.md): the probe types {@link FOCUS_SENTINEL}
 * and compares PNG bytes before/after. Identical bytes means nothing
 * rendered, i.e. the keystrokes went nowhere. `src/eval/ocr.ts` upgrades this
 * to text-verified confirmation when a local `tesseract` binary is available.
 */
import { FocusMissError } from "../types.ts";

/** Typed into the focused window to prove keystrokes land there. */
export const FOCUS_SENTINEL = "NOAPI_FOCUS_OK";

/**
 * The cookbook click point — top-left quadrant on 1280x720, inside the window
 * that just opened. Screen center (640, 360) hits the window BEHIND; see the
 * header comment. Never use it.
 */
export const CALIBRATED_CLICK = { x: 320, y: 300 } as const;

/**
 * The known-bad point (screen center on 1280x720). Only used by the
 * NOAPI_FORCE_FOCUS_MISS=1 hook in `src/surfaces/desktop.ts` to exercise the
 * conductor's rewind path on demand.
 */
export const SCREEN_CENTER = { x: 640, y: 360 } as const;

/**
 * The slice of a Solari desktop handle the sentinel needs. Structural, so the
 * real `@solarisdk/core` `Desktop` and test fakes both satisfy it.
 */
export interface DesktopLike {
  mouse: {
    click(x: number, y: number, opts?: { humanize?: boolean }): Promise<void>;
  };
  keyboard: {
    type(text: string): Promise<void>;
    hotkey(...keys: string[]): Promise<void>;
  };
  screenshot(opts?: { format?: "png" | "jpeg" }): Promise<Uint8Array>;
}

export interface FocusOpts {
  /** Injectable sleep (tests pass a no-op). Defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** Settle time after click/type before the screenshot. Default 300ms. */
  waitMs?: number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Dumb-reliable focus probe: screenshot, type the sentinel, settle,
 * screenshot again. Identical PNG bytes → nothing rendered → focus miss.
 *
 * On success the sentinel is undone with ctrl+z (best-effort — if the undo
 * fails we are no worse off than before the probe). On miss nothing is
 * undone here; the caller ({@link typeConfirmed}) attempts undo too, since a
 * partial render that still byte-compares equal is possible in theory.
 *
 * @param shot Screenshot function (usually the surface's ring-pushing one).
 */
export async function confirmFocus(
  desktop: DesktopLike,
  shot: () => Promise<Uint8Array>,
  opts: FocusOpts = {},
): Promise<boolean> {
  const sleep = opts.sleep ?? defaultSleep;
  const waitMs = opts.waitMs ?? 300;

  const before = await shot();
  await desktop.keyboard.type(FOCUS_SENTINEL);
  await sleep(waitMs);
  const after = await shot();

  if (bytesEqual(before, after)) {
    return false;
  }
  try {
    await desktop.keyboard.hotkey("ctrl", "z");
  } catch {
    // best-effort undo — the probe already proved focus, a failed undo is cosmetic
  }
  return true;
}

/**
 * Click and capture the result. Used before typing real content; the returned
 * shot is both proof and rewind material. Does NOT itself confirm focus —
 * pair it with {@link typeConfirmed} / {@link confirmFocus}.
 */
export async function clickAndConfirm(
  desktop: DesktopLike,
  x: number,
  y: number,
  opts: FocusOpts = {},
): Promise<Uint8Array> {
  const sleep = opts.sleep ?? defaultSleep;
  await desktop.mouse.click(x, y, { humanize: true });
  await sleep(opts.waitMs ?? 300);
  return desktop.screenshot({ format: "png" });
}

export interface TypeConfirmedOpts extends FocusOpts {
  /** Attached to {@link FocusMissError} so the journal can point at proof. */
  screenshotPath?: string;
}

/**
 * Confirm focus, then type `text` for real. Throws {@link FocusMissError}
 * when the sentinel does not change the screen — callers (the conductor)
 * catch it and rewind the step instead of typing into the void.
 */
export async function typeConfirmed(
  desktop: DesktopLike,
  shot: () => Promise<Uint8Array>,
  text: string,
  opts: TypeConfirmedOpts = {},
): Promise<void> {
  const ok = await confirmFocus(desktop, shot, opts);
  if (!ok) {
    try {
      // a miss means the keystrokes went elsewhere; undo is usually a no-op
      // but guards against a partial render that byte-compared equal
      await desktop.keyboard.hotkey("ctrl", "z");
    } catch {
      // best-effort
    }
    throw new FocusMissError(
      "focus sentinel did not render — click missed the target window",
      opts.screenshotPath,
    );
  }
  await desktop.keyboard.type(text);
}

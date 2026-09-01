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
 * rendered, i.e. the keystrokes went nowhere.
 *
 * Sentinel cleanup is COMMIT-AND-OVERWRITE with clicks only. Verified live
 * against a Solari desktop: `keyboard.type` does NOT translate "\n" into an
 * Enter keypress (the formula bar showed the raw concatenation), and a
 * `hotkey("ctrl","z")` chord was delivered as a literal "z". So the sentinel
 * is committed by clicking a neutral cell ({@link COMMIT_CLICK}), the
 * sentinel cell is re-clicked, and the real text is typed over it — typing
 * on a selected cell replaces its content. Only click/type/screenshot are
 * used; all three are proven on the real template.
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
 * A neutral far cell on the Calc grid (roughly F10 at 1280x720). Clicking it
 * COMMITS an in-progress cell edit — verified live that `keyboard.type` does
 * not translate "\n" into an Enter keypress (the formula bar showed the raw
 * concatenation), and that keyboard chords are unreliable on the template.
 * Click-to-commit uses only the two input primitives that are proven.
 */
export const COMMIT_CLICK = { x: 600, y: 450 } as const;

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
 * Dumb-reliable focus probe: screenshot, type the sentinel, click a neutral
 * cell to COMMIT the edit (Enter via "\n" does not work — see COMMIT_CLICK),
 * settle, screenshot again. Identical PNG bytes → nothing rendered → focus
 * miss. On success the sentinel sits in the document; callers remove it by
 * overwriting ({@link typeWithSentinel}). No keyboard chords are used —
 * verified live that hotkey("ctrl","z") delivered a literal "z".
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
  await desktop.mouse.click(COMMIT_CLICK.x, COMMIT_CLICK.y, { humanize: true });
  await sleep(waitMs);
  const after = await shot();

  return !bytesEqual(before, after);
}

/**
 * Click and capture the result. Used before typing real content; the returned
 * shot is both proof and rewind material. Does NOT itself confirm focus —
 * pair it with {@link typeWithSentinel} / {@link confirmFocus}.
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
 * The full sentinel flow for typing `text` at (x, y):
 *
 *   1. click (x, y)                       — focus the cell/field
 *   2. type FOCUS_SENTINEL                — probe text
 *   3. click COMMIT_CLICK                 — commit the edit (no Enter key!)
 *   4. screenshot diff                    — proof the keystrokes rendered
 *   5. click (x, y) again                 — reselect the sentinel cell
 *   6. type `text`                        — overwrites the sentinel
 *   7. click COMMIT_CLICK                 — commit the real content
 *
 * Throws {@link FocusMissError} at step 4 when the screen did not change —
 * the conductor catches it and rewinds the step instead of typing into the
 * void. Only click/type/screenshot are used: every one of them is proven on
 * the real template, while "\n" and chords are proven NOT to work.
 */
export async function typeWithSentinel(
  desktop: DesktopLike,
  shot: () => Promise<Uint8Array>,
  x: number,
  y: number,
  text: string,
  opts: TypeConfirmedOpts = {},
): Promise<void> {
  await clickAndConfirm(desktop, x, y, opts);
  const ok = await confirmFocus(desktop, shot, opts);
  if (!ok) {
    throw new FocusMissError(
      "focus sentinel did not render — click missed the target window",
      opts.screenshotPath,
    );
  }
  await clickAndConfirm(desktop, x, y, opts);
  await desktop.keyboard.type(text);
  await clickAndConfirm(desktop, COMMIT_CLICK.x, COMMIT_CLICK.y, opts);
}

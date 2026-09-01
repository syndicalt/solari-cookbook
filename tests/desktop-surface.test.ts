/**
 * Desktop surface tests. No network, no real SDK — a fake DesktopLike /
 * DesktopClientLike records calls and scripts health / exec / screenshot
 * behavior. The real DesktopClient is never constructed.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FocusMissError, type NoapiConfig } from "../src/types.ts";
import { FOCUS_SENTINEL } from "../src/rewind/focus.ts";
import {
  SolariDesktopSurface,
  type DesktopClientLike,
  type DesktopLike,
} from "../src/surfaces/desktop.ts";

const noSleep = async () => {};

const CONFIG: NoapiConfig = {
  solariApiKey: "",
  portalOrigin: "http://127.0.0.1:8787",
  portalUser: "u",
  portalPassword: "p",
  plan: "free",
    portalMode: "local",
};

interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

class FakeDesktop implements DesktopLike {
  readonly sessionId = "sess-test";
  readonly streamUrl = "https://vnc.example/sess-test";

  readyOnPoll = 1;
  healthCalls = 0;
  execImpl: (cmd: string, args: string[]) => ExecResult = () => ({
    exitCode: 0,
    stdout: "",
    stderr: "",
  });
  openImpl: (name: string, args: string[]) => Promise<number> = async () => 4321;
  /** Return differing bytes per call by default (screen keeps changing). */
  screenshotImpl: () => Uint8Array;

  execCalls: Array<{ cmd: string; args: string[] }> = [];
  openCalls: Array<{ name: string; args: string[] }> = [];
  clicks: Array<{ x: number; y: number }> = [];
  types: string[] = [];
  hotkeys: string[][] = [];
  files = new Map<string, Uint8Array | string>();
  closeCalls = 0;

  #shotSeq = 0;
  constructor() {
    this.screenshotImpl = () => new Uint8Array([0x89, 0x50, ++this.#shotSeq]);
  }

  async health(): Promise<{ ready: boolean }> {
    this.healthCalls += 1;
    return { ready: this.healthCalls >= this.readyOnPoll };
  }

  connectCalls = 0;
  async connect(): Promise<void> {
    this.connectCalls += 1;
  }

  async exec(cmd: string, opts?: { args?: string[] }): Promise<ExecResult> {
    const args = opts?.args ?? [];
    this.execCalls.push({ cmd, args });
    return this.execImpl(cmd, args);
  }

  fs = {
    write: async (path: string, data: Uint8Array | string): Promise<void> => {
      this.files.set(path, data);
    },
    read: async (path: string): Promise<Uint8Array> => {
      const data = this.files.get(path);
      if (data === undefined) throw new Error(`no such file: ${path}`);
      return typeof data === "string" ? new TextEncoder().encode(data) : data;
    },
  };

  mouse = {
    click: async (x: number, y: number): Promise<void> => {
      this.clicks.push({ x, y });
    },
  };

  keyboard = {
    type: async (text: string): Promise<void> => {
      this.types.push(text);
    },
    hotkey: async (...keys: string[]): Promise<void> => {
      this.hotkeys.push(keys);
    },
  };

  async screenshot(): Promise<Uint8Array> {
    return this.screenshotImpl();
  }

  async open(name: string, args: string[] = []): Promise<number> {
    this.openCalls.push({ name, args });
    return this.openImpl(name, args);
  }

  recordingUrl: string | undefined = "https://rec.example/sess-test.mp4";
  recordCalls = { start: 0, stop: 0 };
  record = {
    start: async (): Promise<unknown> => {
      this.recordCalls.start += 1;
      return {};
    },
    stop: async (): Promise<unknown> => {
      this.recordCalls.stop += 1;
      return {};
    },
  };

  close(): void {
    this.closeCalls += 1;
  }
}

class FakeClient implements DesktopClientLike {
  createOpts: Array<Record<string, unknown>> = [];
  destroyed: string[] = [];
  private readonly desktop: FakeDesktop;
  constructor(desktop: FakeDesktop) {
    this.desktop = desktop;
  }
  async create(opts: Record<string, unknown>): Promise<DesktopLike> {
    this.createOpts.push(opts);
    return this.desktop;
  }
  async destroy(sessionId: string): Promise<unknown> {
    this.destroyed.push(sessionId);
    return {};
  }
}

function makeSurface(desktop = new FakeDesktop()) {
  const client = new FakeClient(desktop);
  const surface = new SolariDesktopSurface(CONFIG, { client, sleep: noSleep });
  return { desktop, client, surface };
}

/** Capture console.log lines for the duration of fn. */
async function captureLogs<T>(fn: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    return { result: await fn(), lines };
  } finally {
    console.log = orig;
  }
}

/** soffice present, headless convert succeeds, pdf readable. */
function libreOfficeExec(desktop: FakeDesktop): void {
  desktop.execImpl = (cmd, args) => {
    // Probes go through the shell: exec("sh", ["-c", "command -v <name>"]).
    if (cmd === "sh" && args[0] === "-c" && (args[1] ?? "").startsWith("command -v")) {
      return { exitCode: args[1] === "command -v soffice" ? 0 : 1, stdout: "", stderr: "" };
    }
    if (cmd === "soffice" && args.includes("--convert-to")) {
      desktop.files.set("/work/exceptions.pdf", new Uint8Array([0x25, 0x50, 0x44, 0x46]));
      return { exitCode: 0, stdout: "convert ok", stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };
}

test("start polls health until ready and logs the streamUrl immediately", async () => {
  const { desktop, client, surface } = makeSurface();
  desktop.readyOnPoll = 3;

  const { result, lines } = await captureLogs(() => surface.start());

  assert.equal(result, "https://vnc.example/sess-test");
  assert.equal(desktop.healthCalls, 3); // ready on the 3rd poll
  assert.equal(surface.sessionId, "sess-test");
  assert.equal(surface.streamUrl, "https://vnc.example/sess-test");
  assert.ok(lines.some((l) => l.startsWith("desktop.stream url=https://vnc.example/")));
  assert.equal(client.createOpts.length, 1);
  assert.equal(client.createOpts[0]!.template, "default");
  assert.equal(client.createOpts[0]!.resolution, "1280x720");
  assert.equal(client.createOpts[0]!.timeoutMs, 600_000);
});

test("start throws a clear error when X11 never becomes ready", async () => {
  const { desktop, surface } = makeSurface();
  desktop.readyOnPoll = Number.MAX_SAFE_INTEGER;
  await assert.rejects(surface.start(), /desktop\.health not ready/);
});

test("openApp probes the binary, falls back to the alias, then errors listing probed names", async () => {
  const { desktop, surface } = makeSurface();
  await captureLogs(() => surface.start());

  // soffice missing, libreoffice present → alias wins
  desktop.execImpl = (_cmd, args) => ({
    exitCode: args[1] === "command -v libreoffice" ? 0 : 1,
    stdout: "",
    stderr: "",
  });
  const pid = await captureLogs(() => surface.openApp("libreoffice")).then((r) => r.result);
  assert.equal(pid, 4321);
  assert.deepEqual(
    desktop.execCalls.map((c) => c.args[1]),
    ["command -v soffice", "command -v libreoffice"],
  );
  assert.equal(desktop.openCalls[0]!.name, "libreoffice");

  // neither present → error names everything probed
  desktop.execImpl = () => ({ exitCode: 1, stdout: "", stderr: "" });
  await assert.rejects(surface.openApp("libreoffice"), /probed: soffice, libreoffice/);
  await assert.rejects(surface.openApp("mousepad"), /probed: mousepad/);
});

test("dispose closes the channel and destroys the session exactly once", async () => {
  const { desktop, client, surface } = makeSurface();
  await captureLogs(() => surface.start());

  const { lines } = await captureLogs(async () => {
    await surface.dispose();
    await surface.dispose(); // idempotent
  });

  assert.equal(desktop.closeCalls, 1);
  assert.deepEqual(client.destroyed, ["sess-test"]);
  assert.ok(lines.some((l) => l.startsWith("desktop.disposed session=sess-test")));
});

test("secondsUsed is zero before start and positive after", async () => {
  const { surface } = makeSurface();
  assert.equal(surface.secondsUsed(), 0);
  await captureLogs(() => surface.start());
  assert.ok(surface.secondsUsed() >= 0);
});

test("record lifecycle: start on record:true, stopRecording returns the mp4 URL", async () => {
  const { desktop, surface } = makeSurface();
  await captureLogs(() => surface.start({ record: true }));
  assert.equal(desktop.recordCalls.start, 1);

  const { result: url } = await captureLogs(() => surface.stopRecording());
  assert.equal(desktop.recordCalls.stop, 1);
  assert.equal(url, "https://rec.example/sess-test.mp4");

  // Second stop is a no-op; nothing left running.
  assert.equal(await surface.stopRecording(), null);
  assert.equal(desktop.recordCalls.stop, 1);
});

test("dispose auto-stops a recording left running (footage safety net)", async () => {
  const { desktop, surface } = makeSurface();
  await captureLogs(() => surface.start({ record: true }));
  await captureLogs(() => surface.dispose());
  assert.equal(desktop.recordCalls.start, 1);
  assert.equal(desktop.recordCalls.stop, 1, "dispose must stop the recording before destroy");
  assert.equal(desktop.closeCalls, 1);
});

test("no recording when record is not requested", async () => {
  const { desktop, surface } = makeSurface();
  await captureLogs(() => surface.start());
  assert.equal(desktop.recordCalls.start, 0);
  assert.equal(await surface.stopRecording(), null);
});

test("formatLibreOffice happy path: upload, GUI open, sentinel, headless convert, pdf back", async () => {
  const dir = await mkdtemp(join(tmpdir(), "noapi-desktop-"));
  try {
    const csvPath = join(dir, "exceptions.csv");
    await writeFile(csvPath, "invoice,vendor,amount\nINV-1,Acme,10.00\n");

    const { desktop, surface } = makeSurface();
    libreOfficeExec(desktop);
    await captureLogs(() => surface.start());

    const { pdfBytes, finalShot } = await captureLogs(() =>
      surface.formatLibreOffice({ exceptionsCsvPath: csvPath }),
    ).then((r) => r.result);

    // csv shipped to the VM
    assert.ok(desktop.files.has("/work/exceptions.csv"));
    // GUI opened with the csv
    assert.deepEqual(desktop.openCalls[0], {
      name: "soffice",
      args: ["--calc", "/work/exceptions.csv"],
    });
    // Text Import modal dismissed via OK, Tip-of-the-Day blind-dismissed,
    // then the sentinel flow: focus click, commit click, reselect, commit
    assert.deepEqual(desktop.clicks, [
      { x: 943, y: 703 },
      { x: 873, y: 508 },
      { x: 320, y: 300 },
      { x: 600, y: 450 },
      { x: 320, y: 300 },
      { x: 600, y: 450 },
    ]);
    // sentinel typed then overwritten by the real title — no chords, no "\n"
    assert.deepEqual(desktop.types, [FOCUS_SENTINEL, "EXCEPTIONS"]);
    assert.deepEqual(desktop.hotkeys, []);
    // headless convert issued
    assert.ok(
      desktop.execCalls.some(
        (c) => c.cmd === "soffice" && c.args.includes("--headless") && c.args.includes("--convert-to"),
      ),
    );
    assert.deepEqual(pdfBytes, new Uint8Array([0x25, 0x50, 0x44, 0x46]));
    assert.ok(finalShot.length > 0);
    // ring holds the labeled frames
    const labels = surface.ring.frames().map((f) => f.label);
    assert.ok(labels.includes("desktop-01-open"));
    assert.ok(labels.includes("desktop-final"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("formatLibreOffice GUI-open failure: logs desktop.gui_fallback, still converts and screenshots", async () => {
  const dir = await mkdtemp(join(tmpdir(), "noapi-desktop-"));
  try {
    const csvPath = join(dir, "exceptions.csv");
    await writeFile(csvPath, "invoice,vendor\nINV-1,Acme\n");

    const { desktop, surface } = makeSurface();
    libreOfficeExec(desktop);
    desktop.openImpl = async (_name, args) => {
      if (args.includes("--calc")) throw new Error("no display");
      return 5555; // the --view reopen works
    };
    await captureLogs(() => surface.start());

    const { result, lines } = await captureLogs(() =>
      surface.formatLibreOffice({ exceptionsCsvPath: csvPath }),
    );

    assert.ok(lines.some((l) => l.startsWith("desktop.gui_fallback")));
    // no GUI → no clicks, no sentinel typing
    assert.equal(desktop.clicks.length, 0);
    assert.equal(desktop.types.length, 0);
    // pdf still produced headless, result reopened for the proof shot
    assert.ok(
      desktop.execCalls.some((c) => c.args.includes("--convert-to")),
      "headless convert still ran",
    );
    assert.deepEqual(desktop.openCalls[1], {
      name: "soffice",
      args: ["--view", "/work/exceptions.pdf"],
    });
    assert.deepEqual(result.pdfBytes, new Uint8Array([0x25, 0x50, 0x44, 0x46]));
    assert.ok(result.finalShot.length > 0);
    const labels = surface.ring.frames().map((f) => f.label);
    assert.ok(labels.includes("desktop-final"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("NOAPI_FORCE_FOCUS_MISS=1 sends the first click to screen center and the sentinel fires", async () => {
  const dir = await mkdtemp(join(tmpdir(), "noapi-desktop-"));
  const prev = process.env.NOAPI_FORCE_FOCUS_MISS;
  process.env.NOAPI_FORCE_FOCUS_MISS = "1";
  try {
    const csvPath = join(dir, "exceptions.csv");
    await writeFile(csvPath, "invoice,vendor\nINV-1,Acme\n");

    const { desktop, surface } = makeSurface();
    libreOfficeExec(desktop);
    // frozen screen: typing renders nothing → sentinel must fire
    desktop.screenshotImpl = () => new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    await captureLogs(() => surface.start());

    const { lines } = await captureLogs(async () => {
      await assert.rejects(surface.formatLibreOffice({ exceptionsCsvPath: csvPath }), (err: unknown) => {
        assert.ok(err instanceof FocusMissError);
        return true;
      });
    });

    assert.ok(lines.some((l) => l.startsWith("desktop.force_focus_miss action=cancel_import_dialog")));
    // The Text Import modal is CANCELED (no document loads), then the center
    // click into the Start Center, then the commit click before the throw.
    assert.deepEqual(desktop.clicks, [
      { x: 848, y: 703 },
      { x: 640, y: 360 },
      { x: 600, y: 450 },
    ]);
  } finally {
    if (prev === undefined) delete process.env.NOAPI_FORCE_FOCUS_MISS;
    else process.env.NOAPI_FORCE_FOCUS_MISS = prev;
    await rm(dir, { recursive: true, force: true });
  }
});

/**
 * Sandbox surface — the Solari microVM where reconciliation actually runs.
 *
 * Cookbook contract (examples/sandbox-quickstart-ts, sandbox-port-preview-ts):
 *  - `SolariClient` defaults baseUrl; `sandboxes.create({ template, timeoutMs })`.
 *  - `timeoutMs` is a ROLLING IDLE WINDOW — it resets on every use, it is not
 *    a hard deadline. Long runs heartbeat with a cheap command.
 *  - `commands.run(cmd, { args })` is NOT shell-interpreted — argv goes in
 *    `args`; for pipes/globs/redirection run a shell explicitly.
 *  - `connect()` opens the control channel, needed for files/git/code.
 *  - `kill()` destroys the remote VM; `close()` alone leaves it burning
 *    credits until the idle timeout.
 *
 * Invoices are never parsed on the laptop: fixtures and the zip are pushed
 * into the VM and `reconcile.py` runs inside it.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SolariClient } from "@solarisdk/sdk";
import type { NoapiConfig } from "../types.ts";

/* ------------------------------------------------------------------------ */
/* Structural SDK types — the smallest slice of @solarisdk/sdk we use.      */
/* ------------------------------------------------------------------------ */

export interface CommandResultLike {
  stdout: string;
  exitCode: number;
}

/** Minimal structural view of the SDK's Sandbox handle. */
export interface SandboxLike {
  readonly sandboxId: string;
  connect(): Promise<void>;
  commands: {
    run(cmd: string, opts?: { args?: string[] }): Promise<CommandResultLike>;
  };
  files: {
    write(path: string, data: string | Uint8Array): Promise<void>;
    readText(path: string): Promise<string>;
    read(path: string): Promise<Uint8Array>;
  };
  snapshot(name?: string): Promise<string>;
  revert(snapshotId: string): Promise<void>;
  previewUrl(port: number): Promise<{ url: string; token?: string }>;
  kill(): Promise<void>;
}

/** Minimal structural view of the SDK's `SolariClient`. */
export interface SolariClientLike {
  sandboxes: {
    create(opts: { template: string; timeoutMs: number }): Promise<SandboxLike>;
  };
}

/* ------------------------------------------------------------------------ */
/* Public surface interface.                                                */
/* ------------------------------------------------------------------------ */

export interface SandboxStartOptions {
  template?: string;
  /** Rolling idle window, NOT a hard deadline. Default 10 min. */
  timeoutMs?: number;
  /** Heartbeat interval that keeps the idle window alive. 0 disables. */
  heartbeatMs?: number;
}

export interface ReconcileOptions {
  /** Local path to the invoice zip downloaded by the browser surface. */
  zipPath: string;
  /** Local dir containing reconcile.py, ledger.csv, policy.yaml. */
  fixturesDir: string;
  /** In-VM working directory. Default "/work". */
  workdir?: string;
}

export interface ReconcileResult {
  exceptionsCsv: string;
  chartPng: Uint8Array;
  exceptions: number;
}

export interface SandboxSurface {
  start(opts?: SandboxStartOptions): Promise<void>;
  write(path: string, data: string | Uint8Array): Promise<void>;
  readText(path: string): Promise<string>;
  sh(script: string): Promise<{ stdout: string; exitCode: number }>;
  reconcileLedger(opts: ReconcileOptions): Promise<ReconcileResult>;
  snapshot(name?: string): Promise<string>;
  revert(snapshotId: string): Promise<void>;
  previewUrl(port: number): Promise<string>;
  readonly sandboxId: string | null;
  /** Wall seconds between successful start() and dispose(). */
  secondsUsed(): number;
  dispose(): Promise<void>;
}

export interface SandboxDeps {
  /** Injected client for tests; production constructs the real SDK client. */
  client?: SolariClientLike;
  /** Log sink; defaults to console.log. Lowercase, short, grepable lines. */
  logger?: (line: string) => void;
}

const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_HEARTBEAT_MS = 60_000;

/* ------------------------------------------------------------------------ */
/* Implementation.                                                          */
/* ------------------------------------------------------------------------ */

export class SolariSandboxSurface implements SandboxSurface {
  readonly #config: NoapiConfig;
  readonly #deps: SandboxDeps;
  #client: SolariClientLike | null = null;
  #sandbox: SandboxLike | null = null;
  #heartbeat: ReturnType<typeof setInterval> | null = null;
  #startedAt: number | null = null;
  #endedAt: number | null = null;
  #disposed = false;

  constructor(config: NoapiConfig, deps: SandboxDeps = {}) {
    this.#config = config;
    this.#deps = deps;
  }

  async start(opts: SandboxStartOptions = {}): Promise<void> {
    const client = await this.#sdk();
    this.#sandbox = await client.sandboxes.create({
      template: opts.template ?? "base",
      // Rolling IDLE window — it resets on every use, it is not a hard deadline.
      timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
    // Opens the control channel. Needed for files/git/code; commands alone can
    // take a one-shot HTTP path without it.
    await this.#sandbox.connect();
    this.#startedAt = Date.now();
    this.#log(`sandbox.start id=${this.#sandbox.sandboxId}`);

    const heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    if (heartbeatMs > 0) {
      // The idle window resets on every use. Desktop steps can leave the
      // sandbox untouched for minutes, so ping it with the cheapest command
      // that exists instead of letting the VM die mid-run.
      this.#heartbeat = setInterval(() => void this.#beat(), heartbeatMs);
      this.#heartbeat.unref();
    }
  }

  async write(path: string, data: string | Uint8Array): Promise<void> {
    await this.#require().files.write(path, data);
  }

  async readText(path: string): Promise<string> {
    return this.#require().files.readText(path);
  }

  async sh(script: string): Promise<{ stdout: string; exitCode: number }> {
    // `cmd` is NOT shell-interpreted — argv goes in `args`. For pipes, globs
    // or redirection, run a shell explicitly: run("sh", { args: ["-c", "..."] }).
    // Never concatenate a pipeline into run() itself.
    const out = await this.#require().commands.run("sh", { args: ["-c", script] });
    return { stdout: out.stdout, exitCode: out.exitCode };
  }

  async reconcileLedger(opts: ReconcileOptions): Promise<ReconcileResult> {
    const sandbox = this.#require();
    const workdir = opts.workdir ?? "/work";

    // Push inputs into the VM. Reconciliation MUST run inside the sandbox —
    // invoices are never parsed on the laptop.
    const [reconcilePy, ledgerCsv, policyYaml, zipBytes] = await Promise.all([
      readFile(join(opts.fixturesDir, "reconcile.py"), "utf8"),
      readFile(join(opts.fixturesDir, "ledger.csv"), "utf8"),
      readFile(join(opts.fixturesDir, "policy.yaml"), "utf8"),
      readFile(opts.zipPath),
    ]);
    const mkdir = await this.sh(`mkdir -p ${workdir}`);
    if (mkdir.exitCode !== 0) throw new Error(`sandbox.reconcile mkdir failed exit=${mkdir.exitCode}`);
    await sandbox.files.write(`${workdir}/reconcile.py`, reconcilePy);
    await sandbox.files.write(`${workdir}/ledger.csv`, ledgerCsv);
    await sandbox.files.write(`${workdir}/policy.yaml`, policyYaml);
    await sandbox.files.write(`${workdir}/invoices.zip`, zipBytes);

    const extract = await this.sh(`cd ${workdir} && python3 -m zipfile -e invoices.zip invoices/`);
    if (extract.exitCode !== 0) {
      throw new Error(`sandbox.reconcile extract failed exit=${extract.exitCode} stdout=${extract.stdout}`);
    }

    // Direct argv form — no shell needed, so no sh wrapper.
    const run = await sandbox.commands.run("python3", {
      args: [`${workdir}/reconcile.py`, workdir],
    });
    if (run.exitCode !== 0) {
      throw new Error(`sandbox.reconcile failed exit=${run.exitCode} stdout=${run.stdout}`);
    }
    const match = run.stdout.match(/reconcile\.exceptions n=(\d+)/);
    const nStr = match?.[1];
    if (nStr === undefined) {
      throw new Error(`sandbox.reconcile missing exceptions line stdout=${run.stdout}`);
    }
    const exceptions = Number.parseInt(nStr, 10);

    const exceptionsCsv = await sandbox.files.readText(`${workdir}/exceptions.csv`);
    // The SDK exposes files.read(path): Promise<Uint8Array>, so binary
    // artifacts come back directly — no base64-over-sh detour needed.
    const chartPng = await sandbox.files.read(`${workdir}/chart.png`);
    this.#log(`sandbox.reconcile exceptions=${exceptions}`);
    return { exceptionsCsv, chartPng, exceptions };
  }

  async snapshot(name?: string): Promise<string> {
    // Checkpoints the RUNNING session; it keeps running. Returns the id.
    const id = await this.#require().snapshot(name);
    this.#log(`sandbox.snapshot id=${id} name=${name ?? "none"}`);
    return id;
  }

  async revert(snapshotId: string): Promise<void> {
    // Restores this session in place; the sandbox id stays stable.
    await this.#require().revert(snapshotId);
    this.#log(`sandbox.revert id=${snapshotId}`);
  }

  async previewUrl(port: number): Promise<string> {
    // Served from *.preview.getsolari.com, reachable from the open internet.
    const { url } = await this.#require().previewUrl(port);
    this.#log(`sandbox.preview url=${url}`);
    return url;
  }

  get sandboxId(): string | null {
    return this.#sandbox?.sandboxId ?? null;
  }

  secondsUsed(): number {
    if (this.#startedAt === null) return 0;
    const end = this.#endedAt ?? Date.now();
    return (end - this.#startedAt) / 1000;
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    if (this.#heartbeat) {
      clearInterval(this.#heartbeat);
      this.#heartbeat = null;
    }
    const id = this.#sandbox?.sandboxId;
    if (this.#sandbox) {
      // kill() destroys the remote VM. close() alone would only drop your
      // local control channel and leave it running until the idle timeout.
      await this.#sandbox.kill();
    }
    this.#endedAt = Date.now();
    this.#log(`sandbox.disposed id=${id ?? "none"}`);
  }

  /** Supports `await using surface = new SolariSandboxSurface(...)` (Node 22+). */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.dispose();
  }

  /* -- internals --------------------------------------------------------- */

  async #beat(): Promise<void> {
    try {
      await this.#sandbox?.commands.run("true");
      this.#log("sandbox.heartbeat ok");
    } catch {
      // A failed heartbeat is not fatal — the next tick retries.
      this.#log("sandbox.heartbeat fail");
    }
  }

  #require(): SandboxLike {
    if (!this.#sandbox) throw new Error("sandbox action called before start()");
    return this.#sandbox;
  }

  async #sdk(): Promise<SolariClientLike> {
    if (this.#client) return this.#client;
    if (this.#deps.client) {
      this.#client = this.#deps.client;
    } else {
      // Production path only; tests always inject a fake. The real handle is
      // structurally compatible with SandboxLike (it has more methods, which
      // is fine), so the cast stays here at the SDK edge.
      const { SolariClient } = await import("@solarisdk/sdk");
      const client: SolariClient = new SolariClient({ apiKey: this.#config.solariApiKey });
      this.#client = client as unknown as SolariClientLike;
    }
    return this.#client;
  }

  #log(line: string): void {
    (this.#deps.logger ?? console.log)(line);
  }
}

/** Run `fn` against a started sandbox surface, disposing in `finally`. */
export async function withSandbox<T>(
  config: NoapiConfig,
  opts: SandboxStartOptions,
  fn: (surface: SandboxSurface) => Promise<T>,
  deps: SandboxDeps = {},
): Promise<T> {
  const surface = new SolariSandboxSurface(config, deps);
  await surface.start(opts);
  try {
    return await fn(surface);
  } finally {
    await surface.dispose();
  }
}

/**
 * Sandbox surface tests — node:test, no network, no real SDK.
 *
 * Fakes record every call so we can assert the cookbook rules structurally:
 * argv-form commands (run("sh", { args: ["-c", ...] })), heartbeat keeping the
 * rolling idle window alive, in-VM reconciliation (zip extracted by python,
 * never parsed on the laptop), snapshot/revert/preview pass-throughs, and a
 * dispose that calls kill() exactly once.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  SolariSandboxSurface,
  type CommandResultLike,
  type SandboxLike,
  type SolariClientLike,
} from "../src/surfaces/sandbox.ts";
import type { NoapiConfig } from "../src/types.ts";

/* ------------------------------------------------------------------------ */
/* Fakes.                                                                    */
/* ------------------------------------------------------------------------ */

function config(overrides: Partial<NoapiConfig> = {}): NoapiConfig {
  return {
    solariApiKey: "slr_test_fake",
    portalOrigin: "http://127.0.0.1:8787",
    portalUser: "reviewer@getsolari.com",
    portalPassword: "reviewer",
    plan: "free",
    ...overrides,
  };
}

interface RunCall {
  cmd: string;
  args?: string[];
}

class FakeSandbox implements SandboxLike {
  readonly sandboxId = "sbx-1";
  connectCalls = 0;
  runCalls: RunCall[] = [];
  /** Programmable command results keyed on cmd, or a default. */
  runResults = new Map<string, CommandResultLike>();
  defaultRunResult: CommandResultLike = { stdout: "", exitCode: 0 };
  writes: { path: string; data: string | Uint8Array }[] = [];
  textFiles = new Map<string, string>();
  binaryFiles = new Map<string, Uint8Array>();
  snapshotCalls: (string | undefined)[] = [];
  revertCalls: string[] = [];
  previewCalls: number[] = [];
  killCalls = 0;

  async connect(): Promise<void> {
    this.connectCalls += 1;
  }

  readonly commands = {
    run: async (cmd: string, opts?: { args?: string[] }): Promise<CommandResultLike> => {
      this.runCalls.push({ cmd, args: opts?.args });
      return this.runResults.get(cmd) ?? this.defaultRunResult;
    },
  };

  readonly files = {
    write: async (path: string, data: string | Uint8Array): Promise<void> => {
      this.writes.push({ path, data });
    },
    readText: async (path: string): Promise<string> => {
      const v = this.textFiles.get(path);
      if (v === undefined) throw new Error(`no such text file: ${path}`);
      return v;
    },
    read: async (path: string): Promise<Uint8Array> => {
      const v = this.binaryFiles.get(path);
      if (v === undefined) throw new Error(`no such binary file: ${path}`);
      return v;
    },
  };

  async snapshot(name?: string): Promise<string> {
    this.snapshotCalls.push(name);
    return `snap-${this.snapshotCalls.length}`;
  }

  async revert(snapshotId: string): Promise<void> {
    this.revertCalls.push(snapshotId);
  }

  async previewUrl(port: number): Promise<{ url: string; token?: string }> {
    this.previewCalls.push(port);
    return { url: `https://sbx-1-${port}.preview.getsolari.com` };
  }

  async kill(): Promise<void> {
    this.killCalls += 1;
  }
}

class FakeClient implements SolariClientLike {
  createCalls: { template: string; timeoutMs: number }[] = [];
  readonly sandbox = new FakeSandbox();

  readonly sandboxes = {
    create: async (opts: { template: string; timeoutMs: number }): Promise<SandboxLike> => {
      this.createCalls.push(opts);
      return this.sandbox;
    },
  };
}

function harness(cfg = config()) {
  const client = new FakeClient();
  const logs: string[] = [];
  const surface = new SolariSandboxSurface(cfg, { client, logger: (line) => logs.push(line) });
  return { client, sandbox: client.sandbox, logs, surface };
}

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), "noapi-sandbox-test-"));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/* ------------------------------------------------------------------------ */
/* Tests.                                                                    */
/* ------------------------------------------------------------------------ */

test("start creates a base sandbox with a rolling idle window and connects", async () => {
  const { client, sandbox, surface } = harness();
  await surface.start({ heartbeatMs: 0 });
  assert.deepEqual(client.createCalls, [{ template: "base", timeoutMs: 10 * 60_000 }]);
  assert.equal(sandbox.connectCalls, 1);
  assert.equal(surface.sandboxId, "sbx-1");
  assert.ok(surface.secondsUsed() >= 0);
  await surface.dispose();
});

test("sh() uses the cookbook argv form: run('sh', { args: ['-c', script] })", async () => {
  const { sandbox, surface } = harness();
  sandbox.runResults.set("sh", { stdout: "total 4\n", exitCode: 0 });
  await surface.start({ heartbeatMs: 0 });
  const out = await surface.sh("cd /work && ls -la | head");
  assert.deepEqual(out, { stdout: "total 4\n", exitCode: 0 });
  assert.deepEqual(sandbox.runCalls, [{ cmd: "sh", args: ["-c", "cd /work && ls -la | head"] }]);
  await surface.dispose();
});

test("heartbeat keeps the rolling idle window alive and stops on dispose", async () => {
  const { sandbox, logs, surface } = harness();
  await surface.start({ heartbeatMs: 20 });
  await sleep(75);
  const beatsBeforeDispose = sandbox.runCalls.filter((c) => c.cmd === "true").length;
  assert.ok(beatsBeforeDispose >= 2, `expected >=2 heartbeats, got ${beatsBeforeDispose}`);
  assert.ok(logs.some((l) => l === "sandbox.heartbeat ok"));
  await surface.dispose();
  await sleep(60);
  const beatsAfterDispose = sandbox.runCalls.filter((c) => c.cmd === "true").length;
  assert.equal(beatsAfterDispose, beatsBeforeDispose);
});

test("snapshot, revert, and previewUrl pass through with logs", async () => {
  const { sandbox, logs, surface } = harness();
  await surface.start({ heartbeatMs: 0 });
  const id = await surface.snapshot("after-reconcile");
  assert.equal(id, "snap-1");
  assert.deepEqual(sandbox.snapshotCalls, ["after-reconcile"]);
  assert.ok(logs.some((l) => l === "sandbox.snapshot id=snap-1 name=after-reconcile"));
  await surface.revert("snap-1");
  assert.deepEqual(sandbox.revertCalls, ["snap-1"]);
  assert.ok(logs.some((l) => l === "sandbox.revert id=snap-1"));
  const url = await surface.previewUrl(3000);
  assert.equal(url, "https://sbx-1-3000.preview.getsolari.com");
  assert.deepEqual(sandbox.previewCalls, [3000]);
  assert.ok(logs.some((l) => l.startsWith("sandbox.preview url=")));
  await surface.dispose();
});

test("reconcileLedger runs entirely inside the sandbox", async () => {
  const dir = await tmp();
  try {
    // Local inputs: fixtures + the invoice zip the browser surface downloaded.
    await writeFile(join(dir, "reconcile.py"), "print('stub')\n");
    await writeFile(join(dir, "ledger.csv"), "id,amount\n1,10\n");
    await writeFile(join(dir, "policy.yaml"), "tolerance: 0.01\n");
    await writeFile(join(dir, "invoices.zip"), new Uint8Array([0x50, 0x4b, 0x03, 0x04]));

    const { sandbox, logs, surface } = harness();
    sandbox.runResults.set("python3", { stdout: "reconcile.exceptions n=2\n", exitCode: 0 });
    sandbox.textFiles.set("/work/exceptions.csv", "invoice,expected,actual\nINV-2,10,12\nINV-5,7,6\n");
    sandbox.binaryFiles.set("/work/chart.png", new Uint8Array([0x89, 0x50, 0x4e, 0x47]));

    await surface.start({ heartbeatMs: 0 });
    const result = await surface.reconcileLedger({ zipPath: join(dir, "invoices.zip"), fixturesDir: dir });

    assert.equal(result.exceptions, 2);
    assert.ok(result.exceptionsCsv.includes("INV-2"));
    assert.deepEqual([...result.chartPng], [0x89, 0x50, 0x4e, 0x47]);

    // Fixtures and zip were pushed into the VM.
    const written = sandbox.writes.map((w) => w.path);
    assert.deepEqual(written, [
      "/work/reconcile.py",
      "/work/ledger.csv",
      "/work/policy.yaml",
      "/work/invoices.zip",
    ]);

    // Extraction happened in-VM via python's zipfile module (sh argv form).
    const extractCall = sandbox.runCalls.find((c) => c.cmd === "sh" && c.args?.[1]?.includes("zipfile"));
    assert.ok(extractCall, "expected a zipfile extraction via sh");
    assert.deepEqual(extractCall.args, [
      "-c",
      "cd /work && python3 -m zipfile -e invoices.zip invoices/",
    ]);

    // reconcile.py ran with direct argv — never concatenated into a shell.
    const pyCall = sandbox.runCalls.find((c) => c.cmd === "python3");
    assert.deepEqual(pyCall, { cmd: "python3", args: ["/work/reconcile.py", "/work"] });

    // The laptop never parsed invoices: no read of the zip back, no local csv.
    assert.ok(logs.some((l) => l === "sandbox.reconcile exceptions=2"));
    await surface.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("reconcileLedger throws with stdout when reconcile.py exits non-zero", async () => {
  const dir = await tmp();
  try {
    await writeFile(join(dir, "reconcile.py"), "raise SystemExit(1)\n");
    await writeFile(join(dir, "ledger.csv"), "id,amount\n");
    await writeFile(join(dir, "policy.yaml"), "tolerance: 0.01\n");
    await writeFile(join(dir, "invoices.zip"), new Uint8Array([0x50, 0x4b]));

    const { sandbox, surface } = harness();
    sandbox.runResults.set("python3", { stdout: "boom: ledger empty", exitCode: 1 });
    await surface.start({ heartbeatMs: 0 });
    await assert.rejects(
      () => surface.reconcileLedger({ zipPath: join(dir, "invoices.zip"), fixturesDir: dir }),
      /sandbox\.reconcile failed exit=1 stdout=boom: ledger empty/,
    );
    await surface.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("dispose kills the VM exactly once and is idempotent", async () => {
  const { sandbox, logs, surface } = harness();
  await surface.start({ heartbeatMs: 0 });
  await surface.dispose();
  await surface.dispose();
  assert.equal(sandbox.killCalls, 1);
  assert.ok(logs.some((l) => l === "sandbox.disposed id=sbx-1"));
});

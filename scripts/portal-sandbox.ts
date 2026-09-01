/**
 * Portal-in-sandbox — the deterministic twin world, served by Solari.
 *
 * The cloud browser cannot reach `127.0.0.1` on this machine, so for live
 * runs the portal is deployed into a sandbox and exposed on a public
 * `*.preview.getsolari.com` URL (`sandbox.previewUrl`, cookbook:
 * examples/sandbox-port-preview-ts). That URL becomes NOAPI_PORTAL_ORIGIN
 * for the run — browser, portal, and reconciliation all live in Solari.
 *
 * Usage:
 *   node scripts/portal-sandbox.ts [url-file]
 *
 * Prints `portal.sandbox url=<previewUrl>` and keeps the sandbox alive with
 * a heartbeat (rolling idle window) until SIGINT/SIGTERM, then kills it —
 * kill() destroys the VM; close() alone leaves it billing.
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { loadDotEnv } from "../src/config.ts";
import { portalUrl } from "../src/portal-url.ts";
import { buildPortalJs } from "./build-portal-js.ts";

const PORTAL_PORT = 8787;
const HEARTBEAT_MS = 60_000;

loadDotEnv();
const apiKey = process.env.SOLARI_API_KEY ?? "";
if (!apiKey) {
  console.error("portal.sandbox: SOLARI_API_KEY not set");
  process.exit(2);
}

const urlFile = process.argv[2];
const buildDir = buildPortalJs();

const { SolariClient } = await import("@solarisdk/sdk");
const pt = new SolariClient({ apiKey });

const sandbox = await pt.sandboxes.create({
  template: "base",
  // Rolling IDLE window — resets on every use; the heartbeat holds it open.
  timeoutMs: 15 * 60_000,
});
console.log(`portal.sandbox id=${sandbox.sandboxId}`);

const heartbeat = setInterval(() => {
  sandbox.commands.run("true").catch(() => {});
}, HEARTBEAT_MS);

async function shutdown(code: number): Promise<never> {
  clearInterval(heartbeat);
  await sandbox.kill().catch(() => {});
  console.log("portal.sandbox killed");
  process.exit(code);
}
process.on("SIGINT", () => void shutdown(0));
process.on("SIGTERM", () => void shutdown(0));

try {
  await sandbox.connect();

  // Ship the transpiled portal preserving the layout zip.js expects.
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.push(full);
    }
  };
  walk(buildDir);
  await sandbox.commands.run("sh", { args: ["-c", "mkdir -p /app/apps/portal /app/fixtures/invoices"] });
  for (const file of files) {
    const dest = join("/app", relative(buildDir, file));
    await sandbox.files.write(dest, readFileSync(file));
  }
  console.log(`portal.sandbox deployed files=${files.length}`);

  // commands.run waits for exit — background the server with nohup (cookbook).
  // Host must be 0.0.0.0: the preview gateway is not on the VM's loopback.
  await sandbox.commands.run("sh", {
    args: ["-c", `cd /app && NOAPI_PORTAL_HOST=0.0.0.0 PORT=${PORTAL_PORT} nohup node apps/portal/server.js > /app/portal.log 2>&1 &`],
  });

  const { url } = await sandbox.previewUrl(PORTAL_PORT);
  // The server takes a moment; poll before declaring it up (cookbook pattern).
  // portalUrl keeps the gateway's pt_token query on the request — without it
  // the preview gateway 401s.
  let up = false;
  for (let i = 0; i < 30 && !up; i++) {
    try {
      const res = await fetch(portalUrl(url, "/login"));
      up = res.status === 200;
    } catch {
      /* not yet */
    }
    if (!up) await new Promise((r) => setTimeout(r, 1000));
  }
  if (!up) {
    const log = await sandbox.commands.run("sh", { args: ["-c", "cat /app/portal.log"] });
    throw new Error(`portal did not answer on the preview URL after 30s — portal.log: ${log.stdout.trim()}`);
  }

  console.log(`portal.sandbox url=${url}`);
  if (urlFile) writeFileSync(urlFile, url + "\n");
} catch (err) {
  console.error(`portal.sandbox failed: ${(err as Error).message}`);
  await shutdown(1);
}

/**
 * Debug the preview-URL path end to end: deploy portal, verify it answers
 * INSIDE the VM, then fetch the preview URL from here with the real error.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { loadDotEnv } from "../src/config.ts";
import { buildPortalJs } from "./build-portal-js.ts";

loadDotEnv();
const apiKey = process.env.SOLARI_API_KEY ?? "";
if (!apiKey) process.exit(2);

const buildDir = buildPortalJs();
const { SolariClient } = await import("@solarisdk/sdk");
const pt = new SolariClient({ apiKey });
const sandbox = await pt.sandboxes.create({ template: "base", timeoutMs: 10 * 60_000 });
console.log(`debug.sandbox id=${sandbox.sandboxId}`);

try {
  await sandbox.connect();
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else files.push(full);
    }
  };
  walk(buildDir);
  await sandbox.commands.run("sh", { args: ["-c", "mkdir -p /app/apps/portal /app/fixtures/invoices"] });
  for (const f of files) await sandbox.files.write(join("/app", relative(buildDir, f)), readFileSync(f));

  await sandbox.commands.run("sh", {
    args: ["-c", "cd /app && NOAPI_PORTAL_HOST=0.0.0.0 PORT=8787 nohup node apps/portal/server.js > /app/portal.log 2>&1 &"],
  });
  await new Promise((r) => setTimeout(r, 2000));

  // 1. Does it answer inside the VM?
  const inside = await sandbox.commands.run("sh", {
    args: ["-c", "node -e 'fetch(\"http://127.0.0.1:8787/login\").then(r=>console.log(\"in-vm status\",r.status)).catch(e=>console.log(\"in-vm error\",e.message))'"],
  });
  console.log(`debug.invm ${inside.stdout.trim()} ${inside.stderr.trim()}`);
  const listen = await sandbox.commands.run("sh", {
    args: ["-c", "cat /proc/net/tcp | awk 'NR>1 {print $2}' | grep -i 2242 || echo 'no listener on 0x2242 (8787)'; cat /app/portal.log"],
  });
  console.log(`debug.listen ${listen.stdout.trim()}`);

  // 2. Preview URL from here — path must go BEFORE the ?pt_token query.
  const { url } = await sandbox.previewUrl(8787);
  console.log(`debug.preview url=${url}`);
  const joinPreview = (base: string, path: string): string => {
    const u = new URL(base);
    return `${u.origin}${path}${u.search}`;
  };
  const first = await fetch(joinPreview(url, "/login"));
  console.log(`debug.joined status=${first.status} set-cookie=${first.headers.get("set-cookie") ?? "none"}`);
  // Does the gateway cookie alone (no token) satisfy later requests?
  const gwCookie = (first.headers.get("set-cookie") ?? "").split(";")[0];
  if (gwCookie) {
    const second = await fetch(`${new URL(url).origin}/login`, { headers: { cookie: gwCookie } });
    console.log(`debug.cookie-only status=${second.status}`);
  }
} finally {
  await sandbox.kill();
  console.log("debug.killed");
}

/**
 * Probe the `base` sandbox template: does it ship node, and which version?
 * One cheap create/run/kill cycle. Used to decide how the portal is deployed
 * into a sandbox for `previewUrl` exposure.
 */
import { loadDotEnv } from "../src/config.ts";

loadDotEnv();
const apiKey = process.env.SOLARI_API_KEY ?? "";
if (!apiKey) {
  console.error("probe: SOLARI_API_KEY not set");
  process.exit(2);
}

const { SolariClient } = await import("@solarisdk/sdk");
const pt = new SolariClient({ apiKey });

const sb = await pt.sandboxes.create({ template: "base", timeoutMs: 3 * 60_000 });
console.log(`probe.sandbox id=${sb.sandboxId}`);
try {
  await sb.connect();
  // argv rule: `command` is a shell builtin, not a binary — go through sh.
  const r = await sb.commands.run("sh", {
    args: ["-c", "echo node=$(command -v node || echo MISSING); node --version 2>/dev/null; echo python3=$(command -v python3 || echo MISSING); python3 --version 2>/dev/null; echo npm=$(command -v npm || echo MISSING)"],
  });
  console.log(r.stdout.trim());
} finally {
  await sb.kill(); // kill() destroys the VM; close() alone leaves it billing
  console.log("probe.killed");
}

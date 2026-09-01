/**
 * Debug the `default` desktop template: is LibreOffice there, and under what
 * name? One cheap create/exec/destroy cycle.
 */
import { loadDotEnv } from "../src/config.ts";

loadDotEnv();
const apiKey = process.env.SOLARI_API_KEY ?? "";
if (!apiKey) process.exit(2);

const { DesktopClient } = await import("@solarisdk/desktop");
const client = new DesktopClient({ apiKey, baseUrl: "https://api.getsolari.com" });

const desktop = await client.create({ template: "default", resolution: "1280x720", timeoutMs: 5 * 60_000 });
console.log(`debug.desktop session=${desktop.sessionId}`);
try {
  await desktop.connect();
  for (let i = 0; i < 30; i++) {
    const h = await desktop.health();
    if (h.ready) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  const probe = await desktop.exec("sh", {
    args: ["-c", "echo '-- command -v:'; command -v soffice libreoffice localc ooffice; echo '-- grep /usr/bin:'; ls /usr/bin | grep -iE 'office|calc|writer' || echo none; echo '-- /usr/lib:'; ls -d /usr/lib/libreoffice* /opt/libreoffice* 2>/dev/null || echo none; echo '-- apt:'; (dpkg -l 2>/dev/null | grep -i libre | head -5) || echo none"],
  });
  console.log(probe.stdout);
  console.log(`debug.probe exit=${probe.exitCode} stderr=${probe.stderr.trim()}`);

  // Does open() resolve the app by name regardless of PATH?
  try {
    const pid = await desktop.open("libreoffice");
    console.log(`debug.open libreoffice pid=${pid}`);
  } catch (err) {
    console.log(`debug.open libreoffice failed: ${(err as Error).message}`);
  }
} finally {
  await desktop.close();
  await client.destroy(desktop.sessionId);
  console.log("debug.destroyed");
}

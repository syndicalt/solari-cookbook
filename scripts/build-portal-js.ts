/**
 * Build the portal for the sandbox `base` template (node 18 — no TS).
 *
 * Transpiles `apps/portal/*.ts` to plain ESM JS with the TypeScript compiler
 * API (already a devDependency — no new deps), rewrites `.ts` import
 * specifiers to `.js`, and copies the invoice fixtures, preserving the
 * relative layout that `zip.ts`'s DEFAULT_INVOICES_DIR expects:
 *
 *   build/portal-js/apps/portal/{server,selectors,zip}.js
 *   build/portal-js/fixtures/invoices/*.txt
 *   build/portal-js/package.json          ("type": "module" for node 18)
 *
 * The sandbox `base` image ships node 18 (probed 2026-09), which cannot
 * strip types; the sources are erasable-syntax-only, so transpileModule
 * output is byte-for-byte runnable.
 */
import { transpileModule, ModuleKind, ScriptTarget } from "typescript";
import { mkdirSync, readFileSync, writeFileSync, copyFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const SRC_DIR = "apps/portal";
const OUT_DIR = "build/portal-js";
const MODULES = ["server", "selectors", "zip"];

/** Transpile the portal to sandbox-ready JS. Returns the output dir. */
export function buildPortalJs(outDir: string = OUT_DIR): string {
  const moduleOut = join(outDir, "apps/portal");
  const invoicesOut = join(outDir, "fixtures/invoices");
  mkdirSync(moduleOut, { recursive: true });
  mkdirSync(invoicesOut, { recursive: true });

  for (const name of MODULES) {
    const src = readFileSync(join(SRC_DIR, `${name}.ts`), "utf8");
    const { outputText } = transpileModule(src, {
      compilerOptions: { module: ModuleKind.ES2022, target: ScriptTarget.ES2022 },
      fileName: `${name}.ts`,
    });
    // Node resolves specifiers literally: `./zip.ts` must become `./zip.js`.
    const js = outputText.replace(/(from\s+["']\.\/[a-z-]+)\.ts(["'])/g, "$1.js$2");
    writeFileSync(join(moduleOut, `${name}.js`), js);
  }

  for (const file of readdirSync("fixtures/invoices")) {
    copyFileSync(join("fixtures/invoices", file), join(invoicesOut, file));
  }
  writeFileSync(join(outDir, "package.json"), JSON.stringify({ type: "module" }) + "\n");
  return outDir;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const dir = buildPortalJs();
  console.log(`build.portal dir=${dir}`);
}

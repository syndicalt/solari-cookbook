/**
 * noapi CLI.
 *
 *   node src/cli.ts doctor                     cheapest live launch + dispose
 *   node src/cli.ts run <scenario.json>        run a scenario through the conductor
 *   node src/cli.ts run ... --dry              validate + plan only, no Solari calls
 *
 * One command, one key. The CLI parses arguments and hands off; all behavior
 * lives in `src/conductor.ts`, `src/doctor.ts`, and the surfaces.
 */
import { parseArgs } from "node:util";
import { loadDotEnv, resolveConfig, describe, hasSolariKey } from "./config.ts";
import { loadScenario } from "./planner/static.ts";
import { doctorMain } from "./doctor.ts";

const USAGE = `noapi — finish work where there is no API

usage:
  noapi doctor                        cheapest real launch + clean dispose
  noapi run <scenario.json> [--dry]   run a scenario (default: scenarios/vendor-close.json)

env:
  SOLARI_API_KEY        slr_live_... from https://console.getsolari.com
  NOAPI_PORTAL_ORIGIN   fake vendor portal origin (default http://127.0.0.1:8787)

no key? run \`make demo-offline\` — portal + fixtures only, no Solari.`;

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  loadDotEnv();

  switch (command) {
    case "doctor":
      return doctorMain();

    case "run": {
      const { values, positionals } = parseArgs({
        args: rest,
        options: { dry: { type: "boolean", default: false } },
        allowPositionals: true,
      });
      const scenarioPath = positionals[0] ?? "scenarios/vendor-close.json";
      const scenario = loadScenario(scenarioPath);
      const config = resolveConfig();
      console.log(`run.start scenario=${scenario.id} ${describe(config)}`);

      if (values.dry) {
        console.log(`run.dry steps=${scenario.steps.length} predicates=${scenario.success.length} budget=$${scenario.budgetUsd}`);
        return 0;
      }
      if (!hasSolariKey(config)) {
        console.error("run: SOLARI_API_KEY is not set — refusing to fake a Solari run.");
        console.error("run: use `make demo-offline` for the portal + fixtures path without a key.");
        return 2;
      }

      const { runScenario } = await import("./conductor.ts");
      const report = await runScenario(scenario, config);
      console.log(`run.done ok=${report.ok} cost=$${report.costUsdEstimate.toFixed(4)} rewinds=${report.rewinds} wall=${(report.wallMs / 1000).toFixed(1)}s`);
      return report.ok ? 0 : 1;
    }

    default:
      console.error(USAGE);
      return command === undefined || command === "help" || command === "--help" ? 0 : 2;
  }
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    console.error(`noapi: ${(err as Error).message}`);
    process.exitCode = 1;
  });

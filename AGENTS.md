# AGENTS.md — NOAPI

You are building **NOAPI**: a reliability-first conductor that treats Solari cloud **browser**, **sandbox**, and **desktop** as one machine. The job is the Pinetree / Solari intern challenge. The spec is `NOAPI-implementation-plan.md`. This file is the operating contract. Follow it over improvisation.

Kimi K3 notes: thinking is always on — spend it on architecture and failure modes, then ship small diffs. You have native vision — use it on desktop screenshots. You have a 1M window — do **not** paste the whole spec into every file. Read a file when you need it. You hallucinate APIs under time pressure; the Solari SDK is real and small — **read the cookbook before you type a call**.

---

## What you are making

One CLI:

```bash
export SOLARI_API_KEY=slr_live_...
make demo          # vendor-close across all three surfaces
make demo-offline  # portal + fixtures only, no Solari
make doctor        # cheapest real launch + clean dispose
make demo-flaky    # forced desktop focus-miss, then rewind
```

Default scenario: **monthly vendor close**. Browser pulls invoices from **our** fake portal → sandbox reconciles and snapshots → desktop formats the pack in LibreOffice → browser uploads PDF → `eval.json` decides success.

A run is not done until `artifacts/<runId>/eval.json` is green and every Solari session is disposed.

Five reviewer questions that must all be yes:

1. All three Solari surfaces in one workflow?
2. Work that has no clean API (LibreOffice is the punchline)?
3. Reliability is a subsystem (rewind, eval, audit), not `try/except`?
4. Can a human watch it (VNC `streamUrl` + rrweb + screenshots)?
5. One command + one key reruns it?

---

## Sources of truth (read before inventing)

| Need | Open this |
|---|---|
| Product / phases / extras | `NOAPI-implementation-plan.md` |
| Exact SDK calls, gotchas | `vendor/solari-cookbook/examples/**` or `/tmp/solari-cookbook/examples/**` |
| Official docs | https://docs.getsolari.com |
| Prices for `budget.ts` | https://docs.getsolari.com/pricing |
| This contract | `AGENTS.md` |

Never invent `solari.*` methods. If the cookbook and docs disagree, cookbook examples win for v0. Copy their comments on `close()` / `kill()` / recording into our wrappers.

Cookbook map you must implement against:

- Browser launch/close: `examples/browser-quickstart-ts`
- Stealth / proxy: `examples/browser-stealth-proxy-ts`
- Profiles: `examples/browser-profiles-ts`
- Recording + replay poll (~30s): `examples/browser-session-recording-py`
- Sandbox commands/files: `examples/sandbox-quickstart-ts`
- Stateful kernel: `examples/sandbox-code-interpreter-py`
- `previewUrl`: `examples/sandbox-port-preview-ts`
- Desktop screenshot/click/type/open/destroy: `examples/desktop-computer-use-py`

---

## Always / ask / never

### Always

- Work **one phase at a time** (below). Announce the phase, list files you will touch, implement, verify, stop.
- Wrap every Solari resource in `try/finally` (or `await using` on Node 22+).
- Call `await browser.close()` **and** `await solari.close()`. Skip the second and the process hangs — instant reject.
- End sandboxes with `kill()`, not only `close()`.
- End desktops with `destroy(sessionId)`, not only `close()`.
- Pass `recording: true` on any scored browser session. Poll replay ~30s. No flag → replay 404s forever.
- Sandbox commands are argv. Use `commands.run("ls", { args: ["-la"] })` or `sh -c`. Never `run("ls -la")`.
- Treat `timeoutMs` as a **rolling idle window**. Heartbeat live sessions during long steps.
- After every desktop click/type: screenshot, then confirm focus. **Do not click screen center.** Cookbook: Mousepad/Calc open top-left; (640,360) on 1280x720 hits the window behind and types into the void.
- Persist browser profiles with an explicit `profiles.save`. Attach ≠ autosave.
- Write `artifacts/<runId>/journal.ndjson` as the run happens.
- Hash artifacts into `MANIFEST.sha256`.
- Estimate cost with the public price list. Refuse the next surface if projected cost > `scenario.budgetUsd`.
- Keep secrets out of git. Only `.env.example`. Never print a live key.
- Prefer small, compiling files over one 2k-line `index.ts`.
- After a surface lands, run the narrowest check that can fail (`make doctor`, portal contract test, `tsc --noEmit`).

### Ask first

- Turning on the LLM planner (`src/planner/llm.ts`). Default is the static JSON planner.
- Hitting any live third-party site (banks, EHR, real vendors).
- Adding a new runtime language or agent framework (LangGraph, Crew, etc.).
- Spending paid Solari credits on anything other than `doctor` / `demo` / `demo-flaky`.
- Shipping stretch extras before Phase 4 is green (time-travel UI, `SIGHUMAN`, second scenario, snapshot algebra).

### Never

- Fake a passing Solari run. If there is no key, run `make demo-offline` and say so.
- Leave VMs/browsers alive on exception. Register disposers on `process` exit too.
- Build a chat UI, “agent applies to this job,” crypto, or a multi-cloud abstraction.
- Depend on Playwright/Puppeteer installed separately if the Solari SDK already ships the client — match the cookbook.
- Commit `artifacts/`, `recordings/`, `.env`, or session recordings.
- Drive the scored demo with an LLM. AI is for **writing the code**, not steering the only run reviewers watch.
- Silent desktop input. No screenshot after a click is a bug.
- Rewrite this file or the implementation plan unless the user asked.

---

## Target tree

```text
noapi/
  AGENTS.md
  NOAPI-implementation-plan.md
  README.md
  docs/REVIEWER.md
  Makefile
  package.json
  pyproject.toml
  .env.example
  scenarios/vendor-close.json
  fixtures/{ledger.csv,policy.yaml,reconcile.py,invoices/}
  apps/portal/                 # fake vendor site
  apps/dashboard/              # static run viewer
  src/
    cli.ts
    conductor.ts
    journal.ts
    budget.ts
    types.ts
    surfaces/{browser.ts,sandbox.ts,desktop.ts}
    rewind/{snapshots.ts,replays.ts}
    eval/{predicates.ts,score.ts}
    planner/static.ts          # v0
    planner/llm.ts             # exists, off
  python/{desktop_sidecar.py,libreoffice_ops.py,ocr_probe.py}
  vendor/solari-cookbook/      # submodule or vendored examples
```

Node 22+ owns conductor, browser, sandbox, CLI, portal.  
Python 3.11+ owns the desktop sidecar (`solari_desktop`) unless you first prove `@solarisdk/desktop` covers `open` / click / type / screenshot / `streamUrl` / `destroy`. If it does, delete the sidecar and stay on TS. Probe; do not guess.

---

## Phase gates

Do not start phase N+1 until the exit check for N is green. If you are unsure where the repo is, inspect the tree and resume the first incomplete phase.

| Phase | Build | Exit check |
|---|---|---|
| **0 Physics** | repo, Makefile, `.env.example`, disposer helpers, cookbook pointer, `src` stubs | `make doctor` with a key launches the cheapest browser, prints session id, exits 0 (no hang). Without a key, doctor exits 2 with a clear message |
| **1 Twin world** | portal login / invoices zip / PDF upload; seeded ledger that disagrees on **two** invoices; sha256 goldens | `make demo-offline` closes the books with curl only. No Solari |
| **2 Three surfaces** | scripted happy path: browser pull → sandbox reconcile + snapshot → desktop LibreOffice + proof shot → browser upload → dispose all | `make demo` writes artifacts and prints `streamUrl`. Eval may still be manual |
| **3 Conductor** | scenario JSON, journal, predicates, budget, rewind on focus-miss | `make demo` writes green `eval.json`. `make demo-flaky` shows `rewinds >= 1` and still passes |
| **4 Reviewer pack** | README, GIF slot, `docs/REVIEWER.md`, cost line, cookbook mapping, mermaid | A stranger can judge the repo in three minutes |
| **5 One extra** | pick exactly one from the plan §6.4–6.7 | Only after Phase 4 |

Stop at 4 unless the user asks for 5.

---

## Coding rules

- TypeScript strict. No `any` except at SDK edges, and comment why.
- Named exports. One concept per file.
- Logs: lowercase, short, grepable (`step.start login surface=browser`). No “I have successfully…”.
- IDs: ulid for runs.
- Scenario schema is the API. Actions are functions in surfaces, not a pile of conditionals in `cli.ts`.
- Reconciliation **runs inside the sandbox**. `files.write` `fixtures/reconcile.py`; do not parse invoices on the laptop.
- Portal selectors live in one module shared by portal and browser surface so they cannot drift.
- Desktop LibreOffice: probe binary with `command -v` / cookbook `exec(["-v", name])`. If GUI `open()` fails, fallback `soffice --headless --convert-to pdf` **and still** open the PDF on the desktop for the proof screenshot. Headless-only is a cookbook remix and loses the VNC bookmark.
- Free-plan degrade: no stealth/proxy/captcha; one sandbox so dashboard preview may be local HTML. Detect plan on first error and continue.
- Focus sentinel (v0 is allowed to be dumb): type `NOAPI_FOCUS_OK`, screenshot, confirm, undo. Use vision on that PNG before you reach for a bigger model.
- Tests: Node test runner for portal contract + predicate unit tests. No Jest cathedral.

---

## Verification protocol

After every non-trivial change:

1. `npx tsc --noEmit` (once `package.json` exists).
2. Relevant make target (`doctor` / `demo-offline` / unit tests).
3. Grep your diff for `run("ls` , `.close()` without `solari.close`, desktop clicks without a following `screenshot`.
4. If you touched desktop flow and have a PNG, **look at the image**. If the typed text is not in the document, it is a focus miss — fix coordinates, do not “assume it worked.”
5. Report what you could not run (no key, no network, API 402). Never imply it passed.

Definition of a green demo run:

- `eval.json` `"ok": true`
- `exceptions.csv` exists and has ≥1 data row
- `close-pack.pdf` exists
- portal `/close/last` accepted the upload
- at least one desktop PNG whose bytes you inspected
- journal shows matching `step.ok` for login, pull, reconcile, format, file
- process exits by itself (no hung event loop)
- no live Solari sessions left

---

## Session protocol (how to spend a long-horizon turn)

1. State the phase and the exit check.
2. Read only the spec sections + cookbook files needed for that phase.
3. Touch the minimum file set. Prefer new files over editing five at once.
4. Implement until the exit check is reachable, not until the whole product exists.
5. Run verification. Paste command + last lines of output, not a novel.
6. If blocked on a missing Solari API (snapshots-from-id, desktop TS SDK), implement the fallback flagged in the plan (rewind from cached `/work` files; Python sidecar) and leave a `TODO(solari-api)` comment with the doc URL. Do not stall the phase.
7. Stop. Do not start the next phase in the same breath unless the user said “keep going.”

When debugging Solari:

- Print `session id`, `streamUrl`, `previewUrl` immediately after create.
- On failure, destroy first, then diagnose. Credits are the budget.
- Recording upload is async after release — wait before declaring replay dead.

---

## Quality bar for this challenge

Reviewers work at the company that wrote the cookbook. They will smell:

- hung Node processes → you skipped `solari.close()`
- 404 replay → you skipped `recording: true`
- empty LibreOffice doc → you clicked the wallpaper
- invoices parsed on localhost → you did not use the sandbox
- LangGraph + 12 files of abstractions, no VNC → you built a framework, not a use case

Optimize for a 20-second VNC clip and a green `eval.json`. Eloquence in the README is Phase 4, not Phase 2.

Public README voice: operator, not influencer. Lead with the command and the cost. Do not call the project revolutionary in README copy.

---

## Env

```bash
# .env.example
SOLARI_API_KEY=          # slr_live_... from console.getsolari.com
NOAPI_PORTAL_ORIGIN=http://127.0.0.1:8787
NOAPI_PORTAL_USER=reviewer@getsolari.com
NOAPI_PORTAL_PASSWORD=reviewer
# optional, planner off unless set
# OPENAI_API_KEY=
```

One key across browsers, sandboxes, desktops. That is the product.

---

## If you only do one thing

Build a conductor that finishes vendor-close on all three surfaces, proves it with artifacts and a screenshot you actually looked at, rewinds a step instead of the universe, and leaves no session running.
)

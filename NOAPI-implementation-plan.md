# NOAPI — Implementation Plan

**Working title:** NOAPI  
**Tagline:** An agent that finishes work where there is no API.  
**Purpose:** Win the Pinetree Research / Solari intern challenge by turning the three cookbook primitives (cloud browser, sandbox, desktop) into one reliability-first computer-use runtime.  
**Constraint:** One `SOLARI_API_KEY`. Deterministic demo. Reviewers can rerun it Monday morning without our cookies.  
**North star:** Pinetree’s sentence — *transform general intelligence into reliable labor on software that has no API.*

This document is the build spec, not a pitch deck. Every section should be implementable.

---

## 0. Why this, not another cookbook example

The cookbook already proves “launch a browser,” “run a command,” “click Mousepad.” Adding example #10 loses.

NOAPI wins if a reviewer can answer yes to all five:

1. Did they use **all three** Solari surfaces in one workflow?
2. Is the workflow something a human actually does on software with **no clean API**?
3. Is **reliability** a first-class subsystem (rewind, eval, audit), not a try/except?
4. Can I **watch** it (VNC stream + rrweb replay + screenshots)?
5. Can I **rerun** it with one command and a key?

If any answer is no, the project is a demo. If all five are yes, it is a prototype of the product Pinetree is already building.

---

## 1. Product definition

### 1.1 What the user types

```text
npx noapi run scenarios/vendor-close.json
```

or, later:

```text
npx noapi run "Close June: pull invoices from the vendor portal, reconcile against ledger.csv, put exceptions into a LibreOffice pack, upload the PDF."
```

The first form is the challenge deliverable. The second form is the intern-level stretch.

### 1.2 What comes out

A `Run` object:

| Field | Source |
|---|---|
| `id` | ulid |
| `status` | `queued \| running \| succeeded \| failed \| rewound` |
| `steps[]` | surface, action, timing, cost estimate |
| `artifacts/` | invoices, ledger diff, charts, xlsx, pdf, screenshots |
| `replays.browser` | rrweb URL / downloaded NDJSON |
| `streams.desktop` | VNC `streamUrl` |
| `preview.dashboard` | `*.preview.getsolari.com` |
| `eval.json` | success predicates + cost + wall clock |
| `rewind.log` | which snapshot was restored, why |

### 1.3 Non-goals (on purpose)

- Becoming a general agent framework (LangGraph clone).
- Hitting live Epic / Workday / Bank of America in v0. Brittle and looks reckless.
- Multi-cloud providers. This is a Solari-shaped product.
- A hosted SaaS with auth and billing. The challenge is a public repo that runs.

---

## 2. The demo scenario: Monthly Vendor Close

This is the default scenario shipped in the repo. It is boring on purpose. Boring office work is the TAM.

### 2.1 Storyboard (four minutes of wall clock)

```text
T+0:00  Planner loads scenarios/vendor-close.json
T+0:05  Browser launches with stealth + profile + recording
T+0:20  Logs into fake vendor portal (profile may already be warm)
T+0:40  Downloads /invoices/2026-06.zip to the control plane
T+0:50  Sandbox boots from snapshot `close-base` (or template base)
T+1:00  Files written into /work: invoices, fixtures/ledger.csv, policy.yaml
T+1:20  Code interpreter reconciles, writes exceptions.csv + chart.png
T+1:25  Sandbox snapshot saved as close-numbers-ok
T+1:30  Desktop boots 1280x720, streamUrl printed
T+1:50  LibreOffice Calc opens, agent clicks the sheet (not the chrome)
T+2:20  Exceptions pasted, header/footer applied, PDF exported
T+2:30  Screenshot proof saved; PDF pulled off the VM
T+2:40  Browser uploads PDF to /close/submit
T+2:50  Dashboard preview URL printed; sessions killed
T+3:00  eval.json written; run marked succeeded
```

### 2.2 Why this scenario is the right default

- **Browser** is required: login, cookies, file download, file upload.
- **Sandbox** is required: parsing, joins, charts, snapshots.
- **Desktop** is required: LibreOffice is the “no API” punchline. The default Solari desktop template already ships it.
- **Recording** is required: finance-shaped work demands an audit trail.
- Reviewers in a YC/StartX orbit immediately get “close the books.”

### 2.3 Scenario file format

```json
{
  "id": "vendor-close",
  "title": "June 2026 vendor close",
  "budgetUsd": 0.50,
  "timeoutMs": 240000,
  "fixtures": {
    "ledger": "fixtures/ledger.csv",
    "policy": "fixtures/policy.yaml"
  },
  "success": [
    { "kind": "fileExists", "path": "artifacts/exceptions.csv" },
    { "kind": "fileExists", "path": "artifacts/close-pack.pdf" },
    { "kind": "portalAccepted", "url": "/close/last" },
    { "kind": "rowCount", "path": "artifacts/exceptions.csv", "min": 1 },
    { "kind": "screenshotContainsText", "path": "artifacts/desktop-final.png", "text": "EXCEPTIONS" }
  ],
  "steps": [
    { "id": "login",       "surface": "browser",  "action": "loginPortal" },
    { "id": "pull",        "surface": "browser",  "action": "downloadInvoices" },
    { "id": "reconcile",   "surface": "sandbox",  "action": "reconcileLedger" },
    { "id": "snapshot",    "surface": "sandbox",  "action": "snapshot", "name": "close-numbers-ok" },
    { "id": "format",      "surface": "desktop",  "action": "formatLibreOffice" },
    { "id": "file",        "surface": "browser",  "action": "uploadPack" }
  ]
}
```

Success predicates are code, not vibes. That is the reliability thesis in the scenario format itself.

---

## 3. Architecture

### 3.1 One-picture system

```text
                    ┌─────────────────────────────────────┐
                    │              noapi CLI              │
                    │  parse scenario | print stream URLs │
                    └─────────────────┬───────────────────┘
                                      │
                    ┌─────────────────▼───────────────────┐
                    │              Conductor              │
                    │  plan · budget · timeout · journal  │
                    └─────────────────┬───────────────────┘
          ┌───────────────────────────┼───────────────────────────┐
          ▼                           ▼                           ▼
   Surface: Browser            Surface: Sandbox            Surface: Desktop
   @solarisdk/browser          @solarisdk/sandbox          solari_desktop
   Playwright-shaped           commands / files / kernel   screenshot/click/type
   profiles, stealth,          snapshots, previewUrl       streamUrl, open()
   recording, proxies          kill() not close()          destroy()
          │                           │                           │
          └───────────────┬───────────┴───────────┬───────────────┘
                          ▼                       ▼
                   Rewind + Eval              Artifact Store
                   last-good snapshot         artifacts/<runId>/
                   rrweb poll                 eval.json
                   screenshot OCR             journal.ndjson
                          │
                          ▼
                   Fake Vendor Portal
                   (local fixture app the browser hits)
```

### 3.2 Process model

Keep v0 as **one Node process + one Python sidecar** rather than a distributed system.

- **Node 22+** owns the conductor, browser surface, sandbox surface, CLI, portal, dashboard.
- **Python 3.11+** owns the desktop surface (`solari_desktop` cookbook is Python-first) and optional OCR for screenshot predicates.
- They talk over localhost JSON-RPC or a tiny HTTP control port. Do not invent a message bus.

Alternative if we want one language: implement desktop from the TS SDK if `@solarisdk/desktop` is complete enough. Prefer one language if the SDK surface is real. Fall back to the sidecar because the cookbook’s only desktop example is Python, and reviewers will recognize it.

### 3.3 Hard rules copied from the cookbook (treat as tests)

These are not style notes. Encode them as lint + runtime asserts.

| Rule | Failure mode if ignored | Where to enforce |
|---|---|---|
| Always `await solari.close()` after browsers | Process hangs; looks broken on review | `using` / `try/finally` in `surfaces/browser.ts` |
| `kill()` a sandbox, do not only `close()` | VM burns credits until idle timeout | `surfaces/sandbox.ts` disposer |
| Desktop `destroy(sessionId)`, not just `close()` | Same credit leak | `surfaces/desktop.py` |
| `timeoutMs` is a rolling idle window | Long think ≠ death; silence = death | heartbeat ping every N seconds |
| Recording is opt-in per session | Replay 404s forever | conductor refuses `eval.replay` if flag off |
| Sandbox commands are argv | `run("ls -la")` looks for a binary named `ls -la` | wrapper `sh -c` helper, never string-shell by accident |
| Click the document, not screen center | Keystrokes land on the window behind | desktop action must screenshot-confirm focus |
| Profile save is explicit | Login does not persist | `profiles.save` after every authenticated run |

### 3.4 Credit and session budget

Free tier is tight: $3 credits, 1 concurrent sandbox, 3 browsers, 1 hour max session, no stealth. Starter ($20) unlocks stealth, proxies, captcha.

Design the default demo to run on **Starter**, and degrade on Free:

- Free: skip stealth/proxy, keep recording if the plan allows, shrink desktop resolution, shorter idle timeouts.
- Always print a running cost estimate using published rates so the README can say “this run cost ~$0.12.”

Budget guard in the conductor: if projected cost > `scenario.budgetUsd`, refuse to start the next surface and snapshot instead.

---

## 4. Module plan

### 4.1 Repo layout

```text
noapi/
  README.md
  LICENSE                     # MIT, matching the cookbook
  package.json
  pyproject.toml
  Makefile                    # demo, portal, lint, eval
  .env.example                # SOLARI_API_KEY=
  scenarios/
    vendor-close.json
    insurance-intake.json     # stretch scenario
    paper-replication.json    # stretch scenario
  fixtures/
    ledger.csv
    policy.yaml
    invoices/                 # generated by the portal, also checked in as goldens
  apps/
    portal/                   # fake vendor web app
    dashboard/                # static run viewer, later served via previewUrl
  src/
    cli.ts
    conductor.ts
    journal.ts
    budget.ts
    types.ts
    surfaces/
      browser.ts
      sandbox.ts
      desktop.ts              # thin client to the python sidecar
    rewind/
      snapshots.ts
      replays.ts
      focus_check.py
    eval/
      predicates.ts
      ocr.ts
      score.ts
    planner/
      static.ts               # v0: just read the JSON
      llm.ts                  # v1: optional, off by default
  python/
    desktop_sidecar.py
    libreoffice_ops.py
    ocr_probe.py
  artifacts/                  # gitignored except .gitkeep
  recordings/                 # gitignored
  docs/
    IMPLEMENTATION.md         # this file, or a short pointer to it
    REVIEWER.md               # 90-second path for Harry
```

Fork the cookbook **and leave it as a git submodule or a `/vendor/cookbook` reference**, so the README can say “every surface call maps to an official example.” That is courtesy and a flex.

### 4.2 Conductor

Responsibilities:

- Load scenario, validate schema.
- Open a journal (`artifacts/<runId>/journal.ndjson`).
- Acquire surfaces lazily. Do not boot desktop until the sandbox snapshot exists.
- Heartbeat each live session so rolling idle windows do not murder a think step.
- On step failure: consult rewind policy, then either retry, restore snapshot, or abort with artifacts preserved.
- Always run disposers. A crashed agent that leaves VMs up is an automatic no.

Journal event shapes:

```ts
type Event =
  | { t: number; type: "step.start"; id: string; surface: Surface }
  | { t: number; type: "step.ok"; id: string; ms: number }
  | { t: number; type: "step.fail"; id: string; error: string; screenshot?: string }
  | { t: number; type: "rewind"; from: string; snapshot: string }
  | { t: number; type: "cost"; usd: number }
  | { t: number; type: "artifact"; path: string }
```

The journal is the thing you grep when a reviewer asks “what happened at 1:22.”

### 4.3 Browser surface

Copy patterns from:

- `browser-quickstart-ts` — launch / goto / close / `solari.close()`
- `browser-stealth-proxy-ts` — `stealth`, `proxy`, `captcha`
- `browser-profiles-ts` — create / reuse / `profiles.save`
- `browser-session-recording-py` — `recording: true`, poll replay ~30s

API we expose to the conductor:

```ts
interface BrowserSurface {
  start(opts: { stealth?: boolean; profile?: string; recording: true }): Promise<void>
  page(): Page
  download(url: string, dest: string): Promise<string>
  upload(selector: string, file: string): Promise<void>
  saveProfile(): Promise<void>
  replayUrl(): Promise<string | null>
  dispose(): Promise<void>
}
```

Portal selectors live in `apps/portal/selectors.ts` shared with the agent so the demo cannot drift.

### 4.4 Sandbox surface

Copy patterns from:

- `sandbox-quickstart-ts` — create, `commands.run`, files, `kill()`
- `sandbox-code-interpreter-py` — stateful kernel, rich results
- `sandbox-port-preview-ts` — `previewUrl(port)`

API:

```ts
interface SandboxSurface {
  start(opts: { template?: string; snapshotId?: string }): Promise<void>
  write(path: string, bytes: Uint8Array | string): Promise<void>
  read(path: string): Promise<Uint8Array>
  sh(script: string): Promise<{ stdout: string; exitCode: number }>
  python(code: string, contextId?: string): Promise<KernelResult>
  snapshot(name: string): Promise<string>
  preview(port: number): Promise<string>
  dispose(): Promise<void>
}
```

Reconciliation code runs **inside** the sandbox, not on the laptop. That is the point of the product. Check the script into `fixtures/reconcile.py` and `files.write` it over.

### 4.5 Desktop surface

Copy `desktop-computer-use-py` almost verbatim, then wrap it.

API:

```python
class DesktopSurface:
    async def start(self, resolution="1280x720") -> str:  # returns streamUrl
    async def open(self, app: str) -> int
    async def click(self, x: int, y: int, *, humanize=True) -> None
    async def type(self, text: str) -> None
    async def screenshot(self, path: str) -> bytes
    async def exec(self, argv: list[str]) -> ExecResult
    async def focus_confirmed(self, expected_text: str) -> bool
    async def dispose(self) -> None
```

LibreOffice choreography (the fragile part — isolate it):

1. `desktop.open("libreoffice")` or the exact binary the template ships. Probe with `exec(["-v", "name"])` as the cookbook says.
2. Wait until `health.ready`.
3. File → Open `/work/exceptions.csv` **or** push the file then open by path via `exec`.
4. Click inside the sheet. **Do not click (640, 360) on a 1280x720 display.** Use a calibrated point from a template screenshot, then verify with `focus_confirmed`.
5. Apply a trivial format (bold header row) so the screenshot is visually distinct.
6. Export PDF to `/work/close-pack.pdf`.
7. Pull the file back through the sidecar.

If GUI automation is flakier than we can tolerate in v0, ship a **documented fallback**: `soffice --headless --convert-to pdf` via `desktop.exec` / sandbox, *and still* open the PDF on the desktop for the screenshot proof. The live VNC moment is what gets bookmarked on X. Headless-only is a cookbook remix.

### 4.6 Fake vendor portal

This is not a throwaway. It is how the demo stays deterministic.

Must have:

- `/login` with a seeded user `reviewer@getsolari.com` / password in `.env.example`
- `/invoices` zip download, content hashed and checked in as a golden
- `/close/submit` multipart PDF upload
- `/close/last` JSON the eval predicate hits
- A visible banner `NOAPI VENDOR PORTAL` so screenshots and recordings are obviously ours
- No captcha on the happy path. Optional “hard mode” route that flips captcha on, for stealth demos on Starter+

Run it two ways:

- Local on `:8787` for development.
- Inside a sandbox with `previewUrl` for the “entire world is Solari” flex.

### 4.7 Dashboard

A static page written into the sandbox and exposed with `previewUrl`:

- Live status of steps
- Embedded desktop stream URL
- Links to rrweb replay
- Artifact thumbnails
- Running cost

The X post caption is this URL. That is distribution engineering.

---

## 5. Reliability subsystem (the actual product)

### 5.1 Rewind

Three clocks, one policy.

| Surface | Time-travel primitive | How we use it |
|---|---|---|
| Browser | rrweb NDJSON replay (opt-in) | Diff the last N events after a failed click; store the recording even on failure |
| Sandbox | VM snapshot / fork | After `reconcile` succeeds, snapshot. If desktop fails, do **not** rerun parse. Restore and resume at `format` |
| Desktop | Screenshot ring buffer | Keep last 10 frames. On focus miss, recapture and replan the click |

Policy file:

```yaml
rewind:
  maxAttemptsPerStep: 2
  restoreSnapshotOn:
    - desktop.focus_miss
    - desktop.app_not_ready
  neverRestoreOn:
    - budget_exceeded
    - portal_rejected_auth
  keepFailedArtifacts: true
```

This is the “revolutionary” claim we can defend: **most computer-use demos restart the universe. NOAPI restarts the step.**

### 5.2 Focus confirmation (desktop)

Cookbook landmine, promoted to a subsystem.

```text
click(x, y)
sleep(300ms)
shot = screenshot()
if not ocr_or_pixel_probe(shot, expected):
    raise FocusMiss(shot)
```

Probe v0 can be dumb and reliable: after typing a sentinel string `NOAPI_FOCUS_OK`, screenshot and look for those bytes/pixels, then undo. Do not start with a full vision model. Add one later as an optional judge.

### 5.3 Eval

`eval.json` is the scoreboard the README embeds.

```json
{
  "runId": "...",
  "scenario": "vendor-close",
  "ok": true,
  "predicates": [
    { "name": "fileExists:exceptions.csv", "ok": true },
    { "name": "fileExists:close-pack.pdf", "ok": true },
    { "name": "portalAccepted", "ok": true },
    { "name": "screenshotContainsText:EXCEPTIONS", "ok": true }
  ],
  "wallMs": 178440,
  "costUsdEstimate": 0.14,
  "surfaces": { "browserSec": 70, "sandboxSec": 40, "desktopSec": 68 },
  "replayUrl": "https://...",
  "streamUrl": "https://...",
  "previewUrl": "https://....preview.getsolari.com",
  "rewinds": 1
}
```

A scenario is not done until eval is green. “The agent looked like it worked” is a failed run.

### 5.4 Cost accounting

Use the public price sheet as constants:

- Browser hourly by plan
- Sandbox vCPU-hour + GB-hour
- Desktop = sandbox + $0.02/hour live screen
- Captcha per solve, proxy per GB, if used

Write `budget.ts` with those numbers and a comment linking `docs.getsolari.com/pricing`. Reviewers work at the company that wrote the price list. Getting the units right is a quiet IQ test.

---

## 6. Revolutionary extras (ship a few, sketch the rest)

These are the perks that make the repo feel like a lab notebook, not a weekend hack. Ranked by “build this / mention this.”

### 6.1 Ship in v0 — Three-surface conductor + rewind

Already specified. This *is* the product.

### 6.2 Ship in v0 — Audit-grade evidence pack

Every run produces a folder a controller could file:

```text
artifacts/<runId>/
  journal.ndjson
  eval.json
  invoices.zip
  exceptions.csv
  chart.png
  close-pack.pdf
  desktop-01-open.png
  desktop-02-focused.png
  desktop-03-exported.png
  browser.ndjson.gz
  MANIFEST.sha256
```

Hash every artifact. Print the manifest in the README run log. Finance and healthcare (Pinetree’s original beachhead) both care about “what did the agent touch.”

### 6.3 Ship in v0 — Deterministic twin world

The fake portal + checked-in goldens + seeded ledger means:

- CI can run against recorded HTTP if we later add a page.route fixture.
- Reviewers cannot get blocked by a third-party captcha on demo day.
- We can add `noapi doctor` which hits Solari, launches the cheapest browser, and exits 0.

### 6.4 Ship in v1 if time — Self-hosted eval gym

`scenarios/` is an eval suite, not a single demo.

Second scenario, still on-mission: **insurance intake**. Browser pulls a patient packet from the portal, sandbox extracts fields, desktop opens the packet in a PDF viewer / LibreOffice Writer and fills a claim form. Healthcare-shaped without touching a real EHR.

Third scenario: **paper replication**. Browser downloads a dataset and a paper’s code drop, sandbox runs it, desktop opens the resulting figure. Speaks to “research lab” without pretending we reproduced AlphaFold.

The gym is how you talk about intern work: “I did not just demo an agent. I started the harness you will need to measure the next one.”

### 6.5 Stretch — Time-travel debugger UI

A page that plays three tracks on one scrubber:

- rrweb (DOM)
- desktop screenshots / VNC
- sandbox journal (files written, kernel cells)

This is the most visually unique thing we could show on X. Even a crude version (three columns, shared timestamp) is enough. Full sync is a product.

### 6.6 Stretch — Snapshot algebra

Treat snapshots as git for machines:

```text
noapi snap ls
noapi snap fork close-numbers-ok --as close-whatif-fx
noapi run --from close-whatif-fx scenarios/vendor-close.json
```

Fork the “numbers are right” world and rerun only the GUI pack under a different template resolution. That is a research primitive, not a wrapper.

### 6.7 Stretch — Dual-control: agent + human on the same desktop

Desktop already has `streamUrl`. Add a “take over” flag: the agent pauses at `NeedHuman`, a reviewer clicks in VNC, the agent resumes from the next screenshot.

Name the interrupt `SIGHUMAN`. Cute, memorable, actually useful for the workflows Pinetree wants (healthcare ops will not go fully hands-off on day one).

### 6.8 Stretch — Planner that must cite a surface

If we turn the LLM planner on, force every planned step to name `browser | sandbox | desktop` and a success predicate before it is allowed to run. Plans that say “figure it out” are rejected. This encodes the product taxonomy into the prompt, which is a taste signal.

Default remains the static JSON planner. The challenge says use AI to *build*, not necessarily to *steer at runtime*. A flaky LLM loop can sink a good infra demo.

### 6.9 Stretch — Adversarial portal

A second portal mode that:

- rotates a selector every request
- throws a captcha on Starter+
- expires the session mid-download

Score how many rewinds the conductor needs. Publish the number. Reliability labs love a leaderboard even when the leaderboard has one row.

### 6.10 Perk, not a product — Cost flamegraph

A one-file HTML artifact that stacks browser-hours vs vCPU-hours vs live-screen surcharge. Founders who bill a single balance will notice. It also proves we read the price page.

### 6.11 Perk — Cookbook conformance test

A script `noapi cookbook-check` that runs the official examples’ critical assertions (close the client, kill the VM, recording flag, argv). Frame it as “we did not just fork the repo, we turned the README gotchas into CI.”

### 6.12 Do not ship — Crypto, consumer chat UI, “agent that applies to this job”

Viral and low signal. If we want a wink, put a single line in the README: *the intern is the runtime.* Then show the vendor close.

---

## 7. Implementation phases

### Phase 0 — Repo physics (half a day)

- Public repo, MIT, `.env.example`, Makefile.
- Submodule or vendor pointer to `solari-sdk/solari-cookbook`.
- `noapi doctor`: key present, can `launch()` a browser, prints session id, closes cleanly.
- README skeleton with empty GIF slot and the five yes/no questions from §0.

Exit: a stranger with a key can clone and pass doctor.

### Phase 1 — Twin world (half a day)

- Fake vendor portal with login, zip download, PDF upload.
- Seeded `fixtures/ledger.csv` that disagrees with the zip on two invoices (so exceptions are real).
- Goldens + sha256.

Exit: curl-driven close works without Solari at all. This is the safety rail.

### Phase 2 — Three surfaces, scripted (one day)

No planner intelligence. A TypeScript script that is the conductor’s happy path inlined:

1. Browser login + download.
2. Sandbox write + `reconcile.py` + snapshot.
3. Desktop LibreOffice + screenshot.
4. Browser upload.
5. Disposers.

Copy cookbook comments into our wrappers so reviewers see we read them.

Exit: one green `make demo` on Starter-plan key. Artifacts folder populated. Stream URL printed.

### Phase 3 — Conductor + eval + rewind (one day)

- Scenario JSON.
- Journal.
- Predicates.
- Snapshot restore on desktop focus miss (force-fail once in a `make demo-flaky` target so rewind is visible).
- Cost estimate.
- Dashboard static files + optional previewUrl.

Exit: `eval.json` is the source of truth. Flaky target shows `rewinds: 1` and still passes.

### Phase 4 — Reviewer pack (half a day)

- 20-second screen recording of VNC + dashboard.
- `docs/REVIEWER.md` with exact commands, expected cost, expected exceptions count.
- README that is the X post in prose.
- License, architecture diagram (mermaid in README).
- Explicit “what we did not build” section so we look adult.

Exit: a person who has never seen the repo can judge it in three minutes.

### Phase 5 — Only if Phase 4 is done

Pick **one**:

- Insurance-intake second scenario, or
- Time-travel three-column debugger, or
- `SIGHUMAN` takeover.

Two extras is worse than one finished extra.

---

## 8. Tooling and libraries

Keep the stack boring. Novelty lives in the conductor, not the framework.

| Layer | Choice | Why |
|---|---|---|
| Control plane | TypeScript, Node 22, `tsx` | Cookbook’s best examples are TS; `await using` for disposers |
| Desktop sidecar | Python 3.11, `solari_desktop` | Official example language |
| Browser driving | Playwright API via `@solarisdk/browser` | Do not add raw CDP unless we must |
| Sandbox | `@solarisdk/sandbox` + `@solarisdk/sdk` for preview | Match cookbook imports |
| CLI | `commander` or raw `node:util parseArgs` | Fewer deps |
| Portal | Hono or plain `node:http` | One file if possible |
| OCR probe | Tesseract in the sidecar, optional | Only for screenshot predicates |
| LLM planner | Off by default. If on, one OpenAI-compatible client | Must not be required to demo |
| Tests | Node test runner + a portal contract test | No Jest cathedral |

AI is used to write the glue, the portal, the reconcile script, and the README. That satisfies “we insist you use AI to build it” without making the runtime a lottery.

---

## 9. Failure modes we design for

| Failure | Symptom | Response |
|---|---|---|
| Missing `solari.close()` | Script hangs after success | Disposer + `doctor` timeout |
| Desktop click miss | Empty document, silent | Focus sentinel + rewind |
| Recording forgotten | Replay 404 | Conductor requires `recording: true` for scored runs |
| Idle timeout mid-plan | Session dies during LLM think | Heartbeat + static planner in v0 |
| Free-plan stealth | Launch error | Plan detect + degrade path |
| LibreOffice not in template | `open()` fails | Probe with `command -v`, fallback `soffice --headless`, still screenshot |
| Reviewer has no key | Clone does nothing | Portal-only `make demo-offline` plus recorded GIF |
| Cost runaway | Forgotten VM | Hard budget + process `on('exit')` kill list |
| Live site drift | Third-party login changes | We do not use live sites in v0 |

---

## 10. What “done” looks like for the challenge

A public GitHub repo whose README opens with:

1. A GIF of LibreOffice receiving exceptions on a Solari desktop.
2. `export SOLARI_API_KEY=... && make demo`
3. A preview URL and a replay URL from the last recorded run (even if expired, the GIF remains).
4. The sentence: *Browser pulled. Sandbox reconciled and snapshotted. Desktop formatted the pack. Eval passed. Cost $0.xx.*
5. A mermaid of the three surfaces.
6. A table mapping each call to a cookbook example.
7. `docs/REVIEWER.md`

Then the X/LinkedIn post, 20 seconds of VNC, tags `@harrychow_` and `@getsolari`.

That is the entire application. No resume, by their rules.

---

## 11. Suggested build order for the first coding session

1. `doctor` + disposer helpers (steal comments from the cookbook).
2. Portal + fixtures + `make demo-offline`.
3. Browser login/download/upload against local portal.
4. Sandbox reconcile + snapshot.
5. Desktop sidecar open/click/type/screenshot with focus sentinel.
6. Wire the four steps in `conductor.ts`.
7. Eval + journal + budget.
8. Forced-fail rewind target.
9. Dashboard + README + GIF.
10. Stop.

Anything after step 9 is extra credit. Shipping a complete three-surface run with eval is the interview. A half-built debugger is not.

---

## 12. Naming and voice

- Repo: `noapi` or `noapi-solari`.
- Agent voice in logs: short, lowercase, cookbook-like. No “I have successfully…”
- README voice: operators, not influencers. Lead with the command and the cost.
- Avoid “revolutionary” in the public README. Put the ambition in the architecture and the rewind log. Let the reviewer say it.

Internal name for the conductor if we want a wink: **Workhorse**. Public name stays NOAPI.

---

## 13. Open questions to resolve on the first build hour

1. Is `@solarisdk/desktop` complete enough to drop the Python sidecar?
2. Does snapshot-from-id work on the current sandbox API the way the docs imply, or do we only have “create from template” today? If snapshots are thin, implement rewind as “rerun from cached `/work` artifacts” and keep the snapshot call behind a feature flag.
3. Exact LibreOffice binary name on `template: "default"`. Probe, do not guess.
4. Replay download format and poll interval — cookbook says ~30s; confirm against current API.
5. Whether preview URLs work from a sandbox that also runs the dashboard while the desktop is alive (concurrency limits: Free = 1 sandbox). Dashboard may need to be local for Free-plan reviewers.

If (5) bites, print local `artifacts/<runId>/dashboard.html` and treat previewUrl as Starter+ garnish.

---

## 14. One-line contract

**NOAPI is a conductor that turns Solari’s browser, sandbox, and desktop into one machine, proves the work with artifacts and replays, and rewinds a step instead of the universe.**

Build that. Film it. Tag them.
)

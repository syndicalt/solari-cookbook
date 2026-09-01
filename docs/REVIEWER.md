# REVIEWER.md — the 90-second path

You are reviewing NOAPI for the Pinetree / Solari intern challenge. This page is the fastest route to a judgment.

## 30 seconds — no key, no cost

```bash
git clone <this repo> && cd noapi
make demo-offline
```

Expected tail:

```
reconcile.exceptions n=2
reconcile.ok
pack.ok out=artifacts/offline/close-pack.pdf bytes=8xx
offline.ok exceptions=2 upload=accepted sha256=............
```

That just ran the deterministic twin world with curl only: portal login → invoice zip download (sha256 golden-checked) → reconciliation → PDF pack → portal upload → `/close/last` verification. No Solari, no third parties, works on a plane.

## 60 seconds — with one key

```bash
export SOLARI_API_KEY=slr_live_...
make doctor   # cheapest real launch; prints a session id; exits 0 (no hang)
make demo     # the full three-surface vendor close
```

While it runs (~3 min):

- The **desktop `streamUrl`** is printed the moment the desktop boots — open it and watch LibreOffice receive the exceptions live over VNC. The VM also records itself: `eval.json`'s `desktopRecordingUrl` is an mp4 of the whole desktop session (uploaded on `record.stop()`, harvested before dispose).
- Expected cost: **~$0.14** on Starter (estimate from the published price sheet; printed at the end and in `eval.json`).
- Expected exceptions: **exactly 2** (one transposed-digit amount, one invoice missing from the ledger — both seeded in `fixtures/`).

When it finishes:

```bash
cat artifacts/<runId>/eval.json        # "ok": true is the definition of done
sha256sum -c artifacts/<runId>/MANIFEST.sha256
```

Then prove reliability is a subsystem, not a vibe:

```bash
make demo-flaky    # forces a desktop focus-miss (click at screen center)
grep rewind artifacts/<runId>/eval.json    # "rewinds": 1 — and still green
grep '"rewind"' artifacts/<runId>/journal.ndjson
```

The flaky run clicks (640,360) — the window *behind* LibreOffice — on purpose. The focus sentinel catches the miss, the conductor restores the `close-numbers-ok` sandbox snapshot, discards the poisoned GUI session, retries the step, and passes. That is the whole thesis: **rewind the step, not the universe.**

## Where to look, in order

1. `scenarios/vendor-close.json` — the scenario is the API; success predicates are code.
2. `src/conductor.ts` — lazy surface acquisition, budget guard, rewind loop, disposers.
3. `src/surfaces/desktop.ts` — the LibreOffice choreography and the cookbook's focus landmine handled in the open.
4. `src/rewind/policy.ts` — the rewind decision table, as data.
5. `artifacts/<runId>/` — the evidence pack (journal, eval, screenshots, replay, manifest).

## Claims you can check cheaply

| Claim | Check |
|---|---|
| No hung processes | `make demo` exits by itself; `make doctor` exits 0 in seconds |
| No leaked sessions | conductor disposes in reverse order + SIGINT/SIGTERM handlers; `kill()` sandboxes, `destroy()` desktops, `solari.close()` browsers |
| Recording actually on | `grep recording src/surfaces/browser.ts`; replay saved as `browser.ndjson` even on failed runs |
| Reconciliation in the sandbox, not the laptop | `grep reconcileLedger src/surfaces/sandbox.ts` — invoices cross into `/work`, `python3 reconcile.py` runs in the VM |
| Budget is real | set `"budgetUsd": 0.000001` in the scenario and `make demo` — it refuses to start the next surface |
| Cookbook rules are CI, not README | `make lint` greps for argv-violations; unit tests assert dispose ordering |

## If something fails

- `doctor` exit 2 → no `SOLARI_API_KEY` in the environment.
- Desktop step capacity error → the desktop pool has no warm hosts; retry in a minute (browsers/sandboxes are unaffected).
- Replay 404s → expected for ~30s after release (upload is async); the conductor polls before giving up.
- Anything else: `artifacts/<runId>/journal.ndjson` is the grep target.

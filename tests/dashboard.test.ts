/** Dashboard tests — escaping, badges, links, step rows, file write. */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { renderDashboard, writeDashboard } from "../src/dashboard.ts";
import type { EvalReport, JournalEvent } from "../src/types.ts";

function report(overrides: Partial<EvalReport> = {}): EvalReport {
  return {
    runId: "01TEST",
    scenario: "vendor-close",
    ok: true,
    predicates: [
      { name: "fileExists:exceptions.csv", ok: true },
      { name: "rowCount:exceptions.csv>=1", ok: false, detail: "0 data rows (min 1)" },
    ],
    wallMs: 12_345,
    costUsdEstimate: 0.0042,
    surfaces: { browserSec: 10, sandboxSec: 20, desktopSec: 30 },
    replayUrl: null,
    streamUrl: null,
    previewUrl: null,
    rewinds: 0,
    ...overrides,
  };
}

const EVENTS: JournalEvent[] = [
  { t: 1, type: "step.start", id: "login", surface: "browser" },
  { t: 2, type: "step.ok", id: "login", ms: 100 },
  { t: 3, type: "step.start", id: "format", surface: "desktop" },
  { t: 4, type: "step.fail", id: "format", error: "focus miss" },
  { t: 5, type: "step.start", id: "file", surface: "browser" },
];

test("renderDashboard escapes HTML in all interpolated fields", () => {
  const html = renderDashboard(
    report({ scenario: 'x"><script>alert(1)</script>', runId: "01<b>" }),
    EVENTS,
  );
  assert.ok(!html.includes("<script>alert(1)</script>"));
  assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
  assert.ok(!html.includes("01<b>"));
});

test("renderDashboard shows the ok/failed badge", () => {
  assert.match(renderDashboard(report({ ok: true }), []), /class="badge">ok</);
  assert.match(renderDashboard(report({ ok: false }), []), /class="badge">failed</);
});

test("renderDashboard links stream/replay when present, dims when absent", () => {
  const linked = renderDashboard(
    report({ streamUrl: "https://vnc.example/s1", replayUrl: "/tmp/browser.ndjson", previewUrl: "https://prev.example" }),
    [],
  );
  assert.match(linked, /<a href="https:\/\/vnc\.example\/s1">desktop stream \(vnc\)<\/a>/);
  assert.match(linked, /<a href="\/tmp\/browser\.ndjson">browser replay \(rrweb\)<\/a>/);
  assert.match(linked, /<a href="https:\/\/prev\.example">dashboard preview<\/a>/);

  const bare = renderDashboard(report(), []);
  assert.match(bare, /desktop stream \(vnc\): n\/a/);
  assert.match(bare, /browser replay \(rrweb\): n\/a/);
});

test("renderDashboard renders step rows from journal events", () => {
  const html = renderDashboard(report(), EVENTS);
  // login completed with its timing; format failed; file never finished.
  assert.match(html, /<td>✅<\/td><td>login<\/td><td>browser<\/td><td>100ms<\/td>/);
  assert.match(html, /<td>❌<\/td><td>format<\/td><td>desktop<\/td><td><\/td>/);
  assert.match(html, /<td>…<\/td><td>file<\/td><td>browser<\/td><td><\/td>/);
});

test("renderDashboard renders predicate rows and the cost line", () => {
  const html = renderDashboard(report(), []);
  assert.match(html, /fileExists:exceptions\.csv/);
  assert.match(html, /0 data rows \(min 1\)/);
  assert.match(html, /wall 12\.3s · cost ~\$0\.0042 · rewinds 0/);
  assert.match(html, /browser 10s · sandbox 20s · desktop 30s/);
});

test("writeDashboard writes dashboard.html into the artifact dir", () => {
  const dir = mkdtempSync(join(tmpdir(), "noapi-dashboard-"));
  try {
    const path = writeDashboard(dir, report(), EVENTS);
    assert.equal(path, join(dir, "dashboard.html"));
    const html = readFileSync(path, "utf8");
    assert.match(html, /^<!doctype html>/);
    assert.match(html, /NOAPI/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Journal tests — NDJSON on disk, counters, close flushes. */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Journal } from "../src/journal.ts";
import type { JournalEvent } from "../src/types.ts";

function tmpJournal(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "noapi-journal-"));
  return { dir, path: join(dir, "journal.ndjson") };
}

function readEvents(path: string): JournalEvent[] {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as JournalEvent);
}

test("journal writes parseable NDJSON events of the documented shapes", async () => {
  const { dir, path } = tmpJournal();
  try {
    const journal = new Journal(path);
    journal.stepStart("login", "browser");
    journal.stepOk("login", 42);
    journal.stepFail("format", "boom");
    journal.stepFail("format", "boom again", "/tmp/shot.png");
    journal.rewind("format", "snap-1");
    journal.cost(0.0123);
    journal.artifact("/tmp/exceptions.csv");
    assert.equal(journal.rewinds, 1);
    await journal.close();

    const events = readEvents(path);
    assert.equal(events.length, 7);
    for (const e of events) assert.equal(typeof e.t, "number");

    const [start, ok, fail, failShot, rewind, cost, artifact] = events;
    assert.deepEqual({ ...start!, t: 0 }, { t: 0, type: "step.start", id: "login", surface: "browser" });
    assert.deepEqual({ ...ok!, t: 0 }, { t: 0, type: "step.ok", id: "login", ms: 42 });
    assert.deepEqual({ ...fail!, t: 0 }, { t: 0, type: "step.fail", id: "format", error: "boom" });
    assert.equal((failShot as { screenshot?: string }).screenshot, "/tmp/shot.png");
    assert.deepEqual({ ...rewind!, t: 0 }, { t: 0, type: "rewind", from: "format", snapshot: "snap-1" });
    assert.deepEqual({ ...cost!, t: 0 }, { t: 0, type: "cost", usd: 0.0123 });
    assert.deepEqual({ ...artifact!, t: 0 }, { t: 0, type: "artifact", path: "/tmp/exceptions.csv" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("journal counts rewinds only, and close flushes everything", async () => {
  const { dir, path } = tmpJournal();
  try {
    const journal = new Journal(path);
    assert.equal(journal.rewinds, 0);
    journal.artifact("/a");
    journal.rewind("x", "snap-1");
    journal.rewind("y", "snap-2");
    assert.equal(journal.rewinds, 2);
    await journal.close();
    assert.equal(readEvents(path).length, 3);
    assert.equal(journal.path, path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("journal creates parent directories and appends", async () => {
  const dir = mkdtempSync(join(tmpdir(), "noapi-journal-nested-"));
  try {
    const path = join(dir, "deeply", "nested", "journal.ndjson");
    const journal = new Journal(path);
    journal.stepStart("a", "sandbox");
    await journal.close();
    assert.ok(existsSync(path));
    // Appending to the same path (flags: "a") keeps prior lines.
    const second = new Journal(path);
    second.stepOk("a", 1);
    await second.close();
    const lines = readFileSync(path, "utf8").trim().split("\n");
    assert.equal(lines.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

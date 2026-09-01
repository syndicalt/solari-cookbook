/** ULID tests — format, uniqueness, timestamp-prefix ordering. */
import assert from "node:assert/strict";
import test from "node:test";
import { ulid } from "../src/ulid.ts";

const CROCKFORD = /^[0-9A-HJKMNP-TV-Z]{26}$/;

test("ulid is 26 chars of Crockford base32", () => {
  for (let i = 0; i < 100; i++) {
    assert.match(ulid(), CROCKFORD);
  }
});

test("ulid is unique over 1000 ids", () => {
  const ids = new Set<string>();
  for (let i = 0; i < 1000; i++) ids.add(ulid());
  assert.equal(ids.size, 1000);
});

test("ulid timestamp prefix is fixed-width and orders lexicographically", () => {
  const t1 = 1_000_000;
  const t2 = 2_000_000;
  const a = ulid(t1);
  const b = ulid(t1);
  const c = ulid(t2);
  // Same timestamp → same 10-char prefix (random suffix differs).
  assert.equal(a.slice(0, 10), b.slice(0, 10));
  assert.notEqual(a, b);
  // Earlier timestamp sorts first regardless of the random suffix.
  assert.ok(a.slice(0, 10) < c.slice(0, 10));
  assert.ok(ulid(0).slice(0, 10) <= a.slice(0, 10));
});

test("ulid accepts an explicit now for deterministic prefixes", () => {
  const now = 1_700_000_000_000;
  assert.equal(ulid(now).slice(0, 10), ulid(now).slice(0, 10));
});

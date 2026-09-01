/**
 * Eval predicates — success is code, not vibes.
 *
 * Each scenario `success[]` predicate is evaluated against the run's
 * artifact directory and (for `portalAccepted`) the live portal. A run is
 * not done until every predicate is green; "the agent looked like it
 * worked" is a failed run.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { NoapiConfig, PredicateResult, SuccessPredicate } from "../types.ts";
import { ocrPng, ocrAvailable } from "./ocr.ts";

/** Injectable seams so tests never need tesseract or a network. */
export interface PredicateDeps {
  /** OCR a PNG to text; defaults to local tesseract via ocr.ts. */
  ocr?: (pngPath: string) => Promise<string>;
  /** HTTP client; defaults to global fetch. */
  fetchFn?: typeof fetch;
}

/** Human-readable predicate name for the eval report. */
export function predicateName(p: SuccessPredicate): string {
  switch (p.kind) {
    case "fileExists":
      return `fileExists:${p.path}`;
    case "rowCount":
      return `rowCount:${p.path}>=${p.min}`;
    case "portalAccepted":
      return `portalAccepted:${p.url}`;
    case "screenshotContainsText":
      return `screenshotContainsText:${p.text}`;
  }
}

/** Data rows in a CSV artifact (all lines after the header, blanks ignored). */
export function csvDataRows(path: string): number {
  const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.trim().length > 0);
  return Math.max(0, lines.length - 1);
}

/**
 * Log into the portal and GET an authed JSON endpoint. Returns the parsed
 * body and HTTP status. The eval path uses the seeded reviewer credentials,
 * the same ones the browser agent typed into the form.
 */
export async function portalGetAuthed(
  config: NoapiConfig,
  urlPath: string,
  fetchFn: typeof fetch = fetch,
): Promise<{ status: number; body: unknown }> {
  const origin = config.portalOrigin;
  const login = await fetchFn(`${origin}/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ email: config.portalUser, password: config.portalPassword }).toString(),
    redirect: "manual",
  });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
  if (!cookie) return { status: 401, body: { ok: false, error: "login failed" } };
  const res = await fetchFn(`${origin}${urlPath}`, { headers: { cookie } });
  return { status: res.status, body: await res.json().catch(() => null) };
}

/** Evaluate one predicate against the artifact dir. */
export async function evaluatePredicate(
  p: SuccessPredicate,
  artifactsDir: string,
  config: NoapiConfig,
  deps: PredicateDeps = {},
): Promise<PredicateResult> {
  const name = predicateName(p);
  switch (p.kind) {
    case "fileExists": {
      const ok = existsSync(join(artifactsDir, p.path));
      return { name, ok, ...(ok ? {} : { detail: `${p.path} not in ${artifactsDir}` }) };
    }
    case "rowCount": {
      const full = join(artifactsDir, p.path);
      if (!existsSync(full)) return { name, ok: false, detail: `${p.path} missing` };
      const rows = csvDataRows(full);
      return { name, ok: rows >= p.min, detail: `${rows} data rows (min ${p.min})` };
    }
    case "portalAccepted": {
      try {
        const { status, body } = await portalGetAuthed(config, p.url, deps.fetchFn);
        const ok = status === 200 && typeof body === "object" && body !== null && (body as { ok?: boolean }).ok === true;
        return { name, ok, detail: `status=${status}` };
      } catch (err) {
        return { name, ok: false, detail: (err as Error).message };
      }
    }
    case "screenshotContainsText": {
      const full = join(artifactsDir, p.path);
      if (!existsSync(full)) return { name, ok: false, detail: `${p.path} missing` };
      const ocr = deps.ocr ?? ocrPng;
      if (!deps.ocr && !(await ocrAvailable())) {
        return { name, ok: false, detail: "tesseract unavailable — cannot verify screenshot text" };
      }
      try {
        const text = await ocr(full);
        const ok = text.toUpperCase().includes(p.text.toUpperCase());
        return { name, ok, detail: ok ? undefined : `ocr did not find ${JSON.stringify(p.text)}` };
      } catch (err) {
        return { name, ok: false, detail: (err as Error).message };
      }
    }
  }
}

/** Evaluate every predicate in order. */
export async function evaluateAll(
  predicates: SuccessPredicate[],
  artifactsDir: string,
  config: NoapiConfig,
  deps: PredicateDeps = {},
): Promise<PredicateResult[]> {
  const out: PredicateResult[] = [];
  for (const p of predicates) out.push(await evaluatePredicate(p, artifactsDir, config, deps));
  return out;
}

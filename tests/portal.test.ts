/**
 * Portal contract test — drives the real server over localhost with fetch,
 * the same shape of traffic the browser surface and offline-close.sh make.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createPortal } from "../apps/portal/server.ts";
import { ROUTES } from "../apps/portal/selectors.ts";

const GOLDEN_SHA256 = readFileSync("fixtures/invoices.sha256", "utf8").trim();

test("portal contract", async (t) => {
  const portal = await createPortal({ port: 0 });
  const base = `http://127.0.0.1:${portal.port}`;
  t.after(() => portal.close());

  let cookie = "";

  const authedFetch = (path: string, init: RequestInit = {}): Promise<Response> => {
    const headers = new Headers(init.headers);
    headers.set("cookie", cookie);
    return fetch(`${base}${path}`, { ...init, headers, redirect: "manual" });
  };

  await t.test("unauth GET /invoices redirects to /login", async () => {
    const res = await fetch(`${base}${ROUTES.invoices}`, { redirect: "manual" });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), ROUTES.login);
  });

  await t.test("unauth zip download returns 401 json", async () => {
    const res = await fetch(`${base}${ROUTES.invoicesZip}`);
    assert.equal(res.status, 401);
    assert.match(res.headers.get("content-type") ?? "", /application\/json/);
  });

  await t.test("every html page carries the portal banner", async () => {
    const res = await fetch(`${base}${ROUTES.login}`);
    const html = await res.text();
    assert.match(html, /data-testid="portal-banner"/);
    assert.match(html, /NOAPI VENDOR PORTAL/);
  });

  await t.test("login with wrong password shows login-error", async () => {
    const res = await fetch(`${base}${ROUTES.login}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        email: "reviewer@getsolari.com",
        password: "wrong",
      }).toString(),
      redirect: "manual",
    });
    const html = await res.text();
    assert.match(html, /data-testid="login-error"/);
  });

  await t.test("login ok sets cookie and redirects home", async () => {
    const res = await fetch(`${base}${ROUTES.login}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        email: "reviewer@getsolari.com",
        password: "reviewer",
      }).toString(),
      redirect: "manual",
    });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), ROUTES.home);
    const setCookie = res.headers.get("set-cookie") ?? "";
    assert.match(setCookie, /sid=[^;]+/);
    assert.match(setCookie, /HttpOnly/);
    cookie = setCookie.split(";")[0]!;
  });

  await t.test("zip download matches the pinned sha256 golden", async () => {
    const res = await authedFetch(ROUTES.invoicesZip);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /application\/zip/);
    assert.match(
      res.headers.get("content-disposition") ?? "",
      /filename="2026-06\.zip"/,
    );
    const body = Buffer.from(await res.arrayBuffer());
    const sha = createHash("sha256").update(body).digest("hex");
    assert.equal(sha, GOLDEN_SHA256);
  });

  await t.test("/close/last before any upload is 404", async () => {
    const res = await authedFetch(ROUTES.closeLast);
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { ok: false });
  });

  await t.test("pdf upload round-trips through /close/last", async () => {
    const pdfBytes = Buffer.from("%PDF-1.4\nfake close pack\n%%EOF\n");
    const boundary = "noapitestboundary";
    const multipart = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\n` +
          'content-disposition: form-data; name="file"; filename="close-pack.pdf"\r\n' +
          "content-type: application/pdf\r\n\r\n",
      ),
      pdfBytes,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const res = await authedFetch(ROUTES.closeSubmit, {
      method: "POST",
      headers: {
        "content-type": `multipart/form-data; boundary=${boundary}`,
      },
      body: multipart,
    });
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /data-testid="upload-status"/);
    assert.match(html, /accepted/);

    const last = await authedFetch(ROUTES.closeLast);
    assert.equal(last.status, 200);
    const payload = (await last.json()) as {
      ok: boolean;
      filename: string;
      bytes: number;
      sha256: string;
      receivedAt: string;
    };
    assert.equal(payload.ok, true);
    assert.equal(payload.filename, "close-pack.pdf");
    assert.equal(payload.bytes, pdfBytes.length);
    assert.equal(
      payload.sha256,
      createHash("sha256").update(pdfBytes).digest("hex"),
    );
    assert.ok(!Number.isNaN(Date.parse(payload.receivedAt)));
  });

  await t.test("non-pdf upload is rejected", async () => {
    const boundary = "noapitestboundary";
    const multipart = Buffer.from(
      `--${boundary}\r\n` +
        'content-disposition: form-data; name="file"; filename="evil.exe"\r\n\r\n' +
        "nope\r\n" +
        `--${boundary}--\r\n`,
    );
    const res = await authedFetch(ROUTES.closeSubmit, {
      method: "POST",
      headers: {
        "content-type": `multipart/form-data; boundary=${boundary}`,
      },
      body: multipart,
    });
    assert.equal(res.status, 400);
  });

  await t.test("oversized upload is rejected with 413 (body cap)", async () => {
    const boundary = "noapitestboundary";
    const big = Buffer.alloc(26 * 1024 * 1024, 0x41); // 26 MiB > 25 MiB cap
    const multipart = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\n` +
          'content-disposition: form-data; name="file"; filename="huge.pdf"\r\n' +
          "content-type: application/pdf\r\n\r\n",
      ),
      big,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const res = await authedFetch(ROUTES.closeSubmit, {
      method: "POST",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      body: multipart,
    });
    assert.equal(res.status, 413);
  });
});

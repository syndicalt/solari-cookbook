/**
 * NOAPI fake vendor portal — plain node:http, zero dependencies.
 *
 * Seeded reviewer login, a monthly invoice zip (deterministic bytes from
 * `./zip.ts`, pinned by `fixtures/invoices.sha256`), and a close-pack PDF
 * upload endpoint. Sessions are an in-memory Map keyed by a randomUUID
 * HttpOnly `sid` cookie; nothing here is durable or secure by design — it
 * exists so the browser surface has a site with no clean API to drive.
 *
 * All selectors/routes come from `./selectors.ts`, which the browser
 * surface also imports, so the two cannot drift.
 */
import { createHash, randomUUID } from "node:crypto";
import type { Server, IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { PORTAL_BANNER_TEXT, ROUTES } from "./selectors.ts";
import { buildInvoicesZip } from "./zip.ts";

/** Options accepted by {@link createPortal}. */
export interface PortalOptions {
  /** Port to listen on; 0 picks an ephemeral port. Default 8787. */
  port?: number;
  /** Seeded login email. Default reviewer@getsolari.com. */
  user?: string;
  /** Seeded login password. Default reviewer. */
  password?: string;
}

/** Handle returned by {@link createPortal}. */
export interface PortalHandle {
  server: Server;
  /** The actual bound port (resolved after listen, so port 0 works). */
  port: number;
  /** Close the server; resolves once connections drain. */
  close: () => Promise<void>;
}

/** In-memory record of the last accepted close-pack upload. */
export interface UploadRecord {
  filename: string;
  bytes: number;
  sha256: string;
  receivedAt: string;
}

const COOKIE_NAME = "sid";

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>
<body>
<header data-testid="portal-banner" style="background:#111;color:#fff;padding:8px">${PORTAL_BANNER_TEXT}</header>
<main>
${body}
</main>
</body>
</html>
`;
}

function loginPage(error: boolean): string {
  return page(
    "sign in",
    `<h1>vendor portal sign in</h1>
${error ? '<p data-testid="login-error">invalid email or password</p>' : ""}
<form method="post" action="${ROUTES.login}">
  <label>email <input type="email" name="email" data-testid="login-email" required></label>
  <label>password <input type="password" name="password" data-testid="login-password" required></label>
  <button type="submit" data-testid="login-submit">sign in</button>
</form>`,
  );
}

function homePage(): string {
  return page(
    "home",
    `<h1>monthly close</h1>
<ul>
  <li><a href="${ROUTES.invoices}">june 2026 invoices</a></li>
  <li><a href="${ROUTES.closeSubmit}">submit close pack</a></li>
</ul>`,
  );
}

function invoicesPage(names: string[]): string {
  const items = names.map((name) => `<li>${escapeHtml(name)}</li>`).join("\n");
  return page(
    "invoices",
    `<h1>invoices — 2026-06</h1>
<ul>
${items}
</ul>
<p><a href="${ROUTES.invoicesZip}" data-testid="invoices-download">download all (zip)</a></p>`,
  );
}

function submitPage(status: string | null): string {
  return page(
    "submit close pack",
    `<h1>submit close pack</h1>
${status ? `<p data-testid="upload-status">${escapeHtml(status)}</p>` : ""}
<form method="post" action="${ROUTES.closeSubmit}" enctype="multipart/form-data">
  <input type="file" name="file" data-testid="upload-file" accept="application/pdf" required>
  <button type="submit" data-testid="upload-submit">upload</button>
</form>`,
  );
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

interface MultipartFile {
  filename: string;
  data: Buffer;
}

/**
 * Hand-rolled single-file multipart/form-data parser. Only good enough for
 * one file field per request, which is all the upload form sends.
 */
function parseMultipart(body: Buffer, contentType: string): MultipartFile | null {
  const match = /boundary=(?:"([^"]+)"|([^\s;]+))/.exec(contentType);
  const boundary = match?.[1] ?? match?.[2];
  if (!boundary) return null;
  const delimiter = Buffer.from(`--${boundary}`);
  const start = body.indexOf(delimiter);
  if (start < 0) return null;
  const headerEnd = body.indexOf("\r\n\r\n", start);
  if (headerEnd < 0) return null;
  const headerBlock = body.subarray(start, headerEnd).toString("latin1");
  const nameMatch = /filename="([^"]*)"/.exec(headerBlock);
  if (!nameMatch || !nameMatch[1]) return null;
  const dataStart = headerEnd + 4;
  let dataEnd = body.indexOf(delimiter, dataStart);
  if (dataEnd < 0) return null;
  dataEnd -= 2; // strip the \r\n immediately before the closing boundary
  return { filename: nameMatch[1], data: body.subarray(dataStart, dataEnd) };
}

/**
 * Create and start the portal. Resolves once the server is listening.
 */
export async function createPortal(options: PortalOptions = {}): Promise<PortalHandle> {
  const port = options.port ?? Number(process.env.NOAPI_PORTAL_PORT ?? process.env.PORT ?? 8787);
  const user = options.user ?? process.env.NOAPI_PORTAL_USER ?? "reviewer@getsolari.com";
  const password = options.password ?? process.env.NOAPI_PORTAL_PASSWORD ?? "reviewer";

  const sessions = new Map<string, { user: string }>();
  const zip = buildInvoicesZip();
  const invoiceNames = [
    "INV-2026-06-001.txt",
    "INV-2026-06-002.txt",
    "INV-2026-06-003.txt",
    "INV-2026-06-004.txt",
    "INV-2026-06-005.txt",
  ];
  let lastUpload: UploadRecord | null = null;

  const authedUser = (req: IncomingMessage): string | null => {
    const cookie = req.headers.cookie ?? "";
    for (const part of cookie.split(";")) {
      const [name, ...rest] = part.trim().split("=");
      if (name === COOKIE_NAME) {
        const session = sessions.get(rest.join("="));
        if (session) return session.user;
      }
    }
    return null;
  };

  const sendHtml = (res: ServerResponse, status: number, html: string): void => {
    res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  };

  const sendJson = (res: ServerResponse, status: number, payload: unknown): void => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
  };

  /** Unauthed HTML requests bounce to /login; API-ish requests get 401 JSON. */
  const rejectUnauthed = (res: ServerResponse, json: boolean): void => {
    if (json) {
      sendJson(res, 401, { ok: false, error: "unauthorized" });
    } else {
      res.writeHead(302, { location: ROUTES.login });
      res.end();
    }
  };

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname;
      const method = req.method ?? "GET";
      const who = authedUser(req);

      if (method === "GET" && path === ROUTES.login) {
        sendHtml(res, 200, loginPage(false));
        return;
      }

      if (method === "POST" && path === ROUTES.login) {
        const body = (await readBody(req)).toString("utf8");
        const form = new URLSearchParams(body);
        if (form.get("email") === user && form.get("password") === password) {
          const sid = randomUUID();
          sessions.set(sid, { user });
          res.writeHead(302, {
            location: ROUTES.home,
            "set-cookie": `${COOKIE_NAME}=${sid}; HttpOnly; Path=/`,
          });
          res.end();
        } else {
          sendHtml(res, 401, loginPage(true));
        }
        return;
      }

      if (method === "GET" && path === ROUTES.home) {
        if (!who) return rejectUnauthed(res, false);
        sendHtml(res, 200, homePage());
        return;
      }

      if (method === "GET" && path === ROUTES.invoices) {
        if (!who) return rejectUnauthed(res, false);
        sendHtml(res, 200, invoicesPage(invoiceNames));
        return;
      }

      if (method === "GET" && path === ROUTES.invoicesZip) {
        if (!who) return rejectUnauthed(res, true);
        res.writeHead(200, {
          "content-type": "application/zip",
          "content-disposition": 'attachment; filename="2026-06.zip"',
          "content-length": zip.length,
        });
        res.end(zip);
        return;
      }

      if (method === "GET" && path === ROUTES.closeSubmit) {
        if (!who) return rejectUnauthed(res, false);
        sendHtml(res, 200, submitPage(null));
        return;
      }

      if (method === "POST" && path === ROUTES.closeSubmit) {
        if (!who) return rejectUnauthed(res, false);
        const body = await readBody(req);
        const file = parseMultipart(body, req.headers["content-type"] ?? "");
        if (!file || !file.filename.toLowerCase().endsWith(".pdf")) {
          sendHtml(res, 400, submitPage("rejected: a .pdf file is required"));
          return;
        }
        const sha256 = createHash("sha256").update(file.data).digest("hex");
        lastUpload = {
          filename: file.filename,
          bytes: file.data.length,
          sha256,
          receivedAt: new Date().toISOString(),
        };
        sendHtml(res, 200, submitPage(`accepted ${sha256.slice(0, 12)}`));
        return;
      }

      if (method === "GET" && path === ROUTES.closeLast) {
        if (!who) return rejectUnauthed(res, true);
        if (!lastUpload) {
          sendJson(res, 404, { ok: false });
          return;
        }
        sendJson(res, 200, { ok: true, ...lastUpload });
        return;
      }

      sendHtml(res, 404, page("not found", "<h1>404</h1>"));
    })().catch((err: unknown) => {
      console.error("portal.error", err);
      if (!res.headersSent) {
        sendJson(res, 500, { ok: false, error: "internal" });
      } else {
        res.end();
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  const boundPort = typeof address === "object" && address ? address.port : port;
  console.log(`portal.listen port=${boundPort}`);

  return {
    server,
    port: boundPort,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

/** CLI entrypoint: `node apps/portal/server.ts` (see `make portal`). */
export async function main(): Promise<void> {
  await createPortal();
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  void main();
}

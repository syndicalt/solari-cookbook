/**
 * Portal selectors — the single source of truth shared by the fake vendor
 * portal (`apps/portal/server.ts`) and the browser surface actions
 * (`src/actions/*`). Both sides import from here so the demo cannot drift:
 * if a selector changes, the portal and the agent change together.
 *
 * Every interactive element carries a stable `data-testid`; the agent drives
 * the portal the way a human would, not through hidden endpoints.
 */
export const SELECTORS = {
  /** Email input on /login. */
  loginEmail: '[data-testid="login-email"]',
  /** Password input on /login. */
  loginPassword: '[data-testid="login-password"]',
  /** Submit button on /login. */
  loginSubmit: '[data-testid="login-submit"]',
  /** Visible error banner after a failed login. */
  loginError: '[data-testid="login-error"]',
  /** Banner present on every authed page: "NOAPI VENDOR PORTAL". */
  portalBanner: '[data-testid="portal-banner"]',
  /** Download link for the monthly invoice zip on /invoices. */
  invoicesDownload: '[data-testid="invoices-download"]',
  /** File input on /close/submit. */
  uploadFile: '[data-testid="upload-file"]',
  /** Submit button on /close/submit. */
  uploadSubmit: '[data-testid="upload-submit"]',
  /** Status line shown after a successful upload. */
  uploadStatus: '[data-testid="upload-status"]',
} as const;

export type SelectorName = keyof typeof SELECTORS;

/** Portal route paths, shared for the same reason as the selectors. */
export const ROUTES = {
  login: "/login",
  home: "/",
  invoices: "/invoices",
  invoicesZip: "/invoices/2026-06.zip",
  closeSubmit: "/close/submit",
  closeLast: "/close/last",
} as const;

/** The banner text that must be visible in screenshots and recordings. */
export const PORTAL_BANNER_TEXT = "NOAPI VENDOR PORTAL";

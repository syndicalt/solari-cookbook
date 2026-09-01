/**
 * Portal URL joining.
 *
 * When the portal is exposed via a sandbox `previewUrl`, the gateway puts an
 * auth token in the query string (`?pt_token=...`) and 401s every request
 * that lacks it. Naive `origin + path` concatenation appends the path AFTER
 * the query and breaks. This helper joins properly, preserving the query.
 */
export function portalUrl(origin: string, path: string): string {
  const u = new URL(origin);
  u.pathname = path;
  return u.toString();
}

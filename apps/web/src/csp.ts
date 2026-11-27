/**
 * The dashboard's Content-Security-Policy (R3-03).
 *
 * Served by Caddy in production (`deploy/Caddyfile`) and by `vite preview`, so
 * the browser suite runs under exactly this policy. A unit test keeps the
 * Caddyfile identical to this constant.
 *
 * - Scripts and style sheets: this origin only. The build has one module
 *   script and one style sheet and no inline code, and nothing uses `eval`.
 * - The one documented exception: `style-src-attr 'unsafe-inline'`, for the
 *   inline `style` attributes React components use. It covers attributes only;
 *   `<style>` elements and style sheets stay `'self'`.
 * - No plugins, no `<base>` rewriting, forms post only here, and the dashboard
 *   cannot be framed.
 *
 * The Vite dev server is deliberately left without it: hot reload needs inline
 * scripts.
 */
export const DASHBOARD_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "style-src-attr 'unsafe-inline'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ')

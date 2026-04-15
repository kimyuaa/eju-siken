/**
 * Optional: when static files and the API are on different hosts (e.g. GitHub Pages + Railway),
 * set the full report endpoint URL (must end with /api/report or we append it in app.js).
 *
 * Monolith (same server serves HTML + /api): leave unset.
 *
 * Example:
 * window.__REPORT_API_URL__ = "https://your-service.up.railway.app/api/report";
 */

// Default wiring for GitHub Pages (static host) -> Railway (API host).
// This prevents 405 Method Not Allowed when the browser tries POST /api/report on github.io.
try {
  if (typeof window !== "undefined" && window.location && window.location.hostname.endsWith(".github.io")) {
    window.__REPORT_API_URL__ = "https://eju-siken-production.up.railway.app/api/report";
  }
} catch {
  // ignore
}

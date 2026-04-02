/**
 * wake-page.ts – Cold-start loading page served while the container boots.
 *
 * Shown to browser visitors when the container is not yet running or not yet
 * ready to serve requests.  The page:
 *   - Shows a branded PiClaw loading animation.
 *   - Auto-refreshes via meta-refresh every 3 seconds.
 *   - Also polls /_cf/health via fetch and redirects as soon as 200 is returned.
 *   - Shows elapsed time so the user knows something is happening.
 */

export const WAKE_PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="refresh" content="3">
  <title>PiClaw — Starting up…</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #0f1117;
      color: #e4e4e7;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      text-align: center;
    }
    .container { max-width: 420px; padding: 2rem; }
    .logo {
      width: 64px; height: 64px;
      margin: 0 auto 1.5rem;
      border-radius: 16px;
      background: linear-gradient(135deg, #6366f1, #8b5cf6);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 28px;
      animation: pulse 2s ease-in-out infinite;
    }
    @keyframes pulse {
      0%, 100% { transform: scale(1); opacity: 1; }
      50% { transform: scale(1.06); opacity: 0.85; }
    }
    h1 { font-size: 1.25rem; font-weight: 600; margin-bottom: 0.5rem; }
    p { color: #a1a1aa; font-size: 0.9rem; line-height: 1.5; }
    .spinner {
      margin: 1.5rem auto;
      width: 28px; height: 28px;
      border: 3px solid rgba(255,255,255,0.1);
      border-top-color: #8b5cf6;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .elapsed { color: #71717a; font-size: 0.8rem; margin-top: 1rem; font-variant-numeric: tabular-nums; }
    .status { color: #a1a1aa; font-size: 0.8rem; margin-top: 0.25rem; }
  </style>
</head>
<body>
  <div class="container">
    <div class="logo">🦀</div>
    <h1>PiClaw is waking up</h1>
    <p>The workspace container is starting. This usually takes a few seconds.</p>
    <div class="spinner"></div>
    <div class="elapsed" id="elapsed"></div>
    <div class="status" id="status">Waiting for container…</div>
  </div>
  <script>
    const start = Date.now();
    const $elapsed = document.getElementById("elapsed");
    const $status = document.getElementById("status");

    function fmt(ms) {
      const s = Math.floor(ms / 1000);
      return s < 60 ? s + "s" : Math.floor(s / 60) + "m " + (s % 60) + "s";
    }

    // Update elapsed timer every second
    setInterval(() => {
      $elapsed.textContent = fmt(Date.now() - start) + " elapsed";
    }, 1000);

    // Poll for readiness — redirect as soon as the container is healthy
    let checking = false;
    async function check() {
      if (checking) return;
      checking = true;
      try {
        const res = await fetch(location.href, {
          method: "HEAD",
          cache: "no-store",
          headers: { "X-CF-Wake-Poll": "1" },
        });
        if (res.ok && !res.headers.get("content-type")?.includes("text/html")) {
          // Container is serving real responses — reload to get the actual page
          $status.textContent = "Ready! Redirecting…";
          location.reload();
          return;
        }
        // Also try the health endpoint directly
        const health = await fetch("/_cf/health", { cache: "no-store" });
        if (health.ok) {
          $status.textContent = "Ready! Redirecting…";
          location.reload();
          return;
        }
        $status.textContent = "Container starting…";
      } catch {
        $status.textContent = "Waiting for container…";
      } finally {
        checking = false;
      }
    }

    // Poll every 2 seconds (meta-refresh at 3s is the fallback)
    setInterval(check, 2000);
    // First check after 1 second
    setTimeout(check, 1000);
  </script>
</body>
</html>`;

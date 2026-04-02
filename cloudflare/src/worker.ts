/**
 * worker.ts – Cloudflare Worker entry point for PiClawFlare.
 *
 * This is the always-on gateway that routes all traffic to the PiClaw
 * container.  It is intentionally thin — the Worker does almost nothing,
 * which means:
 *
 *   - **Every HTTP request automatically wakes the container.**
 *     Extension-registered routes, remote interop endpoints, user-built
 *     webhooks, and any future upstream endpoints all work without
 *     per-endpoint sleep/wake plumbing.
 *
 *   - **Cron trigger provides belt-and-suspenders alarm fallback.**
 *     Fires every minute and asks the DO to check for missed alarms.
 *
 * Exports:
 *   - `default` — Worker handlers (fetch, scheduled).
 *   - `PiClawContainer` — re-exported DO class for wrangler binding.
 */

import type { Env } from "./env.js";

// Re-export the Durable Object class so wrangler can bind it.
export { PiClawContainer } from "./container.js";

export default {
  /**
   * All HTTP requests are forwarded to the PiClawContainer Durable Object.
   *
   * The DO manages container lifecycle (start, wake, sleep, proxy).
   * Because this is a single-user application, we use a stable name
   * (`PICLAW_CF_CONTAINER_NAME`, default "piclaw-main") to always route
   * to the same container instance.
   */
  async fetch(request: Request, env: Env): Promise<Response> {
    const containerName = env.PICLAW_CF_CONTAINER_NAME || "piclaw-main";
    const id = env.PICLAW_CONTAINER.idFromName(containerName);
    const stub = env.PICLAW_CONTAINER.get(id);
    return stub.fetch(request);
  },

  /**
   * Cron trigger: fires every minute (configured in wrangler.jsonc).
   *
   * Acts as a belt-and-suspenders fallback for scheduled task wake-ups.
   * The DO checks whether any alarms were missed or need to be synced.
   * This ensures no scheduled task is delayed by more than ~1 minute,
   * even if a DO alarm was somehow lost.
   */
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    const containerName = env.PICLAW_CF_CONTAINER_NAME || "piclaw-main";
    const id = env.PICLAW_CONTAINER.idFromName(containerName);
    const stub = env.PICLAW_CONTAINER.get(id);

    try {
      await stub.fetch(
        new Request("http://internal/_cf/scheduled-check", { method: "POST" }),
      );
    } catch (err) {
      // Cron failures are retried by the platform.  Log for observability.
      console.error("[Worker] scheduled check failed:", err);
    }
  },
};

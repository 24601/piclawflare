/**
 * container.ts – PiClawContainer Durable Object.
 *
 * Extends the Cloudflare `Container` class to manage the PiClaw container
 * lifecycle:
 *   - Automatic sleep after configurable inactivity (`sleepAfter`).
 *   - Wake-on-demand for any HTTP request (inherent in the Container class).
 *   - Built-in `schedule()` for scheduled task wake-ups.
 *   - `onActivityExpired()` queries container activity before shutting down.
 *   - Cold-start loading page while the container boots.
 *   - WhatsApp keep-awake mode that disables sleeping.
 *   - Cron-trigger scheduled check as fallback for missed alarms.
 *
 * The container-side PiClaw process exposes internal `/_cf/*` endpoints
 * that the DO uses for health checks, activity queries, alarm registration,
 * and task triggers.
 */

import { Container } from "@cloudflare/containers";
import type { Env } from "./env.js";
import { WAKE_PAGE_HTML } from "./wake-page.js";

/** Callback name used by schedule() for scheduled task wake-ups. */
const TASK_WAKE_CALLBACK = "onTaskWake";

/**
 * PiClaw Container Durable Object.
 *
 * Each instance manages a single PiClaw container (single-user application).
 * The Worker routes all requests here; this class handles lifecycle decisions
 * (start, sleep, wake, alarm) and proxies HTTP to the container.
 */
export class PiClawContainer extends Container<Env> {
  // ── Container class configuration ─────────────────────────────

  /** Default port where PiClaw's Bun HTTP server listens inside the container. */
  defaultPort = 8080;

  /**
   * How long to keep the container alive after the last request.
   * In `keep-awake` mode (WhatsApp Baileys), effectively never sleeps.
   */
  override get sleepAfter(): string | number {
    if (this.isKeepAwake()) return "999d";
    return this.env.PICLAW_CF_SLEEP_AFTER || "10m";
  }

  // ── Lifecycle hooks ───────────────────────────────────────────

  override onStart(): void {
    console.log("[PiClawContainer] Container started");
  }

  override onStop(params: { exitCode: number; reason: string }): void {
    console.log(
      `[PiClawContainer] Container stopped: ${params.reason} (exit ${params.exitCode})`,
    );
  }

  override onError(error: unknown): void {
    console.error(`[PiClawContainer] Container error:`, error);
  }

  /**
   * Called when the `sleepAfter` inactivity timeout expires.
   *
   * Before shutting down, we query the container's activity endpoint.
   * If the container is busy (agent run, terminal session, autoresearch,
   * etc.), we renew the timeout instead of stopping.
   *
   * If the container reports idle, we tell it to prepare for sleep
   * (flush SQLite WAL, save state) before letting the base class stop it.
   */
  override async onActivityExpired(): Promise<void> {
    // In keep-awake mode, never stop.
    if (this.isKeepAwake()) {
      this.renewActivityTimeout();
      return;
    }

    try {
      const resp = await this.internalFetch("/_cf/activity");
      if (resp.ok) {
        const data: unknown = await resp.json();
        if (data && typeof data === "object" && "idle" in data) {
          if ((data as { idle: boolean }).idle === false) {
            // Container is busy — renew timeout and check again later.
            this.renewActivityTimeout();
            return;
          }
        } else {
          // Unexpected response format — assume busy to be safe.
          console.warn("[PiClawContainer] Unexpected /_cf/activity response:", data);
          this.renewActivityTimeout();
          return;
        }
      }
    } catch {
      // Can't reach container — it may already be stopped. Let it go.
    }

    // Container is idle. Ask it to prepare for sleep.
    try {
      await this.internalFetch("/_cf/prepare-sleep", { method: "POST" });
    } catch {
      // Best effort — container may already be shutting down.
    }

    // Now let the base class stop the container.
    await this.stop();
  }

  // ── Request handling ──────────────────────────────────────────

  /**
   * All requests flow through here.  The base `Container.fetch()` handles
   * sleep-timer resets and proxying.  We intercept a few internal paths and
   * add a cold-start loading page for browser visitors.
   */
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    // ── Internal DO-level endpoints (not proxied to container) ──
    if (pathname === "/_cf/alarm/register" || pathname === "/_cf/scheduled-check") {
      if (!this.isInternalAuthorized(request)) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (pathname === "/_cf/alarm/register") {
        return this.handleAlarmRegistration(request);
      }
      return this.handleScheduledCheck();
    }

    // ── Check container state ──────────────────────────────────
    const state = await this.getState();

    if (state.status !== "running" && state.status !== "healthy") {
      // Container is not running — start it.
      try {
        await this.start();
      } catch (err) {
        console.error("[PiClawContainer] Failed to start container:", err);
      }

      // For browser requests, show the loading page immediately.
      if (this.acceptsHtml(request)) {
        return this.serveWakePage();
      }

      // For API requests, wait for the container to become healthy.
      const ready = await this.waitForReady(30_000);
      if (!ready) {
        return new Response(
          JSON.stringify({ error: "Container did not become ready in time." }),
          { status: 503, headers: { "Content-Type": "application/json" } },
        );
      }
    }

    // ── Proxy to container (base class handles sleep timer) ────
    return super.fetch(request);
  }

  // ── Scheduled task callback ───────────────────────────────────

  /**
   * Callback invoked by the Container `schedule()` system when a scheduled
   * task wake-up fires.  Starts the container if needed and triggers the
   * container-side scheduler to check for due tasks.
   */
  async onTaskWake(_payload: string): Promise<void> {
    try {
      // Ensure container is running (schedule fires even if container is stopped).
      const state = await this.getState();
      if (state.status !== "running" && state.status !== "healthy") {
        await this.start();
        await this.waitForReady(30_000);
      }
      await this.internalFetch("/_cf/tasks/due", { method: "POST" });
    } catch (err) {
      console.error("[PiClawContainer] onTaskWake failed:", err);
    }
    // Sync the next alarm so we wake up for the next task too.
    await this.syncNextAlarm();
  }

  // ── Internal endpoints (DO-level, not proxied) ────────────────

  /**
   * `POST /_cf/alarm/register` — container-side subsystems call this to
   * request a future wake-up at a specific time.
   *
   * Body: `{ "nextWakeAt": "<ISO-8601 timestamp>" }`
   *
   * Uses the Container class `schedule()` method which is backed by DO
   * storage and survives hibernation.
   */
  private async handleAlarmRegistration(req: Request): Promise<Response> {
    try {
      const body = (await req.json()) as { nextWakeAt?: string };
      const wakeAt = body?.nextWakeAt ? new Date(body.nextWakeAt).getTime() : NaN;
      if (!isFinite(wakeAt) || wakeAt <= Date.now()) {
        return this.jsonResponse(
          { ok: false, error: "Invalid or past nextWakeAt." },
          400,
        );
      }

      const wakeDate = new Date(wakeAt);
      await this.schedule(wakeDate, TASK_WAKE_CALLBACK, "task-wake");

      return this.jsonResponse({
        ok: true,
        alarmAt: wakeDate.toISOString(),
      });
    } catch (err) {
      return this.jsonResponse({ ok: false, error: String(err) }, 500);
    }
  }

  /**
   * `GET/POST /_cf/scheduled-check` — called by the Worker's cron trigger
   * every minute as a belt-and-suspenders fallback.
   *
   * If the container is running, syncs the next alarm from the container's
   * task schedule.
   */
  private async handleScheduledCheck(): Promise<Response> {
    try {
      const state = await this.getState();
      if (state.status === "running" || state.status === "healthy") {
        await this.syncNextAlarm();
        return this.jsonResponse({ ok: true, action: "synced" });
      }

      // Container not running. Check if there are pending schedules that
      // should fire now — if so, wake the container.
      const schedules = await this.listSchedules(TASK_WAKE_CALLBACK);
      const now = Date.now();
      const overdue = schedules.some((s) => s.time <= now);
      if (overdue) {
        await this.onTaskWake("cron-fallback");
        return this.jsonResponse({ ok: true, action: "alarm_fired" });
      }

      return this.jsonResponse({ ok: true, action: "noop" });
    } catch (err) {
      return this.jsonResponse({ ok: false, error: String(err) }, 500);
    }
  }

  // ── Helpers ───────────────────────────────────────────────────

  /**
   * Query the container's `/_cf/tasks/next-due` endpoint and schedule a
   * wake-up for the next task.
   */
  private async syncNextAlarm(): Promise<void> {
    try {
      const resp = await this.internalFetch("/_cf/tasks/next-due");
      if (!resp.ok) return;
      const data = (await resp.json()) as { nextRunAt?: string | null };
      if (!data?.nextRunAt) return;
      const nextMs = new Date(data.nextRunAt).getTime();
      if (!isFinite(nextMs) || nextMs <= Date.now()) return;

      await this.schedule(
        new Date(nextMs),
        TASK_WAKE_CALLBACK,
        "task-wake",
      );
    } catch {
      // Container may not be ready — cron will retry next minute.
    }
  }

  /**
   * Poll the container's `/_cf/health` endpoint until it returns 200 or
   * the timeout expires.  Returns `true` if the container is ready.
   */
  private async waitForReady(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const resp = await this.internalFetch("/_cf/health");
        if (resp.ok) return true;
      } catch {
        // Not ready yet.
      }
      await new Promise((r) => setTimeout(r, 1_000));
    }
    return false;
  }

  /**
   * Make an HTTP request to the container's internal port.
   * Includes the internal secret header when configured.
   */
  private async internalFetch(
    path: string,
    init?: RequestInit,
  ): Promise<Response> {
    const port = this.ctx.container.getTcpPort(this.defaultPort);
    const headers = new Headers(init?.headers);
    if (this.env.PICLAW_CF_INTERNAL_SECRET) {
      headers.set("x-cf-internal-secret", this.env.PICLAW_CF_INTERNAL_SECRET);
    }
    return port.fetch(`http://localhost${path}`, {
      ...init,
      headers,
    });
  }

  /** Check if the request carries the correct internal secret. */
  private isInternalAuthorized(req: Request): boolean {
    const expected = this.env.PICLAW_CF_INTERNAL_SECRET;
    if (!expected) return true; // No secret configured — allow (dev mode).
    return req.headers.get("x-cf-internal-secret") === expected;
  }

  /** Whether the WhatsApp keep-awake mode is active. */
  private isKeepAwake(): boolean {
    const mode = (this.env.PICLAW_CF_WHATSAPP_MODE || "")
      .trim()
      .toLowerCase();
    return (
      mode === "keep-awake" || mode === "keep_awake" || mode === "keepawake"
    );
  }

  /** Whether the request is from a browser expecting HTML. */
  private acceptsHtml(req: Request): boolean {
    const accept = req.headers.get("accept") || "";
    return accept.includes("text/html");
  }

  /** Serve the cold-start loading page. */
  private serveWakePage(): Response {
    return new Response(WAKE_PAGE_HTML, {
      status: 503,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Retry-After": "5",
        "Cache-Control": "no-store",
      },
    });
  }

  /** Build a JSON response with optional status code. */
  private jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }
}

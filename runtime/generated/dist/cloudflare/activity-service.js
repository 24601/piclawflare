/**
 * cloudflare/activity-service.ts – Central activity/idle detection for Cloudflare Containers.
 *
 * The ActivityService is a passive registry that tracks all ongoing work in the
 * PiClaw process.  Subsystems register/unregister activity signals when they
 * start/finish work.  The Durable Object queries the service's HTTP endpoint
 * (`/_cf/activity`) to decide whether the container is safe to sleep.
 *
 * Design principles:
 *   - **Passive**: the service never decides to sleep — it only reports status.
 *   - **No-op when disabled**: `getActivityService()` returns null when CF mode
 *     is off.  Subsystem integrations check for null and skip the call.
 *   - **SSE-aware**: SSE connections alone do not prevent sleep after the
 *     configurable SSE idle timeout — real user interaction resets the timer.
 *   - **Forward-compatible**: new activity kinds can be added by any subsystem
 *     or extension without changing this module.
 *
 * Consumers:
 *   - `cloudflare/cf-endpoints.ts` exposes the status via `GET /_cf/activity`.
 *   - `runtime/bootstrap.ts` creates the singleton at startup when CF mode is on.
 *   - Agent pool, task scheduler, SSE hub, terminal/VNC services, IPC watcher,
 *     autoresearch supervisor, and media upload handlers register/unregister.
 */
import { createLogger } from "../utils/logger.js";
const log = createLogger("cloudflare.activity");
// ---------------------------------------------------------------------------
// ActivityService implementation
// ---------------------------------------------------------------------------
export class ActivityService {
    sseIdleTimeoutMs;
    activities = new Map();
    lastUserInteraction = Date.now();
    idleSince = Date.now();
    /**
     * SSE idle timeout in milliseconds.  SSE connections alone do not prevent
     * sleep after this duration without a real user interaction.
     */
    constructor(sseIdleTimeoutMs = 300_000) {
        this.sseIdleTimeoutMs = sseIdleTimeoutMs;
    }
    // ── Registration ──────────────────────────────────────────────
    /** Register an ongoing activity that should prevent container sleep. */
    register(signal) {
        this.activities.set(signal.id, signal);
        this.idleSince = null;
    }
    /** Unregister a completed activity. */
    unregister(id) {
        this.activities.delete(id);
        if (this.activities.size === 0 || this.onlySseClientsRemain()) {
            this.idleSince = this.idleSince ?? Date.now();
        }
    }
    // ── User interaction tracking ─────────────────────────────────
    /**
     * Mark that a real user interaction occurred (any HTTP request that is
     * not an SSE connection or a heartbeat).  Resets the SSE idle timer.
     */
    touchUserInteraction() {
        this.lastUserInteraction = Date.now();
    }
    // ── Queries ───────────────────────────────────────────────────
    /**
     * Whether the container is currently idle (safe to sleep).
     *
     * The service considers the container idle when:
     *   - No non-SSE activities are registered, AND
     *   - Either no SSE clients are connected, OR the SSE idle timeout has
     *     elapsed since the last real user interaction.
     */
    isIdle() {
        const nonSse = this.getNonSseActivities();
        if (nonSse.length > 0)
            return false;
        const sseClients = this.getSseActivities();
        if (sseClients.length === 0)
            return true;
        // SSE clients are connected but no other work is happening.
        // Check if the user has interacted recently enough.
        const sinceLastInteraction = Date.now() - this.lastUserInteraction;
        return sinceLastInteraction >= this.sseIdleTimeoutMs;
    }
    /** Return a full status snapshot for the `/_cf/activity` endpoint. */
    getStatus() {
        const idle = this.isIdle();
        return {
            idle,
            activities: Array.from(this.activities.values()),
            idleSinceMs: idle && this.idleSince ? Date.now() - this.idleSince : null,
            lastUserInteractionMs: this.lastUserInteraction,
        };
    }
    /** Return the number of currently registered activities. */
    get size() {
        return this.activities.size;
    }
    // ── Internal helpers ──────────────────────────────────────────
    getNonSseActivities() {
        return Array.from(this.activities.values()).filter((s) => s.kind !== "sse_client");
    }
    getSseActivities() {
        return Array.from(this.activities.values()).filter((s) => s.kind === "sse_client");
    }
    onlySseClientsRemain() {
        return Array.from(this.activities.values()).every((s) => s.kind === "sse_client");
    }
}
// ---------------------------------------------------------------------------
// Singleton management
// ---------------------------------------------------------------------------
let instance = null;
/**
 * Return the global ActivityService instance, or null if CF mode is disabled.
 * Subsystems should check for null and skip activity tracking when off.
 */
export function getActivityService() {
    return instance;
}
/**
 * Create and store the global ActivityService.  Called once at startup by
 * `runtime/bootstrap.ts` when `PICLAW_CF_ENABLED` is true.
 */
export function createActivityService(sseIdleTimeoutMs) {
    const resolvedTimeout = sseIdleTimeoutMs ?? 300_000;
    instance = new ActivityService(resolvedTimeout);
    log.info("Activity service created", {
        operation: "create_activity_service",
        sseIdleTimeoutMs: resolvedTimeout,
    });
    return instance;
}
/**
 * Destroy the global ActivityService (for tests).
 */
export function destroyActivityService() {
    instance = null;
}

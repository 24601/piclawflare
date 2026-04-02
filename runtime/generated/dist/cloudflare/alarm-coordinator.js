/**
 * cloudflare/alarm-coordinator.ts – Bridges timer-based subsystems to DO alarms.
 *
 * When a subsystem needs the container to be awake at a future time (e.g. the
 * task scheduler computes `next_run`), it calls `registerWakeUp()`.  The
 * coordinator POSTs to the DO's `/_cf/alarm/register` endpoint which sets a
 * persistent DO alarm.  When the alarm fires, the DO wakes the container.
 *
 * This is the key forward-compatibility mechanism for timers: any subsystem
 * (task scheduler, future cron, future event-driven triggers) just calls
 * `registerWakeUp(source, isoTime)` and the rest is automatic.
 *
 * Design:
 *   - Deduplication: keeps track of the earliest registered wake-up and only
 *     sends a new registration when the time moves earlier.
 *   - Debounce: multiple rapid `registerWakeUp()` calls within a short window
 *     are batched into a single HTTP request.
 *   - No-op when disabled: `getAlarmCoordinator()` returns null outside CF mode.
 *   - `getNextWakeUp()` returns the earliest registered time for the
 *     `/_cf/tasks/next-due` endpoint.
 *
 * Consumers:
 *   - `task-scheduler.ts` calls `registerWakeUp()` after computing `next_run`.
 *   - `ipc.ts` calls `registerWakeUp()` after creating/updating tasks.
 *   - `cf-endpoints.ts` calls `getNextWakeUp()` for the next-due endpoint.
 *   - `runtime/bootstrap.ts` creates the singleton at startup when CF mode is on.
 */
import { createLogger } from "../utils/logger.js";
const log = createLogger("cloudflare.alarm");
/** How long to wait before sending the batched registration (ms). */
const DEBOUNCE_MS = 500;
/**
 * AlarmCoordinator bridges timer needs to the Durable Object alarm system.
 *
 * In CF mode it sends HTTP to the DO.  In non-CF mode it's a no-op (the
 * polling loops handle everything).
 */
export class AlarmCoordinator {
    containerPort;
    internalSecret;
    /** Earliest registered wake-up time as epoch ms (or null). */
    nextWakeMs = null;
    /** Pending debounce timer. */
    debounceTimer = null;
    /** All registered wake-ups keyed by source. */
    registrations = new Map();
    /**
     * @param containerPort  The port on which the container is reachable by the
     *   DO for `/_cf/alarm/register`.  In practice the DO makes the call, but
     *   the container-side coordinator can also POST directly to `localhost`.
     *   If null, the coordinator runs in "local-only" mode and only tracks the
     *   next wake-up for `getNextWakeUp()` without sending HTTP.
     * @param internalSecret  Shared secret for the `x-cf-internal-secret` header.
     */
    constructor(containerPort = null, internalSecret = "") {
        this.containerPort = containerPort;
        this.internalSecret = internalSecret;
    }
    // ── Public API ────────────────────────────────────────────────
    /**
     * Register that the container needs to be awake at `isoTime`.
     *
     * @param source  Identifies the caller (e.g. `"task:abc123"`, `"scheduler"`).
     * @param isoTime  ISO-8601 timestamp of the desired wake-up.
     */
    registerWakeUp(source, isoTime) {
        const ms = new Date(isoTime).getTime();
        if (!isFinite(ms) || ms <= Date.now())
            return;
        this.registrations.set(source, ms);
        this.recomputeNext();
    }
    /**
     * Remove a previously registered wake-up (e.g. when a task is cancelled).
     */
    removeWakeUp(source) {
        if (!this.registrations.delete(source))
            return;
        this.recomputeNext();
    }
    /**
     * Return the earliest registered wake-up as an ISO-8601 string, or null.
     * Used by the `/_cf/tasks/next-due` endpoint.
     */
    getNextWakeUp() {
        if (this.nextWakeMs === null)
            return null;
        if (this.nextWakeMs <= Date.now())
            return null;
        return new Date(this.nextWakeMs).toISOString();
    }
    // ── Internals ─────────────────────────────────────────────────
    recomputeNext() {
        let earliest = null;
        const now = Date.now();
        const values = Array.from(this.registrations.values());
        for (const ms of values) {
            if (ms <= now)
                continue;
            if (earliest === null || ms < earliest)
                earliest = ms;
        }
        // Prune expired registrations.
        const entries = Array.from(this.registrations.entries());
        for (const [key, ms] of entries) {
            if (ms <= now)
                this.registrations.delete(key);
        }
        const changed = earliest !== this.nextWakeMs;
        this.nextWakeMs = earliest;
        // Only send to the DO when the earliest time moved earlier (or appeared).
        if (changed && earliest !== null) {
            this.debounceSend();
        }
    }
    debounceSend() {
        if (this.debounceTimer)
            clearTimeout(this.debounceTimer);
        this.debounceTimer = setTimeout(() => {
            this.debounceTimer = null;
            this.sendAlarmRegistration().catch((err) => {
                log.warn("Failed to send alarm registration to DO", {
                    operation: "alarm_coordinator.send",
                    err,
                });
            });
        }, DEBOUNCE_MS);
    }
    async sendAlarmRegistration() {
        if (this.nextWakeMs === null)
            return;
        if (this.containerPort === null) {
            // Local-only mode — just track the time for getNextWakeUp().
            log.info("Alarm registration (local-only)", {
                operation: "alarm_coordinator.local",
                nextWakeAt: new Date(this.nextWakeMs).toISOString(),
            });
            return;
        }
        const nextWakeAt = new Date(this.nextWakeMs).toISOString();
        const headers = {
            "Content-Type": "application/json",
        };
        if (this.internalSecret) {
            headers["x-cf-internal-secret"] = this.internalSecret;
        }
        try {
            const resp = await fetch(`http://localhost:${this.containerPort}/_cf/alarm/register`, {
                method: "POST",
                headers,
                body: JSON.stringify({ nextWakeAt }),
            });
            if (!resp.ok) {
                const text = await resp.text().catch(() => "");
                log.warn("DO alarm registration returned non-OK", {
                    operation: "alarm_coordinator.send",
                    status: resp.status,
                    body: text.slice(0, 200),
                });
            }
            else {
                log.info("Alarm registered with DO", {
                    operation: "alarm_coordinator.send",
                    nextWakeAt,
                });
            }
        }
        catch (err) {
            log.warn("Failed to reach DO for alarm registration", {
                operation: "alarm_coordinator.send",
                err,
            });
        }
    }
}
// ---------------------------------------------------------------------------
// Singleton management
// ---------------------------------------------------------------------------
let instance = null;
/**
 * Return the global AlarmCoordinator instance, or null if CF mode is disabled.
 * Subsystems should check for null and skip alarm registration when off.
 */
export function getAlarmCoordinator() {
    return instance;
}
/**
 * Create and store the global AlarmCoordinator.  Called once at startup by
 * `runtime/bootstrap.ts` when `PICLAW_CF_ENABLED` is true.
 */
export function createAlarmCoordinator(containerPort, internalSecret) {
    instance = new AlarmCoordinator(containerPort ?? null, internalSecret ?? "");
    log.info("Alarm coordinator created", {
        operation: "create_alarm_coordinator",
        mode: containerPort ? "http" : "local-only",
    });
    return instance;
}
/**
 * Destroy the global AlarmCoordinator (for tests).
 */
export function destroyAlarmCoordinator() {
    instance = null;
}

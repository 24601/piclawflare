/**
 * cloudflare/alarm-coordinator.ts – Tracks the earliest scheduled wake-up time.
 *
 * When a subsystem needs the container to be awake at a future time (e.g. the
 * task scheduler computes `next_run`), it calls `registerWakeUp()`.  The
 * coordinator tracks the earliest time across all sources, which the DO
 * queries via the `/_cf/tasks/next-due` endpoint to set its persistent alarm.
 *
 * This is the key forward-compatibility mechanism for timers: any subsystem
 * (task scheduler, future cron, future event-driven triggers) just calls
 * `registerWakeUp(source, isoTime)` and the rest is automatic.
 *
 * Design:
 *   - Deduplication: keeps track of the earliest registered wake-up.
 *   - No-op when disabled: `getAlarmCoordinator()` returns null outside CF mode.
 *   - `getNextWakeUp()` returns the earliest registered time for the
 *     `/_cf/tasks/next-due` endpoint (which the DO uses to set its alarm).
 *
 * Consumers:
 *   - `task-scheduler.ts` calls `registerWakeUp()` after computing `next_run`
 *     and `getNextWakeUp()` via the `getNextDueTaskTime()` helper.
 *   - `cf-endpoints.ts` calls `getNextWakeUp()` for the `/_cf/tasks/next-due` endpoint.
 *   - `runtime/bootstrap.ts` creates the singleton at startup when CF mode is on.
 */

import { createLogger } from "../utils/logger.js";

const log = createLogger("cloudflare.alarm");

/**
 * AlarmCoordinator tracks the earliest scheduled wake-up time across all
 * subsystems.  The DO pulls this value via `/_cf/tasks/next-due` and uses
 * it to set its persistent alarm.
 */
export class AlarmCoordinator {
  /** Earliest registered wake-up time as epoch ms (or null). */
  private nextWakeMs: number | null = null;
  /** All registered wake-ups keyed by source. */
  private registrations = new Map<string, number>();

  constructor() {}

  // ── Public API ────────────────────────────────────────────────

  /**
   * Register that the container needs to be awake at `isoTime`.
   *
   * @param source  Identifies the caller (e.g. `"task:abc123"`, `"scheduler"`).
   * @param isoTime  ISO-8601 timestamp of the desired wake-up.
   */
  registerWakeUp(source: string, isoTime: string): void {
    const ms = new Date(isoTime).getTime();
    if (!isFinite(ms) || ms <= Date.now()) return;

    this.registrations.set(source, ms);
    this.recomputeNext();
  }

  /**
   * Remove a previously registered wake-up (e.g. when a task is cancelled).
   */
  removeWakeUp(source: string): void {
    if (!this.registrations.delete(source)) return;
    this.recomputeNext();
  }

  /**
   * Return the earliest registered wake-up as an ISO-8601 string, or null.
   * Used by the `/_cf/tasks/next-due` endpoint.
   */
  getNextWakeUp(): string | null {
    if (this.nextWakeMs === null) return null;
    if (this.nextWakeMs <= Date.now()) return null;
    return new Date(this.nextWakeMs).toISOString();
  }

  // ── Internals ─────────────────────────────────────────────────

  private recomputeNext(): void {
    let earliest: number | null = null;
    const now = Date.now();
    const values = Array.from(this.registrations.values());
    for (const ms of values) {
      if (ms <= now) continue;
      if (earliest === null || ms < earliest) earliest = ms;
    }

    // Prune expired registrations.
    const entries = Array.from(this.registrations.entries());
    for (const [key, ms] of entries) {
      if (ms <= now) this.registrations.delete(key);
    }

    this.nextWakeMs = earliest;
  }
}

// ---------------------------------------------------------------------------
// Singleton management
// ---------------------------------------------------------------------------

let instance: AlarmCoordinator | null = null;

/**
 * Return the global AlarmCoordinator instance, or null if CF mode is disabled.
 * Subsystems should check for null and skip alarm registration when off.
 */
export function getAlarmCoordinator(): AlarmCoordinator | null {
  return instance;
}

/**
 * Create and store the global AlarmCoordinator.  Called once at startup by
 * `runtime/bootstrap.ts` when `PICLAW_CF_ENABLED` is true.
 */
export function createAlarmCoordinator(): AlarmCoordinator {
  instance = new AlarmCoordinator();
  log.info("Alarm coordinator created", {
    operation: "create_alarm_coordinator",
  });
  return instance;
}

/**
 * Destroy the global AlarmCoordinator (for tests).
 */
export function destroyAlarmCoordinator(): void {
  instance = null;
}

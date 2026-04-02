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
// Activity signal types
// ---------------------------------------------------------------------------

/**
 * Well-known activity kinds.  Extensions may use `"extension_work"` or any
 * custom string — the registry does not enforce a closed set.
 */
export type ActivityKind =
  | "agent_run"
  | "side_prompt"
  | "sse_client"
  | "terminal_session"
  | "vnc_session"
  | "task_execution"
  | "ipc_processing"
  | "file_upload"
  | "autoresearch"
  | "extension_work"
  | (string & {}); // allow arbitrary strings

/** A single registered activity signal. */
export interface ActivitySignal {
  /** What kind of activity this is. */
  kind: ActivityKind;
  /** Unique identifier for this specific activity instance. */
  id: string;
  /** Optional human-readable description (for diagnostics). */
  description?: string;
  /** `Date.now()` when the activity started. */
  startedAt: number;
  /** Chat JID associated with this activity (if any). */
  chatJid?: string;
}

/** Snapshot of the activity service's current state. */
export interface ActivityStatus {
  /** True when no registered activities block sleep. */
  idle: boolean;
  /** Currently registered activities. */
  activities: ActivitySignal[];
  /** Milliseconds since the service became idle, or null if busy. */
  idleSinceMs: number | null;
  /** Epoch ms of the last real user interaction (non-SSE HTTP request). */
  lastUserInteractionMs: number;
}

// ---------------------------------------------------------------------------
// ActivityService implementation
// ---------------------------------------------------------------------------

export class ActivityService {
  private readonly activities = new Map<string, ActivitySignal>();
  private lastUserInteraction = Date.now();
  private idleSince: number | null = Date.now();

  /**
   * SSE idle timeout in milliseconds.  SSE connections alone do not prevent
   * sleep after this duration without a real user interaction.
   */
  constructor(private readonly sseIdleTimeoutMs: number = 300_000) {}

  // ── Registration ──────────────────────────────────────────────

  /** Register an ongoing activity that should prevent container sleep. */
  register(signal: ActivitySignal): void {
    this.activities.set(signal.id, signal);
    this.idleSince = null;
  }

  /** Unregister a completed activity. */
  unregister(id: string): void {
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
  touchUserInteraction(): void {
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
  isIdle(): boolean {
    const nonSse = this.getNonSseActivities();
    if (nonSse.length > 0) return false;

    const sseClients = this.getSseActivities();
    if (sseClients.length === 0) return true;

    // SSE clients are connected but no other work is happening.
    // Check if the user has interacted recently enough.
    const sinceLastInteraction = Date.now() - this.lastUserInteraction;
    return sinceLastInteraction >= this.sseIdleTimeoutMs;
  }

  /** Return a full status snapshot for the `/_cf/activity` endpoint. */
  getStatus(): ActivityStatus {
    const idle = this.isIdle();
    let idleSinceMs: number | null = null;
    if (idle) {
      if (this.idleSince) {
        // Fully idle (no activities at all).
        idleSinceMs = Date.now() - this.idleSince;
      } else if (this.onlySseClientsRemain()) {
        // SSE-only idle — effectively idle since the SSE timeout elapsed
        // after the last user interaction.
        const effectiveIdleSince = this.lastUserInteraction + this.sseIdleTimeoutMs;
        idleSinceMs = Math.max(0, Date.now() - effectiveIdleSince);
      }
    }
    return {
      idle,
      activities: Array.from(this.activities.values()),
      idleSinceMs,
      lastUserInteractionMs: this.lastUserInteraction,
    };
  }

  /** Return the number of currently registered activities. */
  get size(): number {
    return this.activities.size;
  }

  // ── Internal helpers ──────────────────────────────────────────

  private getNonSseActivities(): ActivitySignal[] {
    return Array.from(this.activities.values()).filter(
      (s) => s.kind !== "sse_client",
    );
  }

  private getSseActivities(): ActivitySignal[] {
    return Array.from(this.activities.values()).filter(
      (s) => s.kind === "sse_client",
    );
  }

  private onlySseClientsRemain(): boolean {
    return Array.from(this.activities.values()).every(
      (s) => s.kind === "sse_client",
    );
  }
}

// ---------------------------------------------------------------------------
// Singleton management
// ---------------------------------------------------------------------------

let instance: ActivityService | null = null;

/**
 * Return the global ActivityService instance, or null if CF mode is disabled.
 * Subsystems should check for null and skip activity tracking when off.
 */
export function getActivityService(): ActivityService | null {
  return instance;
}

/**
 * Create and store the global ActivityService.  Called once at startup by
 * `runtime/bootstrap.ts` when `PICLAW_CF_ENABLED` is true.
 */
export function createActivityService(
  sseIdleTimeoutMs?: number,
): ActivityService {
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
export function destroyActivityService(): void {
  instance = null;
}

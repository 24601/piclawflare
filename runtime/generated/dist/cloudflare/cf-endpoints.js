/**
 * cloudflare/cf-endpoints.ts – Internal `/_cf/*` HTTP endpoints.
 *
 * These endpoints are called by the Durable Object (or cron fallback) to
 * manage the container lifecycle.  They are registered on the web server's
 * request router **before** auth gates so the DO can reach them without a
 * session cookie.  Access is protected by the `PICLAW_CF_INTERNAL_SECRET`
 * shared-secret header.
 *
 * Endpoints:
 *   GET  /_cf/health         – Readiness probe (200 when booted, 503 during startup).
 *   GET  /_cf/activity       – Activity/idle status for sleep decisions.
 *   POST /_cf/prepare-sleep  – Graceful pre-sleep: flush WAL, save state, drain SSE.
 *   POST /_cf/tasks/due      – Trigger immediate check and execution of due tasks.
 *   GET  /_cf/tasks/next-due – Return the next scheduled task time.
 *   POST /_cf/ipc            – Accept IPC commands via HTTP (wake-compatible alternative
 *                              to file-based IPC).
 *
 * Consumers:
 *   - `channels/web/request-router-service.ts` calls `handleCfEndpoint()`.
 *   - `cloudflare/container.ts` (DO) calls these endpoints via HTTP.
 *   - `runtime/bootstrap.ts` wires the dependencies at startup.
 */
import { getActivityService } from "./activity-service.js";
import { getAlarmCoordinator } from "./alarm-coordinator.js";
import { getCloudflareConfig } from "../core/config.js";
import { createLogger } from "../utils/logger.js";
const log = createLogger("cloudflare.endpoints");
let deps = null;
/**
 * Wire the endpoint dependencies.  Called once by `runtime/bootstrap.ts`
 * after all services are initialized.
 */
export function setCfEndpointDeps(d) {
    deps = d;
}
// ---------------------------------------------------------------------------
// Auth guard
// ---------------------------------------------------------------------------
function isAuthorized(req) {
    const config = getCloudflareConfig();
    // If no secret is configured, allow all (development mode).
    if (!config.internalSecret)
        return true;
    const header = req.headers.get("x-cf-internal-secret") || "";
    return header === config.internalSecret;
}
// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
/**
 * Handle a `/_cf/*` request.  Returns a Response if the path is recognized,
 * or null to let the normal router continue.
 *
 * Called very early in the request pipeline — before auth gates.
 */
export async function handleCfEndpoint(req, pathname) {
    if (!pathname.startsWith("/_cf/"))
        return null;
    if (!getCloudflareConfig().enabled)
        return null;
    // Auth check — all /_cf/* endpoints require the internal secret.
    if (!isAuthorized(req)) {
        return json({ error: "Unauthorized" }, 401);
    }
    switch (pathname) {
        case "/_cf/health":
            return handleHealth();
        case "/_cf/activity":
            return handleActivity();
        case "/_cf/prepare-sleep":
            return handlePrepareSleep();
        case "/_cf/tasks/due":
            return handleTasksDue();
        case "/_cf/tasks/next-due":
            return handleTasksNextDue();
        case "/_cf/ipc":
            return handleIpc(req);
        default:
            return json({ error: "Unknown /_cf endpoint" }, 404);
    }
}
// ---------------------------------------------------------------------------
// Endpoint handlers
// ---------------------------------------------------------------------------
/**
 * `GET /_cf/health` — Readiness probe.
 *
 * Returns 200 when the runtime is fully booted (DB initialized, web channel
 * started).  Returns 503 during startup.  The DO polls this to know when the
 * container is ready to serve user requests.
 */
function handleHealth() {
    if (!deps || !deps.isReady()) {
        return json({ status: "starting" }, 503);
    }
    return json({ status: "ready" });
}
/**
 * `GET /_cf/activity` — Activity/idle status.
 *
 * Returns the ActivityService's full status snapshot.  The DO uses this in
 * `onActivityExpired()` to decide whether to actually stop the container.
 */
function handleActivity() {
    const service = getActivityService();
    if (!service) {
        return json({ idle: true, activities: [], idleSinceMs: null, lastUserInteractionMs: 0 });
    }
    const status = service.getStatus();
    // Also include the next scheduled task time for richer diagnostics.
    const coordinator = getAlarmCoordinator();
    const nextScheduledTask = coordinator?.getNextWakeUp() ?? null;
    return json({ ...status, nextScheduledTask });
}
/**
 * `POST /_cf/prepare-sleep` — Graceful pre-sleep preparation.
 *
 * Called by the DO just before stopping the container.  Performs:
 *   1. SQLite WAL checkpoint (TRUNCATE) to flush pending writes.
 *   2. Save RuntimeState timestamps to DB.
 *   3. Close idle agent sessions.
 *   4. (SSE clients will reconnect on wake — no explicit drain needed.)
 */
async function handlePrepareSleep() {
    if (!deps) {
        return json({ ok: false, error: "Runtime not initialized" }, 503);
    }
    try {
        await deps.prepareSleep();
        log.info("Container prepared for sleep", {
            operation: "prepare_sleep",
        });
        return json({ ok: true });
    }
    catch (err) {
        log.error("Failed to prepare for sleep", {
            operation: "prepare_sleep",
            err,
        });
        return json({ ok: false, error: String(err) }, 500);
    }
}
/**
 * `POST /_cf/tasks/due` — Trigger immediate task execution.
 *
 * Called by the DO alarm handler after waking the container for a scheduled
 * task.  Runs `getDueTasks()` and executes them synchronously (within the
 * normal scheduler queue).
 */
async function handleTasksDue() {
    if (!deps) {
        return json({ ok: false, error: "Runtime not initialized" }, 503);
    }
    try {
        await deps.triggerDueTasks();
        // After executing, return the next due time so the DO can set its alarm.
        const nextRunAt = deps.getNextDueTaskTime();
        return json({ ok: true, nextRunAt });
    }
    catch (err) {
        log.error("Failed to trigger due tasks", {
            operation: "tasks_due",
            err,
        });
        return json({ ok: false, error: String(err) }, 500);
    }
}
/**
 * `GET /_cf/tasks/next-due` — Next scheduled task time.
 *
 * Returns the earliest `next_run` across all active scheduled tasks.
 * The DO uses this to set its alarm for the next wake-up.
 */
function handleTasksNextDue() {
    if (!deps) {
        return json({ nextRunAt: null }, 503);
    }
    const nextRunAt = deps.getNextDueTaskTime();
    return json({ nextRunAt });
}
/**
 * `POST /_cf/ipc` — HTTP-based IPC command ingestion.
 *
 * Accepts the same JSON format as file-based IPC:
 *   - `{ "type": "message", "text": "...", "chatJid": "..." }`
 *   - `{ "type": "schedule_task", ... }`
 *   - etc.
 *
 * The Worker forwards this to the DO, which wakes the container and proxies.
 * The container processes the command through the existing IPC handlers.
 */
async function handleIpc(req) {
    if (!deps) {
        return json({ ok: false, error: "Runtime not initialized" }, 503);
    }
    let payload;
    try {
        payload = (await req.json());
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
            return json({ ok: false, error: "Body must be a JSON object" }, 400);
        }
    }
    catch {
        return json({ ok: false, error: "Invalid JSON body" }, 400);
    }
    try {
        await deps.processIpcPayload(payload);
        return json({ ok: true });
    }
    catch (err) {
        log.error("IPC payload processing failed", {
            operation: "ipc",
            err,
        });
        return json({ ok: false, error: String(err) }, 500);
    }
}
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function json(body, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
    });
}

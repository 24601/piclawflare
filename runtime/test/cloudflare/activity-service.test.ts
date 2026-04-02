/**
 * Tests for the Cloudflare ActivityService.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import {
  ActivityService,
  createActivityService,
  destroyActivityService,
  getActivityService,
  type ActivitySignal,
} from "../../src/cloudflare/activity-service.js";

describe("ActivityService", () => {
  let service: ActivityService;

  beforeEach(() => {
    service = new ActivityService(5_000); // 5s SSE idle timeout for tests
  });

  // ── Registration lifecycle ─────────────────────────────────────

  it("starts idle with no activities", () => {
    expect(service.isIdle()).toBe(true);
    expect(service.size).toBe(0);
  });

  it("reports busy after registering a non-SSE activity", () => {
    service.register({
      kind: "agent_run",
      id: "run-1",
      startedAt: Date.now(),
    });
    expect(service.isIdle()).toBe(false);
    expect(service.size).toBe(1);
  });

  it("returns to idle after unregistering all activities", () => {
    service.register({ kind: "agent_run", id: "run-1", startedAt: Date.now() });
    service.register({ kind: "task_execution", id: "task-1", startedAt: Date.now() });
    expect(service.isIdle()).toBe(false);
    expect(service.size).toBe(2);

    service.unregister("run-1");
    expect(service.isIdle()).toBe(false);
    expect(service.size).toBe(1);

    service.unregister("task-1");
    expect(service.isIdle()).toBe(true);
    expect(service.size).toBe(0);
  });

  it("handles unregistering a nonexistent id gracefully", () => {
    service.unregister("nonexistent");
    expect(service.isIdle()).toBe(true);
  });

  it("handles duplicate registration by overwriting", () => {
    service.register({ kind: "agent_run", id: "run-1", startedAt: 100 });
    service.register({ kind: "agent_run", id: "run-1", startedAt: 200 });
    expect(service.size).toBe(1);
    const status = service.getStatus();
    expect(status.activities[0].startedAt).toBe(200);
  });

  // ── Multiple activity kinds ────────────────────────────────────

  it("tracks different activity kinds concurrently", () => {
    const kinds = [
      "agent_run",
      "side_prompt",
      "terminal_session",
      "vnc_session",
      "task_execution",
      "ipc_processing",
      "file_upload",
      "autoresearch",
      "extension_work",
    ] as const;

    for (const kind of kinds) {
      service.register({ kind, id: `${kind}-1`, startedAt: Date.now() });
    }

    expect(service.isIdle()).toBe(false);
    expect(service.size).toBe(kinds.length);

    // Unregister all
    for (const kind of kinds) {
      service.unregister(`${kind}-1`);
    }
    expect(service.isIdle()).toBe(true);
  });

  it("supports arbitrary custom activity kinds", () => {
    service.register({ kind: "my_custom_thing", id: "custom-1", startedAt: Date.now() });
    expect(service.isIdle()).toBe(false);
    service.unregister("custom-1");
    expect(service.isIdle()).toBe(true);
  });

  // ── SSE idle timeout logic ────────────────────────────────────

  it("considers SSE-only as idle after SSE timeout", () => {
    // Touch interaction long ago
    service.touchUserInteraction();
    // Simulate time passing beyond the SSE idle timeout
    (service as any).lastUserInteraction = Date.now() - 10_000;

    service.register({ kind: "sse_client", id: "sse-1", startedAt: Date.now() });
    // With 5s timeout and 10s since last interaction, should be idle
    expect(service.isIdle()).toBe(true);
  });

  it("considers SSE-only as busy within SSE timeout", () => {
    service.touchUserInteraction(); // just now
    service.register({ kind: "sse_client", id: "sse-1", startedAt: Date.now() });
    // Interaction was just now, within the 5s timeout
    expect(service.isIdle()).toBe(false);
  });

  it("non-SSE activity always prevents idle regardless of SSE timeout", () => {
    (service as any).lastUserInteraction = Date.now() - 10_000;
    service.register({ kind: "sse_client", id: "sse-1", startedAt: Date.now() });
    service.register({ kind: "agent_run", id: "run-1", startedAt: Date.now() });
    // Even though SSE idle timeout has passed, agent_run keeps it busy
    expect(service.isIdle()).toBe(false);
  });

  it("touchUserInteraction resets SSE idle timer", () => {
    (service as any).lastUserInteraction = Date.now() - 10_000;
    service.register({ kind: "sse_client", id: "sse-1", startedAt: Date.now() });
    expect(service.isIdle()).toBe(true); // expired

    service.touchUserInteraction();
    expect(service.isIdle()).toBe(false); // fresh interaction
  });

  it("multiple SSE clients — still idle after timeout", () => {
    (service as any).lastUserInteraction = Date.now() - 10_000;
    service.register({ kind: "sse_client", id: "sse-1", startedAt: Date.now() });
    service.register({ kind: "sse_client", id: "sse-2", startedAt: Date.now() });
    service.register({ kind: "sse_client", id: "sse-3", startedAt: Date.now() });
    expect(service.isIdle()).toBe(true);
    expect(service.size).toBe(3);
  });

  // ── getStatus ──────────────────────────────────────────────────

  it("getStatus returns correct idle state", () => {
    const status = service.getStatus();
    expect(status.idle).toBe(true);
    expect(status.activities).toEqual([]);
    expect(status.idleSinceMs).toBeGreaterThanOrEqual(0);
  });

  it("getStatus returns correct busy state", () => {
    service.register({
      kind: "agent_run",
      id: "run-1",
      description: "Test run",
      startedAt: 123456,
      chatJid: "web:default",
    });
    const status = service.getStatus();
    expect(status.idle).toBe(false);
    expect(status.activities.length).toBe(1);
    expect(status.activities[0].id).toBe("run-1");
    expect(status.activities[0].kind).toBe("agent_run");
    expect(status.activities[0].description).toBe("Test run");
    expect(status.activities[0].chatJid).toBe("web:default");
    expect(status.idleSinceMs).toBe(null);
  });

  it("getStatus includes lastUserInteractionMs", () => {
    service.touchUserInteraction();
    const status = service.getStatus();
    expect(status.lastUserInteractionMs).toBeGreaterThan(0);
    expect(status.lastUserInteractionMs).toBeLessThanOrEqual(Date.now());
  });

  // ── Singleton management ───────────────────────────────────────

  it("getActivityService returns null before creation", () => {
    destroyActivityService();
    expect(getActivityService()).toBe(null);
  });

  it("createActivityService sets the singleton", () => {
    destroyActivityService();
    const created = createActivityService(1000);
    expect(getActivityService()).toBe(created);
    destroyActivityService();
  });

  afterEach(() => {
    destroyActivityService();
  });
});

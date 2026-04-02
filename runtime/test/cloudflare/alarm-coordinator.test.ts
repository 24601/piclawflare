/**
 * Tests for the Cloudflare AlarmCoordinator.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import {
  AlarmCoordinator,
  createAlarmCoordinator,
  destroyAlarmCoordinator,
  getAlarmCoordinator,
} from "../../src/cloudflare/alarm-coordinator.js";

describe("AlarmCoordinator", () => {
  let coordinator: AlarmCoordinator;

  beforeEach(() => {
    coordinator = new AlarmCoordinator();
  });

  // ── Registration and retrieval ─────────────────────────────────

  it("starts with no next wake-up", () => {
    expect(coordinator.getNextWakeUp()).toBe(null);
  });

  it("registers a future wake-up", () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    coordinator.registerWakeUp("test-source", future);
    expect(coordinator.getNextWakeUp()).toBe(future);
  });

  it("ignores past timestamps", () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    coordinator.registerWakeUp("test-source", past);
    expect(coordinator.getNextWakeUp()).toBe(null);
  });

  it("ignores invalid timestamps", () => {
    coordinator.registerWakeUp("test-source", "not-a-date");
    expect(coordinator.getNextWakeUp()).toBe(null);
  });

  it("keeps the earliest when multiple sources register", () => {
    const t1 = new Date(Date.now() + 120_000).toISOString();
    const t2 = new Date(Date.now() + 60_000).toISOString(); // earlier
    const t3 = new Date(Date.now() + 180_000).toISOString();

    coordinator.registerWakeUp("source-a", t1);
    coordinator.registerWakeUp("source-b", t2);
    coordinator.registerWakeUp("source-c", t3);

    expect(coordinator.getNextWakeUp()).toBe(t2);
  });

  it("updates when a source registers an earlier time", () => {
    const later = new Date(Date.now() + 120_000).toISOString();
    const earlier = new Date(Date.now() + 30_000).toISOString();

    coordinator.registerWakeUp("source-a", later);
    expect(coordinator.getNextWakeUp()).toBe(later);

    coordinator.registerWakeUp("source-a", earlier);
    expect(coordinator.getNextWakeUp()).toBe(earlier);
  });

  // ── Removal ────────────────────────────────────────────────────

  it("removeWakeUp clears a registration", () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    coordinator.registerWakeUp("source-a", future);
    expect(coordinator.getNextWakeUp()).toBe(future);

    coordinator.removeWakeUp("source-a");
    expect(coordinator.getNextWakeUp()).toBe(null);
  });

  it("removeWakeUp recalculates to next earliest", () => {
    const t1 = new Date(Date.now() + 30_000).toISOString(); // earliest
    const t2 = new Date(Date.now() + 60_000).toISOString();

    coordinator.registerWakeUp("source-a", t1);
    coordinator.registerWakeUp("source-b", t2);
    expect(coordinator.getNextWakeUp()).toBe(t1);

    coordinator.removeWakeUp("source-a");
    expect(coordinator.getNextWakeUp()).toBe(t2);
  });

  it("removeWakeUp is safe for unknown sources", () => {
    coordinator.removeWakeUp("nonexistent");
    expect(coordinator.getNextWakeUp()).toBe(null);
  });

  // ── Singleton management ───────────────────────────────────────

  it("getAlarmCoordinator returns null before creation", () => {
    destroyAlarmCoordinator();
    expect(getAlarmCoordinator()).toBe(null);
  });

  it("createAlarmCoordinator sets the singleton", () => {
    destroyAlarmCoordinator();
    const created = createAlarmCoordinator();
    expect(getAlarmCoordinator()).toBe(created);
    destroyAlarmCoordinator();
  });

  afterEach(() => {
    destroyAlarmCoordinator();
  });
});

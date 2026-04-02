/**
 * runtime/bootstrap.ts – Runtime bootstrap orchestration and default dependency wiring.
 */

import {
  getCloudflareConfig,
  getIdentityConfig,
  getRoutingConfig,
  getRuntimeTimingConfig,
  getWhatsAppConfig,
} from "../core/config.js";
import {
  createActivityService,
  createAlarmCoordinator,
  setCfEndpointDeps,
} from "../cloudflare/index.js";
import { stopIpcWatcher } from "../ipc.js";
import type { SchedulerDeps } from "../task-scheduler.js";
import { stopSchedulerLoop } from "../task-scheduler.js";
import { createLogger } from "../utils/logger.js";
import type { RuntimeSignalRegistrar } from "./composition.js";
import { registerRuntimeShutdownSignals } from "./composition.js";
import { startRuntimeLoop, type StartRuntimeLoopDeps } from "./coordinator.js";
import { registerOptionalProviders } from "./provider-bootstrap.js";
import { createShutdownHandler, type ShutdownDeps } from "./shutdown.js";
import { registerShutdownHandler } from "./shutdown-registry.js";
import {
  createWhatsAppChannel,
  initializeRuntimeEnvironment,
  queueStartupResumePendingIpc,
  startOptionalPushoverChannel,
  startWebChannel,
} from "./startup.js";
import {
  createRuntimeSenders,
  startRuntimeWorkers,
  type RuntimeModelResolver,
  type RuntimePushoverWorkerChannel,
  type RuntimeSenders,
  type RuntimeWebWorkerChannel,
  type RuntimeWhatsAppWorkerChannel,
} from "./wiring.js";

const log = createLogger("runtime.bootstrap");

/** Queue contract required by runtime bootstrap orchestration. */
export type RuntimeBootstrapQueue =
  & StartRuntimeLoopDeps["queue"]
  & SchedulerDeps["queue"]
  & ShutdownDeps["queue"];

/** Agent-pool contract required by runtime bootstrap orchestration. */
export type RuntimeBootstrapAgentPool =
  & StartRuntimeLoopDeps["agentPool"]
  & SchedulerDeps["agentPool"]
  & RuntimeModelResolver
  & ShutdownDeps["agentPool"];

/** Runtime state contract required by runtime bootstrap orchestration. */
export type RuntimeBootstrapState = StartRuntimeLoopDeps["state"];

/** Web channel contract required by runtime bootstrap orchestration. */
export type RuntimeBootstrapWeb = RuntimeWebWorkerChannel & ShutdownDeps["web"];

/** WhatsApp channel contract required by runtime bootstrap orchestration. */
export type RuntimeBootstrapWhatsApp =
  & StartRuntimeLoopDeps["whatsapp"]
  & RuntimeWhatsAppWorkerChannel
  & ShutdownDeps["whatsapp"]
  & { connect: () => Promise<unknown> };

/** Optional pushover channel contract required by runtime bootstrap orchestration. */
export type RuntimeBootstrapPushover = RuntimePushoverWorkerChannel & NonNullable<ShutdownDeps["pushover"]>;

/** Runtime core services contract consumed by bootstrap orchestration. */
export interface RuntimeBootstrapCoreServices {
  queue: RuntimeBootstrapQueue;
  agentPool: RuntimeBootstrapAgentPool;
  state: RuntimeBootstrapState;
}

/** Concrete runtime-core contract required to wire production startup modules. */
export interface RuntimeBootstrapDefaultCoreServices extends RuntimeBootstrapCoreServices {
  queue: Parameters<typeof startWebChannel>[0];
  agentPool: Parameters<typeof startWebChannel>[1];
  state: Parameters<typeof createWhatsAppChannel>[0];
}

/** Dependency injection contract for the runtime bootstrap sequence. */
export interface RuntimeBootstrapDeps {
  core: RuntimeBootstrapCoreServices;
  assistantName: string;
  triggerPattern: RegExp;
  pollIntervalMs: number;
  signalRegistrar: RuntimeSignalRegistrar;
  initializeRuntimeEnvironment(state: RuntimeBootstrapState): void;
  registerOptionalProviders(agentPool: RuntimeBootstrapAgentPool): void;
  startWebChannel(queue: RuntimeBootstrapQueue, agentPool: RuntimeBootstrapAgentPool): Promise<RuntimeBootstrapWeb>;
  startOptionalPushoverChannel(): Promise<RuntimeBootstrapPushover | null>;
  createWhatsAppChannel(state: RuntimeBootstrapState, options?: { disable?: boolean }): RuntimeBootstrapWhatsApp;
  createShutdownHandler(deps: ShutdownDeps): (signal: string) => Promise<void>;
  registerRuntimeShutdownSignals(
    registrar: RuntimeSignalRegistrar,
    shutdown: (signal: string) => Promise<void>
  ): void;
  createRuntimeSenders(
    web: RuntimeBootstrapWeb,
    whatsapp: RuntimeBootstrapWhatsApp,
    pushover: RuntimeBootstrapPushover | null
  ): RuntimeSenders;
  startRuntimeWorkers(
    queue: RuntimeBootstrapQueue,
    agentPool: RuntimeBootstrapAgentPool,
    web: RuntimeBootstrapWeb,
    senders: RuntimeSenders
  ): void;
  queueStartupResumePendingIpc(): void;
  startRuntimeLoop(deps: StartRuntimeLoopDeps): Promise<void>;
  log(message: string): void;
  stopIpcWatcher(): void;
  stopSchedulerLoop(): void;
}

/**
 * Build default runtime bootstrap dependencies from production modules.
 */
export function createDefaultRuntimeBootstrapDeps(core: RuntimeBootstrapDefaultCoreServices): RuntimeBootstrapDeps {
  return {
    core,
    assistantName: getIdentityConfig().assistantName,
    triggerPattern: getRoutingConfig().triggerPattern,
    pollIntervalMs: getRuntimeTimingConfig().pollIntervalMs,
    signalRegistrar: process,
    initializeRuntimeEnvironment: () => initializeRuntimeEnvironment(core.state),
    registerOptionalProviders: () => registerOptionalProviders(core.agentPool),
    startWebChannel: () => startWebChannel(core.queue, core.agentPool),
    startOptionalPushoverChannel: () => startOptionalPushoverChannel(),
    createWhatsAppChannel: (_state, options?) => createWhatsAppChannel(core.state, options),
    createShutdownHandler,
    registerRuntimeShutdownSignals,
    createRuntimeSenders,
    startRuntimeWorkers,
    queueStartupResumePendingIpc,
    startRuntimeLoop,
    log: (message) => log.info(message, { operation: "bootstrap.banner" }),
    stopIpcWatcher,
    stopSchedulerLoop,
  };
}

/**
 * Bootstrap and run all runtime subsystems in production order.
 */
export async function bootstrapRuntime(deps: RuntimeBootstrapDeps): Promise<void> {
  const { queue, agentPool, state } = deps.core;

  deps.initializeRuntimeEnvironment(state);
  deps.registerOptionalProviders(agentPool);

  // ── Cloudflare Containers integration (opt-in) ────────────────
  const cfConfig = getCloudflareConfig();
  if (cfConfig.enabled) {
    const activityService = createActivityService(cfConfig.sseIdleTimeoutMs);
    // The alarm coordinator tracks next-wake-up times for the
    // /_cf/tasks/next-due endpoint.  The DO pulls this value and uses it
    // to set its persistent alarm.
    createAlarmCoordinator();
    log.info("Cloudflare Containers mode enabled", {
      operation: "bootstrap.cf_init",
      sseIdleTimeoutMs: cfConfig.sseIdleTimeoutMs,
      whatsappMode: cfConfig.whatsappMode,
      activityServiceReady: activityService.size === 0,
    });

    // WhatsApp handling for CF mode
    if (cfConfig.whatsappMode === "disabled") {
      const waConfig = getWhatsAppConfig();
      if (waConfig.phoneNumber) {
        log.warn(
          "WhatsApp phone is configured but PICLAW_CF_WHATSAPP_MODE is 'disabled'. " +
          "WhatsApp will not connect. Set PICLAW_CF_WHATSAPP_MODE=keep-awake to " +
          "use WhatsApp (disables container idling).",
          { operation: "bootstrap.cf_whatsapp_disabled" },
        );
      }
    } else if (cfConfig.whatsappMode === "keep-awake") {
      log.warn(
        "Cloudflare Containers keep-awake mode is active (WhatsApp Baileys). " +
        "The container will never idle/sleep, which increases hosting costs.",
        { operation: "bootstrap.cf_whatsapp_keepawake" },
      );
    }
  }

  deps.log("=== Piclaw - Pi Coding Agent Assistant ===");

  const web = await deps.startWebChannel(queue, agentPool);
  const pushover = await deps.startOptionalPushoverChannel();

  // In CF disabled WhatsApp mode, explicitly pass disable:true so the no-op
  // stub is used without mutating global env state.
  const shouldDisableWhatsApp = cfConfig.enabled && cfConfig.whatsappMode === "disabled";
  const whatsapp = deps.createWhatsAppChannel(state, shouldDisableWhatsApp ? { disable: true } : undefined);

  const shutdown = deps.createShutdownHandler({
    queue,
    agentPool,
    whatsapp,
    web,
    pushover,
    stopIpcWatcher: deps.stopIpcWatcher,
    stopSchedulerLoop: deps.stopSchedulerLoop,
  });
  registerShutdownHandler(shutdown);
  deps.registerRuntimeShutdownSignals(deps.signalRegistrar, shutdown);

  const senders = deps.createRuntimeSenders(web, whatsapp, pushover);
  deps.startRuntimeWorkers(queue, agentPool, web, senders);

  // ── Wire CF endpoint dependencies (after workers are online) ──
  if (cfConfig.enabled) {
    const { getDueTasks: getDueTasksFn, getDb: getDbFn } = await import("../db.js");
    const { getNextDueTaskTime: getNextDueTaskTimeFn } = await import("../task-scheduler.js");

    setCfEndpointDeps({
      isReady: () => true, // We're past all init at this point
      prepareSleep: async () => {
        // Checkpoint SQLite WAL to flush pending writes
        try {
          getDbFn().exec("PRAGMA wal_checkpoint(TRUNCATE)");
        } catch (err) {
          log.warn("WAL checkpoint failed during prepare-sleep", {
            operation: "bootstrap.prepare_sleep",
            err,
          });
        }
        // Save runtime state timestamps
        state.saveTimestamps();
        // Note: we do NOT call agentPool.shutdown() here because it
        // permanently destroys the pool. If the container survives (e.g. the
        // DO stop call is delayed), subsequent agent runs would fail. The
        // container process will be terminated by the DO after this returns.
      },
      triggerDueTasks: async () => {
        // Enqueue due tasks through the lane-aware queue (same path as the
        // regular scheduler poll loop) so they serialise with any in-flight
        // user-initiated agent runs on the same chat. Running tasks directly
        // would bypass lane serialization and risk session state corruption.
        const { runScheduledTask } = await import("../task-scheduler.js");
        const { getTaskById: getTaskByIdFn } = await import("../db.js");
        for (const task of getDueTasksFn()) {
          const cur = getTaskByIdFn(task.id);
          if (!cur || cur.status !== "active") continue;
          queue.enqueueTask(cur.id, () => runScheduledTask(cur, {
            queue,
            agentPool,
            sendMessage: senders.sendMessage,
            sendNudge: senders.sendNudge,
          }), `chat:${cur.chat_jid}`);
        }
      },
      getNextDueTaskTime: () => getNextDueTaskTimeFn(),
      processIpcPayload: async (data) => {
        const { processMessageCommand, processTaskCommand } = await import("../ipc.js");
        const commandType = typeof data.type === "string" ? data.type : "";
        if (commandType === "message") {
          await processMessageCommand(data, {
            sendMessage: senders.sendMessage,
            sendNudge: senders.sendNudge,
          });
        } else {
          await processTaskCommand(data, {
            sendMessage: senders.sendMessage,
            sendNudge: senders.sendNudge,
            resolveModel: (input: string) => agentPool.resolveModelInput(input),
            resumeChat: async (d) => {
              const chatJid = typeof d.chatJid === "string" && d.chatJid.trim()
                ? d.chatJid.trim()
                : "web:default";
              const threadRootId = typeof d.threadRootId === "number" ? d.threadRootId : null;
              (web as any).resumeChat?.(chatJid, threadRootId);
            },
            resumePending: async (d) => {
              const chatJid = typeof d?.chatJid === "string" && d.chatJid.trim()
                ? d.chatJid.trim()
                : undefined;
              (web as any).resumePendingChats?.(chatJid);
            },
          });
        }
      },
    });
    log.info("Cloudflare endpoint dependencies wired", {
      operation: "bootstrap.cf_endpoints_wired",
    });
  }

  // Queue restart recovery as soon as workers are online. Do not wait for
  // WhatsApp to finish its initial connect/reconnect path, which may be slow
  // or flaky on some installs and would otherwise delay web recovery.
  deps.queueStartupResumePendingIpc();

  await whatsapp.connect();

  await deps.startRuntimeLoop({
    queue,
    state,
    agentPool,
    whatsapp,
    assistantName: deps.assistantName,
    triggerPattern: deps.triggerPattern,
    pollIntervalMs: deps.pollIntervalMs,
  });
}

/**
 * runtime/bootstrap.ts – Runtime bootstrap orchestration and default dependency wiring.
 */
import { getCloudflareConfig, getIdentityConfig, getRoutingConfig, getRuntimeTimingConfig, getWhatsAppConfig, } from "../core/config.js";
import { createActivityService, createAlarmCoordinator, setCfEndpointDeps, } from "../cloudflare/index.js";
import { stopIpcWatcher } from "../ipc.js";
import { stopSchedulerLoop } from "../task-scheduler.js";
import { createLogger } from "../utils/logger.js";
import { registerRuntimeShutdownSignals } from "./composition.js";
import { startRuntimeLoop } from "./coordinator.js";
import { registerOptionalProviders } from "./provider-bootstrap.js";
import { createShutdownHandler } from "./shutdown.js";
import { registerShutdownHandler } from "./shutdown-registry.js";
import { createWhatsAppChannel, initializeRuntimeEnvironment, queueStartupResumePendingIpc, startOptionalPushoverChannel, startWebChannel, } from "./startup.js";
import { createRuntimeSenders, startRuntimeWorkers, } from "./wiring.js";
const log = createLogger("runtime.bootstrap");
/**
 * Build default runtime bootstrap dependencies from production modules.
 */
export function createDefaultRuntimeBootstrapDeps(core) {
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
        createWhatsAppChannel: () => createWhatsAppChannel(core.state),
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
export async function bootstrapRuntime(deps) {
    const { queue, agentPool, state } = deps.core;
    deps.initializeRuntimeEnvironment(state);
    deps.registerOptionalProviders(agentPool);
    // ── Cloudflare Containers integration (opt-in) ────────────────
    const cfConfig = getCloudflareConfig();
    if (cfConfig.enabled) {
        const activityService = createActivityService(cfConfig.sseIdleTimeoutMs);
        // The alarm coordinator runs in local-only mode initially — it tracks
        // next-wake-up times for the /_cf/tasks/next-due endpoint.  The DO
        // calls /_cf/alarm/register separately to set its persistent alarms.
        createAlarmCoordinator(null, cfConfig.internalSecret);
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
                log.warn("WhatsApp phone is configured but PICLAW_CF_WHATSAPP_MODE is 'disabled'. " +
                    "WhatsApp will not connect. Set PICLAW_CF_WHATSAPP_MODE=keep-awake to " +
                    "use WhatsApp (disables container idling).", { operation: "bootstrap.cf_whatsapp_disabled" });
            }
        }
        else if (cfConfig.whatsappMode === "keep-awake") {
            log.warn("Cloudflare Containers keep-awake mode is active (WhatsApp Baileys). " +
                "The container will never idle/sleep, which increases hosting costs.", { operation: "bootstrap.cf_whatsapp_keepawake" });
        }
    }
    deps.log("=== Piclaw - Pi Coding Agent Assistant ===");
    const web = await deps.startWebChannel(queue, agentPool);
    const pushover = await deps.startOptionalPushoverChannel();
    // In CF disabled mode, create WhatsApp normally.
    // In CF keep-awake mode, also create WhatsApp normally.
    // In CF disabled WhatsApp mode, the stub is used (WHATSAPP_PHONE is effectively empty).
    const shouldDisableWhatsApp = cfConfig.enabled && cfConfig.whatsappMode === "disabled";
    const origPhone = process.env.WHATSAPP_PHONE;
    const origPiclawPhone = process.env.PICLAW_WHATSAPP_PHONE;
    if (shouldDisableWhatsApp) {
        // Temporarily clear phone env vars so the stub is used
        process.env.WHATSAPP_PHONE = "";
        process.env.PICLAW_WHATSAPP_PHONE = "";
    }
    const whatsapp = deps.createWhatsAppChannel(state);
    if (shouldDisableWhatsApp) {
        // Restore env vars
        if (origPhone !== undefined)
            process.env.WHATSAPP_PHONE = origPhone;
        else
            delete process.env.WHATSAPP_PHONE;
        if (origPiclawPhone !== undefined)
            process.env.PICLAW_WHATSAPP_PHONE = origPiclawPhone;
        else
            delete process.env.PICLAW_WHATSAPP_PHONE;
    }
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
                }
                catch (err) {
                    log.warn("WAL checkpoint failed during prepare-sleep", {
                        operation: "bootstrap.prepare_sleep",
                        err,
                    });
                }
                // Save runtime state timestamps
                state.saveTimestamps();
                // Shut down the agent pool (closes idle sessions)
                await agentPool.shutdown();
            },
            triggerDueTasks: async () => {
                // Execute due tasks through the existing scheduler mechanism
                const { runScheduledTask } = await import("../task-scheduler.js");
                for (const task of getDueTasksFn()) {
                    await runScheduledTask(task, {
                        queue,
                        agentPool,
                        sendMessage: senders.sendMessage,
                        sendNudge: senders.sendNudge,
                    });
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
                }
                else {
                    await processTaskCommand(data, {
                        sendMessage: senders.sendMessage,
                        sendNudge: senders.sendNudge,
                        resolveModel: (input) => agentPool.resolveModelInput(input),
                        resumeChat: async (d) => {
                            const chatJid = typeof d.chatJid === "string" && d.chatJid.trim()
                                ? d.chatJid.trim()
                                : "web:default";
                            const threadRootId = typeof d.threadRootId === "number" ? d.threadRootId : null;
                            web.resumeChat?.(chatJid, threadRootId);
                        },
                        resumePending: async (d) => {
                            const chatJid = typeof d?.chatJid === "string" && d.chatJid.trim()
                                ? d.chatJid.trim()
                                : undefined;
                            web.resumePendingChats?.(chatJid);
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

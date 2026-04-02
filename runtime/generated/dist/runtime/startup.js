/**
 * runtime/startup.ts – Runtime startup wiring helpers.
 */
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { WebChannel } from "../channels/web.js";
import { PushoverChannel } from "../channels/pushover.js";
import { WhatsAppChannel } from "../channels/whatsapp.js";
import { setMessagesPostFn } from "../extensions/messages-crud.js";
import { DATA_DIR, STORE_DIR, WORKSPACE_DIR, getPushoverConfig, getToolOutputConfig, getWhatsAppConfig, } from "../core/config.js";
import { initDatabase, storeChatMetadata, storeMessage } from "../db.js";
import { startToolOutputCleanup } from "../tool-output.js";
import { createUuid } from "../utils/ids.js";
import { createLogger } from "../utils/logger.js";
import { patchConsoleTimestamps } from "./console-timestamps.js";
const log = createLogger("runtime.startup");
/** Initialize directories, database, and persisted runtime state. */
export function initializeRuntimeEnvironment(state) {
    patchConsoleTimestamps();
    mkdirSync(STORE_DIR, { recursive: true });
    mkdirSync(DATA_DIR, { recursive: true });
    mkdirSync(WORKSPACE_DIR, { recursive: true });
    initDatabase();
    const toolOutputConfig = getToolOutputConfig();
    startToolOutputCleanup(toolOutputConfig.retentionDays, toolOutputConfig.cleanupIntervalMs);
    state.loadTimestamps();
    state.loadChats();
}
/** Start web channel and run immediate crash-recovery bootstrap. */
export async function startWebChannel(queue, agentPool) {
    const web = new WebChannel({ queue, agentPool });
    await web.start();
    web.recoverInflightRuns();
    // Run an immediate pending-resume scan at startup so deferred queued
    // follow-ups are picked up even before IPC workers process resume tasks.
    // Queue dedupe keeps this safe when IPC-driven resume_pending runs too.
    web.resumePendingChats();
    // Wire the messages tool post action to use the web channel for broadcast.
    setMessagesPostFn((chatJid, content, isBot, mediaIds, contentBlocks) => {
        const interaction = web.storeMessage(chatJid, content, isBot, mediaIds, {
            contentBlocks,
        });
        if (!interaction)
            return null;
        web.broadcastEvent(isBot ? "agent_response" : "new_post", interaction);
        return interaction.id;
    });
    return web;
}
/**
 * Queue a self-addressed IPC task to resume pending chats once background
 * workers and external channels are fully online.
 */
export function queueStartupResumePendingIpc() {
    try {
        const tasksDir = join(DATA_DIR, "ipc", "tasks");
        mkdirSync(tasksDir, { recursive: true });
        const payload = {
            type: "resume_pending",
            chatJid: "all",
            reason: "startup",
        };
        const filePath = join(tasksDir, `resume_pending_${createUuid("startup")}.json`);
        writeFileSync(filePath, JSON.stringify(payload));
        log.info("Queued startup resume_pending IPC", {
            operation: "queue_resume_pending_ipc",
            filePath,
        });
    }
    catch (err) {
        log.error("Failed to queue resume_pending IPC", {
            operation: "queue_resume_pending_ipc",
            err,
        });
    }
}
/** Start optional Pushover channel if configured. */
export async function startOptionalPushoverChannel() {
    const pushoverConfig = getPushoverConfig();
    if (!pushoverConfig.appToken || !pushoverConfig.userKey) {
        return null;
    }
    const pushover = new PushoverChannel({
        appToken: pushoverConfig.appToken,
        userKey: pushoverConfig.userKey,
        device: pushoverConfig.device || undefined,
        priority: pushoverConfig.priority,
        sound: pushoverConfig.sound || undefined,
    });
    await pushover.start();
    return pushover;
}
/** Build WhatsApp channel with runtime callbacks and pairing IPC integration. */
export function createWhatsAppChannel(state, options) {
    const whatsAppConfig = getWhatsAppConfig();
    if (options?.disable || !whatsAppConfig.phoneNumber) {
        // Return a no-op stub when WhatsApp is not configured.
        // The runtime expects a whatsapp object with connect/disconnect/sendMessage/setTyping.
        return {
            connect: async () => { },
            disconnect: async () => { },
            sendMessage: async () => { },
            setTyping: async () => { },
            isConnected: () => false,
        };
    }
    return new WhatsAppChannel({
        chatJids: () => state.chatJids,
        phoneNumber: whatsAppConfig.phoneNumber || undefined,
        onPairingCode: (code) => {
            try {
                const ipcDir = join(DATA_DIR, "ipc", "messages");
                mkdirSync(ipcDir, { recursive: true });
                const payload = {
                    type: "message",
                    chatJid: "web:default",
                    text: code,
                };
                const filePath = join(ipcDir, `${createUuid("pairing")}.json`);
                writeFileSync(filePath, JSON.stringify(payload));
            }
            catch (err) {
                log.error("Failed to write pairing code IPC message", {
                    operation: "pairing_code_ipc",
                    err,
                });
            }
        },
        onMessage: (chatJid, msg) => {
            if (!state.chatJids.has(chatJid) && msg.is_from_me) {
                state.chatJids.add(chatJid);
                state.saveChats();
            }
            storeMessage(msg);
        },
        onChatMetadata: (chatJid, timestamp) => storeChatMetadata(chatJid, timestamp),
    });
}

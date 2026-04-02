/**
 * web/sse.ts – Server-Sent Events (SSE) primitives.
 *
 * Provides low-level SSE stream creation, event encoding, client
 * lifecycle management, and broadcast helpers.
 *
 * Consumers: web/sse-hub.ts builds on these primitives.
 */
import { getActivityService } from "../../../cloudflare/activity-service.js";
import { createLogger } from "../../../utils/logger.js";
import { getAppAssetVersion } from "../http/static.js";
const log = createLogger("web.sse");
const encoder = new TextEncoder();
const CHAT_SCOPED_EVENT_TYPES = new Set([
    "agent_status",
    "agent_thought",
    "agent_thought_delta",
    "agent_draft",
    "agent_draft_delta",
    "agent_response",
    "new_post",
    "new_reply",
    "interaction_updated",
    "interaction_deleted",
    "agent_steer_queued",
    "agent_followup_queued",
    "agent_followup_consumed",
    "agent_followup_removed",
    "model_changed",
    "ui_theme",
    "extension_ui_timeout",
    "extension_ui_request",
    "extension_ui_notify",
    "extension_ui_status",
    "extension_ui_working",
    "extension_ui_widget",
    "extension_ui_title",
    "extension_ui_editor_text",
    "extension_ui_error",
    "generated_widget_open",
    "generated_widget_delta",
    "generated_widget_final",
    "generated_widget_close",
    "generated_widget_error",
]);
export function requiresChatScopedDelivery(eventType) {
    return CHAT_SCOPED_EVENT_TYPES.has(String(eventType || "").trim());
}
/**
 * Maximum number of concurrent SSE clients.
 * Prevents resource exhaustion from opening too many connections.
 * Each client holds a ReadableStream controller and a heartbeat interval.
 */
const MAX_SSE_CLIENTS = 50;
/**
 * Create an SSE response stream and register the client.
 * Returns 503 if the maximum client limit has been reached.
 */
export function handleSse(channel, req) {
    // Guard against connection exhaustion — reject if at capacity
    if (channel.clients.size >= MAX_SSE_CLIENTS) {
        return new Response(JSON.stringify({ error: "Too many connections" }), {
            status: 503,
            headers: { "Content-Type": "application/json" },
        });
    }
    let clientRef = null;
    const chatJid = req ? (new URL(req.url).searchParams.get("chat_jid") || "").trim() || null : null;
    const sseClientId = `sse-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const stream = new ReadableStream({
        start: (controller) => {
            const heartbeat = setInterval(() => {
                try {
                    controller.enqueue(encoder.encode(": heartbeat\n\n"));
                    controller.enqueue(encoder.encode(`event: heartbeat\ndata: ${JSON.stringify({ ts: Date.now(), ...(chatJid ? { chat_jid: chatJid } : {}) })}\n\n`));
                }
                catch {
                    clearInterval(heartbeat);
                    if (clientRef)
                        channel.clients.delete(clientRef);
                    getActivityService()?.unregister(sseClientId);
                }
            }, 30000);
            clientRef = { controller, heartbeat, chatJid };
            channel.clients.add(clientRef);
            controller.enqueue(encoder.encode(`event: connected\ndata: ${JSON.stringify({ app_asset_version: getAppAssetVersion(), ...(chatJid ? { chat_jid: chatJid } : {}) })}\n\n`));
            // Register SSE client as an activity (with sse_client kind, which gets
            // special idle-timeout treatment in ActivityService).
            getActivityService()?.register({
                kind: "sse_client",
                id: sseClientId,
                description: chatJid ? `SSE client for ${chatJid}` : "SSE client",
                startedAt: Date.now(),
                chatJid: chatJid ?? undefined,
            });
        },
        cancel: () => {
            if (clientRef) {
                clearInterval(clientRef.heartbeat);
                channel.clients.delete(clientRef);
            }
            getActivityService()?.unregister(sseClientId);
        },
    });
    return new Response(stream, {
        headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no",
        },
    });
}
/** Encode and send an SSE event to all connected clients. */
export function broadcastEvent(channel, eventType, data) {
    const eventChatJid = data && typeof data === "object" && typeof data.chat_jid === "string"
        ? String(data.chat_jid || "").trim() || null
        : null;
    if (requiresChatScopedDelivery(eventType) && !eventChatJid) {
        log.warn("Dropping chat-scoped event without chat_jid", { eventType });
        return;
    }
    const payload = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
    const bytes = encoder.encode(payload);
    for (const client of channel.clients) {
        if (eventChatJid && client.chatJid && client.chatJid !== eventChatJid) {
            continue;
        }
        try {
            client.controller.enqueue(bytes);
        }
        catch {
            clearInterval(client.heartbeat);
            channel.clients.delete(client);
        }
    }
}

/**
 * env.ts – Typed environment bindings for the PiClawFlare Worker.
 *
 * These types mirror the bindings declared in wrangler.jsonc and are
 * consumed by both the Worker fetch/scheduled handlers and the
 * PiClawContainer Durable Object class.
 */

import type { PiClawContainer } from "./container.js";

export interface Env {
  /** Durable Object namespace for the PiClaw container. */
  PICLAW_CONTAINER: DurableObjectNamespace<PiClawContainer>;

  /** Stable name for the singleton container instance (default: "piclaw-main"). */
  PICLAW_CF_CONTAINER_NAME: string;

  /**
   * How long the container stays alive after the last activity before sleeping.
   * Accepts duration strings: "5m", "30s", "1h", etc.  Default: "10m".
   */
  PICLAW_CF_SLEEP_AFTER: string;

  /**
   * WhatsApp operating mode on Cloudflare.
   * - "disabled" (default): No WhatsApp; full idling.
   * - "keep-awake": Baileys connects; container never sleeps.
   * - "cloud-api": (Future) Webhook-based WhatsApp Cloud API.
   */
  PICLAW_CF_WHATSAPP_MODE: string;

  /**
   * Shared secret for authenticating internal /_cf/* requests between the
   * DO and the container.  Must match `PICLAW_CF_INTERNAL_SECRET` on the
   * container side.  Optional but strongly recommended in production.
   */
  PICLAW_CF_INTERNAL_SECRET?: string;
}

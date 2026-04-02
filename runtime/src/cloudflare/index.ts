/**
 * cloudflare/index.ts – Public barrel export for Cloudflare Containers integration.
 *
 * Re-exports the activity service, alarm coordinator, and CF endpoint handler
 * so consumers can import from a single path:
 *   import { getActivityService, getAlarmCoordinator } from "./cloudflare/index.js";
 */

export {
  ActivityService,
  createActivityService,
  destroyActivityService,
  getActivityService,
  type ActivityKind,
  type ActivitySignal,
  type ActivityStatus,
} from "./activity-service.js";

export {
  AlarmCoordinator,
  createAlarmCoordinator,
  destroyAlarmCoordinator,
  getAlarmCoordinator,
} from "./alarm-coordinator.js";

export {
  handleCfEndpoint,
  setCfEndpointDeps,
  type CfEndpointDeps,
} from "./cf-endpoints.js";

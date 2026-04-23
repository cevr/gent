/**
 * ResourceHost — substrate for long-lived state declared by extension Resources.
 *
 * This facade exports the independent host pieces:
 * - Resource service/lifecycle layer assembly.
 * - Subscription collection + pub/sub engine.
 * - Schedule collection + reconciliation.
 * - MachineEngine lives in `machine-engine.ts` to keep actor protocol separate.
 *
 * @module
 */

export { buildResourceLayer, collectResourceEntries, type ResourceEntry } from "./resource-layer.js"

export {
  collectSubscriptions,
  SubscriptionEngine,
  type SubscriptionHandler,
  type SubscriptionEngineService,
} from "./subscription-engine.js"

export {
  collectSchedules,
  reconcileScheduledJobs,
  type ScheduledJobCommand,
  type SchedulerFailure,
} from "./schedule-engine.js"

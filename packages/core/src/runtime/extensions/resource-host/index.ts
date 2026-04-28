/**
 * ResourceHost — substrate for long-lived state declared by extension Resources.
 *
 * This facade exports the independent host pieces:
 * - Resource service/lifecycle layer assembly.
 * - Schedule collection + reconciliation.
 * - ExtensionRuntime lives in `extension-runtime.ts` to keep actor protocol separate.
 *
 * @module
 */

export { buildResourceLayer, collectResourceEntries, type ResourceEntry } from "./resource-layer.js"

export {
  collectSchedules,
  reconcileScheduledJobs,
  type ScheduledJobCommand,
  type SchedulerFailure,
} from "./schedule-engine.js"

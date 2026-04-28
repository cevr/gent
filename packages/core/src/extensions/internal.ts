/**
 * Builtin-only extension internals.
 *
 * This seam exists for Gent-owned extensions that need runtime or app services
 * which are intentionally excluded from the public authoring API.
 */

export type { ExtensionStorage } from "../runtime/extensions/extension-storage.js"
export { BuiltinEventSink, type BuiltinEventSinkService } from "../domain/event-publisher.js"
export { ToolRunner, type ToolRunnerService } from "../runtime/agent/tool-runner.js"
export { ExtensionRuntime } from "../runtime/extensions/resource-host/extension-runtime.js"
export {
  InteractionPendingReader,
  type InteractionPendingReaderService,
  type PendingInteraction,
} from "../storage/interaction-pending-reader.js"

/**
 * Branch-tool authoring API.
 *
 * A second, narrower entry point than `@gent/core/extensions/api`. That API is
 * for extensions that *use* the loop: they register tools, agents, and hooks,
 * and reach the host through `ExtensionContext`. This one is for the rarer
 * extension that *implements* a loop seam — a feature whose tools hold
 * branch-scoped state, dispatch inner operations, and recover their own calls
 * across a restart.
 *
 * Such a feature ships a `BranchToolFeature`: its migrations, its storage, and
 * the factory that builds its per-branch services. The loop installs whatever
 * it is given and never looks inside.
 *
 * Two entry points rather than one wide surface: nothing here belongs in an
 * ordinary extension's vocabulary, and an ordinary extension importing
 * `ToolRunner` or `BranchToolWork` is a design mistake this split keeps
 * visible. Add a name here only when a branch-tool feature cannot be written
 * without it.
 *
 * @example
 * ```ts
 * import { type BranchToolFeature, BranchToolWork } from "@gent/core/extensions/branch-tools"
 *
 * export const MyBranchTools: BranchToolFeature<MyStorageTags> = {
 *   migrations: myMigrations,
 *   storage: myStorageLayer,
 *   branchLayer: myBranchLayer,
 * }
 * ```
 *
 * @module
 */

// The feature contract itself: what a root installs, and what the loop reads.
export {
  type BranchToolFeature,
  CurrentBranchToolFeature,
  noBranchTools,
} from "../runtime/agent/branch-tool-feature.js"
export { BranchToolLayer, type BranchToolLayerFactory } from "../runtime/agent/branch-tool-layer.js"
export { BranchToolWork } from "../runtime/agent/branch-tool-work.js"
export { eraseResourceLayer } from "../runtime/extensions/extension-effect-membrane.js"

// Storage the feature contributes and reads.
export type { FeatureMigrations } from "../storage/schema.js"
export { InteractionStorage } from "../storage/interaction-storage.js"
export { MessageStorage } from "../storage/message-storage.js"
export { EventPublisher } from "../domain/event-publisher.js"
export { GentPlatform } from "../runtime/gent-platform.js"
export {
  makeOwnedToolCallReader,
  type OwnedToolCallAddress,
} from "../storage/sqlite/owned-tool-call.js"
export { StorageError } from "../domain/storage-error.js"
export { EventStoreError } from "../domain/event.js"

// The questions core asks a dispatching feature.
export { InnerOperationReceipts } from "../domain/inner-operation-receipts.js"
export { RetainedBindings } from "../domain/retained-bindings.js"
export {
  ToolCallRecoveryError,
  ToolCallRecoveryOutcome,
  ToolCallRecoveryService,
} from "../domain/tool-call-recovery.js"

// Identifying and resolving the calls a feature dispatches.
export { ToolBindingIdentity } from "../domain/tool-binding.js"
export {
  innerOperationBindingIdentity,
  resolveStoredToolBinding,
} from "../runtime/agent/tool-binding-resolution.js"
export { CurrentDispatchingCall } from "../runtime/agent/current-dispatching-call.js"
export { CurrentToolCall } from "../runtime/agent/current-tool-call.js"
export { type ResolvedToolCapability, ToolRunner } from "../runtime/agent/tool-runner.js"
export { getToolMetadata } from "../domain/capability/tool.js"
export { summarizeToolOutput } from "../domain/tool-output.js"

// Running a turn's worth of work, and stopping when the turn is interrupted.
export {
  CurrentAgentLoopTurnProfile,
  type AgentLoopTurnProfile,
  runAgentLoopTurnProfile,
} from "../runtime/agent/agent-loop.turn-profile.js"
export {
  neverInterrupted,
  type TurnInterruptionStatus,
} from "../runtime/agent/turn-interruption.js"
export { AgentLoopError } from "../runtime/agent/agent-loop.state.js"

// Reporting what the feature did to the model's context.
export { ContextDirective, ModelContextLedger } from "../runtime/model-context-ledger.js"
export { partToText } from "../runtime/model-compaction.js"

// Interaction ownership: a feature that suspends for an answer owns the request.
export { CurrentInteractionOwner, type InteractionOwnership } from "../domain/interaction-owner.js"
export { ApprovalDecisionSchema, InteractionRequestRecord } from "../domain/interaction-request.js"

// Ids and domain values a feature names.
export { InteractionRequestId, ToolId } from "../domain/ids.js"
export { Permission } from "../domain/permission.js"

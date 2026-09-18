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
  type BranchToolLayerFactory,
  BranchToolWork,
} from "../runtime/tools.js"
export { eraseResourceLayer } from "../runtime/extension-host.js"

// Storage the feature contributes and reads.
export type { FeatureMigrations } from "../storage/schema.js"
export { InteractionStorage } from "../storage/storage.js"
export { MessageStorage } from "../storage/storage.js"
export { EventPublisher } from "../domain/event.js"
export { GentPlatform } from "../runtime/gent-platform.js"
export { makeOwnedToolCallReader, type OwnedToolCallAddress } from "../storage/storage.js"
export { StorageError } from "../domain/errors.js"
export { EventStoreError } from "../domain/event.js"

// The questions core asks a dispatching feature.
export {
  ToolCallRecoveryError,
  ToolCallRecoveryOutcome,
  ToolCallRecoveryService,
} from "../runtime/tools.js"

// Identifying and resolving the calls a feature dispatches.
export { ToolBindingIdentity } from "../domain/capability.js"
export { innerOperationBindingIdentity, resolveStoredToolBinding } from "../runtime/tools.js"
export { CurrentDispatchingCall } from "../runtime/tools.js"
export { CurrentToolCall } from "../runtime/tools.js"
export { type ResolvedToolCapability, ToolRunner } from "../runtime/tools.js"
export { getToolMetadata } from "../domain/capability.js"
export { summarizeOutput } from "../domain/message.js"

// Running a turn's worth of work, and stopping when the turn is interrupted.
export {
  CurrentAgentLoopTurnProfile,
  type AgentLoopTurnProfile,
  runAgentLoopTurnProfile,
} from "../runtime/turn.js"
export { neverInterrupted, type TurnInterruptionStatus } from "../runtime/tools.js"
export { AgentLoopError } from "../domain/agent-loop.js"

// Reporting what the feature did to the model's context.
export { ContextDirective, ModelContextLedger } from "../runtime/model-context.js"
export { partToText } from "../domain/message.js"

// Implementing the context compaction seam.
export {
  type CompactionRequest,
  CompactionSummary,
  ModelCompactionError,
  ModelContextCompactor,
} from "../runtime/model-context.js"
export { estimateTextTokens, ModelContextBudget } from "../runtime/model-context.js"
export { Message } from "../domain/message.js"
export { type Usage } from "../domain/event.js"
export { type ProviderAuthError } from "../domain/driver.js"
export { type ProviderError } from "../domain/errors.js"
export { responseUsage } from "../domain/message.js"
export { toPrompt } from "../runtime/model-context.js"

// Interaction ownership: a feature that suspends for an answer owns the request.
export { CurrentInteractionOwner, type InteractionOwnership } from "../domain/interaction.js"
export { ApprovalDecisionSchema, InteractionRequestRecord } from "../domain/interaction.js"

// Ids and domain values a feature names.
export { InteractionRequestId, ToolId } from "../domain/ids.js"

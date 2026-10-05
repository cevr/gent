/**
 * Branch-tool authoring API.
 *
 * A second, narrower entry point than `@gent/core/extensions/api`. That API is
 * for extensions that *use* the loop: they register tools, agents, and hooks,
 * and reach the host through `ExtensionContext`. This one is for the rarer
 * extension whose tools hold branch-scoped state, dispatch inner operations,
 * and recover their own calls across a restart.
 *
 * Such an extension uses the ordinary vocabulary for its state: a process
 * `defineResource` owns its tables and migrates them, a branch
 * `defineResource` owns its per-branch services, a tool reads its turn's stop
 * through `CurrentTurnStop`, and `tool({ recover })` settles the calls a
 * crash left in flight. This entry adds only the core services such a tool
 * reads and the seams it implements.
 *
 * Two entry points rather than one wide surface: nothing here belongs in an
 * ordinary extension's vocabulary, and an ordinary extension importing
 * `ToolRunner` is a design mistake this split keeps visible. Add a name here
 * only when such a tool cannot be written without it.
 *
 * @module
 */

// The core services a tool body may yield besides its context and platform.
export { type BranchToolHostServices } from "../runtime/tools.js"

// Storage a tool reads.
export { InteractionStorage } from "../storage/storage.js"
export { MessageStorage } from "../storage/storage.js"
export { makeOwnedToolCallReader, type OwnedToolCallAddress } from "../storage/storage.js"
export { StorageError } from "../domain/errors.js"
export { EventStoreError } from "../domain/event.js"

// What a tool's `recover` reads and answers.
export {
  ToolCallRecoveryError,
  ToolCallRecoveryOutcome,
  type ToolRecoveryCall,
} from "../runtime/tools.js"

// Identifying and resolving the calls a feature dispatches.
export { ToolBindingIdentity } from "../domain/capability.js"
export { innerOperationBindingIdentity, resolveStoredToolBinding } from "../runtime/tools.js"
export { CurrentDispatchingCall } from "../runtime/tools.js"
export { CurrentToolCall } from "../runtime/tools.js"
export { type ResolvedToolCapability, type ToolCallGate, ToolRunner } from "../runtime/tools.js"
export { type KeptToolCallVerdict, ToolCallGateState } from "../domain/capability.js"
export { getToolMetadata } from "../domain/capability.js"
export { toolResultSummary } from "../domain/capability.js"

// Running a turn's worth of work, and stopping when the turn is interrupted.
export {
  CurrentAgentLoopTurnProfile,
  type AgentLoopTurnProfile,
  runAgentLoopTurnProfile,
} from "../runtime/turn.js"
export { CurrentTurnStop, type TurnStop } from "../runtime/tools.js"
export { AgentLoopError } from "../domain/agent-loop.js"

// Reporting what the feature did to the model's context.
export { ContextDirective, ModelContextLedger } from "../runtime/model-context.js"
export { partToText } from "../domain/message.js"

// Implementing the context compaction seam.
export {
  type CompactionRequest,
  COMPACTION_SUMMARY_INPUT_TOKENS,
  COMPACTION_SUMMARY_OUTPUT_TOKENS,
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
export { InteractionRequestId } from "../domain/ids.js"

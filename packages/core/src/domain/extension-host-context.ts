import { Schema, type Context, type Effect, type PlatformError } from "effect"
import type { AgentDefinition, AgentName, AgentRunError, AgentRunResult, RunSpec } from "./agent"
import type { EventStoreError } from "./event"
import { BranchId, SessionId, type MessageId } from "./ids"
import type {
  ApprovalDecision,
  ApprovalRequest,
  InteractionPendingError,
} from "./interaction-request"
import type { Branch, Message, MessageMetadata, Session } from "./message"
import type { ModelId } from "./model"

export class ExtensionHostError extends Schema.TaggedErrorClass<ExtensionHostError>()(
  "ExtensionHostError",
  {
    operation: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export class ExtensionHostSearchResult extends Schema.Class<ExtensionHostSearchResult>(
  "ExtensionHostSearchResult",
)({
  sessionId: SessionId,
  sessionName: Schema.NullOr(Schema.String),
  branchId: BranchId,
  snippet: Schema.String,
  createdAt: Schema.Number,
}) {}

// ---------------------------------------------------------------------------
// ExtensionHostContext — unified capability-shaped boundary for extension code
// ---------------------------------------------------------------------------

export interface ExtensionHostContext {
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly agentName?: AgentName
  readonly cwd: string
  readonly home: string
  readonly capabilityContext?: Context.Context<never>

  /** Agent registry + runner */
  readonly agent: ExtensionHostContext.Agent

  /** Session queries */
  readonly session: ExtensionHostContext.SessionFacet

  /** Human interaction (approval, present, confirm, review) */
  readonly interaction: ExtensionHostContext.Interaction
}

export declare namespace ExtensionHostContext {
  interface Agent {
    readonly get: (name: AgentName) => Effect.Effect<AgentDefinition | undefined>
    readonly require: (name: AgentName) => Effect.Effect<AgentDefinition>

    readonly run: (params: {
      agent: AgentDefinition
      prompt: string
      cwd?: string
      runSpec?: RunSpec
    }) => Effect.Effect<AgentRunResult, AgentRunError>

    readonly resolveDualModelPair: () => Effect.Effect<readonly [ModelId, ModelId]>
  }

  interface SessionFacet {
    readonly listMessages: (
      branchId?: BranchId,
    ) => Effect.Effect<ReadonlyArray<Message>, ExtensionHostError>

    readonly getSession: (
      sessionId?: SessionId,
    ) => Effect.Effect<Session | undefined, ExtensionHostError>

    readonly getDetail: (sessionId: SessionId) => Effect.Effect<
      {
        session: Session
        branches: ReadonlyArray<{
          branch: Branch
          messages: ReadonlyArray<Message>
        }>
      },
      ExtensionHostError
    >

    readonly renameCurrent: (
      name: string,
    ) => Effect.Effect<{ renamed: boolean; name?: string }, ExtensionHostError>

    readonly estimateContextPercent: (options?: {
      modelId?: string
    }) => Effect.Effect<number, ExtensionHostError>

    readonly search: (
      query: string,
      options?: {
        sessionId?: SessionId
        dateAfter?: number
        dateBefore?: number
        limit?: number
      },
    ) => Effect.Effect<ReadonlyArray<ExtensionHostSearchResult>, ExtensionHostError>

    // Follow-up control: slot handlers and direct callers enqueue through the
    // session runtime and receive host-shaped errors.
    readonly queueFollowUp: (params: {
      readonly content: string
      readonly metadata?: MessageMetadata
      readonly branchId?: BranchId
    }) => Effect.Effect<void, ExtensionHostError>

    // Branch operations

    readonly listBranches: () => Effect.Effect<ReadonlyArray<Branch>, ExtensionHostError>

    readonly createBranch: (params: {
      name?: string
    }) => Effect.Effect<{ branchId: BranchId }, ExtensionHostError>

    readonly forkBranch: (params: {
      atMessageId: MessageId
      name?: string
    }) => Effect.Effect<{ branchId: BranchId }, ExtensionHostError>

    readonly switchBranch: (params: {
      toBranchId: BranchId
    }) => Effect.Effect<void, ExtensionHostError>

    // Session tree

    readonly createChildSession: (params: {
      name?: string
      cwd?: string
    }) => Effect.Effect<{ sessionId: SessionId; branchId: BranchId }, ExtensionHostError>

    readonly getChildSessions: () => Effect.Effect<ReadonlyArray<Session>, ExtensionHostError>

    readonly getSessionAncestors: (
      sessionId?: SessionId,
    ) => Effect.Effect<ReadonlyArray<Session>, ExtensionHostError>

    // Deletion

    readonly deleteSession: (sessionId: SessionId) => Effect.Effect<void, ExtensionHostError>

    readonly deleteBranch: (branchId: BranchId) => Effect.Effect<void, ExtensionHostError>

    // Message mutation

    readonly deleteMessages: (params: {
      afterMessageId?: MessageId
    }) => Effect.Effect<void, ExtensionHostError>
  }

  interface Interaction {
    readonly approve: (
      params: ApprovalRequest,
    ) => Effect.Effect<ApprovalDecision, EventStoreError | InteractionPendingError>

    readonly present: (params: {
      content: string
      title?: string
    }) => Effect.Effect<void, EventStoreError | InteractionPendingError>

    readonly confirm: (params: {
      content: string
      title?: string
    }) => Effect.Effect<"yes" | "no", EventStoreError | InteractionPendingError>

    readonly review: (params: {
      content: string
      title?: string
      fileNameSeed: string
    }) => Effect.Effect<
      { decision: "yes" | "no" | "edit"; path: string; content?: string },
      EventStoreError | PlatformError.PlatformError | InteractionPendingError
    >
  }
}

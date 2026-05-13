import { Schema, type Effect, type PlatformError } from "effect"
import type { AgentDefinition, AgentName, AgentRunError, AgentRunResult, RunSpec } from "./agent"
import type { ExtensionHostPlatform } from "./extension"
import type { EventStoreError } from "./event"
import { BranchId, SessionId } from "./ids"
import type {
  ApprovalDecision,
  ApprovalRequest,
  InteractionPendingError,
} from "./interaction-request"
import type { Branch, Message, MessageMetadata, Session } from "./message"

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
  readonly host: ExtensionHostPlatform

  /** Agent registry + runner */
  readonly agent: ExtensionHostContext.Agent

  /** Session queries */
  readonly session: ExtensionHostContext.SessionFacet

  /** Human interaction (approval, present, confirm, review) */
  readonly interaction: ExtensionHostContext.Interaction
}

export declare namespace ExtensionHostContext {
  interface Agent {
    readonly listAgents: () => Effect.Effect<ReadonlyArray<AgentDefinition>>

    readonly run: (params: {
      agent: AgentDefinition
      prompt: string
      cwd?: string
      runSpec?: RunSpec
    }) => Effect.Effect<AgentRunResult, AgentRunError>
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
      readonly sourceId: string
      readonly content: string
      readonly metadata?: MessageMetadata
      readonly branchId?: BranchId
    }) => Effect.Effect<void, ExtensionHostError>

    readonly listBranches: () => Effect.Effect<ReadonlyArray<Branch>, ExtensionHostError>
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

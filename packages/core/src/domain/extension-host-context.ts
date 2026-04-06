import type { Effect, PlatformError } from "effect"
import type {
  AgentDefinition,
  AgentExecutionOverrides,
  AgentName,
  AgentPersistence,
  AgentRunError,
  AgentRunResult,
} from "./agent"
import type { EventStoreError, ExtensionUiSnapshot } from "./event"
import type {
  AnyExtensionCommandMessage,
  AnyExtensionRequestMessage,
  ExtensionProtocolError,
  ExtractExtensionReply,
} from "./extension-protocol"
import type { BranchId, SessionId } from "./ids"
import type {
  ApprovalDecision,
  ApprovalRequest,
  InteractionPendingError,
} from "./interaction-request"
import type { Branch, Message, MessageMetadata, Session } from "./message"
import type { ModelId } from "./model"
import type { SearchResult } from "../storage/search-storage"
import type { StorageError } from "../storage/sqlite-storage"

// ---------------------------------------------------------------------------
// ExtensionHostContext — unified capability-shaped boundary for extension code
// ---------------------------------------------------------------------------

export interface ExtensionHostContext {
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly agentName?: AgentName
  readonly cwd: string
  readonly home: string

  /** Extension actor RPC */
  readonly extension: ExtensionHostContext.Extension

  /** Agent registry + runner */
  readonly agent: ExtensionHostContext.Agent

  /** Session queries */
  readonly session: ExtensionHostContext.SessionFacet

  /** Human interaction (approval, present, confirm, review) */
  readonly interaction: ExtensionHostContext.Interaction

  /** Turn-control (follow-ups, interjections) */
  readonly turn: ExtensionHostContext.Turn
}

export declare namespace ExtensionHostContext {
  interface Extension {
    readonly send: (
      message: AnyExtensionCommandMessage,
      branchId?: BranchId,
    ) => Effect.Effect<void, ExtensionProtocolError>

    readonly ask: <M extends AnyExtensionRequestMessage>(
      message: M,
      branchId?: BranchId,
    ) => Effect.Effect<ExtractExtensionReply<M>, ExtensionProtocolError>

    readonly getUiSnapshots: (
      branchId?: BranchId,
    ) => Effect.Effect<ReadonlyArray<ExtensionUiSnapshot>>

    readonly getUiSnapshot: <T>(
      extensionId: string,
      branchId?: BranchId,
    ) => Effect.Effect<T | undefined>
  }

  interface Agent {
    readonly get: (name: AgentName) => Effect.Effect<AgentDefinition | undefined>
    readonly require: (name: AgentName) => Effect.Effect<AgentDefinition>

    readonly run: (params: {
      agent: AgentDefinition
      prompt: string
      cwd?: string
      overrides?: AgentExecutionOverrides
      persistence?: AgentPersistence
    }) => Effect.Effect<AgentRunResult, AgentRunError>

    readonly resolveDualModelPair: () => Effect.Effect<readonly [ModelId, ModelId]>
  }

  interface SessionFacet {
    readonly listMessages: (
      branchId?: BranchId,
    ) => Effect.Effect<ReadonlyArray<Message>, StorageError>

    readonly getSession: (sessionId?: SessionId) => Effect.Effect<Session | undefined, StorageError>

    readonly getDetail: (sessionId: SessionId) => Effect.Effect<
      {
        session: Session
        branches: ReadonlyArray<{
          branch: Branch
          messages: ReadonlyArray<Message>
        }>
      },
      StorageError
    >

    readonly renameCurrent: (
      name: string,
    ) => Effect.Effect<{ renamed: boolean; name?: string }, StorageError | EventStoreError>

    readonly estimateContextPercent: (options?: {
      modelId?: string
    }) => Effect.Effect<number, StorageError>

    readonly search: (
      query: string,
      options?: {
        sessionId?: string
        dateAfter?: number
        dateBefore?: number
        limit?: number
      },
    ) => Effect.Effect<ReadonlyArray<SearchResult>, StorageError>
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

  interface Turn {
    readonly queueFollowUp: (params: {
      content: string
      metadata?: MessageMetadata
    }) => Effect.Effect<void>

    readonly interject: (params: { content: string }) => Effect.Effect<void>
  }
}

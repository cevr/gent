import { DateTime, Effect } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import { DEFAULT_MAX_AGENT_RUN_DEPTH, AgentRunError, type AgentName } from "../../domain/agent.js"
import {
  AgentRunFailed,
  AgentRunSpawned,
  AgentRunSucceeded,
  type EventStoreError,
} from "../../domain/event.js"
import { EventPublisher } from "../../domain/event-publisher.js"
import { BranchId, SessionId, type ToolCallId } from "../../domain/ids.js"
import { Branch, Session } from "../../domain/message.js"
import { BranchStorage } from "../../storage/branch-storage.js"
import { RelationshipStorage } from "../../storage/relationship-storage.js"
import { SessionStorage } from "../../storage/session-storage.js"
import { makeStorageTransaction, type StorageError } from "../../storage/sqlite-storage.js"
import { GentPlatform } from "../gent-platform.js"

export interface DurableAgentRunRuntime {
  readonly createDurableAgentRunSession: (params: {
    agent: { name: AgentName }
    prompt: string
    parentSessionId: SessionId
    parentBranchId: BranchId
    toolCallId?: ToolCallId
    cwd: string
  }) => Effect.Effect<
    { sessionId: SessionId; branchId: BranchId },
    AgentRunError | EventStoreError | StorageError
  >
  readonly publishAgentRunSpawned: (params: {
    parentSessionId: SessionId
    parentBranchId: BranchId
    toolCallId?: ToolCallId
    sessionId: SessionId
    childBranchId: BranchId
    agentName: AgentName
    prompt: string
  }) => Effect.Effect<void, EventStoreError>
  readonly publishAgentRunSucceeded: (params: {
    parentSessionId: SessionId
    parentBranchId: BranchId
    toolCallId?: ToolCallId
    sessionId: SessionId
    agentName: AgentName
    usage?: { input: number; output: number; cost?: number }
    preview?: string
    savedPath?: string
  }) => Effect.Effect<void, EventStoreError>
  readonly publishAgentRunFailed: (params: {
    parentSessionId: SessionId
    parentBranchId: BranchId
    toolCallId?: ToolCallId
    sessionId: SessionId
    agentName: AgentName
  }) => Effect.Effect<void>
}

/** Compute nesting depth of a session from its persisted parent chain. Root sessions have depth 0. */
export const getSessionDepth = (sessionId: SessionId) =>
  Effect.gen(function* () {
    const relationshipStorage = yield* RelationshipStorage
    return yield* relationshipStorage.getSessionAncestors(sessionId).pipe(
      // ancestors includes the session itself at index 0, then parents
      Effect.map((ancestors) => Math.max(0, ancestors.length - 1)),
      // Fail closed: if we can't read ancestry, refuse to spawn rather than allow unbounded recursion
      Effect.mapError(
        () =>
          new AgentRunError({
            message: `Cannot determine session depth for "${sessionId}" — refusing to start agent run.`,
          }),
      ),
    )
  })

export const makeDurableAgentRunRuntime: Effect.Effect<
  DurableAgentRunRuntime,
  never,
  | SessionStorage
  | BranchStorage
  | RelationshipStorage
  | EventPublisher
  | GentPlatform
  | SqlClient.SqlClient
> = Effect.gen(function* () {
  const sessionStorage = yield* SessionStorage
  const branchStorage = yield* BranchStorage
  const relationshipStorage = yield* RelationshipStorage
  const eventPublisher = yield* EventPublisher
  const platform = yield* GentPlatform
  const storageTransaction = yield* makeStorageTransaction

  const getSessionDepth = (sessionId: SessionId) =>
    relationshipStorage.getSessionAncestors(sessionId).pipe(
      // ancestors includes the session itself at index 0, then parents
      Effect.map((ancestors) => Math.max(0, ancestors.length - 1)),
      // Fail closed: if we can't read ancestry, refuse to spawn rather than allow unbounded recursion
      Effect.mapError(
        () =>
          new AgentRunError({
            message: `Cannot determine session depth for "${sessionId}" — refusing to start agent run.`,
          }),
      ),
    )

  const createDurableAgentRunSession = (params: {
    agent: { name: AgentName }
    prompt: string
    parentSessionId: SessionId
    parentBranchId: BranchId
    toolCallId?: ToolCallId
    cwd: string
  }) =>
    Effect.gen(function* () {
      const parentDepth = yield* getSessionDepth(params.parentSessionId)
      if (parentDepth >= DEFAULT_MAX_AGENT_RUN_DEPTH) {
        return yield* new AgentRunError({
          message: `Agent run depth limit reached (max ${DEFAULT_MAX_AGENT_RUN_DEPTH}). Cannot spawn "${params.agent.name}" — parent session is already at depth ${parentDepth}.`,
        })
      }

      const sessionId = SessionId.make(yield* platform.randomId)
      const branchId = BranchId.make(yield* platform.randomId)
      const now = yield* DateTime.nowAsDate

      const committed = yield* storageTransaction(
        Effect.gen(function* () {
          yield* sessionStorage.createSession(
            new Session({
              id: sessionId,
              name: `${params.agent.name}: ${params.prompt.slice(0, 60)}`,
              cwd: params.cwd,
              parentSessionId: params.parentSessionId,
              parentBranchId: params.parentBranchId,
              activeBranchId: branchId,
              createdAt: now,
              updatedAt: now,
            }),
          )
          yield* branchStorage.createBranch(
            new Branch({
              id: branchId,
              sessionId,
              createdAt: now,
            }),
          )
          const envelope = yield* eventPublisher.append(
            AgentRunSpawned.make({
              parentSessionId: params.parentSessionId,
              childSessionId: sessionId,
              agentName: params.agent.name,
              prompt: params.prompt,
              toolCallId: params.toolCallId,
              branchId: params.parentBranchId,
              childBranchId: branchId,
            }),
          )
          return { envelope }
        }),
      )
      yield* eventPublisher.deliver(committed.envelope)

      return { sessionId, branchId }
    })

  const publishAgentRunSpawned = (params: {
    parentSessionId: SessionId
    parentBranchId: BranchId
    toolCallId?: ToolCallId
    sessionId: SessionId
    childBranchId: BranchId
    agentName: AgentName
    prompt: string
  }) =>
    eventPublisher.publish(
      AgentRunSpawned.make({
        parentSessionId: params.parentSessionId,
        childSessionId: params.sessionId,
        agentName: params.agentName,
        prompt: params.prompt,
        toolCallId: params.toolCallId,
        branchId: params.parentBranchId,
        childBranchId: params.childBranchId,
      }),
    )

  const publishAgentRunSucceeded = (params: {
    parentSessionId: SessionId
    parentBranchId: BranchId
    toolCallId?: ToolCallId
    sessionId: SessionId
    agentName: AgentName
    usage?: { input: number; output: number; cost?: number }
    preview?: string
    savedPath?: string
  }) =>
    eventPublisher.publish(
      AgentRunSucceeded.make({
        parentSessionId: params.parentSessionId,
        childSessionId: params.sessionId,
        agentName: params.agentName,
        toolCallId: params.toolCallId,
        branchId: params.parentBranchId,
        usage: params.usage,
        preview: params.preview,
        savedPath: params.savedPath,
      }),
    )

  const publishAgentRunFailed = (params: {
    parentSessionId: SessionId
    parentBranchId: BranchId
    toolCallId?: ToolCallId
    sessionId: SessionId
    agentName: AgentName
  }) =>
    eventPublisher
      .publish(
        AgentRunFailed.make({
          parentSessionId: params.parentSessionId,
          childSessionId: params.sessionId,
          agentName: params.agentName,
          toolCallId: params.toolCallId,
          branchId: params.parentBranchId,
        }),
      )
      .pipe(
        Effect.catchEager((e) =>
          Effect.logWarning("failed to publish agent-run event").pipe(
            Effect.annotateLogs({ error: String(e) }),
          ),
        ),
      )

  return {
    createDurableAgentRunSession,
    publishAgentRunSpawned,
    publishAgentRunSucceeded,
    publishAgentRunFailed,
  }
})

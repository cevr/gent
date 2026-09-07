import { DateTime, Duration, Effect, Option, Predicate, Schedule, Schema, type Cause } from "effect"
import { canonicalJsonString } from "effect-encore"
import { SqlClient } from "effect/unstable/sql"
import {
  DEFAULT_MAX_AGENT_RUN_DEPTH,
  DEFAULT_MAX_PENDING_AGENT_STARTS,
  AgentRunError,
  makeRunSpec,
  type AgentName,
  type RunSpec,
} from "../../domain/agent.js"
import {
  AgentRunFailed,
  AgentRunSpawned,
  AgentRunSucceeded,
  type EventStoreError,
  type TurnCompleted,
} from "../../domain/event.js"
import { EventPublisher } from "../../domain/event-publisher.js"
import {
  ActorCommandId,
  BranchId,
  MessageId,
  SessionId,
  RequestId,
  type ToolCallId,
} from "../../domain/ids.js"
import { SessionRuntime } from "../session-runtime.js"
import {
  SessionOperationStorage,
  StoredAgentStartInput,
} from "../../storage/session-operation-storage.js"
import { Branch, Session } from "../../domain/message.js"
import { BranchStorage } from "../../storage/branch-storage.js"
import { EventStorage } from "../../storage/event-storage.js"
import { RelationshipStorage } from "../../storage/relationship-storage.js"
import { SessionStorage } from "../../storage/session-storage.js"
import { makeStorageTransaction, type StorageError } from "../../storage/sqlite-storage.js"
import { GentPlatform } from "../gent-platform.js"

const canonicalStartInput = (input: typeof StoredAgentStartInput.Type) =>
  Schema.encodeEffect(Schema.fromJsonString(StoredAgentStartInput))(input).pipe(
    Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(Schema.Json))),
    Effect.map(canonicalJsonString),
    Effect.mapError((cause) => new AgentRunError({ message: "Invalid agent-start input", cause })),
  )

interface DurableAgentRunInput {
  agent: { name: AgentName }
  prompt: string
  parentSessionId: SessionId
  parentBranchId: BranchId
  toolCallId?: ToolCallId
  cwd: string
  admission?: { readonly requestId: RequestId; readonly runSpec?: RunSpec }
}

export interface DurableAgentRunRuntime {
  readonly cancel: (
    params: Parameters<DurableAgentRunRuntime["inspect"]>[0],
  ) => Effect.Effect<void, AgentRunError | StorageError, EventStorage | SessionRuntime>
  readonly wait: (
    params: Parameters<DurableAgentRunRuntime["inspect"]>[0] & { readonly waitMs: number },
  ) => Effect.Effect<
    { sessionId: SessionId; branchId: BranchId; completion: Option.Option<TurnCompleted> },
    AgentRunError | StorageError | Cause.TimeoutError,
    EventStorage
  >
  readonly inspect: (params: {
    readonly requestId: RequestId
    readonly parentSessionId: SessionId
    readonly parentBranchId: BranchId
  }) => Effect.Effect<
    { sessionId: SessionId; branchId: BranchId; completion: Option.Option<TurnCompleted> },
    AgentRunError | StorageError,
    EventStorage
  >
  readonly start: (
    params: DurableAgentRunInput & {
      readonly toolCallId: ToolCallId
      readonly admission: { readonly requestId: RequestId; readonly runSpec?: RunSpec }
    },
  ) => Effect.Effect<
    { sessionId: SessionId; branchId: BranchId },
    AgentRunError | EventStoreError | StorageError,
    SessionRuntime
  >
  readonly createDurableAgentRunSession: (
    params: DurableAgentRunInput,
  ) => Effect.Effect<
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
export const getSessionDepth = Effect.fn("AgentRunner.getSessionDepth")(function* (
  sessionId: SessionId,
) {
  const relationshipStorage = yield* RelationshipStorage
  const ancestors = yield* relationshipStorage.getSessionAncestors(sessionId).pipe(
    // Fail closed: if we can't read ancestry, refuse to spawn rather than allow unbounded recursion
    Effect.mapError(
      () =>
        new AgentRunError({
          message: `Cannot determine session depth for "${sessionId}" — refusing to start agent run.`,
        }),
    ),
  )
  const root = ancestors.at(-1)
  if (
    ancestors[0]?.id !== sessionId ||
    Predicate.isUndefined(root) ||
    Predicate.isNotUndefined(root.parentSessionId)
  ) {
    return yield* new AgentRunError({
      message: `Cannot determine session depth for "${sessionId}" — ancestry is missing or incomplete.`,
    })
  }
  return ancestors.length - 1
})

export const makeDurableAgentRunRuntime: Effect.Effect<
  DurableAgentRunRuntime,
  never,
  | SessionStorage
  | SessionOperationStorage
  | BranchStorage
  | RelationshipStorage
  | EventPublisher
  | GentPlatform
  | SqlClient.SqlClient
> = Effect.gen(function* () {
  const sessionStorage = yield* SessionStorage
  const operations = yield* SessionOperationStorage
  const branchStorage = yield* BranchStorage
  const relationshipStorage = yield* RelationshipStorage
  const eventPublisher = yield* EventPublisher
  const platform = yield* GentPlatform
  const storageTransaction = yield* makeStorageTransaction
  const sql = yield* SqlClient.SqlClient

  const createDurableAgentRunSession = (params: DurableAgentRunInput) =>
    Effect.gen(function* () {
      if (Option.isSome(yield* Effect.serviceOption(sql.transactionService))) {
        return yield* new AgentRunError({
          message: "Child admission must commit outside a caller transaction",
        })
      }
      const parentDepth = yield* getSessionDepth(params.parentSessionId).pipe(
        Effect.provideService(RelationshipStorage, relationshipStorage),
      )
      if (parentDepth >= DEFAULT_MAX_AGENT_RUN_DEPTH) {
        return yield* new AgentRunError({
          message: `Agent run depth limit reached (max ${DEFAULT_MAX_AGENT_RUN_DEPTH}). Cannot spawn "${params.agent.name}" — parent session is already at depth ${parentDepth}.`,
        })
      }

      const sessionId = SessionId.make(yield* platform.randomId)
      const branchId = BranchId.make(yield* platform.randomId)
      const now = yield* DateTime.nowAsDate
      const startInput = {
        parentSessionId: params.parentSessionId,
        parentBranchId: params.parentBranchId,
        agentName: params.agent.name,
        prompt: params.prompt,
        cwd: params.cwd,
        toolCallId: params.toolCallId,
        runSpec: params.admission?.runSpec,
      }

      const committed = yield* storageTransaction(
        Effect.gen(function* () {
          if (Predicate.isNotUndefined(params.admission)) {
            const parentBranch = yield* branchStorage.getBranch(params.parentBranchId)
            if (parentBranch?.sessionId !== params.parentSessionId) {
              return yield* new AgentRunError({
                message: "Agent-start branch does not belong to parent",
              })
            }
            const saved = yield* operations.getAgentStart(params.admission.requestId)
            if (Option.isSome(saved)) {
              if (
                (yield* canonicalStartInput(saved.value.input)) !==
                (yield* canonicalStartInput(startInput))
              ) {
                return yield* new AgentRunError({ message: "Agent-start request input changed" })
              }
              const child = yield* sessionStorage.getSession(saved.value.sessionId)
              if (Predicate.isUndefined(child)) {
                return yield* new AgentRunError({ message: "Agent-start child no longer exists" })
              }
              return {
                sessionId: saved.value.sessionId,
                branchId: saved.value.branchId,
                envelope: Option.none(),
              }
            }
            const pending = yield* operations.countPendingAgentStarts({
              sessionId: params.parentSessionId,
              branchId: params.parentBranchId,
            })
            if (pending >= DEFAULT_MAX_PENDING_AGENT_STARTS) {
              return yield* new AgentRunError({
                message: `Parent branch already has ${DEFAULT_MAX_PENDING_AGENT_STARTS} unfinished child starts`,
              })
            }
          }
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
          if (Predicate.isNotUndefined(params.admission)) {
            yield* operations.saveAgentStart(params.admission.requestId, {
              sessionId,
              branchId,
              input: startInput,
            })
          }
          return { sessionId, branchId, envelope: Option.some(envelope) }
        }),
      )
      if (Option.isSome(committed.envelope)) yield* eventPublisher.deliver(committed.envelope.value)

      return { sessionId: committed.sessionId, branchId: committed.branchId }
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

  const inspect = Effect.fn("AgentRunner.inspectDurable")(function* (
    params: Parameters<DurableAgentRunRuntime["inspect"]>[0],
  ) {
    const events = yield* EventStorage
    return yield* storageTransaction(
      Effect.gen(function* () {
        const saved = yield* operations.getAgentStart(params.requestId)
        if (
          Option.isNone(saved) ||
          saved.value.input.parentSessionId !== params.parentSessionId ||
          saved.value.input.parentBranchId !== params.parentBranchId
        ) {
          return yield* new AgentRunError({ message: "Agent-start receipt not owned by parent" })
        }
        const { sessionId, branchId } = saved.value
        const child = yield* sessionStorage.getSession(sessionId)
        const branch = yield* branchStorage.getBranch(branchId)
        if (
          child?.parentSessionId !== params.parentSessionId ||
          child?.parentBranchId !== params.parentBranchId ||
          branch?.sessionId !== sessionId
        ) {
          return yield* new AgentRunError({ message: "Agent-start child no longer exists" })
        }
        const completion = yield* events
          .getLatestEvent({
            sessionId,
            branchId,
            tags: ["TurnCompleted"],
            messageId: MessageId.make(`agent-start:${params.requestId}`),
          })
          .pipe(
            Effect.mapError(
              (cause) => new AgentRunError({ message: "Cannot read child completion", cause }),
            ),
          )
        if (completion?._tag === "TurnCompleted") {
          return { sessionId, branchId, completion: Option.some(completion) }
        }
        return { sessionId, branchId, completion: Option.none<TurnCompleted>() }
      }),
    )
  })

  const submitChildMessage = Effect.fn("AgentRunner.submitChildMessage")(function* (
    requestId: RequestId,
  ) {
    const saved = yield* operations.getAgentStart(requestId)
    if (Option.isNone(saved)) {
      return yield* new AgentRunError({ message: "Agent-start receipt no longer exists" })
    }
    const { sessionId, branchId, input } = saved.value
    const runtime = yield* SessionRuntime
    yield* runtime
      .sendUserMessage({
        sessionId,
        branchId,
        commandId: ActorCommandId.make(`agent-start:${requestId}`),
        content: input.prompt,
        agentOverride: input.agentName,
        interactive: false,
        runSpec: input.runSpec,
        completion: "admission",
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new AgentRunError({
              message: "Child queue admission failed; retry the same start request",
              cause,
            }),
        ),
      )
  })

  return {
    inspect,
    cancel: Effect.fn("AgentRunner.cancelDurable")(function* (
      params: Parameters<DurableAgentRunRuntime["cancel"]>[0],
    ) {
      if (Option.isSome(yield* Effect.serviceOption(sql.transactionService))) {
        return yield* new AgentRunError({
          message: "Child cancellation must run outside a caller transaction",
        })
      }
      const child = yield* inspect(params)
      if (Option.isSome(child.completion)) return
      yield* operations.cancelTurn({
        sessionId: child.sessionId,
        branchId: child.branchId,
        messageId: MessageId.make(`agent-start:${params.requestId}`),
      })
      const runtime = yield* SessionRuntime
      yield* runtime
        .steer({
          _tag: "Cancel",
          sessionId: child.sessionId,
          branchId: child.branchId,
          requestId: RequestId.make(`agent-cancel:${params.requestId}`),
          messageId: MessageId.make(`agent-start:${params.requestId}`),
        })
        .pipe(
          Effect.mapError(
            (cause) => new AgentRunError({ message: "Cannot submit child cancellation", cause }),
          ),
        )
      yield* submitChildMessage(params.requestId)
    }),
    wait: Effect.fn("AgentRunner.waitDurable")(function* (
      params: Parameters<DurableAgentRunRuntime["wait"]>[0],
    ) {
      const waitMs = yield* Schema.decodeEffect(
        Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(30_000)),
      )(params.waitMs).pipe(
        Effect.mapError(
          (cause) =>
            new AgentRunError({ message: "Child wait must be 1–30000 milliseconds", cause }),
        ),
      )
      if (Option.isSome(yield* Effect.serviceOption(sql.transactionService))) {
        return yield* new AgentRunError({
          message: "Child wait must run outside a caller transaction",
        })
      }
      return yield* inspect(params).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("50 millis"),
          until: (observed) => Option.isSome(observed.completion),
        }),
        Effect.timeout(Duration.millis(waitMs)),
      )
    }),
    start: Effect.fn("AgentRunner.startDurable")(function* (
      params: Parameters<DurableAgentRunRuntime["start"]>[0],
    ) {
      if (params.admission.runSpec?.persistence === "ephemeral") {
        return yield* new AgentRunError({
          message: "Durable child start cannot use ephemeral persistence",
        })
      }
      const runSpec = makeRunSpec({
        ...params.admission.runSpec,
        persistence: "durable",
        parentToolCallId: params.toolCallId,
      })
      const child = yield* createDurableAgentRunSession({
        ...params,
        admission: { ...params.admission, runSpec },
      })
      yield* submitChildMessage(params.admission.requestId)
      return child
    }),
    createDurableAgentRunSession,
    publishAgentRunSpawned,
    publishAgentRunSucceeded,
    publishAgentRunFailed,
  }
})

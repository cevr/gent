import { DateTime, Effect, Layer, Context, Stream } from "effect"
import { EventPublisher } from "../domain/event-publisher.js"
import { SessionMutations, type SessionMutationsService } from "../domain/session-mutations.js"
import { SessionCwdRegistry } from "../runtime/session-cwd-registry.js"
import { BranchId, MessageId, SessionId } from "../domain/ids.js"
import { Branch, Message, Session, TextPart, copyMessageToBranch } from "../domain/message.js"
import type { QueueSnapshot } from "../domain/queue.js"
import type { SteerCommand } from "../domain/steer.js"
import {
  EventStore,
  BranchSwitched,
  BranchCreated,
  BranchSummarized,
  SessionStarted,
  SessionNameUpdated,
  SessionSettingsUpdated,
  type AgentEvent,
  type EventStoreError,
} from "../domain/event.js"
import { SessionStorage } from "../storage/session-storage.js"
import { BranchStorage } from "../storage/branch-storage.js"
import { MessageStorage } from "../storage/message-storage.js"
import { Storage, type StorageError } from "../storage/sqlite-storage.js"
import { Provider, providerRequestFromMessages } from "../providers/provider.js"
import { MachineEngine } from "../runtime/extensions/resource-host/machine-engine.js"
import {
  SessionRuntime,
  applySteerCommand,
  sendUserMessageCommand,
} from "../runtime/session-runtime.js"
import { NotFoundError, type AppServiceError } from "./errors.js"
import type {
  CreateBranchInput,
  CreateBranchResult,
  CreateSessionInput,
  CreateSessionResult,
  ForkBranchInput,
  SendMessageInput,
  SwitchBranchInput,
  UpdateSessionReasoningLevelInput,
  UpdateSessionReasoningLevelResult,
} from "./transport-contract.js"

const NAME_GEN_MODEL = "anthropic/claude-haiku-4-5-20251001"

export interface SessionCommandsService {
  readonly createSession: (
    input: CreateSessionInput,
  ) => Effect.Effect<CreateSessionResult, AppServiceError>
  readonly deleteSession: (
    sessionId: SessionId,
  ) => Effect.Effect<void, StorageError | EventStoreError>
  readonly deleteBranch: (input: {
    readonly sessionId: SessionId
    readonly currentBranchId: BranchId
    readonly branchId: BranchId
  }) => Effect.Effect<void, StorageError>
  readonly deleteMessages: (input: {
    readonly sessionId: SessionId
    readonly branchId: BranchId
    readonly afterMessageId?: MessageId
  }) => Effect.Effect<void, StorageError>
  readonly createBranch: (
    input: CreateBranchInput,
  ) => Effect.Effect<CreateBranchResult, AppServiceError>
  readonly renameSession: (input: {
    readonly sessionId: SessionId
    readonly name: string
  }) => Effect.Effect<{ renamed: boolean; name?: string }, StorageError | EventStoreError>
  readonly createSessionBranch: (input: {
    readonly sessionId: SessionId
    readonly parentBranchId?: BranchId
    readonly name?: string
  }) => Effect.Effect<CreateBranchResult, StorageError | EventStoreError>
  readonly switchBranch: (input: SwitchBranchInput) => Effect.Effect<void, AppServiceError>
  readonly switchActiveBranch: (input: {
    readonly sessionId: SessionId
    readonly fromBranchId: BranchId
    readonly toBranchId: BranchId
  }) => Effect.Effect<void, StorageError | EventStoreError>
  readonly forkBranch: (
    input: ForkBranchInput,
  ) => Effect.Effect<CreateBranchResult, AppServiceError>
  readonly forkSessionBranch: (input: {
    readonly sessionId: SessionId
    readonly fromBranchId: BranchId
    readonly atMessageId: MessageId
    readonly name?: string
  }) => Effect.Effect<CreateBranchResult, StorageError | EventStoreError>
  readonly createChildSession: (input: {
    readonly parentSessionId: SessionId
    readonly parentBranchId: BranchId
    readonly name?: string
    readonly cwd?: string
  }) => Effect.Effect<{ sessionId: SessionId; branchId: BranchId }, StorageError | EventStoreError>
  readonly sendMessage: (input: SendMessageInput) => Effect.Effect<void, AppServiceError>
  readonly steer: (command: SteerCommand) => Effect.Effect<void, AppServiceError>
  readonly drainQueuedMessages: (input: {
    sessionId: SessionId
    branchId: BranchId
  }) => Effect.Effect<QueueSnapshot, AppServiceError>
  readonly updateSessionReasoningLevel: (
    input: UpdateSessionReasoningLevelInput,
  ) => Effect.Effect<UpdateSessionReasoningLevelResult, AppServiceError>
}

const makeSessionMutationsService: Effect.Effect<
  SessionMutationsService,
  never,
  | Storage
  | EventStore
  | EventPublisher
  | SessionStorage
  | BranchStorage
  | MessageStorage
  | MachineEngine
  | SessionCwdRegistry
> = Effect.gen(function* () {
  const storage = yield* Storage
  const sessionStorage = yield* SessionStorage
  const branchStorage = yield* BranchStorage
  const messageStorage = yield* MessageStorage
  const eventStore = yield* EventStore
  const eventPublisher = yield* EventPublisher
  const extensionStateRuntime = yield* MachineEngine
  const sessionCwdRegistry = yield* SessionCwdRegistry

  const transactWithEvent = <A, E, R>(
    mutation: Effect.Effect<A, E, R>,
    event: AgentEvent,
  ): Effect.Effect<A, E | EventStoreError | StorageError, R> =>
    Effect.gen(function* () {
      const committed = yield* storage.withTransaction(
        Effect.gen(function* () {
          const result = yield* mutation
          const envelope = yield* eventPublisher.append(event)
          return { result, envelope }
        }),
      )
      yield* eventPublisher.deliver(committed.envelope)
      return committed.result
    })

  const validateMessageCursor = Effect.fn("SessionMutations.validateMessageCursor")(
    function* (input: {
      readonly sessionId: SessionId
      readonly branchId: BranchId
      readonly afterMessageId?: MessageId
    }) {
      if (input.afterMessageId === undefined) return
      const cursor = yield* messageStorage.getMessage(input.afterMessageId)
      if (
        cursor === undefined ||
        cursor.sessionId !== input.sessionId ||
        cursor.branchId !== input.branchId
      ) {
        return yield* Effect.die(`Message "${input.afterMessageId}" not found in current branch`)
      }
    },
  )

  const validateBranchDeletion = Effect.fn("SessionMutations.validateBranchDeletion")(
    function* (input: { readonly sessionId: SessionId; readonly branchId: BranchId }) {
      const branches = yield* branchStorage.listBranches(input.sessionId)
      if (branches.some((branch) => branch.parentBranchId === input.branchId)) {
        return yield* Effect.die(`Cannot delete branch "${input.branchId}" with child branches`)
      }
      const childSessions = yield* storage.getChildSessions(input.sessionId)
      if (childSessions.some((session) => session.parentBranchId === input.branchId)) {
        return yield* Effect.die(`Cannot delete branch "${input.branchId}" with child sessions`)
      }
    },
  )

  const collectSessionTreeIds = Effect.fn("SessionMutations.collectSessionTreeIds")(function* (
    rootSessionId: SessionId,
  ) {
    const sessionIds: SessionId[] = []
    const queue: SessionId[] = [rootSessionId]
    const seen = new Set<SessionId>()
    let index = 0

    while (index < queue.length) {
      const sessionId = queue[index]
      index += 1
      if (sessionId === undefined || seen.has(sessionId)) continue
      seen.add(sessionId)
      sessionIds.push(sessionId)
      const children = yield* storage.getChildSessions(sessionId)
      for (const child of children) {
        queue.push(child.id)
      }
    }

    return sessionIds
  })

  const cleanupSessionRuntimeState = Effect.fn("SessionMutations.cleanupSessionRuntimeState")(
    function* (sessionId: SessionId) {
      yield* extensionStateRuntime.terminateAll(sessionId).pipe(
        // Session deletion owns cleanup best-effort actor termination, then
        // propagates durable store failures below.
        Effect.catchDefect(() => Effect.void),
      )
      yield* eventPublisher.terminateSession(sessionId)
      yield* eventStore.removeSession(sessionId)
      yield* sessionCwdRegistry.forget(sessionId)
    },
  )

  const deleteSessionCascade = Effect.fn("SessionMutations.deleteSessionCascade")(function* (
    sessionId: SessionId,
  ) {
    const sessionIds = yield* collectSessionTreeIds(sessionId)
    yield* Effect.forEach(sessionIds, cleanupSessionRuntimeState, { discard: true })
    yield* sessionStorage.deleteSession(sessionId)
    yield* Effect.forEach(
      sessionIds,
      (deletedSessionId) =>
        Effect.logInfo("session.deleted").pipe(
          Effect.annotateLogs({ sessionId: deletedSessionId }),
        ),
      { discard: true },
    )
  })

  return {
    renameSession: Effect.fn("SessionMutations.renameSession")(function* (input) {
      const trimmed = input.name.trim().slice(0, 80)
      if (trimmed.length === 0) return { renamed: false as const }
      const session = yield* sessionStorage.getSession(input.sessionId)
      if (session === undefined) return { renamed: false as const }
      if (session.name === trimmed) return { renamed: false as const }
      yield* transactWithEvent(
        sessionStorage.updateSession(
          new Session({
            ...session,
            name: trimmed,
            updatedAt: yield* DateTime.nowAsDate,
          }),
        ),
        SessionNameUpdated.make({ sessionId: input.sessionId, name: trimmed }),
      )
      return { renamed: true as const, name: trimmed }
    }),

    createSessionBranch: Effect.fn("SessionMutations.createSessionBranch")(function* (input) {
      const branch = new Branch({
        id: BranchId.make(Bun.randomUUIDv7()),
        sessionId: input.sessionId,
        parentBranchId: input.parentBranchId,
        name: input.name,
        createdAt: yield* DateTime.nowAsDate,
      })
      yield* transactWithEvent(
        branchStorage.createBranch(branch),
        BranchCreated.make({
          sessionId: branch.sessionId,
          branchId: branch.id,
          ...(branch.parentBranchId !== undefined ? { parentBranchId: branch.parentBranchId } : {}),
        }),
      )
      return { branchId: branch.id }
    }),

    forkSessionBranch: Effect.fn("SessionMutations.forkSessionBranch")(function* (input) {
      const fromBranch = yield* branchStorage.getBranch(input.fromBranchId)
      if (fromBranch === undefined || fromBranch.sessionId !== input.sessionId) {
        return yield* Effect.die("Branch not found")
      }

      const messages = yield* messageStorage.listMessages(input.fromBranchId)
      const targetIndex = messages.findIndex((message) => message.id === input.atMessageId)
      if (targetIndex === -1) {
        return yield* Effect.die("Message not found in branch")
      }

      const branch = new Branch({
        id: BranchId.make(Bun.randomUUIDv7()),
        sessionId: input.sessionId,
        parentBranchId: input.fromBranchId,
        parentMessageId: input.atMessageId,
        name: input.name,
        createdAt: yield* DateTime.nowAsDate,
      })
      yield* transactWithEvent(
        Effect.gen(function* () {
          yield* branchStorage.createBranch(branch)
          for (const message of messages.slice(0, targetIndex + 1)) {
            yield* messageStorage.createMessage(
              copyMessageToBranch(message, {
                id: MessageId.make(Bun.randomUUIDv7()),
                branchId: branch.id,
              }),
            )
          }
        }),
        BranchCreated.make({
          sessionId: branch.sessionId,
          branchId: branch.id,
          ...(branch.parentBranchId !== undefined ? { parentBranchId: branch.parentBranchId } : {}),
          ...(branch.parentMessageId !== undefined
            ? { parentMessageId: branch.parentMessageId }
            : {}),
        }),
      )
      return { branchId: branch.id }
    }),

    switchActiveBranch: Effect.fn("SessionMutations.switchActiveBranch")(function* (input) {
      const session = yield* sessionStorage.getSession(input.sessionId)
      if (session === undefined) return yield* Effect.die("Current session not found")
      const fromBranch = yield* branchStorage.getBranch(input.fromBranchId)
      if (fromBranch === undefined || fromBranch.sessionId !== input.sessionId) {
        return yield* Effect.die(`Branch "${input.fromBranchId}" not found in current session`)
      }
      const toBranch = yield* branchStorage.getBranch(input.toBranchId)
      if (toBranch === undefined || toBranch.sessionId !== input.sessionId) {
        return yield* Effect.die(`Branch "${input.toBranchId}" not found in current session`)
      }
      yield* transactWithEvent(
        sessionStorage.updateSession(
          new Session({
            ...session,
            activeBranchId: input.toBranchId,
            updatedAt: yield* DateTime.nowAsDate,
          }),
        ),
        BranchSwitched.make({
          sessionId: input.sessionId,
          fromBranchId: input.fromBranchId,
          toBranchId: input.toBranchId,
        }),
      )
    }),

    createChildSession: Effect.fn("SessionMutations.createChildSession")(function* (input) {
      const sessionId = SessionId.make(Bun.randomUUIDv7())
      const branchId = BranchId.make(Bun.randomUUIDv7())
      const now = yield* DateTime.nowAsDate
      const session = new Session({
        id: sessionId,
        name: input.name ?? "child session",
        cwd: input.cwd,
        parentSessionId: input.parentSessionId,
        parentBranchId: input.parentBranchId,
        activeBranchId: branchId,
        createdAt: now,
        updatedAt: now,
      })
      const branch = new Branch({
        id: branchId,
        sessionId,
        createdAt: now,
      })
      const committed = yield* storage
        .withTransaction(
          Effect.gen(function* () {
            yield* sessionStorage.createSession(session)
            yield* branchStorage.createBranch(branch)
            if (input.cwd !== undefined) {
              yield* sessionCwdRegistry.record(sessionId, input.cwd)
            }
            const envelope = yield* eventPublisher.append(
              SessionStarted.make({ sessionId, branchId }),
            )
            return { envelope }
          }),
        )
        .pipe(Effect.onError(() => sessionCwdRegistry.forget(sessionId)))
      yield* eventPublisher.deliver(committed.envelope)
      return { sessionId, branchId }
    }),

    deleteSession: Effect.fn("SessionMutations.deleteSession")(function* (sessionId) {
      yield* deleteSessionCascade(sessionId)
    }),

    deleteBranch: Effect.fn("SessionMutations.deleteBranch")(function* (input) {
      if (input.branchId === input.currentBranchId) {
        return yield* Effect.die("Cannot delete the current branch")
      }
      const session = yield* sessionStorage.getSession(input.sessionId)
      if (session === undefined) {
        return yield* Effect.die("Current session not found")
      }
      if (session.activeBranchId === input.branchId) {
        return yield* Effect.die("Cannot delete the active branch")
      }
      const branch = yield* branchStorage.getBranch(input.branchId)
      if (branch === undefined || branch.sessionId !== input.sessionId) {
        return yield* Effect.die(`Branch "${input.branchId}" not found in current session`)
      }
      yield* validateBranchDeletion(input)
      yield* branchStorage.deleteBranch(input.branchId)
    }),

    deleteMessages: Effect.fn("SessionMutations.deleteMessages")(function* (input) {
      const branch = yield* branchStorage.getBranch(input.branchId)
      if (branch === undefined || branch.sessionId !== input.sessionId) {
        return yield* Effect.die(`Branch "${input.branchId}" not found in current session`)
      }
      yield* validateMessageCursor(input)
      yield* messageStorage.deleteMessages(input.branchId, input.afterMessageId)
    }),
  } satisfies SessionMutationsService
})

export class SessionCommands extends Context.Service<SessionCommands, SessionCommandsService>()(
  "@gent/core/src/server/session-commands/SessionCommands",
) {
  static Live = Layer.effect(
    SessionCommands,
    Effect.gen(function* () {
      const sessionStorage = yield* SessionStorage
      const branchStorage = yield* BranchStorage
      const messageStorage = yield* MessageStorage
      const storage = yield* Storage
      const sessionRuntime = yield* SessionRuntime
      const eventStore = yield* EventStore
      const eventPublisher = yield* EventPublisher
      const provider = yield* Provider
      const extensionStateRuntime = yield* MachineEngine
      const sessionCwdRegistry = yield* SessionCwdRegistry

      const summarizeBranch = Effect.fn("SessionCommands.summarizeBranch")(function* (
        branchId: BranchId,
      ) {
        const messages = yield* messageStorage.listMessages(branchId)
        if (messages.length === 0) return ""
        const firstMessage = messages[0]
        if (firstMessage === undefined) return ""

        const conversation = messages
          .slice(-50)
          .map((message) => {
            const text = message.parts
              .filter((part): part is TextPart => part.type === "text")
              .map((part) => part.text)
              .join("\n")
            return text !== "" ? `${message.role}: ${text}` : ""
          })
          .filter((line) => line.trim().length > 0)
          .join("\n\n")

        if (conversation === "") return ""

        const summaryMessage = Message.Regular.make({
          id: MessageId.make(Bun.randomUUIDv7()),
          sessionId: firstMessage.sessionId,
          branchId,
          role: "user",
          parts: [
            new TextPart({
              type: "text",
              text: `Summarize this branch concisely. Focus on decisions, open questions, and current state. Keep it short and actionable.\n\nBranch conversation (recent):\n${conversation}`,
            }),
          ],
          createdAt: yield* DateTime.nowAsDate,
        })

        const streamEffect = yield* provider.stream(
          providerRequestFromMessages({
            model: NAME_GEN_MODEL,
            messages: [summaryMessage],
            maxTokens: 400,
          }),
        )

        const parts: string[] = []
        yield* Stream.runForEach(streamEffect, (part) =>
          Effect.sync(() => {
            if (part.type === "text-delta") parts.push(part.delta)
          }),
        )
        return parts.join("").trim()
      })

      const transactWithEvent = <A, E, R>(
        mutation: Effect.Effect<A, E, R>,
        event: AgentEvent,
      ): Effect.Effect<A, E | EventStoreError | StorageError, R> =>
        Effect.gen(function* () {
          const committed = yield* storage.withTransaction(
            Effect.gen(function* () {
              const result = yield* mutation
              const envelope = yield* eventPublisher.append(event)
              return { result, envelope }
            }),
          )
          yield* eventPublisher.deliver(committed.envelope)
          return committed.result
        })

      const createSession = Effect.fn("SessionCommands.createSession")(function* (
        input: CreateSessionInput,
      ) {
        const sessionId = SessionId.make(Bun.randomUUIDv7())
        if (input.parentBranchId !== undefined && input.parentSessionId === undefined) {
          return yield* new NotFoundError({
            message: "parentBranchId requires parentSessionId",
            entity: "session",
          })
        }
        if (input.parentSessionId !== undefined) {
          const parent = yield* sessionStorage.getSession(input.parentSessionId)
          if (parent === undefined) {
            return yield* new NotFoundError({
              message: `Parent session not found: ${input.parentSessionId}`,
              entity: "session",
            })
          }
        }
        if (input.parentBranchId !== undefined && input.parentSessionId !== undefined) {
          const parentBranch = yield* branchStorage.getBranch(input.parentBranchId)
          if (parentBranch === undefined || parentBranch.sessionId !== input.parentSessionId) {
            return yield* new NotFoundError({
              message: `Parent branch not found in parent session: ${input.parentBranchId}`,
              entity: "branch",
            })
          }
        }

        const branchId = BranchId.make(Bun.randomUUIDv7())
        const now = yield* DateTime.nowAsDate
        const name = input.name ?? "New Chat"
        const session = new Session({
          id: sessionId,
          name,
          cwd: input.cwd,
          activeBranchId: branchId,
          parentSessionId: input.parentSessionId,
          parentBranchId: input.parentBranchId,
          createdAt: now,
          updatedAt: now,
        })
        const branch = new Branch({
          id: branchId,
          sessionId,
          createdAt: now,
        })

        const committed = yield* storage
          .withTransaction(
            Effect.gen(function* () {
              yield* sessionStorage.createSession(session)
              yield* branchStorage.createBranch(branch)
              // Pre-record the (sessionId → cwd) binding BEFORE the first event
              // publish so the per-cwd EventPublisher router can dispatch the
              // SessionStarted pulse to the right SessionProfile without falling
              // back to a storage read. `input.cwd` is optional in the schema for
              // legacy callers; sessions without a cwd fall through to the
              // server's primary cwd routing in the publisher.
              if (input.cwd !== undefined) {
                yield* sessionCwdRegistry.record(sessionId, input.cwd)
              }
              const envelope = yield* eventPublisher.append(
                SessionStarted.make({ sessionId, branchId }),
              )
              return { envelope }
            }),
          )
          .pipe(Effect.onError(() => sessionCwdRegistry.forget(sessionId)))
        yield* eventPublisher.deliver(committed.envelope)
        yield* Effect.logInfo("session.created").pipe(
          Effect.annotateLogs({
            sessionId,
            branchId,
            ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
          }),
        )

        // Optional initial prompt — sends immediately after creation
        if (input.initialPrompt !== undefined && input.initialPrompt.length > 0) {
          yield* sessionRuntime.dispatch(
            sendUserMessageCommand({
              sessionId,
              branchId,
              content: input.initialPrompt,
              ...(input.agentOverride !== undefined ? { agentOverride: input.agentOverride } : {}),
            }),
          )
        }

        return { sessionId, branchId, name }
      })

      const createBranch = Effect.fn("SessionCommands.createBranch")(function* (
        input: CreateBranchInput,
      ) {
        return yield* createSessionBranch({
          sessionId: input.sessionId,
          name: input.name,
        })
      })

      const renameSession = Effect.fn("SessionCommands.renameSession")(function* (input: {
        readonly sessionId: SessionId
        readonly name: string
      }) {
        const trimmed = input.name.trim().slice(0, 80)
        if (trimmed.length === 0) return { renamed: false as const }
        const session = yield* sessionStorage.getSession(input.sessionId)
        if (session === undefined) return { renamed: false as const }
        if (session.name === trimmed) return { renamed: false as const }
        yield* transactWithEvent(
          sessionStorage.updateSession(
            new Session({
              ...session,
              name: trimmed,
              updatedAt: yield* DateTime.nowAsDate,
            }),
          ),
          SessionNameUpdated.make({ sessionId: input.sessionId, name: trimmed }),
        )
        return { renamed: true as const, name: trimmed }
      })

      const createSessionBranch = Effect.fn("SessionCommands.createSessionBranch")(
        function* (input: {
          readonly sessionId: SessionId
          readonly parentBranchId?: BranchId
          readonly name?: string
        }) {
          const branch = new Branch({
            id: BranchId.make(Bun.randomUUIDv7()),
            sessionId: input.sessionId,
            parentBranchId: input.parentBranchId,
            name: input.name,
            createdAt: yield* DateTime.nowAsDate,
          })
          yield* transactWithEvent(
            branchStorage.createBranch(branch),
            BranchCreated.make({
              sessionId: branch.sessionId,
              branchId: branch.id,
              ...(branch.parentBranchId !== undefined
                ? { parentBranchId: branch.parentBranchId }
                : {}),
            }),
          )
          return { branchId: branch.id }
        },
      )

      const switchActiveBranch = Effect.fn("SessionCommands.switchActiveBranch")(function* (input: {
        readonly sessionId: SessionId
        readonly fromBranchId: BranchId
        readonly toBranchId: BranchId
      }) {
        const session = yield* sessionStorage.getSession(input.sessionId)
        if (session === undefined) return yield* Effect.die("Current session not found")
        const fromBranch = yield* branchStorage.getBranch(input.fromBranchId)
        if (fromBranch === undefined || fromBranch.sessionId !== input.sessionId) {
          return yield* Effect.die(`Branch "${input.fromBranchId}" not found in current session`)
        }
        const toBranch = yield* branchStorage.getBranch(input.toBranchId)
        if (toBranch === undefined || toBranch.sessionId !== input.sessionId) {
          return yield* Effect.die(`Branch "${input.toBranchId}" not found in current session`)
        }
        yield* transactWithEvent(
          sessionStorage.updateSession(
            new Session({
              ...session,
              activeBranchId: input.toBranchId,
              updatedAt: yield* DateTime.nowAsDate,
            }),
          ),
          BranchSwitched.make({
            sessionId: input.sessionId,
            fromBranchId: input.fromBranchId,
            toBranchId: input.toBranchId,
          }),
        )
      })

      const switchBranch = Effect.fn("SessionCommands.switchBranch")(function* (
        input: SwitchBranchInput,
      ) {
        const fromBranch = yield* branchStorage.getBranch(input.fromBranchId)
        if (fromBranch === undefined || fromBranch.sessionId !== input.sessionId) {
          return yield* new NotFoundError({ message: "From branch not found", entity: "branch" })
        }
        const toBranch = yield* branchStorage.getBranch(input.toBranchId)
        if (toBranch === undefined || toBranch.sessionId !== input.sessionId) {
          return yield* new NotFoundError({ message: "To branch not found", entity: "branch" })
        }

        if (input.summarize !== false && input.fromBranchId !== input.toBranchId) {
          const summary = yield* summarizeBranch(input.fromBranchId).pipe(
            Effect.catchEager(() => Effect.succeed("")),
          )
          if (summary !== "") {
            yield* branchStorage.updateBranchSummary(input.fromBranchId, summary)
            yield* eventPublisher.publish(
              BranchSummarized.make({
                sessionId: input.sessionId,
                branchId: input.fromBranchId,
                summary,
              }),
            )
          }
        }

        yield* switchActiveBranch({
          sessionId: input.sessionId,
          fromBranchId: input.fromBranchId,
          toBranchId: input.toBranchId,
        })
      })

      const forkBranch = Effect.fn("SessionCommands.forkBranch")(function* (
        input: ForkBranchInput,
      ) {
        const fromBranch = yield* branchStorage.getBranch(input.fromBranchId)
        if (fromBranch === undefined || fromBranch.sessionId !== input.sessionId) {
          return yield* new NotFoundError({ message: "Branch not found", entity: "branch" })
        }

        const messages = yield* messageStorage.listMessages(input.fromBranchId)
        if (!messages.some((message) => message.id === input.atMessageId)) {
          return yield* new NotFoundError({
            message: "Message not found in branch",
            entity: "message",
          })
        }

        return yield* forkSessionBranch({
          sessionId: input.sessionId,
          fromBranchId: input.fromBranchId,
          atMessageId: input.atMessageId,
          name: input.name,
        })
      })

      const forkSessionBranch = Effect.fn("SessionCommands.forkSessionBranch")(function* (input: {
        readonly sessionId: SessionId
        readonly fromBranchId: BranchId
        readonly atMessageId: MessageId
        readonly name?: string
      }) {
        const fromBranch = yield* branchStorage.getBranch(input.fromBranchId)
        if (fromBranch === undefined || fromBranch.sessionId !== input.sessionId) {
          return yield* Effect.die("Branch not found")
        }

        const messages = yield* messageStorage.listMessages(input.fromBranchId)
        const targetIndex = messages.findIndex((message) => message.id === input.atMessageId)
        if (targetIndex === -1) {
          return yield* Effect.die("Message not found in branch")
        }

        const branch = new Branch({
          id: BranchId.make(Bun.randomUUIDv7()),
          sessionId: input.sessionId,
          parentBranchId: input.fromBranchId,
          parentMessageId: input.atMessageId,
          name: input.name,
          createdAt: yield* DateTime.nowAsDate,
        })
        yield* transactWithEvent(
          Effect.gen(function* () {
            yield* branchStorage.createBranch(branch)

            for (const message of messages.slice(0, targetIndex + 1)) {
              yield* messageStorage.createMessage(
                copyMessageToBranch(message, {
                  id: MessageId.make(Bun.randomUUIDv7()),
                  branchId: branch.id,
                }),
              )
            }
          }),
          BranchCreated.make({
            sessionId: branch.sessionId,
            branchId: branch.id,
            ...(branch.parentBranchId !== undefined
              ? { parentBranchId: branch.parentBranchId }
              : {}),
            ...(branch.parentMessageId !== undefined
              ? { parentMessageId: branch.parentMessageId }
              : {}),
          }),
        )
        return { branchId: branch.id }
      })

      const createChildSession = Effect.fn("SessionCommands.createChildSession")(function* (input: {
        readonly parentSessionId: SessionId
        readonly parentBranchId: BranchId
        readonly name?: string
        readonly cwd?: string
      }) {
        const sessionId = SessionId.make(Bun.randomUUIDv7())
        const branchId = BranchId.make(Bun.randomUUIDv7())
        const now = yield* DateTime.nowAsDate
        const session = new Session({
          id: sessionId,
          name: input.name ?? "child session",
          cwd: input.cwd,
          parentSessionId: input.parentSessionId,
          parentBranchId: input.parentBranchId,
          activeBranchId: branchId,
          createdAt: now,
          updatedAt: now,
        })
        const branch = new Branch({
          id: branchId,
          sessionId,
          createdAt: now,
        })
        const committed = yield* storage
          .withTransaction(
            Effect.gen(function* () {
              yield* sessionStorage.createSession(session)
              yield* branchStorage.createBranch(branch)
              if (input.cwd !== undefined) {
                yield* sessionCwdRegistry.record(sessionId, input.cwd)
              }
              const envelope = yield* eventPublisher.append(
                SessionStarted.make({ sessionId, branchId }),
              )
              return { envelope }
            }),
          )
          .pipe(Effect.onError(() => sessionCwdRegistry.forget(sessionId)))
        yield* eventPublisher.deliver(committed.envelope)
        return { sessionId, branchId }
      })

      const updateReasoningLevel = Effect.fn("SessionCommands.updateReasoningLevel")(function* (
        input: UpdateSessionReasoningLevelInput,
      ) {
        const session = yield* sessionStorage.getSession(input.sessionId)
        if (session === undefined) {
          return yield* new NotFoundError({ message: "Session not found", entity: "session" })
        }
        yield* transactWithEvent(
          sessionStorage.updateSession(
            new Session({
              ...session,
              reasoningLevel: input.reasoningLevel,
              updatedAt: yield* DateTime.nowAsDate,
            }),
          ),
          SessionSettingsUpdated.make({
            sessionId: input.sessionId,
            reasoningLevel: input.reasoningLevel,
          }),
        )
        return { reasoningLevel: input.reasoningLevel }
      })

      const sendMessage = Effect.fn("SessionCommands.sendMessage")(function* (
        input: SendMessageInput,
      ) {
        yield* sessionRuntime.dispatch(
          sendUserMessageCommand({
            sessionId: input.sessionId,
            branchId: input.branchId,
            content: input.content,
            ...(input.agentOverride !== undefined ? { agentOverride: input.agentOverride } : {}),
            ...(input.runSpec !== undefined ? { runSpec: input.runSpec } : {}),
          }),
        )
        yield* Effect.logInfo("session.messageSent").pipe(
          Effect.annotateLogs({
            sessionId: input.sessionId,
            branchId: input.branchId,
            ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
          }),
        )
      })

      const collectSessionTreeIds = Effect.fn("SessionCommands.collectSessionTreeIds")(function* (
        rootSessionId: SessionId,
      ) {
        const sessionIds: SessionId[] = []
        const queue: SessionId[] = [rootSessionId]
        const seen = new Set<SessionId>()
        let index = 0

        while (index < queue.length) {
          const sessionId = queue[index]
          index += 1
          if (sessionId === undefined || seen.has(sessionId)) continue
          seen.add(sessionId)
          sessionIds.push(sessionId)
          const children = yield* storage.getChildSessions(sessionId)
          for (const child of children) {
            queue.push(child.id)
          }
        }

        return sessionIds
      })

      const cleanupSessionRuntimeState = Effect.fn("SessionCommands.cleanupSessionRuntimeState")(
        function* (sessionId: SessionId) {
          yield* extensionStateRuntime.terminateAll(sessionId).pipe(
            // Session deletion owns cleanup best-effort actor termination, then
            // propagates durable store failures below.
            Effect.catchDefect(() => Effect.void),
          )
          yield* eventPublisher.terminateSession(sessionId)
          yield* eventStore.removeSession(sessionId)
          yield* sessionCwdRegistry.forget(sessionId)
        },
      )

      const deleteSessionCascade = Effect.fn("SessionCommands.deleteSessionCascade")(function* (
        sessionId: SessionId,
      ) {
        const sessionIds = yield* collectSessionTreeIds(sessionId)
        yield* Effect.forEach(sessionIds, cleanupSessionRuntimeState, { discard: true })
        yield* sessionStorage.deleteSession(sessionId)
        yield* Effect.forEach(
          sessionIds,
          (deletedSessionId) =>
            Effect.logInfo("session.deleted").pipe(
              Effect.annotateLogs({ sessionId: deletedSessionId }),
            ),
          { discard: true },
        )
      })

      const deleteSessionOwned = Effect.fn("SessionCommands.deleteSession")(function* (
        sessionId: SessionId,
      ) {
        yield* deleteSessionCascade(sessionId)
      })

      const deleteBranch = Effect.fn("SessionCommands.deleteBranch")(function* (input: {
        readonly sessionId: SessionId
        readonly currentBranchId: BranchId
        readonly branchId: BranchId
      }) {
        if (input.branchId === input.currentBranchId) {
          return yield* Effect.die("Cannot delete the current branch")
        }
        const session = yield* sessionStorage.getSession(input.sessionId)
        if (session === undefined) {
          return yield* Effect.die("Current session not found")
        }
        if (session.activeBranchId === input.branchId) {
          return yield* Effect.die("Cannot delete the active branch")
        }
        const branch = yield* branchStorage.getBranch(input.branchId)
        if (branch === undefined || branch.sessionId !== input.sessionId) {
          return yield* Effect.die(`Branch "${input.branchId}" not found in current session`)
        }
        const branches = yield* branchStorage.listBranches(input.sessionId)
        if (branches.some((candidate) => candidate.parentBranchId === input.branchId)) {
          return yield* Effect.die(`Cannot delete branch "${input.branchId}" with child branches`)
        }
        const childSessions = yield* storage.getChildSessions(input.sessionId)
        if (childSessions.some((session) => session.parentBranchId === input.branchId)) {
          return yield* Effect.die(`Cannot delete branch "${input.branchId}" with child sessions`)
        }
        yield* branchStorage.deleteBranch(input.branchId)
      })

      const deleteMessages = Effect.fn("SessionCommands.deleteMessages")(function* (input: {
        readonly sessionId: SessionId
        readonly branchId: BranchId
        readonly afterMessageId?: MessageId
      }) {
        const branch = yield* branchStorage.getBranch(input.branchId)
        if (branch === undefined || branch.sessionId !== input.sessionId) {
          return yield* Effect.die(`Branch "${input.branchId}" not found in current session`)
        }
        if (input.afterMessageId !== undefined) {
          const cursor = yield* messageStorage.getMessage(input.afterMessageId)
          if (
            cursor === undefined ||
            cursor.sessionId !== input.sessionId ||
            cursor.branchId !== input.branchId
          ) {
            return yield* Effect.die(
              `Message "${input.afterMessageId}" not found in current branch`,
            )
          }
        }
        yield* messageStorage.deleteMessages(input.branchId, input.afterMessageId)
      })

      return {
        createSession,
        // SessionEnded is not emitted on delete — FK cascade would immediately
        // remove the persisted event. Delete is destructive and rare.
        deleteSession: deleteSessionOwned,
        deleteBranch,
        deleteMessages,
        createBranch,
        renameSession,
        createSessionBranch,
        switchBranch,
        switchActiveBranch,
        forkBranch,
        forkSessionBranch,
        createChildSession,
        sendMessage,
        steer: (command) => sessionRuntime.dispatch(applySteerCommand(command)),
        drainQueuedMessages: ({ sessionId, branchId }) =>
          sessionRuntime
            .drainQueuedMessages({ sessionId, branchId })
            .pipe(Effect.withSpan("SessionCommands.drainQueuedMessages")),
        updateSessionReasoningLevel: updateReasoningLevel,
      } satisfies SessionCommandsService
    }),
  )

  static SessionMutationsLive = Layer.effect(SessionMutations, makeSessionMutationsService)
}

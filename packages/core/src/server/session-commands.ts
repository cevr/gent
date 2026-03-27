import { Effect, Layer, ServiceMap, Stream } from "effect"
import type { BranchId, MessageId, SessionId } from "../domain/ids.js"
import { Branch, Message, Session, TextPart } from "../domain/message.js"
import type { QueueSnapshot } from "../domain/queue.js"
import type { SteerCommand } from "../runtime/agent/agent-loop.js"
import {
  EventStore,
  BranchSwitched,
  BranchCreated,
  BranchSummarized,
  SessionStarted,
  SessionSettingsUpdated,
} from "../domain/event.js"
import { Storage } from "../storage/sqlite-storage.js"
import { Provider } from "../providers/provider.js"
import { ActorProcess } from "../runtime/actor-process.js"
import { ExtensionStateRuntime } from "../runtime/extensions/state-runtime.js"
import { NotFoundError, type AppServiceError } from "./errors.js"
import type {
  CreateBranchInput,
  CreateBranchOutput,
  CreateSessionInput,
  CreateSessionResult,
  ForkBranchInput,
  SendMessageInput,
  SwitchBranchInput,
  UpdateSessionBypassInput,
  UpdateSessionBypassResult,
  UpdateSessionReasoningLevelInput,
  UpdateSessionReasoningLevelResult,
} from "./transport-contract.js"

const NAME_GEN_MODEL = "anthropic/claude-haiku-4-5-20251001"

export interface SessionCommandsService {
  readonly createSession: (
    input: CreateSessionInput,
  ) => Effect.Effect<CreateSessionResult, AppServiceError>
  readonly deleteSession: (sessionId: SessionId) => Effect.Effect<void, AppServiceError>
  readonly createBranch: (
    input: CreateBranchInput,
  ) => Effect.Effect<CreateBranchOutput, AppServiceError>
  readonly switchBranch: (input: SwitchBranchInput) => Effect.Effect<void, AppServiceError>
  readonly forkBranch: (
    input: ForkBranchInput,
  ) => Effect.Effect<CreateBranchOutput, AppServiceError>
  readonly sendMessage: (input: SendMessageInput) => Effect.Effect<void, AppServiceError>
  readonly steer: (command: SteerCommand) => Effect.Effect<void, AppServiceError>
  readonly drainQueuedMessages: (input: {
    sessionId: SessionId
    branchId: BranchId
  }) => Effect.Effect<QueueSnapshot, AppServiceError>
  readonly updateSessionBypass: (
    input: UpdateSessionBypassInput,
  ) => Effect.Effect<UpdateSessionBypassResult, AppServiceError>
  readonly updateSessionReasoningLevel: (
    input: UpdateSessionReasoningLevelInput,
  ) => Effect.Effect<UpdateSessionReasoningLevelResult, AppServiceError>
}

export class SessionCommands extends ServiceMap.Service<SessionCommands, SessionCommandsService>()(
  "@gent/core/src/server/session-commands/SessionCommands",
) {
  static Live = Layer.effect(
    SessionCommands,
    Effect.gen(function* () {
      const storage = yield* Storage
      const actorProcess = yield* ActorProcess
      const eventStore = yield* EventStore
      const provider = yield* Provider
      const extensionStateRuntime = yield* ExtensionStateRuntime

      const summarizeBranch = Effect.fn("SessionCommands.summarizeBranch")(function* (
        branchId: BranchId,
      ) {
        const messages = yield* storage.listMessages(branchId)
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

        const summaryMessage = new Message({
          id: Bun.randomUUIDv7() as MessageId,
          sessionId: firstMessage.sessionId,
          branchId,
          role: "user",
          parts: [
            new TextPart({
              type: "text",
              text: `Summarize this branch concisely. Focus on decisions, open questions, and current state. Keep it short and actionable.\n\nBranch conversation (recent):\n${conversation}`,
            }),
          ],
          createdAt: new Date(),
        })

        const streamEffect = yield* provider.stream({
          model: NAME_GEN_MODEL,
          messages: [summaryMessage],
          maxTokens: 400,
        })

        const parts: string[] = []
        yield* Stream.runForEach(streamEffect, (chunk) =>
          Effect.sync(() => {
            if (chunk._tag === "TextChunk") parts.push(chunk.text)
          }),
        )
        return parts.join("").trim()
      })

      const createSession = Effect.fn("SessionCommands.createSession")(function* (
        input: CreateSessionInput,
      ) {
        const sessionId = Bun.randomUUIDv7() as SessionId
        if (input.parentSessionId !== undefined) {
          const parent = yield* storage.getSession(input.parentSessionId)
          if (parent === undefined) {
            return yield* new NotFoundError({
              message: `Parent session not found: ${input.parentSessionId}`,
              entity: "session",
            })
          }
        }

        const branchId = Bun.randomUUIDv7() as BranchId
        const now = new Date()
        const name = input.name ?? "New Chat"
        const bypass = input.bypass ?? true
        const session = new Session({
          id: sessionId,
          name,
          cwd: input.cwd,
          bypass,
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

        yield* storage.createSession(session)
        yield* storage.createBranch(branch)
        yield* eventStore.publish(new SessionStarted({ sessionId, branchId }))
        yield* Effect.logInfo("session.created").pipe(
          Effect.annotateLogs({
            sessionId,
            branchId,
            ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
          }),
        )

        // Optional initial prompt — sends immediately after creation
        if (input.initialPrompt !== undefined && input.initialPrompt.length > 0) {
          yield* actorProcess.sendUserMessage({
            sessionId,
            branchId,
            content: input.initialPrompt,
            ...(input.agentOverride !== undefined ? { agentOverride: input.agentOverride } : {}),
          })
        }

        return { sessionId, branchId, name, bypass }
      })

      const createBranch = Effect.fn("SessionCommands.createBranch")(function* (
        input: CreateBranchInput,
      ) {
        const branch = new Branch({
          id: Bun.randomUUIDv7() as BranchId,
          sessionId: input.sessionId,
          name: input.name,
          createdAt: new Date(),
        })
        yield* storage.createBranch(branch)
        yield* eventStore.publish(
          new BranchCreated({
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

      const switchBranch = Effect.fn("SessionCommands.switchBranch")(function* (
        input: SwitchBranchInput,
      ) {
        const fromBranch = yield* storage.getBranch(input.fromBranchId)
        if (fromBranch === undefined || fromBranch.sessionId !== input.sessionId) {
          return yield* new NotFoundError({ message: "From branch not found", entity: "branch" })
        }
        const toBranch = yield* storage.getBranch(input.toBranchId)
        if (toBranch === undefined || toBranch.sessionId !== input.sessionId) {
          return yield* new NotFoundError({ message: "To branch not found", entity: "branch" })
        }

        if (input.summarize !== false && input.fromBranchId !== input.toBranchId) {
          const summary = yield* summarizeBranch(input.fromBranchId).pipe(
            Effect.catchEager(() => Effect.succeed("")),
          )
          if (summary !== "") {
            yield* storage.updateBranchSummary(input.fromBranchId, summary)
            yield* eventStore.publish(
              new BranchSummarized({
                sessionId: input.sessionId,
                branchId: input.fromBranchId,
                summary,
              }),
            )
          }
        }

        // Persist active branch pointer before publishing event
        const session = yield* storage.getSession(input.sessionId)
        if (session !== undefined) {
          yield* storage.updateSession(
            new Session({
              ...session,
              activeBranchId: input.toBranchId,
              updatedAt: new Date(),
            }),
          )
        }

        yield* eventStore.publish(
          new BranchSwitched({
            sessionId: input.sessionId,
            fromBranchId: input.fromBranchId,
            toBranchId: input.toBranchId,
          }),
        )
      })

      const forkBranch = Effect.fn("SessionCommands.forkBranch")(function* (
        input: ForkBranchInput,
      ) {
        const fromBranch = yield* storage.getBranch(input.fromBranchId)
        if (fromBranch === undefined || fromBranch.sessionId !== input.sessionId) {
          return yield* new NotFoundError({ message: "Branch not found", entity: "branch" })
        }

        const messages = yield* storage.listMessages(input.fromBranchId)
        const targetIndex = messages.findIndex((message) => message.id === input.atMessageId)
        if (targetIndex === -1) {
          return yield* new NotFoundError({
            message: "Message not found in branch",
            entity: "message",
          })
        }

        const branch = new Branch({
          id: Bun.randomUUIDv7() as BranchId,
          sessionId: input.sessionId,
          parentBranchId: input.fromBranchId,
          parentMessageId: input.atMessageId,
          name: input.name,
          createdAt: new Date(),
        })
        yield* storage.createBranch(branch)

        for (const message of messages.slice(0, targetIndex + 1)) {
          yield* storage.createMessage(
            new Message({
              id: Bun.randomUUIDv7() as MessageId,
              sessionId: message.sessionId,
              branchId: branch.id,
              role: message.role,
              parts: message.parts,
              createdAt: message.createdAt,
              ...(message.turnDurationMs !== undefined
                ? { turnDurationMs: message.turnDurationMs }
                : {}),
            }),
          )
        }

        yield* eventStore.publish(
          new BranchCreated({
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

      const sendMessage = Effect.fn("SessionCommands.sendMessage")(function* (
        input: SendMessageInput,
      ) {
        yield* actorProcess.sendUserMessage({
          sessionId: input.sessionId,
          branchId: input.branchId,
          content: input.content,
          ...(input.agentOverride !== undefined ? { agentOverride: input.agentOverride } : {}),
        })
        yield* Effect.logInfo("session.messageSent").pipe(
          Effect.annotateLogs({
            sessionId: input.sessionId,
            branchId: input.branchId,
            ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
          }),
        )
      })

      return {
        createSession,
        // SessionEnded is not emitted on delete — FK cascade would immediately
        // remove the persisted event. Delete is destructive and rare.
        // Terminate actors first to prevent leaks.
        deleteSession: (sessionId) =>
          extensionStateRuntime.terminateAll(sessionId).pipe(
            Effect.catchDefect(() => Effect.void),
            Effect.tap(() => storage.deleteSession(sessionId)),
            Effect.tap(() =>
              Effect.logInfo("session.deleted").pipe(Effect.annotateLogs({ sessionId })),
            ),
          ),
        createBranch,
        switchBranch,
        forkBranch,
        sendMessage,
        steer: (command) => actorProcess.steerAgent(command),
        drainQueuedMessages: ({ sessionId, branchId }) =>
          actorProcess
            .drainQueuedMessages({ sessionId, branchId })
            .pipe(Effect.withSpan("SessionCommands.drainQueuedMessages")),
        updateSessionBypass: Effect.fn("SessionCommands.updateSessionBypass")(function* (
          input: UpdateSessionBypassInput,
        ) {
          const session = yield* storage.getSession(input.sessionId)
          if (session === undefined) {
            return yield* new NotFoundError({ message: "Session not found", entity: "session" })
          }
          yield* storage.updateSession(
            new Session({
              ...session,
              bypass: input.bypass,
              updatedAt: new Date(),
            }),
          )
          yield* eventStore.publish(
            new SessionSettingsUpdated({ sessionId: input.sessionId, bypass: input.bypass }),
          )
          return { bypass: input.bypass }
        }),
        updateSessionReasoningLevel: Effect.fn("SessionCommands.updateSessionReasoningLevel")(
          function* (input: UpdateSessionReasoningLevelInput) {
            const session = yield* storage.getSession(input.sessionId)
            if (session === undefined) {
              return yield* new NotFoundError({ message: "Session not found", entity: "session" })
            }
            yield* storage.updateSession(
              new Session({
                ...session,
                reasoningLevel: input.reasoningLevel,
                updatedAt: new Date(),
              }),
            )
            yield* eventStore.publish(
              new SessionSettingsUpdated({
                sessionId: input.sessionId,
                reasoningLevel: input.reasoningLevel,
              }),
            )
            return { reasoningLevel: input.reasoningLevel }
          },
        ),
      } satisfies SessionCommandsService
    }),
  )
}

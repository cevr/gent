import { DateTime, Effect, Layer, Context, Stream } from "effect"
import { EventPublisher } from "../domain/event-publisher.js"
import { SessionCwdRegistry } from "../runtime/session-cwd-registry.js"
import { BranchId, MessageId, SessionId } from "../domain/ids.js"
import { SessionDeleter } from "../domain/session-deleter.js"
import { Branch, Message, Session, TextPart, copyMessageToBranch } from "../domain/message.js"
import type { QueueSnapshot } from "../domain/queue.js"
import type { SteerCommand } from "../domain/steer.js"
import {
  EventStore,
  BranchSwitched,
  BranchCreated,
  BranchSummarized,
  SessionStarted,
  SessionSettingsUpdated,
} from "../domain/event.js"
import { SessionStorage } from "../storage/session-storage.js"
import { BranchStorage } from "../storage/branch-storage.js"
import { MessageStorage } from "../storage/message-storage.js"
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
  readonly deleteSession: (sessionId: SessionId) => Effect.Effect<void, AppServiceError>
  readonly createBranch: (
    input: CreateBranchInput,
  ) => Effect.Effect<CreateBranchResult, AppServiceError>
  readonly switchBranch: (input: SwitchBranchInput) => Effect.Effect<void, AppServiceError>
  readonly forkBranch: (
    input: ForkBranchInput,
  ) => Effect.Effect<CreateBranchResult, AppServiceError>
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

export class SessionCommands extends Context.Service<SessionCommands, SessionCommandsService>()(
  "@gent/core/src/server/session-commands/SessionCommands",
) {
  static Live = Layer.effect(
    SessionCommands,
    Effect.gen(function* () {
      const sessionStorage = yield* SessionStorage
      const branchStorage = yield* BranchStorage
      const messageStorage = yield* MessageStorage
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

        const summaryMessage = new Message.regular({
          id: MessageId.of(Bun.randomUUIDv7()),
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

      const createSession = Effect.fn("SessionCommands.createSession")(function* (
        input: CreateSessionInput,
      ) {
        const sessionId = SessionId.of(Bun.randomUUIDv7())
        if (input.parentSessionId !== undefined) {
          const parent = yield* sessionStorage.getSession(input.parentSessionId)
          if (parent === undefined) {
            return yield* new NotFoundError({
              message: `Parent session not found: ${input.parentSessionId}`,
              entity: "session",
            })
          }
        }

        const branchId = BranchId.of(Bun.randomUUIDv7())
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
        yield* eventPublisher.publish(new SessionStarted({ sessionId, branchId }))
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
        const branch = new Branch({
          id: BranchId.of(Bun.randomUUIDv7()),
          sessionId: input.sessionId,
          name: input.name,
          createdAt: yield* DateTime.nowAsDate,
        })
        yield* branchStorage.createBranch(branch)
        yield* eventPublisher.publish(
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
              new BranchSummarized({
                sessionId: input.sessionId,
                branchId: input.fromBranchId,
                summary,
              }),
            )
          }
        }

        // Persist active branch pointer before publishing event
        const session = yield* sessionStorage.getSession(input.sessionId)
        if (session !== undefined) {
          yield* sessionStorage.updateSession(
            new Session({
              ...session,
              activeBranchId: input.toBranchId,
              updatedAt: yield* DateTime.nowAsDate,
            }),
          )
        }

        yield* eventPublisher.publish(
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
        const fromBranch = yield* branchStorage.getBranch(input.fromBranchId)
        if (fromBranch === undefined || fromBranch.sessionId !== input.sessionId) {
          return yield* new NotFoundError({ message: "Branch not found", entity: "branch" })
        }

        const messages = yield* messageStorage.listMessages(input.fromBranchId)
        const targetIndex = messages.findIndex((message) => message.id === input.atMessageId)
        if (targetIndex === -1) {
          return yield* new NotFoundError({
            message: "Message not found in branch",
            entity: "message",
          })
        }

        const branch = new Branch({
          id: BranchId.of(Bun.randomUUIDv7()),
          sessionId: input.sessionId,
          parentBranchId: input.fromBranchId,
          parentMessageId: input.atMessageId,
          name: input.name,
          createdAt: yield* DateTime.nowAsDate,
        })
        yield* branchStorage.createBranch(branch)

        for (const message of messages.slice(0, targetIndex + 1)) {
          yield* messageStorage.createMessage(
            copyMessageToBranch(message, {
              id: MessageId.of(Bun.randomUUIDv7()),
              branchId: branch.id,
            }),
          )
        }

        yield* eventPublisher.publish(
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

      return {
        createSession,
        // SessionEnded is not emitted on delete — FK cascade would immediately
        // remove the persisted event. Delete is destructive and rare.
        // Terminate actors first to prevent leaks.
        deleteSession: (sessionId) =>
          extensionStateRuntime.terminateAll(sessionId).pipe(
            Effect.catchDefect(() => Effect.void),
            Effect.tap(() => eventPublisher.terminateSession(sessionId)),
            Effect.tap(() => eventStore.removeSession(sessionId)),
            Effect.tap(() => sessionStorage.deleteSession(sessionId)),
            Effect.tap(() => sessionCwdRegistry.forget(sessionId)),
            Effect.tap(() =>
              Effect.logInfo("session.deleted").pipe(Effect.annotateLogs({ sessionId })),
            ),
          ),
        createBranch,
        switchBranch,
        forkBranch,
        sendMessage,
        steer: (command) => sessionRuntime.dispatch(applySteerCommand(command)),
        drainQueuedMessages: ({ sessionId, branchId }) =>
          sessionRuntime
            .drainQueuedMessages({ sessionId, branchId })
            .pipe(Effect.withSpan("SessionCommands.drainQueuedMessages")),
        updateSessionReasoningLevel: Effect.fn("SessionCommands.updateSessionReasoningLevel")(
          function* (input: UpdateSessionReasoningLevelInput) {
            const session = yield* sessionStorage.getSession(input.sessionId)
            if (session === undefined) {
              return yield* new NotFoundError({ message: "Session not found", entity: "session" })
            }
            yield* sessionStorage.updateSession(
              new Session({
                ...session,
                reasoningLevel: input.reasoningLevel,
                updatedAt: yield* DateTime.nowAsDate,
              }),
            )
            yield* eventPublisher.publish(
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

  /**
   * Domain-tier deleter Layer — projects `SessionCommands.deleteSession`
   * onto the `SessionDeleter` Tag so the runtime can call into the
   * destructive cleanup path without importing `server/`. See
   * `domain/session-deleter.ts` for the inversion rationale.
   */
  static SessionDeleterLive = Layer.effect(
    SessionDeleter,
    Effect.gen(function* () {
      const cmds = yield* SessionCommands
      return {
        // SessionDeleter is the domain-tier interface — failures swallowed
        // here so callers (extension host context) don't need to know the
        // server-tier error channel. The runtime caller catches its own
        // error tail via `Effect.catchEager` regardless.
        deleteSession: (sessionId) =>
          cmds.deleteSession(sessionId).pipe(Effect.catchEager(() => Effect.void)),
      }
    }),
  )
}

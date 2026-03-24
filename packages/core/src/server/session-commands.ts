import { Effect, Layer, ServiceMap, Stream } from "effect"
import { identity } from "effect/Function"
import type { BranchId, MessageId, SessionId } from "../domain/ids.js"
import { Branch, Message, Session, TextPart } from "../domain/message.js"
import type { QueueSnapshot } from "../domain/queue.js"
import type { SteerCommand } from "../runtime/agent/agent-loop.js"
import {
  EventStore,
  BranchSwitched,
  BranchCreated,
  BranchSummarized,
  SessionNameUpdated,
} from "../domain/event.js"
import { Storage } from "../storage/sqlite-storage.js"
import { Provider } from "../providers/provider.js"
import { ActorProcess } from "../runtime/actor-process.js"
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

      const generateSessionName = Effect.fn("SessionCommands.generateSessionName")(function* (
        firstMessage: string,
      ) {
        const prompt = [
          "Generate a 3-5 word lowercase title for a conversation that starts with the following message.",
          "Rules:",
          "- Lowercase only, no quotes, no punctuation",
          "- Be specific to the content, not generic",
          '- Bad: "help with code", "quick question", "new project"',
          '- Good: "fix auth token refresh", "add dark mode toggle", "migrate postgres to sqlite"',
          "",
          `Message: "${firstMessage.slice(0, 300)}"`,
          "",
          "Title:",
        ].join("\n")

        for (let attempt = 0; attempt < 2; attempt++) {
          const result = yield* provider
            .generate({
              model: NAME_GEN_MODEL,
              prompt,
              maxTokens: 30,
            })
            .pipe(Effect.catchEager(() => Effect.succeed("")))

          const name = result
            .trim()
            .replace(/^["']|["']$/g, "")
            .replace(/\.$/g, "")
            .toLowerCase()

          if (name.length > 0 && name !== "new chat" && name !== "untitled") return name
        }

        return "New Chat"
      })

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

        const firstMessage = input.firstMessage
        if (firstMessage !== undefined) {
          const parentSpan = yield* Effect.currentParentSpan.pipe(
            Effect.orElseSucceed(() => undefined),
          )

          yield* Effect.forkDetach(
            Effect.gen(function* () {
              const generatedName = yield* generateSessionName(firstMessage)
              const updatedSession = new Session({
                ...session,
                name: generatedName,
                updatedAt: new Date(),
              })
              yield* storage.updateSession(updatedSession)
              yield* eventStore.publish(new SessionNameUpdated({ sessionId, name: generatedName }))
            }).pipe(
              Effect.catchEager((error) =>
                Effect.logWarning("session name generation failed", error),
              ),
              parentSpan !== undefined ? Effect.withParentSpan(parentSpan) : identity,
            ),
          )

          yield* actorProcess.sendUserMessage({
            sessionId,
            branchId,
            content: firstMessage,
            bypass,
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
        const session = yield* storage.getSession(input.sessionId)
        const parentSpan = yield* Effect.currentParentSpan.pipe(
          Effect.orElseSucceed(() => undefined),
        )

        yield* Effect.forkDetach(
          Effect.gen(function* () {
            if (session === undefined || session.name !== "New Chat") return
            const generatedName = yield* generateSessionName(input.content)
            const updatedSession = new Session({
              ...session,
              name: generatedName,
              updatedAt: new Date(),
            })
            yield* storage.updateSession(updatedSession)
            yield* eventStore.publish(
              new SessionNameUpdated({ sessionId: input.sessionId, name: generatedName }),
            )
          }).pipe(
            Effect.catchEager((error) =>
              Effect.logWarning("session name generation failed", error),
            ),
            parentSpan !== undefined ? Effect.withParentSpan(parentSpan) : identity,
          ),
        )

        yield* actorProcess.sendUserMessage({
          sessionId: input.sessionId,
          branchId: input.branchId,
          content: input.content,
        })
      })

      return {
        createSession,
        deleteSession: (sessionId) => storage.deleteSession(sessionId),
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
            return { reasoningLevel: input.reasoningLevel }
          },
        ),
      } satisfies SessionCommandsService
    }),
  )
}

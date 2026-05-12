import { DateTime, Effect, Layer, Context, Option, Stream } from "effect"
import * as Prompt from "effect/unstable/ai/Prompt"
import { EventPublisher } from "../domain/event-publisher.js"
import { SessionMutations, type SessionMutationError } from "../domain/session-mutations.js"
import { BranchId, MessageId, SessionId } from "../domain/ids.js"
import { Branch, Message, Session } from "../domain/message.js"
import { messagePartsTextLines } from "../domain/message-part-projection.js"
import { BranchSummarized, SessionStarted } from "../domain/event.js"
import { SessionStorage } from "../storage/session-storage.js"
import { BranchStorage } from "../storage/branch-storage.js"
import { MessageStorage } from "../storage/message-storage.js"
import {
  SessionOperationStorage,
  type StoredCreateSessionResult,
} from "../storage/session-operation-storage.js"
import { makeStorageTransaction } from "../storage/sqlite-storage.js"
import { ModelResolver } from "../providers/model-resolver.js"
import { toPrompt } from "../providers/ai-transcript.js"
import * as AiError from "effect/unstable/ai/AiError"
import { ProviderError } from "../domain/provider-error.js"
import { GentPlatform } from "../runtime/gent-platform.js"
import { makeRequestDeduper } from "../runtime/request-dedup.js"
import { SessionRuntime } from "../runtime/session-runtime.js"
import { SessionMutationsLive as SessionMutationsLiveLayer } from "./session-mutations-live.js"
import { NotFoundError, type GentRpcError } from "./errors.js"
import type {
  CreateBranchInput,
  CreateSessionInput,
  ForkBranchInput,
  SendMessageInput,
  SwitchBranchInput,
  UpdateSessionReasoningLevelInput,
} from "./transport-contract.js"

const NAME_GEN_MODEL = "anthropic/claude-haiku-4-5-20251001"

type CreateSessionResult = {
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly name: string
}

type CreateBranchResult = {
  readonly branchId: BranchId
}

type UpdateSessionReasoningLevelResult = {
  readonly reasoningLevel: UpdateSessionReasoningLevelInput["reasoningLevel"]
}

// Common error union for SessionCommands mutations: storage/event errors plus
// the typed business errors surfaced from validation paths.
export type SessionCommandError = SessionMutationError

// SessionCommands is the RPC-facing surface: dedup-wrapped session creates,
// branch operations with summarization, and session runtime commands. Bodies
// that mutate purely-durable state (rename, child-session create,
// branch/message delete) live on `SessionMutations`, an internal RPC-facing
// service shared with this module so there is exactly one implementation of
// each durable mutation. Extensions do not see this surface.
export interface SessionCommandsService {
  readonly createSession: (
    input: CreateSessionInput,
  ) => Effect.Effect<CreateSessionResult, GentRpcError>
  readonly deleteSession: (sessionId: SessionId) => Effect.Effect<void, SessionCommandError>
  readonly createBranch: (
    input: CreateBranchInput,
  ) => Effect.Effect<CreateBranchResult, GentRpcError>
  readonly switchBranch: (input: SwitchBranchInput) => Effect.Effect<void, GentRpcError>
  readonly forkBranch: (input: ForkBranchInput) => Effect.Effect<CreateBranchResult, GentRpcError>
  readonly sendMessage: (input: SendMessageInput) => Effect.Effect<void, GentRpcError>
  readonly updateSessionReasoningLevel: (
    input: UpdateSessionReasoningLevelInput,
  ) => Effect.Effect<UpdateSessionReasoningLevelResult, GentRpcError>
}

export interface SessionCommandsDedupControlService {
  readonly registerCreateSessionInvalidator: (
    invalidate: (requestId: string) => Effect.Effect<void>,
  ) => Effect.Effect<void>
}

export class SessionCommandsDedupControl extends Context.Service<
  SessionCommandsDedupControl,
  SessionCommandsDedupControlService
>()("@gent/core/src/server/session-commands/SessionCommandsDedupControl") {}

export class SessionCommands extends Context.Service<SessionCommands, SessionCommandsService>()(
  "@gent/core/src/server/session-commands/SessionCommands",
) {
  static Live = Layer.effect(
    SessionCommands,
    Effect.gen(function* () {
      const sessionStorage = yield* SessionStorage
      const branchStorage = yield* BranchStorage
      const messageStorage = yield* MessageStorage
      const storageTransaction = yield* makeStorageTransaction
      const sessionOperationStorage = yield* SessionOperationStorage
      const sessionRuntime = yield* SessionRuntime
      const eventPublisher = yield* EventPublisher
      const modelResolver = yield* ModelResolver
      const platform = yield* GentPlatform
      // SessionCommands delegates pure-mutation bodies that do not carry RPC
      // request IDs to SessionMutations. Request-id-bearing branch operations
      // stay here so their durable operation row can be written in the same
      // transaction as the branch/session mutation and appended event.
      const mutations = yield* SessionMutations

      // ── requestId dedup ──
      //
      // Clients generate a `requestId` per mutation so a WS-level retry after
      // an ambiguous failure converges on one durable outcome. Session create
      // additionally stores its result in SQLite; the in-memory cache only
      // collapses concurrent same-process fibers while the durable operation
      // table owns restart/retry correctness.
      //
      // Dedup is *concurrency-safe*: `RpcServer.layerHttp` runs with
      // `concurrency: "unbounded"` and the client has
      // `retryTransientErrors: true`, so the same requestId can land on two
      // fibers in parallel. `Cache` collapses concurrent same-key lookups via
      // an internal Deferred so the second fiber awaits the first's outcome.
      //
      const dedupCreateSession = yield* makeRequestDeduper<
        CreateSessionInput,
        CreateSessionResult,
        GentRpcError
      >({ body: (input) => doCreateSession(input), keyOf: (input) => input.requestId })
      const dedupControl = yield* Effect.serviceOption(SessionCommandsDedupControl)
      if (Option.isSome(dedupControl)) {
        yield* dedupControl.value.registerCreateSessionInvalidator(dedupCreateSession.invalidateKey)
      }
      const dedupSendMessage = yield* makeRequestDeduper<SendMessageInput, void, GentRpcError>({
        body: (input) => doSendMessage(input),
        keyOf: (input) => input.requestId,
      })
      const dedupCreateBranch = yield* makeRequestDeduper<
        CreateBranchInput,
        CreateBranchResult,
        GentRpcError
      >({ body: (input) => doCreateBranch(input), keyOf: (input) => input.requestId })
      const dedupForkBranch = yield* makeRequestDeduper<
        ForkBranchInput,
        CreateBranchResult,
        GentRpcError
      >({ body: (input) => doForkBranch(input), keyOf: (input) => input.requestId })
      const dedupSwitchBranch = yield* makeRequestDeduper<SwitchBranchInput, void, GentRpcError>({
        body: (input) => doSwitchBranch(input),
        keyOf: (input) => input.requestId,
      })

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
            const text = messagePartsTextLines(message.parts).join("\n")
            return text !== "" ? `${message.role}: ${text}` : ""
          })
          .filter((line) => line.trim().length > 0)
          .join("\n\n")

        if (conversation === "") return ""

        const summaryMessage = Message.cases.regular.make({
          id: MessageId.make(yield* platform.randomId),
          sessionId: firstMessage.sessionId,
          branchId,
          role: "user",
          parts: [
            Prompt.textPart({
              text: `Summarize this branch concisely. Focus on decisions, open questions, and current state. Keep it short and actionable.\n\nBranch conversation (recent):\n${conversation}`,
            }),
          ],
          createdAt: yield* DateTime.nowAsDate,
        })

        const parts: string[] = []
        yield* Effect.scoped(
          Effect.gen(function* () {
            const model = yield* modelResolver.resolve({
              modelId: NAME_GEN_MODEL,
              hints: { maxTokens: 400 },
            })
            const stream = model.streamText({ prompt: toPrompt([summaryMessage]) }).pipe(
              Stream.mapError(
                (error: unknown) =>
                  new ProviderError({
                    message: AiError.isAiError(error) ? error.message : String(error),
                    model: NAME_GEN_MODEL,
                    cause: error,
                  }),
              ),
            )
            yield* Stream.runForEach(stream, (part) =>
              Effect.sync(() => {
                if (part.type === "text-delta") parts.push(part.delta)
              }),
            )
          }),
        )
        return parts.join("").trim()
      })

      const createSession: (
        input: CreateSessionInput,
      ) => Effect.Effect<CreateSessionResult, GentRpcError> = Effect.fn(
        "SessionCommands.createSession",
      )(function* (input: CreateSessionInput) {
        return yield* dedupCreateSession(input)
      })

      const sendInitialPrompt = Effect.fn("SessionCommands.sendInitialPrompt")(function* (
        operation: StoredCreateSessionResult,
        requestId: string | undefined,
      ) {
        if (operation.initialPrompt === undefined || operation.initialPrompt.length === 0) return
        yield* sessionRuntime.sendUserMessage({
          sessionId: operation.sessionId,
          branchId: operation.branchId,
          content: operation.initialPrompt,
          ...(operation.agentOverride !== undefined
            ? { agentOverride: operation.agentOverride }
            : {}),
          ...(requestId !== undefined ? { requestId: `session.create:${requestId}:initial` } : {}),
        })
      })

      const createSessionResult = (operation: StoredCreateSessionResult): CreateSessionResult => ({
        sessionId: operation.sessionId,
        branchId: operation.branchId,
        name: operation.name,
      })

      const doCreateSession = Effect.fn("SessionCommands.doCreateSession")(function* (
        input: CreateSessionInput,
      ) {
        if (input.requestId !== undefined) {
          const existing = yield* sessionOperationStorage.getCreateSession(input.requestId)
          if (existing !== undefined) {
            yield* sendInitialPrompt(existing, input.requestId)
            return createSessionResult(existing)
          }
        }

        const sessionId = SessionId.make(yield* platform.randomId)
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

        const branchId = BranchId.make(yield* platform.randomId)
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

        const committed = yield* storageTransaction(
          Effect.gen(function* () {
            if (input.requestId !== undefined) {
              const existing = yield* sessionOperationStorage.getCreateSession(input.requestId)
              if (existing !== undefined) return { result: existing }
            }
            yield* sessionStorage.createSession(session)
            yield* branchStorage.createBranch(branch)
            const envelope = yield* eventPublisher.append(
              SessionStarted.make({ sessionId, branchId }),
            )
            const result: StoredCreateSessionResult = {
              sessionId,
              branchId,
              name,
              ...(input.initialPrompt !== undefined ? { initialPrompt: input.initialPrompt } : {}),
              ...(input.agentOverride !== undefined ? { agentOverride: input.agentOverride } : {}),
            }
            if (input.requestId !== undefined) {
              yield* sessionOperationStorage.saveCreateSession(input.requestId, result)
            }
            return { envelope, result }
          }),
        )
        if (committed.envelope !== undefined) {
          yield* eventPublisher.deliver(committed.envelope)
          yield* Effect.logInfo("session.created").pipe(
            Effect.annotateLogs({
              sessionId: committed.result.sessionId,
              branchId: committed.result.branchId,
              ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
            }),
          )
        }

        yield* sendInitialPrompt(committed.result, input.requestId)
        return createSessionResult(committed.result)
      })

      const createBranch = Effect.fn("SessionCommands.createBranch")(function* (
        input: CreateBranchInput,
      ) {
        return yield* dedupCreateBranch(input)
      })

      const doCreateBranch = Effect.fn("SessionCommands.doCreateBranch")(function* (
        input: CreateBranchInput,
      ) {
        return yield* mutations.createSessionBranch({
          sessionId: input.sessionId,
          name: input.name,
          ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
        })
      })

      const switchBranch: (input: SwitchBranchInput) => Effect.Effect<void, GentRpcError> =
        Effect.fn("SessionCommands.switchBranch")(function* (input: SwitchBranchInput) {
          yield* dedupSwitchBranch(input)
        })

      const doSwitchBranch = Effect.fn("SessionCommands.doSwitchBranch")(function* (
        input: SwitchBranchInput,
      ) {
        // The summarize side-effect lives on SessionCommands because it
        // depends on model resolution and is intentionally outside the durable
        // mutation tx.
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

        yield* mutations.switchActiveBranch({
          sessionId: input.sessionId,
          fromBranchId: input.fromBranchId,
          toBranchId: input.toBranchId,
          ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
        })
      })

      const forkBranch: (
        input: ForkBranchInput,
      ) => Effect.Effect<CreateBranchResult, GentRpcError> = Effect.fn(
        "SessionCommands.forkBranch",
      )(function* (input: ForkBranchInput) {
        return yield* dedupForkBranch(input)
      })

      const doForkBranch = Effect.fn("SessionCommands.doForkBranch")(function* (
        input: ForkBranchInput,
      ) {
        return yield* mutations.forkSessionBranch({
          sessionId: input.sessionId,
          fromBranchId: input.fromBranchId,
          atMessageId: input.atMessageId,
          name: input.name,
          ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
        })
      })

      const sendMessage: (input: SendMessageInput) => Effect.Effect<void, GentRpcError> = Effect.fn(
        "SessionCommands.sendMessage",
      )(function* (input: SendMessageInput) {
        yield* dedupSendMessage(input)
      })

      const doSendMessage = Effect.fn("SessionCommands.doSendMessage")(function* (
        input: SendMessageInput,
      ) {
        yield* sessionRuntime.sendUserMessage({
          sessionId: input.sessionId,
          branchId: input.branchId,
          content: input.content,
          ...(input.agentOverride !== undefined ? { agentOverride: input.agentOverride } : {}),
          ...(input.runSpec !== undefined ? { runSpec: input.runSpec } : {}),
          ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
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
        // remove the persisted event. Delete is destructive and rare. The
        // cascade + runtime-state cleanup live on SessionMutations; this is a
        // thin delegation.
        deleteSession: (sessionId) => mutations.deleteSession(sessionId),
        createBranch,
        switchBranch,
        forkBranch,
        sendMessage,
        updateSessionReasoningLevel: mutations.updateReasoningLevel,
      } satisfies SessionCommandsService
    }),
  )

  static SessionMutationsLive = SessionMutationsLiveLayer
}

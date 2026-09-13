import { Predicate, DateTime, Effect, Layer, Context, Option } from "effect"
import { EventPublisher } from "../domain/event-publisher.js"
import { SessionMutations } from "../domain/session-mutations.js"
import { BranchId, SessionId } from "../domain/ids.js"
import { Branch, Session } from "../domain/message.js"
import { SessionStarted } from "../domain/event.js"
import { SessionStorage } from "../storage/session-storage.js"
import { BranchStorage } from "../storage/branch-storage.js"
import {
  SessionOperationStorage,
  type StoredCreateSessionResult,
} from "../storage/session-operation-storage.js"
import { makeStorageTransaction } from "../storage/sqlite-storage.js"
import { GentPlatform } from "../runtime/gent-platform.js"
import { makeRequestDeduper } from "../runtime/request-dedup.js"
import { SessionRuntime } from "../runtime/session-runtime.js"
import type { SendUserMessagePayload } from "../runtime/session-runtime.js"
import { SessionMutationsLive as SessionMutationsLiveLayer } from "./session-mutations-live.js"
import { NotFoundError, type GentRpcError } from "./errors.js"
import type {
  CreateBranchInput,
  CreateSessionInput,
  ForkBranchInput,
  SendMessageInput,
  SwitchBranchInput,
} from "./transport-contract.js"

type CreateSessionResult = {
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly name: string
}

type CreateBranchResult = {
  readonly branchId: BranchId
}

// SessionCommands is the RPC-facing surface for the commands that carry a
// request id: dedup-wrapped session creates, branch operations with
// summarization, and message sends. Mutations without a request id (rename,
// delete, reasoning level) are called on `SessionMutations` directly, so each
// durable mutation has exactly one implementation. Extensions do not see this
// surface.
interface SessionCommandsService {
  readonly createSession: (
    input: CreateSessionInput,
  ) => Effect.Effect<CreateSessionResult, GentRpcError>
  readonly createBranch: (
    input: CreateBranchInput,
  ) => Effect.Effect<CreateBranchResult, GentRpcError>
  readonly switchBranch: (input: SwitchBranchInput) => Effect.Effect<void, GentRpcError>
  readonly forkBranch: (input: ForkBranchInput) => Effect.Effect<CreateBranchResult, GentRpcError>
  readonly sendMessage: (input: SendMessageInput) => Effect.Effect<void, GentRpcError>
}

interface SessionCommandsDedupControlService {
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
      const storageTransaction = yield* makeStorageTransaction
      const sessionOperationStorage = yield* SessionOperationStorage
      const sessionRuntime = yield* SessionRuntime
      const eventPublisher = yield* EventPublisher
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
      >({
        body: (input) => doCreateSession(input),
        keyOf: (input) => Option.fromUndefinedOr(input.requestId),
      })
      const dedupControl = yield* Effect.serviceOption(SessionCommandsDedupControl)
      if (Option.isSome(dedupControl)) {
        yield* dedupControl.value.registerCreateSessionInvalidator(dedupCreateSession.invalidateKey)
      }
      const dedupSendMessage = yield* makeRequestDeduper<SendMessageInput, void, GentRpcError>({
        body: (input) => doSendMessage(input),
        keyOf: (input) => Option.fromUndefinedOr(input.requestId),
      })
      const dedupCreateBranch = yield* makeRequestDeduper<
        CreateBranchInput,
        CreateBranchResult,
        GentRpcError
      >({
        body: (input) => doCreateBranch(input),
        keyOf: (input) => Option.fromUndefinedOr(input.requestId),
      })
      const dedupForkBranch = yield* makeRequestDeduper<
        ForkBranchInput,
        CreateBranchResult,
        GentRpcError
      >({
        body: (input) => doForkBranch(input),
        keyOf: (input) => Option.fromUndefinedOr(input.requestId),
      })
      const dedupSwitchBranch = yield* makeRequestDeduper<SwitchBranchInput, void, GentRpcError>({
        body: (input) => doSwitchBranch(input),
        keyOf: (input) => Option.fromUndefinedOr(input.requestId),
      })

      const sendInitialPrompt = Effect.fn("SessionCommands.sendInitialPrompt")(function* (
        operation: StoredCreateSessionResult,
        requestId: Option.Option<string>,
      ) {
        if (Predicate.isUndefined(operation.initialPrompt) || operation.initialPrompt.length === 0)
          return
        let message: SendUserMessagePayload = {
          sessionId: operation.sessionId,
          branchId: operation.branchId,
          content: operation.initialPrompt,
        }
        if (Predicate.isNotUndefined(operation.agentOverride)) {
          message = { ...message, agentOverride: operation.agentOverride }
        }
        if (Option.isSome(requestId)) {
          message = { ...message, requestId: `session.create:${requestId.value}:initial` }
        }
        yield* sessionRuntime.sendUserMessage(message)
      })

      const createSessionResult = (operation: StoredCreateSessionResult): CreateSessionResult => ({
        sessionId: operation.sessionId,
        branchId: operation.branchId,
        name: operation.name,
      })

      const doCreateSession = Effect.fn("SessionCommands.doCreateSession")(function* (
        input: CreateSessionInput,
      ) {
        if (!Predicate.isUndefined(input.requestId)) {
          const existing = yield* sessionOperationStorage.getCreateSession(input.requestId)
          if (!Predicate.isUndefined(existing)) {
            yield* sendInitialPrompt(existing, Option.fromUndefinedOr(input.requestId))
            return createSessionResult(existing)
          }
        }

        const sessionId = SessionId.make(yield* platform.randomId)
        if (
          !Predicate.isUndefined(input.parentBranchId) &&
          Predicate.isUndefined(input.parentSessionId)
        ) {
          return yield* new NotFoundError({
            message: "parentBranchId requires parentSessionId",
            entity: "session",
          })
        }
        if (!Predicate.isUndefined(input.parentSessionId)) {
          const parent = yield* sessionStorage.getSession(input.parentSessionId)
          if (Predicate.isUndefined(parent)) {
            return yield* new NotFoundError({
              message: `Parent session not found: ${input.parentSessionId}`,
              entity: "session",
            })
          }
        }
        if (
          !Predicate.isUndefined(input.parentBranchId) &&
          !Predicate.isUndefined(input.parentSessionId)
        ) {
          const parentBranch = yield* branchStorage.getBranch(input.parentBranchId)
          if (
            Predicate.isUndefined(parentBranch) ||
            parentBranch.sessionId !== input.parentSessionId
          ) {
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
            if (!Predicate.isUndefined(input.requestId)) {
              const existing = yield* sessionOperationStorage.getCreateSession(input.requestId)
              if (!Predicate.isUndefined(existing)) return { result: existing }
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
              initialPrompt: input.initialPrompt,
              agentOverride: input.agentOverride,
            }
            if (!Predicate.isUndefined(input.requestId)) {
              yield* sessionOperationStorage.saveCreateSession(input.requestId, result)
            }
            return { envelope, result }
          }),
        )
        if (!Predicate.isUndefined(committed.envelope)) {
          yield* eventPublisher.deliver(committed.envelope)
          yield* Effect.logInfo("session.created").pipe(
            Effect.annotateLogs({
              sessionId: committed.result.sessionId,
              branchId: committed.result.branchId,
              requestId: input.requestId,
            }),
          )
        }

        yield* sendInitialPrompt(committed.result, Option.fromUndefinedOr(input.requestId))
        return createSessionResult(committed.result)
      })

      const doCreateBranch = Effect.fn("SessionCommands.doCreateBranch")(function* (
        input: CreateBranchInput,
      ) {
        return yield* mutations.createSessionBranch({
          sessionId: input.sessionId,
          name: input.name,
          requestId: input.requestId,
        })
      })

      const doSwitchBranch = Effect.fn("SessionCommands.doSwitchBranch")(function* (
        input: SwitchBranchInput,
      ) {
        yield* mutations.switchActiveBranch({
          sessionId: input.sessionId,
          fromBranchId: input.fromBranchId,
          toBranchId: input.toBranchId,
          requestId: input.requestId,
        })
      })

      const doForkBranch = Effect.fn("SessionCommands.doForkBranch")(function* (
        input: ForkBranchInput,
      ) {
        return yield* mutations.forkSessionBranch({
          sessionId: input.sessionId,
          fromBranchId: input.fromBranchId,
          atMessageId: input.atMessageId,
          name: input.name,
          requestId: input.requestId,
        })
      })

      const doSendMessage = Effect.fn("SessionCommands.doSendMessage")(function* (
        input: SendMessageInput,
      ) {
        yield* sessionRuntime.sendUserMessage({
          sessionId: input.sessionId,
          branchId: input.branchId,
          content: input.content,
          agentOverride: input.agentOverride,
          runSpec: input.runSpec,
          requestId: input.requestId,
        })
        yield* Effect.logInfo("session.messageSent").pipe(
          Effect.annotateLogs({
            sessionId: input.sessionId,
            branchId: input.branchId,
            requestId: input.requestId,
          }),
        )
      })

      return {
        createSession: dedupCreateSession,
        createBranch: dedupCreateBranch,
        switchBranch: dedupSwitchBranch,
        forkBranch: dedupForkBranch,
        sendMessage: dedupSendMessage,
      } satisfies SessionCommandsService
    }),
  )

  static SessionMutationsLive = SessionMutationsLiveLayer
}

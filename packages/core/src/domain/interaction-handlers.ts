import { ServiceMap, Effect, Layer } from "effect"
import {
  EventStore,
  InteractionDismissed,
  PermissionRequested,
  type EventStoreError,
  PromptConfirmed,
  PromptEdited,
  PromptPresented,
  PromptRejected,
  type PromptDecision,
  HandoffPresented,
  HandoffConfirmed,
  HandoffRejected,
  type HandoffDecision,
} from "./event"
import type { BranchId, SessionId, ToolCallId } from "./ids"
import type { ToolContext } from "./tool"
import type { PermissionDecision } from "./permission"
import {
  makeInteractionService,
  type InteractionStorageConfig,
  type InteractionRequestRecord,
} from "./interaction-request"
import { Storage } from "../storage/sqlite-storage.js"

// ============================================================================
// Permission Handler
// ============================================================================

interface PermissionParams {
  sessionId: SessionId
  branchId: BranchId
  toolCallId: ToolCallId
  toolName: string
  input: unknown
}

export interface PermissionHandlerService {
  readonly request: (
    params: { toolCallId: ToolCallId; toolName: string; input: unknown },
    ctx: ToolContext,
  ) => Effect.Effect<PermissionDecision, EventStoreError>
  readonly respond: (
    requestId: string,
    decision: PermissionDecision,
  ) => Effect.Effect<PermissionParams | undefined, EventStoreError>
  readonly rehydrate: (record: InteractionRequestRecord) => Effect.Effect<void, EventStoreError>
}

export class PermissionHandler extends ServiceMap.Service<
  PermissionHandler,
  PermissionHandlerService
>()("@gent/core/src/domain/interaction-handlers/PermissionHandler") {
  static Live: Layer.Layer<PermissionHandler, never, EventStore | Storage> = Layer.effect(
    PermissionHandler,
    Effect.gen(function* () {
      const eventStore = yield* EventStore
      const storageCallbacks = yield* makeStorageCallbacks

      const interaction = makeInteractionService<PermissionParams, PermissionDecision>({
        type: "permission",
        onPresent: (requestId, params) =>
          eventStore.publish(
            new PermissionRequested({
              sessionId: params.sessionId,
              branchId: params.branchId,
              requestId,
              toolCallId: params.toolCallId,
              toolName: params.toolName,
              ...(params.input !== undefined ? { input: params.input } : {}),
            }),
          ),
        onRespond: (requestId, params) =>
          eventStore.publish(
            new InteractionDismissed({
              sessionId: params.sessionId,
              branchId: params.branchId,
              requestId,
            }),
          ),
        getContext: (params) => ({ sessionId: params.sessionId, branchId: params.branchId }),
        storage: storageCallbacks,
      })

      return {
        request: Effect.fn("PermissionHandler.request")(function* (params, ctx) {
          return yield* interaction.present({
            sessionId: ctx.sessionId,
            branchId: ctx.branchId,
            toolCallId: params.toolCallId,
            toolName: params.toolName,
            input: params.input,
          })
        }),
        respond: (requestId, decision) => interaction.respond(requestId, decision),
        rehydrate: (record) =>
          interaction.rehydrate(
            record.requestId,
            JSON.parse(record.paramsJson) as PermissionParams,
          ),
      }
    }),
  )

  static Test = (
    decisions: ReadonlyArray<PermissionDecision> = ["allow"],
  ): Layer.Layer<PermissionHandler> => {
    let index = 0
    return Layer.succeed(PermissionHandler, {
      request: () => Effect.succeed(decisions[index++] ?? "allow"),
      respond: () => Effect.sync(() => undefined as PermissionParams | undefined),
      rehydrate: () => Effect.void,
    })
  }
}

// ============================================================================
// Prompt Handler
// ============================================================================

interface PromptParams {
  sessionId: SessionId
  branchId: BranchId
  mode: "present" | "confirm" | "review"
  path?: string
  content?: string
  title?: string
}

export interface PromptHandlerService {
  readonly present: (params: PromptParams) => Effect.Effect<PromptDecision, EventStoreError>
  readonly respond: (
    requestId: string,
    decision: PromptDecision,
    content?: string,
  ) => Effect.Effect<PromptParams | undefined, EventStoreError>
  readonly rehydrate: (record: InteractionRequestRecord) => Effect.Effect<void, EventStoreError>
}

export class PromptHandler extends ServiceMap.Service<PromptHandler, PromptHandlerService>()(
  "@gent/core/src/domain/interaction-handlers/PromptHandler",
) {
  static Live: Layer.Layer<PromptHandler, never, EventStore | Storage> = Layer.effect(
    PromptHandler,
    Effect.gen(function* () {
      const eventStore = yield* EventStore
      const storageCallbacks = yield* makeStorageCallbacks

      const interaction = makeInteractionService<PromptParams, PromptDecision>({
        type: "prompt",
        autoResolve: (params) =>
          params.mode === "present" ? ("yes" as PromptDecision) : undefined,
        onPresent: (requestId, params) =>
          eventStore.publish(
            new PromptPresented({
              sessionId: params.sessionId,
              branchId: params.branchId,
              requestId,
              mode: params.mode,
              ...(params.path !== undefined ? { path: params.path } : {}),
              ...(params.content !== undefined ? { content: params.content } : {}),
              ...(params.title !== undefined ? { title: params.title } : {}),
            }),
          ),
        onRespond: (requestId, params, decision, content) => {
          const dismissed = eventStore.publish(
            new InteractionDismissed({
              sessionId: params.sessionId,
              branchId: params.branchId,
              requestId,
            }),
          )
          if (decision === "yes") {
            return eventStore
              .publish(
                new PromptConfirmed({
                  sessionId: params.sessionId,
                  branchId: params.branchId,
                  requestId,
                  ...(params.path !== undefined ? { path: params.path } : {}),
                }),
              )
              .pipe(Effect.andThen(dismissed))
          }
          if (decision === "edit") {
            return eventStore
              .publish(
                new PromptEdited({
                  sessionId: params.sessionId,
                  branchId: params.branchId,
                  requestId,
                  ...(params.path !== undefined ? { path: params.path } : {}),
                }),
              )
              .pipe(Effect.andThen(dismissed))
          }
          return eventStore
            .publish(
              new PromptRejected({
                sessionId: params.sessionId,
                branchId: params.branchId,
                requestId,
                ...(params.path !== undefined ? { path: params.path } : {}),
                ...(content !== undefined ? { reason: content } : {}),
              }),
            )
            .pipe(Effect.andThen(dismissed))
        },
        getContext: (params) => ({ sessionId: params.sessionId, branchId: params.branchId }),
        storage: storageCallbacks,
      })

      return {
        present: (params) => interaction.present(params),
        respond: (requestId, decision, content) =>
          interaction.respond(requestId, decision, content),
        rehydrate: (record) =>
          interaction.rehydrate(record.requestId, JSON.parse(record.paramsJson) as PromptParams),
      }
    }),
  )

  static Test = (
    decisions: ReadonlyArray<PromptDecision> = ["yes"],
  ): Layer.Layer<PromptHandler> => {
    let index = 0
    return Layer.succeed(PromptHandler, {
      present: () => Effect.succeed(decisions[index++] ?? "yes"),
      respond: () => Effect.sync(() => undefined as PromptParams | undefined),
      rehydrate: () => Effect.void,
    })
  }
}

// ============================================================================
// Handoff Handler
// ============================================================================

interface HandoffParams {
  sessionId: SessionId
  branchId: BranchId
  summary: string
  reason?: string
}

export interface HandoffHandlerService {
  readonly present: (params: HandoffParams) => Effect.Effect<HandoffDecision, EventStoreError>
  readonly peek: (requestId: string) => Effect.Effect<HandoffParams | undefined>
  readonly claim: (requestId: string) => Effect.Effect<HandoffParams | undefined>
  readonly respond: (
    requestId: string,
    decision: HandoffDecision,
    childSessionId?: SessionId,
    reason?: string,
  ) => Effect.Effect<HandoffParams | undefined, EventStoreError>
  readonly rehydrate: (record: InteractionRequestRecord) => Effect.Effect<void, EventStoreError>
}

export class HandoffHandler extends ServiceMap.Service<HandoffHandler, HandoffHandlerService>()(
  "@gent/core/src/domain/interaction-handlers/HandoffHandler",
) {
  static Live: Layer.Layer<HandoffHandler, never, EventStore | Storage> = Layer.effect(
    HandoffHandler,
    Effect.gen(function* () {
      const eventStore = yield* EventStore
      const claimed = new Set<string>()
      const storageCallbacks = yield* makeStorageCallbacks

      const interaction = makeInteractionService<HandoffParams, HandoffDecision>({
        type: "handoff",
        onPresent: (requestId, params) =>
          eventStore.publish(
            new HandoffPresented({
              sessionId: params.sessionId,
              branchId: params.branchId,
              requestId,
              summary: params.summary,
              ...(params.reason !== undefined ? { reason: params.reason } : {}),
            }),
          ),
        onRespond: (requestId, params, decision, extra) => {
          const dismissed = eventStore.publish(
            new InteractionDismissed({
              sessionId: params.sessionId,
              branchId: params.branchId,
              requestId,
            }),
          )
          if (decision === "confirm") {
            return eventStore
              .publish(
                new HandoffConfirmed({
                  sessionId: params.sessionId,
                  branchId: params.branchId,
                  requestId,
                  ...(extra !== undefined ? { childSessionId: extra as SessionId } : {}),
                }),
              )
              .pipe(Effect.andThen(dismissed))
          }
          return eventStore
            .publish(
              new HandoffRejected({
                sessionId: params.sessionId,
                branchId: params.branchId,
                requestId,
                ...(extra !== undefined ? { reason: extra } : {}),
              }),
            )
            .pipe(Effect.andThen(dismissed))
        },
        getContext: (params) => ({ sessionId: params.sessionId, branchId: params.branchId }),
        storage: storageCallbacks,
      })

      return {
        present: (params) => interaction.present(params),

        peek: (requestId) => Effect.succeed(interaction.peek(requestId)),

        claim: (requestId) => {
          const params = interaction.peek(requestId)
          if (params === undefined || claimed.has(requestId)) {
            return Effect.sync(() => undefined as HandoffParams | undefined)
          }
          claimed.add(requestId)
          return Effect.succeed(params)
        },

        respond: Effect.fn("HandoffHandler.respond")(
          function* (requestId, decision, childSessionId, reason) {
            // Pass childSessionId or reason as extra
            const extra = decision === "confirm" ? childSessionId : reason
            return yield* interaction.respond(requestId, decision, extra)
          },
        ),

        rehydrate: (record) =>
          interaction.rehydrate(record.requestId, JSON.parse(record.paramsJson) as HandoffParams),
      }
    }),
  )

  static Test = (
    decisions: ReadonlyArray<HandoffDecision> = ["confirm"],
  ): Layer.Layer<HandoffHandler> => {
    let index = 0
    return Layer.succeed(HandoffHandler, {
      present: () => Effect.succeed(decisions[index++] ?? "confirm"),
      peek: () => Effect.sync(() => undefined as HandoffParams | undefined),
      claim: () => Effect.sync(() => undefined as HandoffParams | undefined),
      respond: () => Effect.sync(() => undefined as HandoffParams | undefined),
      rehydrate: () => Effect.void,
    })
  }
}

// ============================================================================
// Shared storage callback factory
// ============================================================================

const makeStorageCallbacks: Effect.Effect<InteractionStorageConfig, never, Storage> = Effect.gen(
  function* () {
    const storage = yield* Storage
    return {
      persist: (record) =>
        storage.persistInteractionRequest(record).pipe(
          Effect.asVoid,
          Effect.catchEager(() => Effect.void),
        ),
      resolve: (requestId) =>
        storage.resolveInteractionRequest(requestId).pipe(Effect.catchEager(() => Effect.void)),
    }
  },
)

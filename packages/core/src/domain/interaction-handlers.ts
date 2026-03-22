import { ServiceMap, Effect, Layer } from "effect"
import {
  EventStore,
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
import type { BranchId, SessionId } from "./ids"
import type { ToolContext } from "./tool"
import type { PermissionDecision } from "./permission"
import { makeInteractionService } from "./interaction-request"

// ============================================================================
// Permission Handler
// ============================================================================

interface PermissionParams {
  sessionId: SessionId
  branchId: BranchId
  toolCallId: string
  toolName: string
  input: unknown
}

export interface PermissionHandlerService {
  readonly request: (
    params: { toolCallId: string; toolName: string; input: unknown },
    ctx: ToolContext,
  ) => Effect.Effect<PermissionDecision, EventStoreError>
  readonly respond: (
    requestId: string,
    decision: PermissionDecision,
  ) => Effect.Effect<PermissionParams | undefined, EventStoreError>
}

export class PermissionHandler extends ServiceMap.Service<
  PermissionHandler,
  PermissionHandlerService
>()("@gent/core/src/interaction-handlers/PermissionHandler") {
  static Live: Layer.Layer<PermissionHandler, never, EventStore> = Layer.effect(
    PermissionHandler,
    Effect.gen(function* () {
      const eventStore = yield* EventStore

      const interaction = makeInteractionService<PermissionParams, PermissionDecision>({
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
        onRespond: () => Effect.void,
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
      }
    }),
  )

  static Test = (
    decisions: ReadonlyArray<PermissionDecision> = ["allow"],
  ): Layer.Layer<PermissionHandler> => {
    let index = 0
    return Layer.succeed(PermissionHandler, {
      request: () => Effect.succeed(decisions[index++] ?? "allow"),
      respond: () => Effect.succeed(undefined),
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
}

export class PromptHandler extends ServiceMap.Service<PromptHandler, PromptHandlerService>()(
  "@gent/core/src/interaction-handlers/PromptHandler",
) {
  static Live: Layer.Layer<PromptHandler, never, EventStore> = Layer.effect(
    PromptHandler,
    Effect.gen(function* () {
      const eventStore = yield* EventStore

      const interaction = makeInteractionService<PromptParams, PromptDecision>({
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
          if (decision === "yes") {
            return eventStore.publish(
              new PromptConfirmed({
                sessionId: params.sessionId,
                branchId: params.branchId,
                requestId,
                ...(params.path !== undefined ? { path: params.path } : {}),
              }),
            )
          }
          if (decision === "edit") {
            return eventStore.publish(
              new PromptEdited({
                sessionId: params.sessionId,
                branchId: params.branchId,
                requestId,
                ...(params.path !== undefined ? { path: params.path } : {}),
              }),
            )
          }
          return eventStore.publish(
            new PromptRejected({
              sessionId: params.sessionId,
              branchId: params.branchId,
              requestId,
              ...(params.path !== undefined ? { path: params.path } : {}),
              ...(content !== undefined ? { reason: content } : {}),
            }),
          )
        },
      })

      return {
        present: (params) => interaction.present(params),
        respond: (requestId, decision, content) =>
          interaction.respond(requestId, decision, content),
      }
    }),
  )

  static Test = (
    decisions: ReadonlyArray<PromptDecision> = ["yes"],
  ): Layer.Layer<PromptHandler> => {
    let index = 0
    return Layer.succeed(PromptHandler, {
      present: () => Effect.succeed(decisions[index++] ?? "yes"),
      respond: () => Effect.succeed(undefined),
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
}

export class HandoffHandler extends ServiceMap.Service<HandoffHandler, HandoffHandlerService>()(
  "@gent/core/src/interaction-handlers/HandoffHandler",
) {
  static Live: Layer.Layer<HandoffHandler, never, EventStore> = Layer.effect(
    HandoffHandler,
    Effect.gen(function* () {
      const eventStore = yield* EventStore
      const claimed = new Set<string>()

      const interaction = makeInteractionService<HandoffParams, HandoffDecision>({
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
          if (decision === "confirm") {
            return eventStore.publish(
              new HandoffConfirmed({
                sessionId: params.sessionId,
                branchId: params.branchId,
                requestId,
                ...(extra !== undefined ? { childSessionId: extra as SessionId } : {}),
              }),
            )
          }
          return eventStore.publish(
            new HandoffRejected({
              sessionId: params.sessionId,
              branchId: params.branchId,
              requestId,
              ...(extra !== undefined ? { reason: extra } : {}),
            }),
          )
        },
      })

      return {
        present: (params) => interaction.present(params),

        peek: (requestId) => Effect.succeed(interaction.peek(requestId)),

        claim: (requestId) => {
          const params = interaction.peek(requestId)
          if (params === undefined || claimed.has(requestId)) return Effect.succeed(undefined)
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
      }
    }),
  )

  static Test = (
    decisions: ReadonlyArray<HandoffDecision> = ["confirm"],
  ): Layer.Layer<HandoffHandler> => {
    let index = 0
    return Layer.succeed(HandoffHandler, {
      present: () => Effect.succeed(decisions[index++] ?? "confirm"),
      peek: () => Effect.succeed(undefined),
      claim: () => Effect.succeed(undefined),
      respond: () => Effect.succeed(undefined),
    })
  }
}

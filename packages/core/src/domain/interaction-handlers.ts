import { ServiceMap, Deferred, Effect, Layer } from "effect"
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

export interface PermissionHandlerService {
  readonly request: (
    params: { toolCallId: string; toolName: string; input: unknown },
    ctx: ToolContext,
  ) => Effect.Effect<PermissionDecision, EventStoreError>
  readonly respond: (
    requestId: string,
    decision: PermissionDecision,
  ) => Effect.Effect<
    | {
        sessionId: SessionId
        branchId: BranchId
        toolCallId: string
        toolName: string
        input: unknown
      }
    | undefined
  >
}

export class PermissionHandler extends ServiceMap.Service<
  PermissionHandler,
  PermissionHandlerService
>()("@gent/core/src/interaction-handlers/PermissionHandler") {
  static Live: Layer.Layer<PermissionHandler, never, EventStore> = Layer.effect(
    PermissionHandler,
    Effect.gen(function* () {
      const eventStore = yield* EventStore
      const pending = new Map<
        string,
        {
          deferred: Deferred.Deferred<PermissionDecision>
          sessionId: SessionId
          branchId: BranchId
          toolCallId: string
          toolName: string
          input: unknown
        }
      >()

      return {
        request: Effect.fn("PermissionHandler.request")(function* (params, ctx) {
          const requestId = Bun.randomUUIDv7()
          const deferred = yield* Deferred.make<PermissionDecision>()
          pending.set(requestId, {
            deferred,
            sessionId: ctx.sessionId,
            branchId: ctx.branchId,
            toolCallId: params.toolCallId,
            toolName: params.toolName,
            input: params.input,
          })

          yield* eventStore.publish(
            new PermissionRequested({
              sessionId: ctx.sessionId,
              branchId: ctx.branchId,
              requestId,
              toolCallId: params.toolCallId,
              toolName: params.toolName,
              ...(params.input !== undefined ? { input: params.input } : {}),
            }),
          )

          const decision = yield* Deferred.await(deferred)
          pending.delete(requestId)
          return decision
        }),

        respond: Effect.fn("PermissionHandler.respond")(function* (requestId, decision) {
          const entry = pending.get(requestId)
          if (entry === undefined) return undefined
          yield* Deferred.succeed(entry.deferred, decision)
          pending.delete(requestId)
          return {
            sessionId: entry.sessionId,
            branchId: entry.branchId,
            toolCallId: entry.toolCallId,
            toolName: entry.toolName,
            input: entry.input,
          }
        }),
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

export interface PromptHandlerService {
  readonly present: (params: {
    sessionId: SessionId
    branchId: BranchId
    mode: "present" | "confirm" | "review"
    path?: string
    content?: string
    title?: string
  }) => Effect.Effect<PromptDecision, EventStoreError>
  readonly respond: (
    requestId: string,
    decision: PromptDecision,
    content?: string,
  ) => Effect.Effect<
    | {
        sessionId: SessionId
        branchId: BranchId
        path?: string
      }
    | undefined,
    EventStoreError
  >
}

export class PromptHandler extends ServiceMap.Service<PromptHandler, PromptHandlerService>()(
  "@gent/core/src/interaction-handlers/PromptHandler",
) {
  static Live: Layer.Layer<PromptHandler, never, EventStore> = Layer.effect(
    PromptHandler,
    Effect.gen(function* () {
      const eventStore = yield* EventStore
      const pending = new Map<
        string,
        {
          deferred: Deferred.Deferred<PromptDecision>
          sessionId: SessionId
          branchId: BranchId
          mode: "present" | "confirm" | "review"
          path?: string
          content?: string
          title?: string
        }
      >()

      return {
        present: Effect.fn("PromptHandler.present")(function* (params) {
          // Present mode auto-resolves — no event, no user interaction
          if (params.mode === "present") {
            return "yes" as PromptDecision
          }

          const requestId = Bun.randomUUIDv7()
          const deferred = yield* Deferred.make<PromptDecision>()
          pending.set(requestId, {
            deferred,
            sessionId: params.sessionId,
            branchId: params.branchId,
            mode: params.mode,
            path: params.path,
            content: params.content,
            title: params.title,
          })

          yield* eventStore.publish(
            new PromptPresented({
              sessionId: params.sessionId,
              branchId: params.branchId,
              requestId,
              mode: params.mode,
              ...(params.path !== undefined ? { path: params.path } : {}),
              ...(params.content !== undefined ? { content: params.content } : {}),
              ...(params.title !== undefined ? { title: params.title } : {}),
            }),
          )

          const decision = yield* Deferred.await(deferred)
          pending.delete(requestId)
          return decision
        }),

        respond: Effect.fn("PromptHandler.respond")(function* (requestId, decision, content) {
          const entry = pending.get(requestId)
          if (entry === undefined) return undefined

          if (decision === "yes") {
            yield* eventStore.publish(
              new PromptConfirmed({
                sessionId: entry.sessionId,
                branchId: entry.branchId,
                requestId,
                ...(entry.path !== undefined ? { path: entry.path } : {}),
              }),
            )
          } else if (decision === "edit") {
            yield* eventStore.publish(
              new PromptEdited({
                sessionId: entry.sessionId,
                branchId: entry.branchId,
                requestId,
                ...(entry.path !== undefined ? { path: entry.path } : {}),
              }),
            )
          } else {
            yield* eventStore.publish(
              new PromptRejected({
                sessionId: entry.sessionId,
                branchId: entry.branchId,
                requestId,
                ...(entry.path !== undefined ? { path: entry.path } : {}),
                ...(content !== undefined ? { reason: content } : {}),
              }),
            )
          }

          yield* Deferred.succeed(entry.deferred, decision)
          pending.delete(requestId)
          return {
            sessionId: entry.sessionId,
            branchId: entry.branchId,
            ...(entry.path !== undefined ? { path: entry.path } : {}),
          }
        }),
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

export interface HandoffHandlerService {
  readonly present: (params: {
    sessionId: SessionId
    branchId: BranchId
    summary: string
    reason?: string
  }) => Effect.Effect<HandoffDecision, EventStoreError>
  readonly peek: (requestId: string) => Effect.Effect<
    | {
        sessionId: SessionId
        branchId: BranchId
        summary: string
        reason?: string
      }
    | undefined
  >
  /** Atomically claim a pending handoff — removes entry, returns it or undefined if already claimed. */
  readonly claim: (requestId: string) => Effect.Effect<
    | {
        sessionId: SessionId
        branchId: BranchId
        summary: string
        reason?: string
      }
    | undefined
  >
  readonly respond: (
    requestId: string,
    decision: HandoffDecision,
    childSessionId?: SessionId,
    reason?: string,
  ) => Effect.Effect<
    | {
        sessionId: SessionId
        branchId: BranchId
        summary: string
        reason?: string
      }
    | undefined,
    EventStoreError
  >
}

export class HandoffHandler extends ServiceMap.Service<HandoffHandler, HandoffHandlerService>()(
  "@gent/core/src/interaction-handlers/HandoffHandler",
) {
  static Live: Layer.Layer<HandoffHandler, never, EventStore> = Layer.effect(
    HandoffHandler,
    Effect.gen(function* () {
      const eventStore = yield* EventStore
      const pending = new Map<
        string,
        {
          deferred: Deferred.Deferred<HandoffDecision>
          sessionId: SessionId
          branchId: BranchId
          summary: string
          reason?: string
        }
      >()
      const claimed = new Set<string>()

      return {
        peek: (requestId: string) => {
          const entry = pending.get(requestId)
          if (entry === undefined) return Effect.succeed(undefined)
          return Effect.succeed({
            sessionId: entry.sessionId,
            branchId: entry.branchId,
            summary: entry.summary,
            ...(entry.reason !== undefined ? { reason: entry.reason } : {}),
          })
        },

        claim: (requestId: string) => {
          const entry = pending.get(requestId)
          if (entry === undefined || claimed.has(requestId)) return Effect.succeed(undefined)
          claimed.add(requestId)
          return Effect.succeed({
            sessionId: entry.sessionId,
            branchId: entry.branchId,
            summary: entry.summary,
            ...(entry.reason !== undefined ? { reason: entry.reason } : {}),
          })
        },

        present: Effect.fn("HandoffHandler.present")(function* (params) {
          const requestId = Bun.randomUUIDv7()
          const deferred = yield* Deferred.make<HandoffDecision>()
          pending.set(requestId, {
            deferred,
            sessionId: params.sessionId,
            branchId: params.branchId,
            summary: params.summary,
            reason: params.reason,
          })

          yield* eventStore.publish(
            new HandoffPresented({
              sessionId: params.sessionId,
              branchId: params.branchId,
              requestId,
              summary: params.summary,
              ...(params.reason !== undefined ? { reason: params.reason } : {}),
            }),
          )

          const decision = yield* Deferred.await(deferred)
          pending.delete(requestId)
          return decision
        }),

        respond: Effect.fn("HandoffHandler.respond")(
          function* (requestId, decision, childSessionId, reason) {
            const entry = pending.get(requestId)
            if (entry === undefined) return undefined

            // Delete before publishing to prevent double-respond race
            pending.delete(requestId)

            if (decision === "confirm") {
              yield* eventStore.publish(
                new HandoffConfirmed({
                  sessionId: entry.sessionId,
                  branchId: entry.branchId,
                  requestId,
                  ...(childSessionId !== undefined ? { childSessionId } : {}),
                }),
              )
            } else if (decision === "reject") {
              yield* eventStore.publish(
                new HandoffRejected({
                  sessionId: entry.sessionId,
                  branchId: entry.branchId,
                  requestId,
                  ...(reason !== undefined ? { reason } : {}),
                }),
              )
            }

            yield* Deferred.succeed(entry.deferred, decision)
            return {
              sessionId: entry.sessionId,
              branchId: entry.branchId,
              summary: entry.summary,
              ...(entry.reason !== undefined ? { reason: entry.reason } : {}),
            }
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

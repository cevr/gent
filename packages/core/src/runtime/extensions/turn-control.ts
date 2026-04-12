/**
 * Extension turn-control service — shared bridge into agent-loop queue paths.
 *
 * No hidden mailbox here. If the loop has not bound handlers yet, that is a
 * wiring bug and should fail loudly through actor supervision.
 */

import { Effect, Layer, Ref, Semaphore, Context } from "effect"
import type { BranchId, SessionId } from "../../domain/ids.js"
import type { MessageMetadata } from "../../domain/message.js"

export interface QueueFollowUpInput {
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly content: string
  readonly metadata?: MessageMetadata
}

export interface InterjectInput {
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly content: string
}

interface ExtensionTurnControlHandlers {
  readonly queueFollowUp: (input: QueueFollowUpInput) => Effect.Effect<void>
  readonly interject: (input: InterjectInput) => Effect.Effect<void>
}

export interface ExtensionTurnControlService {
  /** Queue a follow-up message after the current turn completes */
  readonly queueFollowUp: (input: QueueFollowUpInput) => Effect.Effect<void>

  /** Interject urgently — interrupts the current turn */
  readonly interject: (input: InterjectInput) => Effect.Effect<void>
  /** Bind the live agent-loop handlers once the loop exists. */
  readonly bind: (handlers: ExtensionTurnControlHandlers) => Effect.Effect<void>
}

export class ExtensionTurnControl extends Context.Service<
  ExtensionTurnControl,
  ExtensionTurnControlService
>()("@gent/core/src/runtime/extensions/turn-control/ExtensionTurnControl") {
  static Live: Layer.Layer<ExtensionTurnControl> = Layer.effect(
    ExtensionTurnControl,
    Effect.gen(function* () {
      const handlersRef = yield* Ref.make<ExtensionTurnControlHandlers | undefined>(undefined)
      const lock = yield* Semaphore.make(1)

      const withHandlers = <A>(
        operation: string,
        run: (handlers: ExtensionTurnControlHandlers) => Effect.Effect<A>,
      ) =>
        Effect.gen(function* () {
          const handlers = yield* lock.withPermits(1)(Ref.get(handlersRef))
          if (handlers === undefined) {
            return yield* Effect.die(
              new Error(`ExtensionTurnControl.${operation} called before AgentLoop bound handlers`),
            )
          }
          return yield* run(handlers)
        })

      return {
        queueFollowUp: Effect.fn("ExtensionTurnControl.queueFollowUp")(function* (
          input: QueueFollowUpInput,
        ) {
          yield* withHandlers("queueFollowUp", (handlers) => handlers.queueFollowUp(input))
        }),

        interject: Effect.fn("ExtensionTurnControl.interject")(function* (input: InterjectInput) {
          yield* withHandlers("interject", (handlers) => handlers.interject(input))
        }),

        bind: Effect.fn("ExtensionTurnControl.bind")(function* (
          handlers: ExtensionTurnControlHandlers,
        ) {
          yield* lock.withPermits(1)(Ref.set(handlersRef, handlers))
        }),
      } satisfies ExtensionTurnControlService
    }),
  )

  static Test = (): Layer.Layer<ExtensionTurnControl> =>
    Layer.succeed(ExtensionTurnControl, {
      queueFollowUp: () => Effect.void,
      interject: () => Effect.void,
      bind: () => Effect.void,
    })
}

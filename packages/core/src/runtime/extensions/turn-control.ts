/** Extension turn-control service — queue-backed mailbox into agent-loop queue paths. */

import { Context, Deferred, Effect, Layer, Queue, Schema, Stream } from "effect"
import { BranchId, SessionId } from "../../domain/ids.js"
import { MessageMetadata } from "../../domain/message.js"

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

export const QueueFollowUpCommand = Schema.TaggedStruct("QueueFollowUp", {
  sessionId: SessionId,
  branchId: BranchId,
  content: Schema.String,
  metadata: Schema.optional(MessageMetadata),
})
export type QueueFollowUpCommand = typeof QueueFollowUpCommand.Type

export const InterjectCommand = Schema.TaggedStruct("Interject", {
  sessionId: SessionId,
  branchId: BranchId,
  content: Schema.String,
})
export type InterjectCommand = typeof InterjectCommand.Type

export const TurnControlCommand = Schema.Union([QueueFollowUpCommand, InterjectCommand])
export type TurnControlCommand = typeof TurnControlCommand.Type

export class TurnControlError extends Schema.TaggedErrorClass<TurnControlError>()(
  "TurnControlError",
  {
    command: Schema.Literals(["QueueFollowUp", "Interject"]),
    message: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export type TurnControlEnvelope = TurnControlCommand & {
  readonly ack: Deferred.Deferred<void, TurnControlError>
}

export interface ExtensionTurnControlService {
  /** Queue a follow-up message after the current turn completes */
  readonly queueFollowUp: (input: QueueFollowUpInput) => Effect.Effect<void, TurnControlError>

  /** Interject urgently — interrupts the current turn */
  readonly interject: (input: InterjectInput) => Effect.Effect<void, TurnControlError>
  /** Stream of queued turn-control commands, owned by the runtime. */
  readonly commands: Stream.Stream<TurnControlEnvelope>
}

export class ExtensionTurnControl extends Context.Service<
  ExtensionTurnControl,
  ExtensionTurnControlService
>()("@gent/core/src/runtime/extensions/turn-control/ExtensionTurnControl") {
  static Live: Layer.Layer<ExtensionTurnControl> = Layer.effect(
    ExtensionTurnControl,
    Effect.gen(function* () {
      const queue = yield* Queue.unbounded<TurnControlEnvelope>()

      return {
        queueFollowUp: Effect.fn("ExtensionTurnControl.queueFollowUp")(function* (
          input: QueueFollowUpInput,
        ) {
          const ack = yield* Deferred.make<void, TurnControlError>()
          yield* Queue.offer(queue, { _tag: "QueueFollowUp", ...input, ack })
          yield* Deferred.await(ack)
        }),

        interject: Effect.fn("ExtensionTurnControl.interject")(function* (input: InterjectInput) {
          const ack = yield* Deferred.make<void, TurnControlError>()
          yield* Queue.offer(queue, { _tag: "Interject", ...input, ack })
          yield* Deferred.await(ack)
        }),

        commands: Stream.fromQueue(queue),
      } satisfies ExtensionTurnControlService
    }),
  )

  static Test = (): Layer.Layer<ExtensionTurnControl> =>
    Layer.succeed(ExtensionTurnControl, {
      queueFollowUp: () => Effect.void,
      interject: () => Effect.void,
      commands: Stream.empty,
    })
}

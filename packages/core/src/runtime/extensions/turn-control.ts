/** Extension turn-control service — queue-backed mailbox into agent-loop queue paths. */

import { Context, Deferred, Effect, Exit, Layer, Queue, Ref, Schema, Stream } from "effect"
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

export interface CurrentTurnControlOwnerService {
  readonly matches: (command: TurnControlCommand) => boolean
  readonly apply: (command: TurnControlCommand) => Effect.Effect<boolean, TurnControlError>
}

export interface ExtensionTurnControlService {
  /** Queue a follow-up message after the current turn completes */
  readonly queueFollowUp: (input: QueueFollowUpInput) => Effect.Effect<void, TurnControlError>

  /** Interject urgently — interrupts the current turn */
  readonly interject: (input: InterjectInput) => Effect.Effect<void, TurnControlError>
  /** Stream of queued turn-control commands, owned by the runtime. */
  readonly commands: Stream.Stream<TurnControlEnvelope>
  readonly withOwner: <A, E, R>(
    owner: CurrentTurnControlOwnerService,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>
}

export class ExtensionTurnControl extends Context.Service<
  ExtensionTurnControl,
  ExtensionTurnControlService
>()("@gent/core/src/runtime/extensions/turn-control/ExtensionTurnControl") {
  static Live: Layer.Layer<ExtensionTurnControl> = Layer.effect(
    ExtensionTurnControl,
    Effect.gen(function* () {
      const queue = yield* Queue.unbounded<TurnControlEnvelope>()
      const ownersRef = yield* Ref.make<ReadonlyArray<CurrentTurnControlOwnerService>>([])
      const findOwner = (command: TurnControlCommand) =>
        Effect.map(Ref.get(ownersRef), (owners) => owners.find((owner) => owner.matches(command)))
      const offerAndAwait = (command: TurnControlCommand) =>
        Effect.gen(function* () {
          const owner = yield* findOwner(command)
          if (owner !== undefined && (yield* owner.apply(command))) {
            return
          }
          const ack = yield* Deferred.make<void, TurnControlError>()
          yield* Queue.offer(queue, { ...command, ack })
          yield* Deferred.await(ack)
        })
      const removeOwner = (owner: CurrentTurnControlOwnerService) =>
        Ref.update(ownersRef, (owners) => {
          const index = owners.indexOf(owner)
          if (index === -1) return owners
          const next = [...owners]
          next.splice(index, 1)
          return next
        })
      const withOwner: ExtensionTurnControlService["withOwner"] = (owner, effect) =>
        Ref.update(ownersRef, (owners) => [owner, ...owners]).pipe(
          Effect.andThen(Effect.exit(effect)),
          Effect.flatMap((exit) =>
            removeOwner(owner).pipe(
              Effect.andThen(
                Exit.match(exit, {
                  onFailure: Effect.failCause,
                  onSuccess: Effect.succeed,
                }),
              ),
            ),
          ),
        )

      return {
        queueFollowUp: Effect.fn("ExtensionTurnControl.queueFollowUp")(function* (
          input: QueueFollowUpInput,
        ) {
          yield* offerAndAwait({ _tag: "QueueFollowUp", ...input })
        }),

        interject: Effect.fn("ExtensionTurnControl.interject")(function* (input: InterjectInput) {
          yield* offerAndAwait({ _tag: "Interject", ...input })
        }),

        commands: Stream.fromQueue(queue),

        withOwner,
      } satisfies ExtensionTurnControlService
    }),
  )

  static Test = (): Layer.Layer<ExtensionTurnControl> => {
    const withOwner: ExtensionTurnControlService["withOwner"] = (_owner, effect) => effect
    return Layer.succeed(ExtensionTurnControl, {
      queueFollowUp: () => Effect.void,
      interject: () => Effect.void,
      commands: Stream.empty,
      withOwner,
    })
  }
}

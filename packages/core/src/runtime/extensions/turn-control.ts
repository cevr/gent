/**
 * Extension turn-control service — wraps existing agent loop queue paths.
 *
 * Extensions use this to schedule follow-up messages or urgent interjections
 * without reaching into the loop internals directly.
 */

import { ServiceMap, DateTime, Effect, Layer } from "effect"
import type { BranchId, MessageId, SessionId } from "../../domain/ids.js"
import { Message, type MessageMetadata, TextPart } from "../../domain/message.js"
import { AgentLoop } from "../agent/agent-loop.js"

export interface ExtensionTurnControlService {
  /** Queue a follow-up message after the current turn completes */
  readonly queueFollowUp: (input: {
    readonly sessionId: SessionId
    readonly branchId: BranchId
    readonly content: string
    readonly metadata?: MessageMetadata
  }) => Effect.Effect<void>

  /** Interject urgently — interrupts the current turn */
  readonly interject: (input: {
    readonly sessionId: SessionId
    readonly branchId: BranchId
    readonly content: string
  }) => Effect.Effect<void>
}

export class ExtensionTurnControl extends ServiceMap.Service<
  ExtensionTurnControl,
  ExtensionTurnControlService
>()("@gent/core/src/runtime/extensions/turn-control/ExtensionTurnControl") {
  static Live: Layer.Layer<ExtensionTurnControl, never, AgentLoop> = Layer.effect(
    ExtensionTurnControl,
    Effect.gen(function* () {
      const agentLoop = yield* AgentLoop

      return {
        queueFollowUp: Effect.fn("ExtensionTurnControl.queueFollowUp")(function* (input: {
          sessionId: SessionId
          branchId: BranchId
          content: string
          metadata?: MessageMetadata
        }) {
          const message = new Message({
            id: Bun.randomUUIDv7() as MessageId,
            sessionId: input.sessionId,
            branchId: input.branchId,
            kind: "regular",
            role: "user",
            parts: [new TextPart({ type: "text", text: input.content })],
            createdAt: yield* DateTime.nowAsDate,
            metadata: input.metadata,
          })
          yield* agentLoop.followUp(message).pipe(Effect.catchEager(() => Effect.void))
        }),

        interject: Effect.fn("ExtensionTurnControl.interject")(function* (input: {
          sessionId: SessionId
          branchId: BranchId
          content: string
        }) {
          yield* agentLoop
            .steer({
              _tag: "Interject",
              sessionId: input.sessionId,
              branchId: input.branchId,
              message: input.content,
            })
            .pipe(Effect.catchEager(() => Effect.void))
        }),
      }
    }),
  )

  static Test = (): Layer.Layer<ExtensionTurnControl> =>
    Layer.succeed(ExtensionTurnControl, {
      queueFollowUp: () => Effect.void,
      interject: () => Effect.void,
    })
}

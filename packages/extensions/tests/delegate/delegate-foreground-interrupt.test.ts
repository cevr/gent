/**
 * A foreground delegation is owned by its tool call. When the parent turn is
 * interrupted the child must stop too: a child that keeps running has no
 * owner, and the parent's next turn can neither await nor cancel it. The
 * gamut testbed showed six such children editing files after an Escape.
 */
import { describe, expect, it } from "effect-bun-test"
import { Deferred, Effect, Option, Stream } from "effect"
import { RequestId } from "@gent/core-internal/domain/ids"
import { SteerCommand } from "@gent/core-internal/domain/agent"
import {
  finishPart,
  LanguageModelLayers,
  textDeltaPart,
  toolCallPart,
} from "@gent/core-internal/test-utils/language-model"
import { createRpcHarness } from "@gent/core-internal/test-utils/rpc-harness"
import { e2ePreset } from "../helpers/test-preset"

describe("foreground delegation under a parent interrupt", () => {
  it.live("interrupting the parent turn ends the child's turn as interrupted", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const childStreaming = yield* Deferred.make<void>()
        let calls = 0
        const providerLayer = LanguageModelLayers.testStream(() => {
          calls += 1
          if (calls === 1) {
            return Effect.succeed(
              Stream.fromIterable([
                toolCallPart("delegate", { todo: "work that never finishes" }),
                finishPart({ finishReason: "tool-calls" }),
              ]),
            )
          }
          if (calls === 2) {
            // The child's stream opens and stalls: it is mid-turn when the
            // parent is interrupted.
            return Effect.succeed(
              Stream.make(textDeltaPart("working")).pipe(
                Stream.concat(
                  Stream.fromEffect(Deferred.succeed(childStreaming, void 0)).pipe(Stream.drain),
                ),
                Stream.concat(Stream.never),
              ),
            )
          }
          return Effect.succeed(
            Stream.fromIterable([textDeltaPart("ack"), finishPart({ finishReason: "stop" })]),
          )
        })
        const { client, sessionId, branchId } = yield* createRpcHarness({
          ...e2ePreset,
          providerLayer,
          subagentRunner: "live",
        })
        yield* client.message.send({ sessionId, branchId, content: "delegate one task" })
        const child = yield* client.session.events({ sessionId, branchId }).pipe(
          Stream.map((envelope) => envelope.event),
          Stream.filter((event) => event._tag === "AgentRunSpawned"),
          Stream.map((event) =>
            Option.map(Option.fromUndefinedOr(event.childBranchId), (childBranchId) => ({
              sessionId: event.childSessionId,
              branchId: childBranchId,
            })),
          ),
          Stream.take(1),
          Stream.runHead,
          Effect.map(Option.flatten),
          Effect.flatMap(Effect.fromOption),
        )
        yield* Deferred.await(childStreaming)
        yield* client.steer.command({
          command: SteerCommand.make({
            _tag: "Interrupt",
            sessionId,
            branchId,
            requestId: RequestId.make("interrupt-parent-of-foreground-child"),
          }),
        })
        const childEnd = yield* client.session.events(child).pipe(
          Stream.filter((envelope) => envelope.event._tag === "TurnCompleted"),
          Stream.take(1),
          Stream.runHead,
        )
        expect(Option.map(childEnd, (envelope) => envelope.event)).toMatchObject(
          Option.some({ _tag: "TurnCompleted", interrupted: true }),
        )
      }).pipe(Effect.timeout("4 seconds")),
    ),
  )
})

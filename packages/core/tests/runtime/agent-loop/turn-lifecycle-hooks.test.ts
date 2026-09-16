/**
 * How a turn ended, as an extension reads it.
 *
 * `turnAfter` carries both facts a handler needs to pick one action:
 * `interrupted` for a turn a person stopped, `streamFailed` for one whose
 * provider stream broke and never recovered. One hook, one decision — a
 * second seam firing afterwards could only correct what the first already did.
 *
 * The hook runs after `TurnCompleted` is appended and delivered
 * (`agent-loop.turn-execution.ts:732`), so these tests poll with `waitFor`
 * rather than waiting on that event.
 */
import { describe, expect, it } from "effect-bun-test"
import { Effect, Ref, Stream } from "effect"
import * as AiError from "effect/unstable/ai/AiError"
import { ExtensionHost, defineExtension, type TurnAfterInput } from "@gent/core/extensions/api"
import type { SteerCommand } from "../../../src/domain/steer"
import { createRpcHarness } from "../../../src/test-utils/rpc-harness"
import { waitFor } from "../../../src/test-utils/fixtures"
import { e2ePreset } from "../../../../extensions/tests/helpers/test-preset"
import {
  finishPart,
  LanguageModelLayers,
  textDeltaPart,
  type LanguageModelStreamPart,
} from "../../../src/test-utils/language-model"

interface TurnOutcome {
  readonly interrupted: boolean
  readonly streamFailed: boolean
}

const makeTurnWatch = (id: string) =>
  Effect.gen(function* () {
    const seen = yield* Ref.make<ReadonlyArray<TurnOutcome>>([])
    const extension = defineExtension({
      id,
      setup: Effect.gen(function* () {
        const host = yield* ExtensionHost
        yield* host.on("turnAfter", (input: TurnAfterInput) =>
          Ref.update(seen, (all) => [
            ...all,
            { interrupted: input.interrupted, streamFailed: input.streamFailed },
          ]),
        )
      }),
    })
    return { seen, extension }
  })

const answeringProvider = () =>
  LanguageModelLayers.testStream(() =>
    Effect.succeed(
      Stream.fromIterable([
        textDeltaPart("answered"),
        finishPart({ finishReason: "stop" }),
      ] satisfies LanguageModelStreamPart[]),
    ),
  )

/**
 * Writes something, then breaks, on every call. A break before any output is
 * retried by the driver; a break after partial output spends a continuation.
 * The turn reports the failure once both are exhausted.
 */
const brokenAfterPartialOutput = (calls: Ref.Ref<number>) =>
  LanguageModelLayers.testStream(() =>
    Effect.gen(function* () {
      const call = yield* Ref.updateAndGet(calls, (n) => n + 1)
      return Stream.concat(
        Stream.fromIterable([textDeltaPart(`part ${call}`)] satisfies LanguageModelStreamPart[]),
        Stream.fail(
          AiError.make({
            module: "Test",
            method: "streamText",
            reason: new AiError.UnknownError({ description: "connection reset" }),
          }),
        ),
      )
    }),
  )

describe("turn lifecycle hooks", () => {
  it.scopedLive("a turn that answers reports neither interrupt nor failure", () =>
    Effect.gen(function* () {
      const watch = yield* makeTurnWatch("@gent/test-turn-after-answered")
      const { client, sessionId, branchId } = yield* createRpcHarness({
        ...e2ePreset,
        providerLayer: answeringProvider(),
        extensionInputs: [...e2ePreset.extensionInputs, watch.extension],
      })

      yield* client.message.send({ sessionId, branchId, content: "answer me" })
      const outcomes = yield* waitFor(
        Ref.get(watch.seen),
        (all) => all.length === 1,
        5_000,
        "turnAfter fired",
      )
      expect(outcomes).toEqual([{ interrupted: false, streamFailed: false }])
    }),
  )

  it.scopedLive("an interrupted turn reports the interrupt", () =>
    Effect.gen(function* () {
      const watch = yield* makeTurnWatch("@gent/test-turn-after-interrupted")
      // The signal provider holds the stream open between parts, so the turn is
      // still running when the interrupt arrives.
      const { layer: providerLayer, controls } = yield* LanguageModelLayers.signal("one. two.")
      const { client, sessionId, branchId } = yield* createRpcHarness({
        ...e2ePreset,
        providerLayer,
        extensionInputs: [...e2ePreset.extensionInputs, watch.extension],
      })

      yield* client.message.send({ sessionId, branchId, content: "answer me" })
      yield* controls.waitForStreamStart.pipe(Effect.timeout("5 seconds"))
      yield* client.steer.command({
        command: {
          _tag: "Interrupt",
          sessionId,
          branchId,
          requestId: "req-lifecycle-interrupt",
        } satisfies SteerCommand,
      })

      const outcomes = yield* waitFor(
        Ref.get(watch.seen),
        (all) => all.length === 1,
        5_000,
        "turnAfter fired",
      )
      expect(outcomes).toEqual([{ interrupted: true, streamFailed: false }])
    }),
  )

  it.scopedLive("a turn whose stream keeps breaking reports the failure once", () =>
    Effect.gen(function* () {
      const watch = yield* makeTurnWatch("@gent/test-turn-after-stream-failed")
      const calls = yield* Ref.make(0)
      const { client, sessionId, branchId } = yield* createRpcHarness({
        ...e2ePreset,
        providerLayer: brokenAfterPartialOutput(calls),
        extensionInputs: [...e2ePreset.extensionInputs, watch.extension],
      })

      yield* client.message.send({ sessionId, branchId, content: "answer me" })
      const outcomes = yield* waitFor(
        Ref.get(watch.seen),
        (all) => all.length === 1,
        10_000,
        "turnAfter fired",
      )

      expect(outcomes).toEqual([{ interrupted: false, streamFailed: true }])
      // Two continuations, then the third partial failure ends the turn.
      expect(yield* Ref.get(calls)).toBe(3)
    }),
  )
})

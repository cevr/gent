import { describe, expect, it } from "effect-bun-test"
import { Effect, Fiber, Option, Stream } from "effect"
import { RequestId } from "@gent/core-internal/domain/ids"
import {
  finishPart,
  LanguageModelLayers,
  textDeltaPart,
} from "@gent/core-internal/test-utils/language-model"
import { createRpcHarness } from "@gent/core-internal/test-utils/rpc-harness"
import { waitFor } from "@gent/core-internal/test-utils/fixtures"
import { e2ePreset } from "../../../extensions/tests/helpers/test-preset"

describe("model context RPC boundary", () => {
  it.scopedLive(
    "settles an oversized turn as a visible failure before provider dispatch",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          let providerCalls = 0
          const providerLayer = LanguageModelLayers.testStream(() => {
            providerCalls += 1
            return Effect.succeed(
              Stream.fromIterable([
                textDeltaPart("recovered"),
                finishPart({ finishReason: "stop" }),
              ]),
            )
          })
          const { client, sessionId, branchId } = yield* createRpcHarness({
            ...e2ePreset,
            providerLayer,
          })
          const errorEventFiber = yield* client.session.events({ sessionId, branchId }).pipe(
            Stream.filter((envelope) => envelope.event._tag === "ErrorOccurred"),
            Stream.runHead,
            Effect.forkScoped,
          )
          const requestId = RequestId.make("model-context-rpc")
          const marker = "rpc-oversized-context-marker"
          const result = yield* Effect.exit(
            client.message.send({
              sessionId,
              branchId,
              content: `${marker} ${"x".repeat(520_000)}`,
              requestId,
            }),
          )

          expect(result._tag).toBe("Failure")
          expect(providerCalls).toBe(0)
          const errorEvent = yield* Fiber.join(errorEventFiber)
          expect(Option.isSome(errorEvent)).toBe(true)
          if (Option.isNone(errorEvent)) return yield* Effect.die("turn error event missing")
          if (errorEvent.value.event._tag !== "ErrorOccurred") {
            return yield* Effect.die("unexpected event in error stream")
          }
          expect(errorEvent.value.event.error).toContain("ModelContextProjectionError")
          const snapshot = yield* waitFor(
            client.session.getSnapshot({ sessionId, branchId }),
            (current) => current.runtime._tag === "Idle",
            5_000,
            "runtime idle after model context failure",
          )
          expect(
            snapshot.messages.some((message) =>
              message.parts.some((part) => part.type === "text" && part.text.includes(marker)),
            ),
          ).toBe(true)

          yield* client.message.send({
            sessionId,
            branchId,
            content: "recover after context failure",
            requestId: RequestId.make("model-context-rpc-recovery"),
          })
          const recovered = yield* waitFor(
            client.session.getSnapshot({ sessionId, branchId }),
            (current) => current.runtime._tag === "Idle",
            5_000,
            "runtime idle after recovery turn",
          )
          expect(providerCalls).toBe(1)
          expect(
            recovered.messages.some((message) =>
              message.parts.some((part) => part.type === "text" && part.text === "recovered"),
            ),
          ).toBe(true)
        }).pipe(Effect.timeout("8 seconds")),
      ),
    12_000,
  )
})

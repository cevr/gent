/**
 * `wake` is an alarm: the model sets it, answers, and goes idle; when it
 * fires, a user-role `wake` message on the same branch starts the next turn.
 */
import { describe, expect, it } from "effect-bun-test"
import { Effect, Exit } from "effect"
import { textStep, toolCallStep } from "@gent/core-internal/test-utils/sequence-steps"
import { LanguageModelLayers } from "@gent/core-internal/test-utils/language-model"
import { createRpcHarness } from "@gent/core-internal/test-utils/rpc-harness"
import { waitFor } from "@gent/core-internal/test-utils/fixtures"
import { e2ePreset } from "../helpers/test-preset"
import { dueAtOf, WAKE_MESSAGE_TYPE, wakeMessage } from "../../src/wake/index.js"

describe("wake", () => {
  it.live("a due time comes from afterSeconds or an ISO time, never both", () =>
    Effect.gen(function* () {
      const now = 1_000_000
      expect(yield* dueAtOf({ afterSeconds: 90 }, now)).toBe(now + 90_000)
      expect(yield* dueAtOf({ at: "1970-01-01T00:20:00.000Z" }, now)).toBe(1_200_000)
      const both = yield* Effect.exit(dueAtOf({ afterSeconds: 1, at: "1970-01-01T00:20:00Z" }, now))
      expect(Exit.isFailure(both)).toBe(true)
      const neither = yield* Effect.exit(dueAtOf({}, now))
      expect(Exit.isFailure(neither)).toBe(true)
      const garbage = yield* Effect.exit(dueAtOf({ at: "tomorrow-ish" }, now))
      expect(Exit.isFailure(garbage)).toBe(true)
      const tooFar = yield* Effect.exit(dueAtOf({ afterSeconds: 25 * 60 * 60 }, now))
      expect(Exit.isFailure(tooFar)).toBe(true)
      expect(wakeMessage({ wakeId: "w1", dueAt: 1_200_000, note: "check CI" })).toBe(
        "Alarm w1 fired at 1970-01-01T00:20:00.000Z. check CI",
      )
    }),
  )

  it.live(
    "an idle session wakes at the alarm with the note as a user message",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
            toolCallStep("wake", { afterSeconds: 0.3, note: "check whether CI is green" }),
            textStep("alarm set, going idle"),
            textStep("woke up and checked CI"),
          ])
          const { client, sessionId, branchId } = yield* createRpcHarness({
            ...e2ePreset,
            providerLayer,
          })
          yield* client.message.send({ sessionId, branchId, content: "wake me when CI is done" })
          const idle = yield* waitFor(
            client.session.getSnapshot({ sessionId, branchId }),
            (current) =>
              current.runtime._tag === "Idle" &&
              current.messages.some(
                (message) =>
                  message.role === "assistant" &&
                  message.parts.some(
                    (part) => part.type === "text" && part.text === "alarm set, going idle",
                  ),
              ),
            5_000,
            "first turn answered",
          )
          expect(
            idle.messages.some((message) => message.metadata?.customType === WAKE_MESSAGE_TYPE),
          ).toBe(false)
          const woken = yield* waitFor(
            client.session.getSnapshot({ sessionId, branchId }),
            (current) =>
              current.runtime._tag === "Idle" &&
              current.messages.some(
                (message) =>
                  message.role === "user" && message.metadata?.customType === WAKE_MESSAGE_TYPE,
              ) &&
              current.messages.some(
                (message) =>
                  message.role === "assistant" &&
                  message.parts.some(
                    (part) => part.type === "text" && part.text === "woke up and checked CI",
                  ),
              ),
            8_000,
            "the alarm queued a wake message and the loop answered it",
          )
          const wake = woken.messages.find(
            (message) => message.metadata?.customType === WAKE_MESSAGE_TYPE,
          )
          expect(
            wake?.parts.some(
              (part) => part.type === "text" && part.text.endsWith("check whether CI is green"),
            ),
          ).toBe(true)
          expect(woken.messages.at(-1)?.role).toBe("assistant")
        }).pipe(Effect.timeout("12 seconds")),
      ),
    15_000,
  )
})

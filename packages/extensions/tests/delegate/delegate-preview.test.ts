/**
 * `AgentRunSucceeded.preview` has two producers: the in-process runner
 * (foreground delegate) and child-completion delivery (background
 * delegate). The agents pane reads both. One clip policy covers both.
 */
import { describe, expect, it } from "effect-bun-test"
import { Effect, Fiber, Option, Stream } from "effect"
import {
  LanguageModelLayers,
  textStep,
  toolCallStep,
} from "@gent/core-internal/test-utils/language-model"
import { createRpcHarness } from "@gent/core-internal/test-utils/rpc-harness"
import { e2ePreset } from "../helpers/test-preset"

const longReply = "p".repeat(300)

const runSucceededPreview = (params: { readonly background: boolean }) =>
  Effect.scoped(
    Effect.gen(function* () {
      const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
        toolCallStep("delegate", {
          todo: "Reply with three hundred characters",
          background: params.background,
        }),
        // The shared step queue serves the child and the parent's continuation
        // in whichever order they call, so every reply is the long one.
        textStep(longReply),
        textStep(longReply),
        textStep(longReply),
      ])
      const { client, sessionId, branchId } = yield* createRpcHarness({
        ...e2ePreset,
        providerLayer,
        subagentRunner: "live",
      })
      const succeededFiber = yield* client.session.events({ sessionId, branchId }).pipe(
        Stream.map((envelope) => envelope.event),
        Stream.filter((event) => event._tag === "AgentRunSucceeded"),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkScoped,
      )
      yield* client.message.send({ sessionId, branchId, content: "delegate this task" })
      const [succeeded] = Array.from(yield* Fiber.join(succeededFiber))
      expect(succeeded?._tag).toBe("AgentRunSucceeded")
      if (succeeded?._tag !== "AgentRunSucceeded") return Option.none<string>()
      return Option.fromUndefinedOr(succeeded.preview)
    }).pipe(Effect.timeout("8 seconds")),
  )

describe("agent run preview", () => {
  it.live(
    "a foreground child's 300-char reply is clipped with a marker",
    () =>
      Effect.gen(function* () {
        const preview = yield* runSucceededPreview({ background: false })
        expect(preview).toEqual(Option.some("p".repeat(200) + "…"))
      }),
    10_000,
  )
  it.live(
    "a background child's 300-char reply is clipped with the same marker",
    () =>
      Effect.gen(function* () {
        const preview = yield* runSucceededPreview({ background: true })
        expect(preview).toEqual(Option.some("p".repeat(200) + "…"))
      }),
    10_000,
  )
})

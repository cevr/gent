import { describe, expect, it } from "effect-bun-test"
import { Effect, Fiber, Stream } from "effect"
import * as Prompt from "effect/unstable/ai/Prompt"
import {
  createRpcHarness,
  LanguageModelLayers,
  testAgent,
  testTurnExtension,
  textStep,
} from "@gent/core/test-utils"
import PromptRulesExtension from "../extensions/prompt-rules.js"

/**
 * Acceptance for the `systemPrompt` hook example: the extension loads
 * through the public entry and its rules reach the model's system prompt.
 */

/** The system text a model call received. */
const systemText = (prompt: Prompt.RawInput): string =>
  [...Prompt.make(prompt).content]
    .filter((message): message is Prompt.SystemMessage => message.role === "system")
    .map((message) => message.content)
    .join("\n")

describe("prompt rules example extension", () => {
  it.scopedLive("its rules reach the system prompt of a turn", () =>
    Effect.gen(function* () {
      const prompts: Array<string> = []
      const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
        {
          ...textStep("ok"),
          assertOptions: (options) => {
            prompts.push(systemText(options.prompt))
          },
        },
      ])
      const { client, sessionId, branchId } = yield* createRpcHarness({
        agents: [testAgent],
        extensionInputs: [testTurnExtension, PromptRulesExtension],
        providerLayer,
      })
      const completed = yield* client.session.events({ sessionId, branchId }).pipe(
        Stream.filter(({ event }) => event._tag === "TurnCompleted"),
        Stream.take(1),
        Stream.runDrain,
        Effect.forkScoped,
      )
      yield* client.message.send({ sessionId, branchId, content: "hi" })
      yield* Fiber.join(completed)
      yield* controls.assertDone
      expect(prompts).toHaveLength(1)
      expect(prompts[0]).toContain("## Project Rules\n- Always write tests for new functions.")
    }).pipe(Effect.timeout("8 seconds")),
  )
})

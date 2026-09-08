/**
 * `/btw` answers from a copy of the branch history and leaves the branch
 * untouched. Follow-ups replay the earlier side turns inside the prompt.
 */
import { describe, expect, it } from "effect-bun-test"
import { Cause, Effect, Exit, Option } from "effect"
import * as Prompt from "effect/unstable/ai/Prompt"
import type { ProviderOptions } from "effect/unstable/ai/LanguageModel"
import { textStep } from "@gent/core-internal/debug/provider"
import { LanguageModelLayers } from "@gent/core-internal/test-utils/language-model"
import { createRpcHarness } from "@gent/core-internal/test-utils/rpc-harness"
import { waitFor } from "@gent/core-internal/test-utils/fixtures"
import { e2ePreset } from "../helpers/test-preset"
import {
  BTW_EXTENSION_ID,
  SIDE_QUESTION_INSTRUCTION,
  sideQuestionPrompt,
} from "../../src/btw/index.js"

const promptTexts = (options: ProviderOptions): ReadonlyArray<string> =>
  [...Prompt.make(options.prompt).content].flatMap((message) => {
    if (message.role === "system") return []
    return message.content
      .filter((part): part is Prompt.TextPart => part.type === "text")
      .map((part) => part.text)
  })

const lastText = (options: ProviderOptions): string =>
  Option.getOrElse(Option.fromUndefinedOr(promptTexts(options).at(-1)), () => "")

describe("side questions", () => {
  it.live("the first prompt carries the instruction and follow-ups replay earlier turns", () =>
    Effect.sync(() => {
      const first = sideQuestionPrompt({ question: "Why?", previous: [] })
      expect(first).toContain(SIDE_QUESTION_INSTRUCTION)
      expect(first).toContain("<side_question>")
      const followUp = sideQuestionPrompt({
        question: "And then?",
        previous: [{ question: "Why?", answer: "Because." }],
      })
      expect(followUp).toContain("Because.")
      expect(followUp.indexOf("Why?")).toBeLessThan(followUp.indexOf("And then?"))
    }),
  )

  it.live(
    "answers from the branch history without adding messages to the branch",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
            textStep("Noted."),
            {
              ...textStep("pelican"),
              assertOptions: (options) => {
                expect(options.tools.map((tool) => tool.name)).toEqual([])
                const texts = promptTexts(options)
                expect(texts.some((text) => text.includes("The codeword is pelican"))).toBe(true)
                expect(lastText(options)).toContain("What is the codeword?")
                expect(lastText(options)).toContain(SIDE_QUESTION_INSTRUCTION)
              },
            },
            {
              ...textStep("seven letters"),
              assertOptions: (options) => {
                const text = lastText(options)
                expect(text).toContain("What is the codeword?")
                expect(text).toContain("pelican")
                expect(text).toContain("How long is it?")
              },
            },
          ])
          const { client, sessionId, branchId } = yield* createRpcHarness({
            ...e2ePreset,
            providerLayer,
            subagentRunner: "live",
          })
          yield* client.message.send({ sessionId, branchId, content: "The codeword is pelican" })
          yield* waitFor(
            client.session.getSnapshot({ sessionId, branchId }),
            (current) => current.runtime._tag === "Idle" && current.messages.length === 2,
            5_000,
            "first turn idle",
          )

          const first = yield* client.extension.request({
            sessionId,
            branchId,
            extensionId: BTW_EXTENSION_ID,
            capabilityId: "btw.ask",
            input: { question: "What is the codeword?", previous: [] },
          })
          expect(first).toEqual({ answer: "pelican" })

          const second = yield* client.extension.request({
            sessionId,
            branchId,
            extensionId: BTW_EXTENSION_ID,
            capabilityId: "btw.ask",
            input: {
              question: "How long is it?",
              previous: [{ question: "What is the codeword?", answer: "pelican" }],
            },
          })
          expect(second).toEqual({ answer: "seven letters" })

          const snapshot = yield* client.session.getSnapshot({ sessionId, branchId })
          expect(snapshot.messages.length).toBe(2)
          yield* controls.assertDone
        }).pipe(Effect.timeout("8 seconds")),
      ),
    10_000,
  )

  it.live("an empty side question is refused before any model call", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([])
        const { client, sessionId, branchId } = yield* createRpcHarness({
          ...e2ePreset,
          providerLayer,
          subagentRunner: "live",
        })
        const exit = yield* Effect.exit(
          client.extension.request({
            sessionId,
            branchId,
            extensionId: BTW_EXTENSION_ID,
            capabilityId: "btw.ask",
            input: { question: "   ", previous: [] },
          }),
        )
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit))
          expect(Cause.pretty(exit.cause)).toContain("Side question is empty")
        expect(yield* controls.callCount).toBe(0)
      }).pipe(Effect.timeout("4 seconds")),
    ),
  )
})

/**
 * `/btw` answers from a copy of the branch history and leaves the branch
 * untouched. Follow-ups replay the earlier side turns inside the prompt.
 */
import { describe, expect, it } from "effect-bun-test"
import { Cause, Effect, Exit, Option, Schema, Stream } from "effect"
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
  SideQuestionProgress,
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

/** Starts the side question and waits for the background run to finish. */
const askAndWait = (params: {
  readonly client: Effect.Success<ReturnType<typeof createRpcHarness>>["client"]
  readonly sessionId: Effect.Success<ReturnType<typeof createRpcHarness>>["sessionId"]
  readonly branchId: Effect.Success<ReturnType<typeof createRpcHarness>>["branchId"]
  readonly question: string
  readonly previous: ReadonlyArray<{ readonly question: string; readonly answer: string }>
}) =>
  Effect.gen(function* () {
    const target = { sessionId: params.sessionId, branchId: params.branchId }
    const started = yield* params.client.extension.request({
      ...target,
      extensionId: BTW_EXTENSION_ID,
      capabilityId: "btw.ask",
      input: { question: params.question, previous: params.previous },
    })
    expect(started).toEqual({ started: true })
    const progress = yield* waitFor(
      params.client.extension
        .request({
          ...target,
          extensionId: BTW_EXTENSION_ID,
          capabilityId: "btw.progress",
          input: {},
        })
        .pipe(Effect.flatMap(Schema.decodeUnknownEffect(SideQuestionProgress))),
      (current) => current.run?.done === true,
      5_000,
      "side question done",
    )
    return Option.fromUndefinedOr(progress.run)
  })

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
              assertRequest: (request) => {
                expect(request.reasoning).toBe("none")
              },
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
          const parentEvents: Array<string> = []
          yield* client.session.events({ sessionId, branchId }).pipe(
            Stream.runForEach((envelope) =>
              Effect.sync(() => parentEvents.push(envelope.event._tag)),
            ),
            Effect.forkScoped,
          )
          yield* client.message.send({ sessionId, branchId, content: "The codeword is pelican" })
          yield* waitFor(
            client.session.getSnapshot({ sessionId, branchId }),
            (current) => current.runtime._tag === "Idle" && current.messages.length === 2,
            5_000,
            "first turn idle",
          )

          const first = yield* askAndWait({
            client,
            sessionId,
            branchId,
            question: "What is the codeword?",
            previous: [],
          })
          expect(Option.map(first, (run) => run.answer)).toEqual(Option.some("pelican"))

          const second = yield* askAndWait({
            client,
            sessionId,
            branchId,
            question: "How long is it?",
            previous: [{ question: "What is the codeword?", answer: "pelican" }],
          })
          expect(Option.map(second, (run) => run.answer)).toEqual(Option.some("seven letters"))

          const snapshot = yield* client.session.getSnapshot({ sessionId, branchId })
          expect(snapshot.messages.length).toBe(2)
          // A private run leaves no child-run provenance on the parent branch.
          expect(parentEvents.filter((tag) => tag.startsWith("AgentRun"))).toEqual([])
          yield* controls.assertDone
        }).pipe(Effect.timeout("8 seconds")),
      ),
    10_000,
  )

  it.live(
    "the answer streams into the progress request while the child is still replying",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer, controls } = yield* LanguageModelLayers.signal(
            "First sentence. Second sentence.",
          )
          const { client, sessionId, branchId } = yield* createRpcHarness({
            ...e2ePreset,
            providerLayer,
            subagentRunner: "live",
          })
          const progress = () =>
            client.extension
              .request({
                sessionId,
                branchId,
                extensionId: BTW_EXTENSION_ID,
                capabilityId: "btw.progress",
                input: {},
              })
              .pipe(Effect.flatMap(Schema.decodeUnknownEffect(SideQuestionProgress)))
          yield* client.message.send({ sessionId, branchId, content: "Hello there" })
          yield* controls.waitForStreamStart
          yield* controls.emitAll
          yield* waitFor(
            client.session.getSnapshot({ sessionId, branchId }),
            (current) => current.runtime._tag === "Idle" && current.messages.length === 2,
            5_000,
            "first turn idle",
          )
          expect(yield* progress()).toEqual({})

          const started = yield* client.extension.request({
            sessionId,
            branchId,
            extensionId: BTW_EXTENSION_ID,
            capabilityId: "btw.ask",
            input: { question: "Say two sentences.", previous: [] },
          })
          expect(started).toEqual({ started: true })
          // A second ask is refused while the first still runs.
          const refused = yield* Effect.exit(
            client.extension.request({
              sessionId,
              branchId,
              extensionId: BTW_EXTENSION_ID,
              capabilityId: "btw.ask",
              input: { question: "Another?", previous: [] },
            }),
          )
          expect(Exit.isFailure(refused)).toBe(true)
          if (Exit.isFailure(refused)) {
            expect(Cause.pretty(refused.cause)).toContain("already in flight")
          }
          // Release one chunk only; progress shows it before the answer exists.
          yield* controls.emitNext
          const partial = yield* waitFor(
            progress(),
            (current) => (current.run?.text.length ?? 0) > 0,
            5_000,
            "first chunk visible",
          )
          expect(partial.run).toEqual({
            question: "Say two sentences.",
            text: "First sentence. ",
            done: false,
          })
          yield* controls.emitAll
          const finished = yield* waitFor(
            progress(),
            (current) => current.run?.done === true,
            5_000,
            "side question done",
          )
          expect(finished.run?.answer).toBe("First sentence. Second sentence. ")
          expect(finished.run?.error).toBeUndefined()
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

import { describe, expect, it } from "effect-bun-test"
import { Cause, Effect, Exit, Layer, Option, Predicate, Schema, Stream } from "effect"
import { LanguageModel } from "effect/unstable/ai"
import * as Prompt from "effect/unstable/ai/Prompt"
import * as AiError from "effect/unstable/ai/AiError"
import { BranchId, MessageId, SessionId } from "@gent/core-internal/domain/ids.js"
import { Message, dateFromMillis } from "@gent/core-internal/domain/message.js"
import { ModelId } from "@gent/core-internal/domain/model.js"
import {
  finishPart,
  LanguageModelLayers,
  textDeltaPart,
} from "@gent/core-internal/test-utils/language-model.js"
import {
  ModelCompactionError,
  ModelContextCompactor,
} from "@gent/core-internal/runtime/model-context-compactor.js"
import { ModelContextBudget } from "@gent/core-internal/runtime/model-context.js"
import {
  compactModelContext,
  MODEL_COMPACTION_OUTPUT_TOKENS,
  ModelContextCompactorLive,
  referencedBindings,
  selectSummarySource,
} from "../../src/compaction/model-compaction.js"
import { RetainedBindings } from "../../src/compaction/tool-contracts.js"

const sessionId = SessionId.make("compaction-session")
const branchId = BranchId.make("compaction-branch")
const modelId = ModelId.make("debug/compaction")

const budget = (contextLimitTokens = 20_000): ModelContextBudget =>
  ModelContextBudget.make({
    contextLimitTokens,
    reservedSystemTokens: 0,
    reservedToolTokens: 0,
    reservedOutputTokens: 64,
  })

const textMessage = (id: string, role: "user" | "assistant", text: string, ordinal: number) =>
  Message.cases.regular.make({
    id: MessageId.make(id),
    sessionId,
    branchId,
    role,
    parts: [Prompt.textPart({ text })],
    createdAt: dateFromMillis(1_000 + ordinal),
  })

const history = (): ReadonlyArray<Message> => [
  textMessage("old-1", "user", "first question", 1),
  textMessage("old-2", "assistant", "first answer about the loader", 2),
  textMessage("old-3", "user", "second question", 3),
  textMessage("old-4", "assistant", "second answer", 4),
]

const failureOf = <A, E>(exit: Exit.Exit<A, E>): Option.Option<E> => {
  if (Exit.isFailure(exit)) return Cause.findErrorOption(exit.cause)
  return Option.none()
}

const promptText = (prompt: Prompt.Prompt): string =>
  prompt.content
    .flatMap((message) => {
      if (Predicate.isString(message.content)) return [message.content]
      return message.content
        .filter((part): part is Prompt.TextPart => part.type === "text")
        .map((part) => part.text)
    })
    .join("\n")

const summaryProvider = (text: string, capture?: (prompt: Prompt.Prompt) => void) =>
  LanguageModelLayers.testStream((options) => {
    if (Predicate.isNotUndefined(capture)) capture(Prompt.make(options.prompt))
    return Effect.succeed(
      Stream.fromIterable([
        textDeltaPart(text),
        finishPart({ finishReason: "stop", usage: { inputTokens: 120, outputTokens: 8 } }),
      ]),
    )
  })

const compact = (
  params: {
    readonly history?: ReadonlyArray<Message>
    readonly budget?: ModelContextBudget
    readonly instructions?: string
    readonly retainedBindings?: ReadonlyArray<string>
  } = {},
) =>
  Effect.gen(function* () {
    const model = yield* LanguageModel.LanguageModel
    return yield* compactModelContext({
      modelId,
      sessionId,
      branchId,
      history: params.history ?? history(),
      budget: params.budget ?? budget(),
      instructions: params.instructions,
      retainedBindings: params.retainedBindings ?? [],
      summaryModel: Effect.succeed(model),
    })
  })

describe("context handoff", () => {
  it.scopedLive("the notice names the session, the id range, and carries the summary", () => {
    let captured = Option.none<Prompt.Prompt>()
    return Effect.gen(function* () {
      const result = yield* compact()
      expect(result.modelId).toBe(modelId)
      expect(result.usage).toEqual({ inputTokens: 120, outputTokens: 8 })
      expect(result.notice).toContain(`Session ${sessionId}, branch ${branchId}`)
      expect(result.notice).toContain("old-1 … old-4 (4)")
      expect(result.notice).toContain("context.history")
      expect(result.notice).toContain("context.read")
      expect(result.notice).toContain("Summary:\nthe whole story")
      expect(result.notice).not.toContain("were not summarized")
      const prompt = Option.getOrThrow(captured)
      expect(promptText(prompt)).toContain("assistant (old-2): first answer about the loader")
      expect(promptText(prompt)).toContain("Conversation so far")
    }).pipe(
      Effect.provide(
        summaryProvider("the whole story", (prompt) => {
          captured = Option.some(prompt)
        }),
      ),
      Effect.timeout("10 seconds"),
    )
  })

  it.scopedLive("instructions reach the system prompt; retained names reach both", () => {
    let system = Option.none<string>()
    let user = ""
    return Effect.gen(function* () {
      const result = yield* compact({
        instructions: "keep the loader decisions",
        retainedBindings: ["rows", "index"],
      })
      expect(Option.getOrElse(system, () => "")).toContain("keep the loader decisions")
      expect(user).toContain("Names retained on this branch: rows, index")
      expect(result.notice).toContain("Names still bound on this branch: rows, index.")
    }).pipe(
      Effect.provide(
        LanguageModelLayers.testStream((options) => {
          const prompt = Prompt.make(options.prompt)
          system = Option.fromNullishOr(prompt.content[0]).pipe(
            Option.filter((message) => message.role === "system"),
            Option.map((message) => String(message.content)),
          )
          user = promptText(prompt)
          return Effect.succeed(
            Stream.fromIterable([textDeltaPart("focused"), finishPart({ finishReason: "stop" })]),
          )
        }),
      ),
      Effect.timeout("10 seconds"),
    )
  })

  it.effect("only names the kept window still uses reach the bindings note", () =>
    Effect.sync(() => {
      const kept = [
        textMessage("new-1", "user", "now join rows with the $index and print total", 5),
        textMessage("new-2", "assistant", "rows.length is 40; indexed = rows.map(r => r.id)", 6),
      ]
      const retained = ["rows", "index", "$index", "total", "r", "indexed", "a.b"]
      expect(referencedBindings(retained, kept)).toEqual([
        "rows",
        "$index",
        "total",
        "r",
        "indexed",
      ])
      expect(referencedBindings(retained, [])).toEqual([])
      expect(referencedBindings([], kept)).toEqual([])
    }),
  )

  it.scopedLive(
    "the compactor lists retained names, then keeps the ones the window references",
    () => {
      let user = ""
      const retained = Layer.succeed(
        RetainedBindings,
        RetainedBindings.of({ list: () => Effect.succeed(["rows", "index", "scratch"]) }),
      )
      return Effect.gen(function* () {
        const model = yield* LanguageModel.LanguageModel
        const compactor = yield* ModelContextCompactor
        const result = yield* compactor.compact({
          modelId,
          sessionId,
          branchId,
          history: history(),
          kept: [textMessage("new-1", "user", "count rows and print index", 5)],
          budget: budget(),
          summaryModel: () => Effect.succeed(model),
        })
        expect(user).toContain("Names retained on this branch: rows, index.")
        expect(user).not.toContain("scratch")
        expect(result.notice).toContain("Names still bound on this branch: rows, index.")
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.provideMerge(ModelContextCompactorLive, retained),
            summaryProvider("focused", (prompt) => {
              user = promptText(prompt)
            }),
          ),
        ),
        Effect.timeout("10 seconds"),
      )
    },
  )

  it.effect("the summary input is the newest run that fits; what falls before is named", () =>
    Effect.sync(() => {
      const long = [
        textMessage("old-1", "assistant", "a".repeat(1_800), 1),
        textMessage("old-2", "assistant", "b".repeat(1_800), 2),
      ]
      const source = selectSummarySource(long, 600, [])
      expect(source.map((message) => message.id)).toEqual([MessageId.make("old-2")])
      expect(selectSummarySource(long, 100, [])).toEqual([])
      expect(selectSummarySource(long, 10_000, []).length).toBe(2)
    }),
  )

  it.scopedLive("one oversized message is clipped so the older turns still get summarized", () => {
    let user = ""
    return Effect.gen(function* () {
      const result = yield* compact({
        history: [
          textMessage("old-1", "assistant", "the loader decision", 1),
          textMessage("old-2", "assistant", "x".repeat(40_000), 2),
        ],
        budget: budget(4_000),
      })
      expect(result.notice).not.toContain("were not summarized")
      expect(user).toContain("assistant (old-1): the loader decision")
      expect(user).toContain("more characters; read the message by id")
      expect(user.length).toBeLessThan(10_000)
    }).pipe(
      Effect.provide(
        summaryProvider("clipped", (prompt) => {
          user = promptText(prompt)
        }),
      ),
      Effect.timeout("10 seconds"),
    )
  })

  it.scopedLive("a history too large for any summary fails without a model call", () => {
    let calls = 0
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        compact({
          history: [textMessage("old-1", "assistant", "a".repeat(200_000), 1)],
          budget: budget(1_600),
        }),
      )
      const failure = failureOf(exit)
      expect(Option.map(failure, (error) => error.reason)).toEqual(Option.some("SourceTooLarge"))
      expect(calls).toBe(0)
    }).pipe(
      Effect.provide(
        LanguageModelLayers.testStream(() => {
          calls += 1
          return Effect.succeed(Stream.fromIterable([finishPart({ finishReason: "stop" })]))
        }),
      ),
      Effect.timeout("10 seconds"),
    )
  })

  it.scopedLive("an unsummarized prefix is named in the notice", () =>
    Effect.gen(function* () {
      const result = yield* compact({
        history: [
          textMessage("old-1", "assistant", "a".repeat(6_000), 1),
          textMessage("old-2", "assistant", "b".repeat(1_000), 2),
        ],
        budget: budget(1_700),
      })
      expect(result.notice).toContain("old-1 … old-2 (2)")
      expect(result.notice).toContain(
        "The summary covers old-2 onward; the 1 earlier messages from old-1 were not summarized",
      )
    }).pipe(Effect.provide(summaryProvider("tail only")), Effect.timeout("10 seconds")),
  )

  it.scopedLive("an empty, oversized, or failed summary is a compaction error", () => {
    const attempt = (layer: Layer.Layer<LanguageModel.LanguageModel>) =>
      Effect.exit(compact()).pipe(Effect.provide(layer), Effect.map(failureOf))
    return Effect.gen(function* () {
      const empty = yield* attempt(summaryProvider("   "))
      expect(Option.map(empty, (error) => error.reason)).toEqual(Option.some("SummaryEmpty"))

      const oversize = yield* attempt(
        summaryProvider("x".repeat((MODEL_COMPACTION_OUTPUT_TOKENS + 10) * 4)),
      )
      expect(Option.map(oversize, (error) => error.reason)).toEqual(Option.some("SummaryOversize"))

      const failed = yield* attempt(
        LanguageModelLayers.testStream(() =>
          Effect.succeed(
            Stream.fail(
              AiError.make({
                module: "ModelCompactionTest",
                method: "streamText",
                reason: new AiError.UnknownError({ description: "summary failed" }),
              }),
            ),
          ),
        ),
      )
      expect(Option.map(failed, (error) => error.reason)).toEqual(
        Option.some("SummaryGenerationFailed: ModelCompactionTest.streamText: summary failed"),
      )
      for (const failure of [empty, oversize, failed]) {
        expect(Option.map(failure, Schema.is(ModelCompactionError))).toEqual(Option.some(true))
      }
    }).pipe(Effect.timeout("10 seconds"))
  })
})

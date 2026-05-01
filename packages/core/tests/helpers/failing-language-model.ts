import { Effect, Stream } from "effect"
import type { LanguageModel } from "effect/unstable/ai"
import * as AiError from "effect/unstable/ai/AiError"

export interface TestLanguageModelOptions {
  readonly disableToolCallResolution?: boolean
  readonly toolkit?: unknown
  readonly prompt?: unknown
}

export interface TestLanguageModelOverrides<Options extends TestLanguageModelOptions> {
  readonly generateText?: (options: Options) => Effect.Effect<unknown, unknown>
  readonly generateObject?: (options: Options) => Effect.Effect<unknown, unknown>
  readonly streamText?: (options: Options) => Stream.Stream<unknown, unknown>
}

const fail = (method: string) =>
  AiError.make({
    module: "Test",
    method,
    reason: new AiError.UnknownError({ description: "stub" }),
  })

const baseLanguageModel: TestLanguageModelOverrides<TestLanguageModelOptions> = {
  generateText: () => Effect.fail(fail("generateText")),
  generateObject: () => Effect.fail(fail("generateObject")),
  streamText: () => Stream.fail(fail("streamText")),
}

// Effect AI models expose overloaded methods. Tests only need one concrete
// call shape, so keep the overload adaptation quarantined in this helper.
export const makeLanguageModel = <
  Options extends TestLanguageModelOptions = TestLanguageModelOptions,
>(
  overrides: TestLanguageModelOverrides<Options> = {},
): LanguageModel.Service =>
  ({
    ...baseLanguageModel,
    ...overrides,
  }) as unknown as LanguageModel.Service

export const failingLanguageModel: LanguageModel.Service = makeLanguageModel()

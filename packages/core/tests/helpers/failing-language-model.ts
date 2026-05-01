import { Effect, Stream } from "effect"
import type { LanguageModel } from "effect/unstable/ai"
import * as AiError from "effect/unstable/ai/AiError"

export const failingLanguageModel: LanguageModel.Service = {
  generateText: (() =>
    Effect.fail(
      AiError.make({
        module: "Test",
        method: "generateText",
        reason: new AiError.UnknownError({ description: "stub" }),
      }),
    )) as never,
  generateObject: (() =>
    Effect.fail(
      AiError.make({
        module: "Test",
        method: "generateObject",
        reason: new AiError.UnknownError({ description: "stub" }),
      }),
    )) as never,
  streamText: (() =>
    Stream.fail(
      AiError.make({
        module: "Test",
        method: "streamText",
        reason: new AiError.UnknownError({ description: "stub" }),
      }),
    )) as never,
}

import { Duration, Effect, Layer, Stream } from "effect"
import {
  FinishChunk,
  Provider,
  ProviderError,
  TextChunk,
  type GenerateRequest,
  type ProviderRequest,
} from "../providers/provider.js"
import type { Message, TextPart } from "../domain/message.js"

const extractLatestUserText = (messages: ReadonlyArray<Message>): string => {
  const latest = [...messages].reverse().find((message) => message.role === "user")
  if (latest === undefined) return ""
  return latest.parts
    .filter((part): part is TextPart => part.type === "text")
    .map((part) => part.text)
    .join("\n")
}

const retryBudgetFor = (text: string): number => {
  if (text.trim().length === 0) return 0
  const hash = [...text].reduce((total, ch) => total + ch.charCodeAt(0), 0)
  if (hash % 3 === 0) return 2
  if (hash % 2 === 0) return 1
  return 0
}

const buildReply = (request: ProviderRequest, latestUserText: string): string => {
  const lineCount = latestUserText.split("\n").filter((line) => line.trim().length > 0).length
  const modelLabel = request.model.startsWith("openai/") ? "deepwork" : "cowork"

  if (lineCount > 1) {
    return [
      `${modelLabel} processed a merged queued turn.`,
      `Received ${lineCount} lines in one message block.`,
      `Tail: ${latestUserText.split("\n").at(-1) ?? latestUserText}`,
    ].join(" ")
  }

  return [
    `${modelLabel} debug response.`,
    `Latest user message: ${latestUserText || "(empty)"}.`,
    "This turn is flowing through the real agent loop with a scripted provider.",
  ].join(" ")
}

const makeReplyStream = (latestUserText: string, reply: string, delayMs = 0) => {
  const chunks = reply.split(/(?<=[.!?])\s+/).filter((chunk) => chunk.length > 0)
  const stream = Stream.fromIterable([
    ...chunks.map((text) => new TextChunk({ text: `${text} ` })),
    new FinishChunk({
      finishReason: "stop",
      usage: {
        inputTokens: Math.max(1, Math.ceil(latestUserText.length / 4)),
        outputTokens: Math.max(1, Math.ceil(reply.length / 4)),
      },
    }),
  ])

  if (delayMs <= 0) return stream

  return stream.pipe(
    Stream.flatMap((chunk) =>
      Stream.fromEffect(Effect.sleep(Duration.millis(delayMs)).pipe(Effect.as(chunk))),
    ),
  )
}

export const DebugProvider = Layer.effect(
  Provider,
  Effect.sync(() => {
    const attempts = new Map<string, number>()

    const stream = (request: ProviderRequest) => {
      const latestUserText = extractLatestUserText(request.messages)
      const key = `${request.model}:${latestUserText}`
      const seen = attempts.get(key) ?? 0
      const retryBudget = retryBudgetFor(latestUserText)

      if (seen < retryBudget) {
        attempts.set(key, seen + 1)
        return Effect.fail(
          new ProviderError({
            message: "Rate limit exceeded (429)",
            model: request.model,
          }),
        )
      }

      attempts.delete(key)
      const reply = buildReply(request, latestUserText)
      return Effect.succeed(makeReplyStream(latestUserText, reply))
    }

    const generate = (_request: GenerateRequest) => Effect.succeed("debug scenario")

    return {
      stream,
      generate,
    }
  }),
)

export const DebugFailingProvider = Layer.succeed(Provider, {
  stream: (request) =>
    Effect.fail(
      new ProviderError({
        message: "provider exploded",
        model: request.model,
      }),
    ),
  generate: () => Effect.succeed("debug failure"),
})

export const DebugSlowProvider = Layer.succeed(Provider, {
  stream: (request) => {
    const latestUserText = extractLatestUserText(request.messages)
    const reply = buildReply(request, latestUserText)
    return Effect.succeed(makeReplyStream(latestUserText, reply, 150))
  },
  generate: () => Effect.succeed("debug slow"),
})

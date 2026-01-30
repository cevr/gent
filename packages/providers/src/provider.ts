import { Context, Effect, Layer, Schema, Stream, JSONSchema } from "effect"
import type { Message, AnyToolDefinition, TextPart, ToolResultPart } from "@gent/core"
import {
  streamText,
  generateText,
  tool,
  jsonSchema,
  type ToolSet,
  type ModelMessage,
  type ToolModelMessage,
  type ToolResultPart as AIToolResultPart,
} from "ai"
import { ProviderFactory } from "./provider-factory"

type StreamTextResult = ReturnType<typeof streamText>
type FullStreamPart = StreamTextResult extends { fullStream: AsyncIterable<infer A> } ? A : never

// Provider Error

export class ProviderError extends Schema.TaggedError<ProviderError>()("ProviderError", {
  message: Schema.String,
  model: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

// Stream Chunk Types

export class TextChunk extends Schema.TaggedClass<TextChunk>()("TextChunk", {
  text: Schema.String,
}) {}

export class ToolCallChunk extends Schema.TaggedClass<ToolCallChunk>()("ToolCallChunk", {
  toolCallId: Schema.String,
  toolName: Schema.String,
  input: Schema.Unknown,
}) {}

export class ReasoningChunk extends Schema.TaggedClass<ReasoningChunk>()("ReasoningChunk", {
  text: Schema.String,
}) {}

export class FinishChunk extends Schema.TaggedClass<FinishChunk>()("FinishChunk", {
  finishReason: Schema.String,
  usage: Schema.optional(
    Schema.Struct({
      inputTokens: Schema.Number,
      outputTokens: Schema.Number,
    }),
  ),
}) {}

export const StreamChunk = Schema.Union(TextChunk, ToolCallChunk, ReasoningChunk, FinishChunk)
export type StreamChunk = typeof StreamChunk.Type

// Provider Request

export interface ProviderRequest {
  readonly model: string
  readonly messages: ReadonlyArray<Message>
  readonly tools?: ReadonlyArray<AnyToolDefinition>
  readonly systemPrompt?: string
  readonly maxTokens?: number
  readonly temperature?: number
}

// Simple generate request (no tools, no streaming)

export interface GenerateRequest {
  readonly model: string
  readonly prompt: string
  readonly systemPrompt?: string
  readonly maxTokens?: number
}

// Provider Service

export interface ProviderService {
  readonly stream: (
    request: ProviderRequest,
  ) => Effect.Effect<Stream.Stream<StreamChunk, ProviderError>, ProviderError>

  readonly generate: (request: GenerateRequest) => Effect.Effect<string, ProviderError>
}

export class Provider extends Context.Tag("@gent/providers/src/provider")<
  Provider,
  ProviderService
>() {
  static Live: Layer.Layer<Provider, never, ProviderFactory> = Layer.effect(
    Provider,
    Effect.gen(function* () {
      const factory = yield* ProviderFactory

      return {
        stream: Effect.fn("Provider.stream")(function* (request: ProviderRequest) {
          const model = yield* factory.getModel(request.model)

          const messages = convertMessages(request.messages)
          const tools = request.tools !== undefined ? convertTools(request.tools) : undefined

          const opts: Parameters<typeof streamText>[0] = {
            model,
            messages,
          }
          if (tools !== undefined) opts.tools = tools
          if (request.systemPrompt !== undefined && request.systemPrompt !== "") {
            opts.system = request.systemPrompt
          }
          if (request.maxTokens !== undefined) {
            opts.maxOutputTokens = request.maxTokens
          }
          if (request.temperature !== undefined) {
            opts.temperature = request.temperature
          }

          const result = yield* Effect.try({
            try: () => streamText(opts),
            catch: (e) =>
              new ProviderError({
                message: `Stream failed: ${e}`,
                model: request.model,
                cause: e,
              }),
          })

          const toChunk = (
            part: FullStreamPart,
          ): Effect.Effect<StreamChunk | null, ProviderError> => {
            switch (part.type) {
              case "text-delta":
                return Effect.succeed<StreamChunk>(new TextChunk({ text: part.text }))
              case "tool-call":
                return Effect.succeed<StreamChunk>(
                  new ToolCallChunk({
                    toolCallId: part.toolCallId,
                    toolName: part.toolName,
                    input: part.input,
                  }),
                )
              case "reasoning-delta":
                return Effect.succeed<StreamChunk>(new ReasoningChunk({ text: part.text }))
              case "finish":
                return Effect.succeed<StreamChunk>(
                  new FinishChunk({
                    finishReason: part.finishReason ?? "stop",
                    usage:
                      part.totalUsage !== undefined
                        ? {
                            inputTokens: part.totalUsage.inputTokens ?? 0,
                            outputTokens: part.totalUsage.outputTokens ?? 0,
                          }
                        : undefined,
                  }),
                )
              case "error": {
                const err = part.error as Error
                return Effect.fail(
                  new ProviderError({
                    message: `API error: ${err?.message ?? String(part.error)}`,
                    model: request.model,
                    cause: part.error,
                  }),
                )
              }
              default:
                return Effect.succeed(null)
            }
          }

          return Stream.fromAsyncIterable<FullStreamPart, ProviderError>(
            result.fullStream,
            (e) =>
              new ProviderError({
                message: `Stream failed: ${e}`,
                model: request.model,
                cause: e,
              }),
          ).pipe(
            Stream.mapEffect(toChunk),
            Stream.filter((chunk): chunk is StreamChunk => chunk !== null),
          )
        }),

        generate: Effect.fn("Provider.generate")(function* (request: GenerateRequest) {
          const model = yield* factory.getModel(request.model)

          const opts: Parameters<typeof generateText>[0] = {
            model,
            prompt: request.prompt,
          }
          if (request.systemPrompt !== undefined && request.systemPrompt !== "") {
            opts.system = request.systemPrompt
          }
          if (request.maxTokens !== undefined) opts.maxOutputTokens = request.maxTokens

          const result = yield* Effect.tryPromise({
            try: () => generateText(opts),
            catch: (e) =>
              new ProviderError({
                message: `Generate failed: ${e}`,
                model: request.model,
                cause: e,
              }),
          })

          return result.text
        }),
      }
    }),
  )

  static Test = (responses: ReadonlyArray<ReadonlyArray<StreamChunk>>): Layer.Layer<Provider> => {
    let index = 0
    return Layer.succeed(Provider, {
      stream: () =>
        Effect.succeed(
          Stream.fromIterable(responses[index++] ?? [new FinishChunk({ finishReason: "stop" })]),
        ),
      generate: () => Effect.succeed("test response"),
    })
  }
}

// Convert our Messages to AI SDK ModelMessages
// Since our types now match AI SDK's shape, this is mostly direct mapping
function convertMessages(messages: ReadonlyArray<Message>): ModelMessage[] {
  const result: ModelMessage[] = []

  for (const msg of messages) {
    const parts = msg.parts

    if (msg.role === "system") {
      const textParts = parts.filter((p): p is TextPart => p.type === "text")
      if (textParts.length > 0) {
        result.push({
          role: "system",
          content: textParts.map((p) => p.text).join("\n"),
        })
      }
      continue
    }

    if (msg.role === "tool") {
      const toolResults = parts.filter((p): p is ToolResultPart => p.type === "tool-result")
      if (toolResults.length > 0) {
        const toolMessage: ToolModelMessage = {
          role: "tool",
          content: toolResults.map(
            (p): AIToolResultPart => ({
              type: "tool-result",
              toolCallId: p.toolCallId,
              toolName: p.toolName,
              // AI SDK v6 ToolResultOutput - cast to match expected type
              output: (p.output.type === "json"
                ? { type: "json" as const, value: p.output.value }
                : {
                    type: "error-json" as const,
                    value: p.output.value,
                  }) as AIToolResultPart["output"],
            }),
          ),
        }
        result.push(toolMessage)
      }
      continue
    }

    if (msg.role === "user") {
      const content: Array<{ type: "text"; text: string } | { type: "image"; image: string }> = []

      for (const part of parts) {
        if (part.type === "text") {
          content.push({ type: "text", text: part.text })
        } else if (part.type === "image") {
          content.push({ type: "image", image: part.image })
        }
      }

      if (content.length > 0) {
        result.push({ role: "user", content })
      }
      continue
    }

    if (msg.role === "assistant") {
      const content: Array<
        | { type: "text"; text: string }
        | { type: "tool-call"; toolCallId: string; toolName: string; input: unknown }
      > = []

      for (const part of parts) {
        if (part.type === "text") {
          content.push({ type: "text", text: part.text })
        } else if (part.type === "tool-call") {
          content.push({
            type: "tool-call",
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            input: part.input,
          })
        }
      }

      if (content.length > 0) {
        result.push({ role: "assistant", content })
      }
    }
  }

  return result
}

const toolCache = new WeakMap<AnyToolDefinition, ToolSet[string]>()

function convertTools(tools: ReadonlyArray<AnyToolDefinition>): ToolSet {
  const result: ToolSet = {}

  for (const t of tools) {
    const cached = toolCache.get(t)
    if (cached !== undefined) {
      result[t.name] = cached
      continue
    }
    const effectJsonSchema = JSONSchema.make(t.params as Schema.Schema<unknown, unknown, never>)
    const wrapped = tool({
      description: t.description,
      inputSchema: jsonSchema(effectJsonSchema),
    }) as ToolSet[string]
    toolCache.set(t, wrapped)
    result[t.name] = wrapped
  }

  return result
}

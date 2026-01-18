import { Context, Effect, Layer, Schema, Stream } from "effect"
import type { Message, ToolDefinition } from "@gent/core"
import { streamText, type CoreMessage, type CoreTool } from "ai"
import { createAnthropic } from "@ai-sdk/anthropic"
import { createOpenAI } from "@ai-sdk/openai"

// Provider Error

export class ProviderError extends Schema.TaggedError<ProviderError>()(
  "ProviderError",
  {
    message: Schema.String,
    model: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  }
) {}

// Stream Chunk Types

export class TextChunk extends Schema.TaggedClass<TextChunk>()("TextChunk", {
  text: Schema.String,
}) {}

export class ToolCallChunk extends Schema.TaggedClass<ToolCallChunk>()(
  "ToolCallChunk",
  {
    toolCallId: Schema.String,
    toolName: Schema.String,
    args: Schema.Unknown,
  }
) {}

export class ReasoningChunk extends Schema.TaggedClass<ReasoningChunk>()(
  "ReasoningChunk",
  {
    text: Schema.String,
  }
) {}

export class FinishChunk extends Schema.TaggedClass<FinishChunk>()(
  "FinishChunk",
  {
    finishReason: Schema.String,
    usage: Schema.optional(
      Schema.Struct({
        promptTokens: Schema.Number,
        completionTokens: Schema.Number,
      })
    ),
  }
) {}

export const StreamChunk = Schema.Union(
  TextChunk,
  ToolCallChunk,
  ReasoningChunk,
  FinishChunk
)
export type StreamChunk = typeof StreamChunk.Type

// Provider Request

export interface ProviderRequest {
  readonly model: string
  readonly messages: ReadonlyArray<Message>
  readonly tools?: ReadonlyArray<ToolDefinition>
  readonly systemPrompt?: string
  readonly maxTokens?: number
  readonly temperature?: number
}

// Provider Service

export interface ProviderService {
  readonly stream: (
    request: ProviderRequest
  ) => Effect.Effect<Stream.Stream<StreamChunk, ProviderError>, ProviderError>
}

export class Provider extends Context.Tag("Provider")<
  Provider,
  ProviderService
>() {
  static Live: Layer.Layer<Provider> = Layer.succeed(Provider, {
    stream: Effect.fn("Provider.stream")(function* (request: ProviderRequest) {
      const [providerName, modelName] = parseModelId(request.model)
      const provider = getProvider(providerName)

      if (!provider) {
        return yield* new ProviderError({
          message: `Unknown provider: ${providerName}`,
          model: request.model,
        })
      }

      const messages = convertMessages(request.messages)
      const tools = request.tools ? convertTools(request.tools) : undefined

      return Stream.async<StreamChunk, ProviderError>((emit) => {
        ;(async () => {
          try {
            const opts: Parameters<typeof streamText>[0] = {
              model: provider(modelName),
              messages,
            }
            if (tools) opts.tools = tools
            if (request.systemPrompt) opts.system = request.systemPrompt
            if (request.maxTokens) opts.maxTokens = request.maxTokens
            if (request.temperature) opts.temperature = request.temperature

            const result = streamText(opts)

            for await (const part of result.fullStream) {
              switch (part.type) {
                case "text-delta":
                  emit.single(new TextChunk({ text: part.textDelta }))
                  break
                case "tool-call":
                  emit.single(
                    new ToolCallChunk({
                      toolCallId: part.toolCallId,
                      toolName: part.toolName,
                      args: part.args,
                    })
                  )
                  break
                case "reasoning":
                  emit.single(new ReasoningChunk({ text: part.textDelta }))
                  break
                case "finish":
                  emit.single(
                    new FinishChunk({
                      finishReason: part.finishReason ?? "stop",
                      usage: part.usage
                        ? {
                            promptTokens: part.usage.promptTokens,
                            completionTokens: part.usage.completionTokens,
                          }
                        : undefined,
                    })
                  )
                  break
              }
            }
            emit.end()
          } catch (e) {
            emit.fail(
              new ProviderError({
                message: `Stream failed: ${e}`,
                model: request.model,
                cause: e,
              })
            )
          }
        })()
      })
    }),
  })

  static Test = (
    responses: ReadonlyArray<ReadonlyArray<StreamChunk>>
  ): Layer.Layer<Provider> => {
    let index = 0
    return Layer.succeed(Provider, {
      stream: () =>
        Effect.succeed(
          Stream.fromIterable(
            responses[index++] ?? [new FinishChunk({ finishReason: "stop" })]
          )
        ),
    })
  }
}

// Helpers

function parseModelId(modelId: string): [string, string] {
  const slash = modelId.indexOf("/")
  if (slash === -1) {
    return ["anthropic", modelId]
  }
  return [modelId.slice(0, slash), modelId.slice(slash + 1)]
}

function getProvider(name: string) {
  switch (name) {
    case "anthropic":
      return createAnthropic()
    case "openai":
      return createOpenAI()
    default:
      return undefined
  }
}

function convertMessages(messages: ReadonlyArray<Message>): CoreMessage[] {
  const result: CoreMessage[] = []

  for (const msg of messages) {
    const parts = msg.parts

    if (msg.role === "system") {
      const textParts = parts.filter((p) => p._tag === "TextPart")
      if (textParts.length > 0) {
        result.push({
          role: "system",
          content: textParts.map((p) => (p as any).text).join("\n"),
        })
      }
      continue
    }

    if (msg.role === "user") {
      // Check for tool results first
      const toolResults = parts.filter((p) => p._tag === "ToolResultPart")
      if (toolResults.length > 0) {
        for (const part of toolResults) {
          result.push({
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: (part as any).toolCallId,
                toolName: (part as any).toolName,
                result: (part as any).result,
                isError: (part as any).isError,
              },
            ],
          })
        }
        continue
      }

      const content: Array<
        { type: "text"; text: string } | { type: "image"; image: string }
      > = []
      for (const part of parts) {
        if (part._tag === "TextPart") {
          content.push({ type: "text", text: (part as any).text })
        } else if (part._tag === "ImagePart") {
          content.push({ type: "image", image: (part as any).url })
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
        | {
            type: "tool-call"
            toolCallId: string
            toolName: string
            args: unknown
          }
      > = []

      for (const part of parts) {
        if (part._tag === "TextPart") {
          content.push({ type: "text", text: (part as any).text })
        } else if (part._tag === "ToolCallPart") {
          content.push({
            type: "tool-call",
            toolCallId: (part as any).toolCallId,
            toolName: (part as any).toolName,
            args: (part as any).args,
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

function convertTools(
  tools: ReadonlyArray<ToolDefinition>
): Record<string, CoreTool> {
  const result: Record<string, CoreTool> = {}

  for (const tool of tools) {
    result[tool.name] = {
      description: tool.description,
      parameters: tool.params as any,
    }
  }

  return result
}

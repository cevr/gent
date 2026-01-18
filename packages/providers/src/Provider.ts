import { Context, Effect, Layer, Schema, Stream, JSONSchema } from "effect"
import type { Message, ToolDefinition } from "@gent/core"
import { TextPart, ToolCallPart, ToolResultPart, ImagePart } from "@gent/core"
import { streamText, tool, jsonSchema, type ToolSet, type ModelMessage, type ToolModelMessage, type ToolResultPart as AIToolResultPart } from "ai"
import { createAnthropic } from "@ai-sdk/anthropic"
import { createOpenAI } from "@ai-sdk/openai"
import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock"
import { fromIni } from "@aws-sdk/credential-providers"

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
    input: Schema.Unknown,
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
        inputTokens: Schema.Number,
        outputTokens: Schema.Number,
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
        // eslint-disable-next-line @typescript-eslint/no-floating-promises -- intentional fire-and-forget async IIFE for Stream.async
        ;(async () => {
          try {
            const opts: Parameters<typeof streamText>[0] = {
              model: provider(modelName),
              messages,
            }
            if (tools) opts.tools = tools
            if (request.systemPrompt) opts.system = request.systemPrompt
            if (request.maxTokens) opts.maxOutputTokens = request.maxTokens
            if (request.temperature) opts.temperature = request.temperature

            const result = streamText(opts)

            for await (const part of result.fullStream) {
              switch (part.type) {
                case "text-delta":
                  await emit.single(new TextChunk({ text: part.text }))
                  break
                case "tool-call":
                  await emit.single(
                    new ToolCallChunk({
                      toolCallId: part.toolCallId,
                      toolName: part.toolName,
                      input: part.input,
                    })
                  )
                  break
                case "reasoning-delta":
                  await emit.single(new ReasoningChunk({ text: part.text }))
                  break
                case "finish":
                  await emit.single(
                    new FinishChunk({
                      finishReason: part.finishReason ?? "stop",
                      usage: part.totalUsage
                        ? {
                            inputTokens: part.totalUsage.inputTokens ?? 0,
                            outputTokens: part.totalUsage.outputTokens ?? 0,
                          }
                        : undefined,
                    })
                  )
                  break
                case "error":
                  const err = part.error as Error
                  await emit.fail(
                    new ProviderError({
                      message: `API error: ${err?.message ?? String(part.error)}`,
                      model: request.model,
                      cause: part.error,
                    })
                  )
                  return
              }
            }
            await emit.end()
          } catch (e) {
            await emit.fail(
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
    case "bedrock":
      return createAmazonBedrock({
        region: process.env["AWS_REGION"] ?? "us-east-1",
        credentialProvider: async () => {
          const creds = await fromIni()()
          return {
            accessKeyId: creds.accessKeyId,
            secretAccessKey: creds.secretAccessKey,
            ...(creds.sessionToken && { sessionToken: creds.sessionToken }),
          }
        },
      })
    default:
      return undefined
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
          content: toolResults.map((p): AIToolResultPart => ({
            type: "tool-result",
            toolCallId: p.toolCallId,
            toolName: p.toolName,
            // AI SDK v6 ToolResultOutput - cast to match expected type
            output: (p.output.type === "json"
              ? { type: "json" as const, value: p.output.value }
              : { type: "error-json" as const, value: p.output.value }) as AIToolResultPart["output"],
          })),
        }
        result.push(toolMessage)
      }
      continue
    }

    if (msg.role === "user") {
      const content: Array<{ type: "text"; text: string } | { type: "image"; image: string }> = []

      for (const part of parts) {
        if (part.type === "text") {
          content.push({ type: "text", text: (part as TextPart).text })
        } else if (part.type === "image") {
          content.push({ type: "image", image: (part as ImagePart).image })
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
          content.push({ type: "text", text: (part as TextPart).text })
        } else if (part.type === "tool-call") {
          const tc = part as ToolCallPart
          content.push({
            type: "tool-call",
            toolCallId: tc.toolCallId,
            toolName: tc.toolName,
            input: tc.input,
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

function convertTools(tools: ReadonlyArray<ToolDefinition>): ToolSet {
  const result: ToolSet = {}

  for (const t of tools) {
    // Convert Effect Schema to JSON Schema, then wrap with AI SDK's jsonSchema helper
    const effectJsonSchema = JSONSchema.make(t.params as Schema.Schema<unknown, unknown, never>)
    result[t.name] = tool({
      description: t.description,
      inputSchema: jsonSchema(effectJsonSchema),
    })
  }

  return result
}

import * as Prompt from "effect/unstable/ai/Prompt"
import type * as Response from "effect/unstable/ai/Response"
import { ToolCallId } from "../domain/ids.js"
import {
  ImagePart,
  ReasoningPart,
  TextPart,
  ToolCallPart,
  ToolResultPart,
  type Message,
  type MessagePart,
} from "../domain/message.js"

export const GENT_MESSAGE_METADATA_FIELDS = [
  "id",
  "sessionId",
  "branchId",
  "kind",
  "role",
  "createdAt",
  "turnDurationMs",
  "metadata",
] as const satisfies ReadonlyArray<keyof Message>

export interface PromptTranscriptOptions {
  readonly systemPrompt?: string
  readonly includeHidden?: boolean
}

export interface ResponseMessageParts {
  readonly assistant: ReadonlyArray<TextPart | ReasoningPart | ImagePart | ToolCallPart>
  readonly tool: ReadonlyArray<ToolResultPart>
}

export const isAiVisibleMessage = (message: Message): boolean => message.metadata?.hidden !== true

const toSystemMessage = (message: Message): Prompt.SystemMessage | undefined => {
  const text = message.parts
    .filter((part): part is TextPart => part.type === "text")
    .map((part) => part.text)
    .join("\n")

  return text.length > 0 ? Prompt.systemMessage({ content: text }) : undefined
}

const toUserMessage = (message: Message): Prompt.UserMessage | undefined => {
  const content: Prompt.UserMessagePart[] = []

  for (const part of message.parts) {
    switch (part.type) {
      case "text":
        content.push(Prompt.textPart({ text: part.text }))
        break
      case "image":
        content.push(
          Prompt.filePart({
            data: part.image,
            mediaType: part.mediaType ?? "image/png",
          }),
        )
        break
      default:
        break
    }
  }

  return content.length > 0 ? Prompt.userMessage({ content }) : undefined
}

const toAssistantMessage = (message: Message): Prompt.AssistantMessage | undefined => {
  const content: Prompt.AssistantMessagePart[] = []

  for (const part of message.parts) {
    switch (part.type) {
      case "text":
        content.push(Prompt.textPart({ text: part.text }))
        break
      case "reasoning":
        content.push(Prompt.reasoningPart({ text: part.text }))
        break
      case "tool-call":
        content.push(
          Prompt.toolCallPart({
            id: part.toolCallId,
            name: part.toolName,
            params: part.input,
            providerExecuted: false,
          }),
        )
        break
      default:
        break
    }
  }

  return content.length > 0 ? Prompt.assistantMessage({ content }) : undefined
}

const toToolMessage = (message: Message): Prompt.ToolMessage | undefined => {
  const content = message.parts.flatMap(
    (part): ReadonlyArray<Prompt.ToolMessagePart> =>
      part.type === "tool-result"
        ? [
            Prompt.toolResultPart({
              id: part.toolCallId,
              name: part.toolName,
              isFailure: part.output.type === "error-json",
              result: part.output.value,
            }),
          ]
        : [],
  )

  return content.length > 0 ? Prompt.toolMessage({ content }) : undefined
}

const toPromptMessage = (message: Message): Prompt.Message | undefined => {
  switch (message.role) {
    case "system":
      return toSystemMessage(message)
    case "user":
      return toUserMessage(message)
    case "assistant":
      return toAssistantMessage(message)
    case "tool":
      return toToolMessage(message)
  }
}

export const toPromptMessages = (
  messages: ReadonlyArray<Message>,
  options?: Pick<PromptTranscriptOptions, "includeHidden">,
): ReadonlyArray<Prompt.Message> => {
  const result: Prompt.Message[] = []

  for (const message of messages) {
    if (options?.includeHidden !== true && !isAiVisibleMessage(message)) continue
    const promptMessage = toPromptMessage(message)
    if (promptMessage !== undefined) result.push(promptMessage)
  }

  return result
}

export const toPrompt = (
  messages: ReadonlyArray<Message>,
  options?: PromptTranscriptOptions,
): Prompt.Prompt => {
  const promptMessages: Prompt.Message[] =
    options?.systemPrompt !== undefined && options.systemPrompt !== ""
      ? [
          Prompt.systemMessage({ content: options.systemPrompt }),
          ...toPromptMessages(messages, options),
        ]
      : [...toPromptMessages(messages, options)]

  return Prompt.fromMessages(promptMessages)
}

const promptPartToMessagePart = (part: Prompt.AssistantMessagePart): MessagePart | undefined => {
  switch (part.type) {
    case "text":
      return new TextPart({ type: "text", text: part.text })
    case "reasoning":
      return new ReasoningPart({ type: "reasoning", text: part.text })
    case "file":
      return typeof part.data === "string" && part.mediaType.startsWith("image/")
        ? new ImagePart({ type: "image", image: part.data, mediaType: part.mediaType })
        : undefined
    case "tool-call":
      return new ToolCallPart({
        type: "tool-call",
        toolCallId: ToolCallId.of(part.id),
        toolName: part.name,
        input: part.params,
      })
    case "tool-result":
      return new ToolResultPart({
        type: "tool-result",
        toolCallId: ToolCallId.of(part.id),
        toolName: part.name,
        output: {
          type: part.isFailure ? "error-json" : "json",
          value: part.result,
        },
      })
    case "tool-approval-request":
      return undefined
  }
}

const promptToolPartToMessagePart = (part: Prompt.ToolMessagePart): ToolResultPart | undefined => {
  switch (part.type) {
    case "tool-result":
      return new ToolResultPart({
        type: "tool-result",
        toolCallId: ToolCallId.of(part.id),
        toolName: part.name,
        output: {
          type: part.isFailure ? "error-json" : "json",
          value: part.result,
        },
      })
    case "tool-approval-response":
      return undefined
  }
}

export const responsePartsToMessageParts = (
  parts: ReadonlyArray<Response.AnyPart>,
): ResponseMessageParts => {
  const prompt = Prompt.fromResponseParts(parts)
  const assistant: Array<TextPart | ReasoningPart | ImagePart | ToolCallPart> = []
  const tool: ToolResultPart[] = []

  for (const message of prompt.content) {
    switch (message.role) {
      case "assistant":
        for (const part of message.content) {
          const messagePart = promptPartToMessagePart(part)
          if (
            messagePart?.type === "text" ||
            messagePart?.type === "reasoning" ||
            messagePart?.type === "image" ||
            messagePart?.type === "tool-call"
          ) {
            assistant.push(messagePart)
          } else if (messagePart?.type === "tool-result") {
            tool.push(messagePart)
          }
        }
        break
      case "tool":
        for (const part of message.content) {
          const messagePart = promptToolPartToMessagePart(part)
          if (messagePart !== undefined) tool.push(messagePart)
        }
        break
      case "system":
      case "user":
        break
    }
  }

  return { assistant, tool }
}

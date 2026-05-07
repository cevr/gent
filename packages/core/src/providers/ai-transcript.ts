import * as Prompt from "effect/unstable/ai/Prompt"
import type { Message, TextPart } from "../domain/message.js"
import {
  assistantMessagePartToPromptPart,
  normalizeResponseParts,
  projectResponsePartsToMessageParts,
  promptFromResponseParts,
  responsePartsFromMessages,
  toolMessagePartToPromptPart,
  userMessagePartToPromptPart,
} from "../domain/message-part-projection.js"

export {
  normalizeResponseParts,
  projectResponsePartsToMessageParts,
  promptFromResponseParts,
  responsePartsFromMessages,
}

export interface PromptTranscriptOptions {
  readonly systemPrompt?: string
  readonly includeHidden?: boolean
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
      case "file":
        content.push(userMessagePartToPromptPart(part))
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
      case "reasoning":
      case "file":
      case "tool-call":
      case "tool-approval-request":
        content.push(assistantMessagePartToPromptPart(part))
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
      part.type === "tool-result" || part.type === "tool-approval-response"
        ? [toolMessagePartToPromptPart(part)]
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

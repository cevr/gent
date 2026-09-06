import { Option, Predicate } from "effect"
import * as Prompt from "effect/unstable/ai/Prompt"
import type { Message } from "../domain/message.js"
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

const toSystemMessage = (message: Message): Option.Option<Prompt.SystemMessage> => {
  const text = message.parts
    .filter((part): part is Prompt.TextPart => part.type === "text")
    .map((part) => part.text)
    .join("\n")

  if (text.length === 0) return Option.none()
  return Option.some(Prompt.systemMessage({ content: text }))
}

const toUserMessage = (message: Message): Option.Option<Prompt.UserMessage> => {
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

  if (content.length === 0) return Option.none()
  return Option.some(Prompt.userMessage({ content }))
}

const toAssistantMessage = (message: Message): Option.Option<Prompt.AssistantMessage> => {
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

  if (content.length === 0) return Option.none()
  return Option.some(Prompt.assistantMessage({ content }))
}

const toToolMessage = (message: Message): Option.Option<Prompt.ToolMessage> => {
  const content = message.parts.flatMap((part): ReadonlyArray<Prompt.ToolMessagePart> => {
    if (part.type !== "tool-result" && part.type !== "tool-approval-response") return []
    return [toolMessagePartToPromptPart(part)]
  })

  if (content.length === 0) return Option.none()
  return Option.some(Prompt.toolMessage({ content }))
}

const toPromptMessage = (message: Message): Option.Option<Prompt.Message> => {
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
    if (Option.isSome(promptMessage)) result.push(promptMessage.value)
  }

  return result
}

export const toPrompt = (
  messages: ReadonlyArray<Message>,
  options?: PromptTranscriptOptions,
): Prompt.Prompt => {
  const promptMessages = [...toPromptMessages(messages, options)]
  const systemPrompt = options?.systemPrompt
  if (!Predicate.isUndefined(systemPrompt) && systemPrompt !== "") {
    promptMessages.unshift(Prompt.systemMessage({ content: systemPrompt }))
  }

  return Prompt.fromMessages(promptMessages)
}

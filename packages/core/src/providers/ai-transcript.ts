import { Option, Predicate, Schema } from "effect"
import * as Prompt from "effect/unstable/ai/Prompt"
import type { Message } from "../domain/message.js"
import { headTailChars } from "../domain/output-buffer.js"
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

/** Model-facing tool results keep this many characters. The transcript keeps the full result. */
export const maximumModelToolResultChars = 64_000

const encodeToolResultJson = Schema.encodeUnknownOption(Schema.fromJsonString(Schema.Json))

/**
 * Bound one tool result for the model with head-plus-tail text.
 * The stored message and its events keep the full result.
 */
export const boundToolResultForModel = (
  part: Prompt.ToolResultPart,
  maxChars: number = maximumModelToolResultChars,
): Prompt.ToolResultPart => {
  const encoded = encodeToolResultJson(part.result)
  if (Option.isNone(encoded) || encoded.value.length <= maxChars) return part
  const bounded = headTailChars(encoded.value, maxChars)
  return Prompt.toolResultPart({
    id: part.id,
    name: part.name,
    isFailure: part.isFailure,
    providerExecuted: part.providerExecuted,
    result: {
      truncated: true,
      totalChars: bounded.totalChars,
      omittedChars: bounded.totalChars - maxChars,
      text: bounded.text,
    },
  })
}

const toToolMessage = (message: Message): Option.Option<Prompt.ToolMessage> => {
  const content = message.parts.flatMap((part): ReadonlyArray<Prompt.ToolMessagePart> => {
    if (part.type === "tool-result") return [boundToolResultForModel(part)]
    if (part.type !== "tool-approval-response") return []
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

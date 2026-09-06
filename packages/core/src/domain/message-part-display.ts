import { Option, Predicate, Result, Schema } from "effect"
import type * as Prompt from "effect/unstable/ai/Prompt"
import { ToolCallId } from "./ids.js"
import { filePartDataToDisplay } from "./message-image-conversion.js"
import {
  type Message,
  type MessagePart,
  type ProjectedMessage,
  type ToolInteraction,
  projectMessage,
} from "./message.js"
import { stringifyOutput, summarizeOutput } from "./tool-output.js"

export interface ImagePartProjection {
  readonly image: string
  readonly mediaType: string
  readonly rawMediaType: string
}

export interface ToolCallPartProjection {
  readonly id: string
  readonly toolName: string
  readonly input: unknown
}

export interface ToolResultPartProjection {
  readonly id: string
  readonly toolName: string
  readonly value: unknown
  readonly summary: string
  readonly text: string
  readonly isError: boolean
}

interface ToolResultState {
  readonly summary: string
  readonly output: string
  readonly isError: boolean
}

interface IndexedToolResultState extends ToolResultState {
  readonly messageIndex: number
  readonly partIndex: number
}

interface ToolCallPosition {
  readonly messageIndex: number
  readonly partIndex: number
}

interface IndexedToolCallState extends ToolCallPartProjection {
  readonly position: ToolCallPosition
}

export interface MessagePartsDisplayTextOptions {
  readonly maxToolChars?: number
}

const truncateDisplayText = (text: string, max: number): string => {
  if (text.length > max) return text.slice(0, max) + "…"
  return text
}

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))
type JsonEncoderInput = Parameters<typeof encodeJson>[0]

const stringifyDisplayValue = (value: JsonEncoderInput): string => {
  const encoded = Result.try(() => encodeJson(value))
  if (Result.isFailure(encoded)) return String(value)
  return encoded.success
}

// oxlint-disable-next-line effect/noNullish -- This projection helper preserves the established public absence contract.
export const messagePartText = (part: MessagePart): string | undefined => {
  if (part.type === "text") return part.text
  // oxlint-disable-next-line effect/noNullish -- This projection helper preserves the established public absence contract.
  return undefined
}

// oxlint-disable-next-line effect/noNullish -- This projection helper preserves the established public absence contract.
export const messagePartReasoning = (part: MessagePart): string | undefined => {
  if (part.type === "reasoning") return part.text
  // oxlint-disable-next-line effect/noNullish -- This projection helper preserves the established public absence contract.
  return undefined
}

// oxlint-disable-next-line effect/noNullish -- This projection helper preserves the established public absence contract.
export const messagePartImage = (part: MessagePart): ImagePartProjection | undefined => {
  // oxlint-disable-next-line effect/noNullish -- This projection helper preserves the established public absence contract.
  if (part.type !== "file" || !part.mediaType.startsWith("image/")) return undefined
  return {
    image: filePartDataToDisplay(part),
    mediaType: part.mediaType,
    rawMediaType: part.mediaType,
  }
}

// oxlint-disable-next-line effect/noNullish -- This projection helper preserves the established public absence contract.
export const messagePartToolCall = (part: MessagePart): ToolCallPartProjection | undefined => {
  // oxlint-disable-next-line effect/noNullish -- This projection helper preserves the established public absence contract.
  if (part.type !== "tool-call") return undefined
  return {
    id: part.id,
    toolName: part.name,
    input: part.params,
  }
}

// oxlint-disable-next-line effect/noNullish -- This projection helper preserves the established public absence contract.
export const messagePartToolResult = (part: MessagePart): ToolResultPartProjection | undefined => {
  // oxlint-disable-next-line effect/noNullish -- This projection helper preserves the established public absence contract.
  if (part.type !== "tool-result") return undefined
  let outputType: "error-json" | "json" = "json"
  if (part.isFailure) outputType = "error-json"
  return {
    id: part.id,
    toolName: part.name,
    value: part.result,
    summary: summarizeOutput({ type: outputType, value: part.result }),
    text: stringifyOutput(part.result),
    isError: part.isFailure,
  }
}

export const messagePartsText = (parts: ReadonlyArray<MessagePart>): string =>
  parts.flatMap((part) => messagePartText(part) ?? []).join("")

export const messagePartsTextLines = (parts: ReadonlyArray<MessagePart>): ReadonlyArray<string> =>
  parts.flatMap((part) => {
    const text = messagePartText(part)
    if (Predicate.isUndefined(text)) return []
    return [text]
  })

// oxlint-disable-next-line effect/noNullish -- This projection helper preserves the established public absence contract.
export const messageSingleText = (parts: ReadonlyArray<MessagePart>): string | undefined => {
  // oxlint-disable-next-line effect/noNullish -- This projection helper preserves the established public absence contract.
  if (parts.length !== 1) return undefined
  const [part] = parts
  // oxlint-disable-next-line effect/noNullish -- This projection helper preserves the established public absence contract.
  if (Predicate.isUndefined(part)) return undefined
  return messagePartText(part)
}

export const messagePartsReasoning = (parts: ReadonlyArray<MessagePart>): string =>
  parts.flatMap((part) => messagePartReasoning(part) ?? []).join("")

export const messagePartsReasoningLines = (
  parts: ReadonlyArray<MessagePart>,
): ReadonlyArray<string> =>
  parts.flatMap((part) => {
    const reasoning = messagePartReasoning(part)
    if (Predicate.isUndefined(reasoning)) return []
    return [reasoning]
  })

export const messagePartsImages = (
  parts: ReadonlyArray<MessagePart>,
): ReadonlyArray<ImagePartProjection> =>
  parts.flatMap((part) => {
    const image = messagePartImage(part)
    if (Predicate.isUndefined(image)) return []
    return [image]
  })

export const messagePartsToolCalls = (
  parts: ReadonlyArray<MessagePart>,
): ReadonlyArray<ToolCallPartProjection> =>
  parts.flatMap((part) => {
    const toolCall = messagePartToolCall(part)
    if (Predicate.isUndefined(toolCall)) return []
    return [toolCall]
  })

export const messagePartsToolCallParts = (
  parts: ReadonlyArray<MessagePart>,
): ReadonlyArray<Prompt.ToolCallPart> =>
  parts.flatMap((part) => {
    if (part.type === "tool-call") return [part]
    return []
  })

export const messagePartsToolResults = (
  parts: ReadonlyArray<MessagePart>,
): ReadonlyArray<ToolResultPartProjection> =>
  parts.flatMap((part) => {
    const toolResult = messagePartToolResult(part)
    if (Predicate.isUndefined(toolResult)) return []
    return [toolResult]
  })

export const messagePartsToolResultParts = (
  parts: ReadonlyArray<MessagePart>,
): ReadonlyArray<Prompt.ToolResultPart> =>
  parts.flatMap((part) => {
    if (part.type === "tool-result") return [part]
    return []
  })

const buildToolResultMapFromMessages = (
  messages: ReadonlyArray<Message>,
): ReadonlyMap<string, ReadonlyArray<IndexedToolResultState>> => {
  const resultMap = new Map<string, IndexedToolResultState[]>()
  for (const [messageIndex, message] of messages.entries()) {
    if (message.role !== "tool") continue
    for (const [partIndex, part] of message.parts.entries()) {
      const result = messagePartToolResult(part)
      if (Predicate.isUndefined(result)) continue
      const results = resultMap.get(result.id) ?? []
      results.push({
        messageIndex,
        partIndex,
        summary: result.summary,
        output: result.text,
        isError: result.isError,
      })
      resultMap.set(result.id, results)
    }
  }
  return resultMap
}

const comparePosition = (left: ToolCallPosition, right: ToolCallPosition): number => {
  if (left.messageIndex !== right.messageIndex) return left.messageIndex - right.messageIndex
  return left.partIndex - right.partIndex
}

const indexedToolCalls = (
  messages: ReadonlyArray<Message>,
): ReadonlyMap<string, ReadonlyArray<IndexedToolCallState>> => {
  const calls = new Map<string, IndexedToolCallState[]>()
  for (const [messageIndex, message] of messages.entries()) {
    for (const [partIndex, part] of message.parts.entries()) {
      const toolCall = messagePartToolCall(part)
      if (Predicate.isUndefined(toolCall)) continue
      const existing = calls.get(toolCall.id) ?? []
      existing.push({ ...toolCall, position: { messageIndex, partIndex } })
      calls.set(toolCall.id, existing)
    }
  }
  return calls
}

const buildToolResultPairings = (
  messages: ReadonlyArray<Message>,
  resultMap: ReadonlyMap<string, ReadonlyArray<IndexedToolResultState>>,
): ReadonlyMap<string, ToolResultState> => {
  const pairings = new Map<string, ToolResultState>()
  const callsById = indexedToolCalls(messages)
  for (const [toolCallId, calls] of callsById) {
    const results = resultMap.get(toolCallId) ?? []
    let resultIndex = 0
    for (const call of calls) {
      while (resultIndex < results.length) {
        const candidate = results[resultIndex]
        if (Predicate.isUndefined(candidate) || comparePosition(candidate, call.position) > 0) break
        resultIndex++
      }
      const result = results[resultIndex]
      if (Predicate.isUndefined(result)) continue
      pairings.set(`${call.position.messageIndex}:${call.position.partIndex}`, result)
      resultIndex++
    }
  }
  return pairings
}

const findResultForToolCall = (
  callMessageIndex: number,
  callPartIndex: number,
  pairings: ReadonlyMap<string, ToolResultState>,
): Option.Option<ToolResultState> =>
  Option.fromUndefinedOr(pairings.get(`${callMessageIndex}:${callPartIndex}`))

const messagePartsToolInteractions = (
  parts: ReadonlyArray<MessagePart>,
  resultForToolCall: (partIndex: number) => Option.Option<ToolResultState>,
): ReadonlyArray<ToolInteraction> => {
  const interactions: ToolInteraction[] = []
  for (const [partIndex, part] of parts.entries()) {
    const toolCall = messagePartToolCall(part)
    if (Predicate.isUndefined(toolCall)) continue
    const id = ToolCallId.make(toolCall.id)
    const result = resultForToolCall(partIndex)
    let status: ToolInteraction["status"] = "running"
    if (Option.isSome(result)) {
      status = "completed"
      if (result.value.isError) status = "error"
    }
    interactions.push({
      id,
      toolName: toolCall.toolName,
      status,
      input: toolCall.input,
      summary: Option.getOrUndefined(Option.map(result, (value) => value.summary)),
      output: Option.getOrUndefined(Option.map(result, (value) => value.output)),
    })
  }
  return interactions
}

export const projectMessagesWithToolInteractions = (
  messages: ReadonlyArray<Message>,
): ReadonlyArray<ProjectedMessage> => {
  const resultMap = buildToolResultMapFromMessages(messages)
  const pairings = buildToolResultPairings(messages, resultMap)
  return messages.map((message, index) =>
    projectMessage(
      message,
      messagePartsToolInteractions(message.parts, (partIndex) =>
        findResultForToolCall(index, partIndex, pairings),
      ),
    ),
  )
}

/**
 * Human-readable transcript display. Renders user-visible text plus tool
 * calls/results; reasoning and images stay available through focused helpers.
 */
export const messagePartsDisplayText = (
  parts: ReadonlyArray<MessagePart>,
  options: MessagePartsDisplayTextOptions = {},
): string => {
  const maxToolChars = options.maxToolChars ?? 500
  const chunks: string[] = []

  for (const part of parts) {
    const text = messagePartText(part)
    if (!Predicate.isUndefined(text)) {
      chunks.push(text)
      continue
    }

    const toolCall = messagePartToolCall(part)
    if (!Predicate.isUndefined(toolCall)) {
      chunks.push(
        `### tool: ${toolCall.toolName}\n${truncateDisplayText(
          stringifyDisplayValue(toolCall.input),
          maxToolChars,
        )}`,
      )
      continue
    }

    const toolResult = messagePartToolResult(part)
    if (!Predicate.isUndefined(toolResult)) {
      chunks.push(`result: ${truncateDisplayText(toolResult.text, maxToolChars)}`)
    }
  }

  return chunks.join("\n")
}

export const stringifySearchValue = (value: JsonEncoderInput): string => {
  if (Predicate.isString(value)) return value
  if (Predicate.isUndefined(value)) return ""
  const encoded = Result.try(() => encodeJson(value))
  if (Result.isFailure(encoded)) return ""
  return encoded.success
}

export const messagePartSearchText = (part: MessagePart): string => {
  const text = messagePartText(part)
  if (!Predicate.isUndefined(text)) return text

  const reasoning = messagePartReasoning(part)
  if (!Predicate.isUndefined(reasoning)) return reasoning

  const image = messagePartImage(part)
  if (!Predicate.isUndefined(image)) {
    return [image.rawMediaType, image.image]
      .filter((value) => !Predicate.isUndefined(value) && value !== "")
      .join(" ")
  }

  const toolCall = messagePartToolCall(part)
  if (!Predicate.isUndefined(toolCall)) {
    return [toolCall.toolName, stringifySearchValue(toolCall.input)]
      .filter((value) => value !== "")
      .join(" ")
  }

  const toolResult = messagePartToolResult(part)
  if (!Predicate.isUndefined(toolResult)) {
    return [toolResult.toolName, stringifySearchValue(toolResult.value)]
      .filter((value) => value !== "")
      .join(" ")
  }

  return ""
}

export const messagePartsSearchText = (parts: ReadonlyArray<MessagePart>): string =>
  parts
    .map(messagePartSearchText)
    .filter((text) => text.length > 0)
    .join("\n")

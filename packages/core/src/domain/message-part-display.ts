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
  readonly rawMediaType: string | undefined
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

const truncateDisplayText = (text: string, max: number): string =>
  text.length > max ? text.slice(0, max) + "…" : text

const stringifyDisplayValue = (value: unknown): string => {
  const encoded = JSON.stringify(value)
  return encoded === undefined ? String(value) : encoded
}

export const messagePartText = (part: MessagePart): string | undefined =>
  part.type === "text" ? part.text : undefined

export const messagePartReasoning = (part: MessagePart): string | undefined =>
  part.type === "reasoning" ? part.text : undefined

export const messagePartImage = (part: MessagePart): ImagePartProjection | undefined =>
  part.type === "file" && part.mediaType.startsWith("image/")
    ? {
        image: filePartDataToDisplay(part),
        mediaType: part.mediaType,
        rawMediaType: part.mediaType,
      }
    : undefined

export const messagePartToolCall = (part: MessagePart): ToolCallPartProjection | undefined =>
  part.type === "tool-call"
    ? {
        id: part.id,
        toolName: part.name,
        input: part.params,
      }
    : undefined

export const messagePartToolResult = (part: MessagePart): ToolResultPartProjection | undefined =>
  part.type === "tool-result"
    ? {
        id: part.id,
        toolName: part.name,
        value: part.result,
        summary: summarizeOutput({
          type: part.isFailure ? "error-json" : "json",
          value: part.result,
        }),
        text: stringifyOutput(part.result),
        isError: part.isFailure,
      }
    : undefined

export const messagePartsText = (parts: ReadonlyArray<MessagePart>): string =>
  parts.flatMap((part) => messagePartText(part) ?? []).join("")

export const messagePartsTextLines = (parts: ReadonlyArray<MessagePart>): ReadonlyArray<string> =>
  parts.flatMap((part) => {
    const text = messagePartText(part)
    return text === undefined ? [] : [text]
  })

export const messageSingleText = (parts: ReadonlyArray<MessagePart>): string | undefined => {
  if (parts.length !== 1) return undefined
  const [part] = parts
  return part === undefined ? undefined : messagePartText(part)
}

export const messagePartsReasoning = (parts: ReadonlyArray<MessagePart>): string =>
  parts.flatMap((part) => messagePartReasoning(part) ?? []).join("")

export const messagePartsReasoningLines = (
  parts: ReadonlyArray<MessagePart>,
): ReadonlyArray<string> =>
  parts.flatMap((part) => {
    const reasoning = messagePartReasoning(part)
    return reasoning === undefined ? [] : [reasoning]
  })

export const messagePartsImages = (
  parts: ReadonlyArray<MessagePart>,
): ReadonlyArray<ImagePartProjection> =>
  parts.flatMap((part) => {
    const image = messagePartImage(part)
    return image === undefined ? [] : [image]
  })

export const messagePartsToolCalls = (
  parts: ReadonlyArray<MessagePart>,
): ReadonlyArray<ToolCallPartProjection> =>
  parts.flatMap((part) => {
    const toolCall = messagePartToolCall(part)
    return toolCall === undefined ? [] : [toolCall]
  })

export const messagePartsToolCallParts = (
  parts: ReadonlyArray<MessagePart>,
): ReadonlyArray<Prompt.ToolCallPart> =>
  parts.flatMap((part) => (part.type === "tool-call" ? [part] : []))

export const messagePartsToolResults = (
  parts: ReadonlyArray<MessagePart>,
): ReadonlyArray<ToolResultPartProjection> =>
  parts.flatMap((part) => {
    const toolResult = messagePartToolResult(part)
    return toolResult === undefined ? [] : [toolResult]
  })

export const messagePartsToolResultParts = (
  parts: ReadonlyArray<MessagePart>,
): ReadonlyArray<Prompt.ToolResultPart> =>
  parts.flatMap((part) => (part.type === "tool-result" ? [part] : []))

const buildToolResultMapFromMessages = (
  messages: ReadonlyArray<Message>,
): ReadonlyMap<string, ReadonlyArray<IndexedToolResultState>> => {
  const resultMap = new Map<string, IndexedToolResultState[]>()
  for (const [messageIndex, message] of messages.entries()) {
    if (message.role !== "tool") continue
    for (const [partIndex, part] of message.parts.entries()) {
      const result = messagePartToolResult(part)
      if (result === undefined) continue
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
      if (toolCall === undefined) continue
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
        if (candidate === undefined || comparePosition(candidate, call.position) > 0) break
        resultIndex++
      }
      const result = results[resultIndex]
      if (result === undefined) continue
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
): ToolResultState | undefined => pairings.get(`${callMessageIndex}:${callPartIndex}`)

const messagePartsToolInteractions = (
  parts: ReadonlyArray<MessagePart>,
  resultForToolCall: (partIndex: number) => ToolResultState | undefined,
): ReadonlyArray<ToolInteraction> => {
  const interactions: ToolInteraction[] = []
  for (const [partIndex, part] of parts.entries()) {
    const toolCall = messagePartToolCall(part)
    if (toolCall === undefined) continue
    const id = ToolCallId.make(toolCall.id)
    const result = resultForToolCall(partIndex)
    let status: ToolInteraction["status"] = "running"
    if (result !== undefined) status = result.isError ? "error" : "completed"
    interactions.push({
      id,
      toolName: toolCall.toolName,
      status,
      input: toolCall.input,
      summary: result?.summary,
      output: result?.output,
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
    if (text !== undefined) {
      chunks.push(text)
      continue
    }

    const toolCall = messagePartToolCall(part)
    if (toolCall !== undefined) {
      chunks.push(
        `### tool: ${toolCall.toolName}\n${truncateDisplayText(
          stringifyDisplayValue(toolCall.input),
          maxToolChars,
        )}`,
      )
      continue
    }

    const toolResult = messagePartToolResult(part)
    if (toolResult !== undefined) {
      chunks.push(`result: ${truncateDisplayText(toolResult.text, maxToolChars)}`)
    }
  }

  return chunks.join("\n")
}

export const stringifySearchValue = (value: unknown): string => {
  if (typeof value === "string") return value
  if (value === undefined) return ""
  const encoded = JSON.stringify(value)
  return encoded === undefined ? "" : encoded
}

export const messagePartSearchText = (part: MessagePart): string => {
  const text = messagePartText(part)
  if (text !== undefined) return text

  const reasoning = messagePartReasoning(part)
  if (reasoning !== undefined) return reasoning

  const image = messagePartImage(part)
  if (image !== undefined) {
    return [image.rawMediaType, image.image]
      .filter((value) => value !== undefined && value !== "")
      .join(" ")
  }

  const toolCall = messagePartToolCall(part)
  if (toolCall !== undefined) {
    return [toolCall.toolName, stringifySearchValue(toolCall.input)]
      .filter((value) => value !== "")
      .join(" ")
  }

  const toolResult = messagePartToolResult(part)
  if (toolResult !== undefined) {
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

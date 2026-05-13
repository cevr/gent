import * as Prompt from "effect/unstable/ai/Prompt"
import * as Response from "effect/unstable/ai/Response"
import { ToolCallId } from "./ids.js"
import {
  filePartDataToDisplay,
  imagePartToResponseFilePart,
  responseFilePartToImagePart,
} from "./message-image-conversion.js"
import { normalizeResponseParts } from "./response-part-normalization.js"
import { stringifyOutput, summarizeOutput } from "./tool-output.js"

export {
  dataUrlToBytes,
  fileDataFromImage,
  imagePartToResponseFilePart,
  responseFilePartToImagePart,
  UrlBackedImageNotSupportedError,
} from "./message-image-conversion.js"
export { normalizeResponseParts } from "./response-part-normalization.js"
import {
  type Message,
  type MessagePart,
  type ProjectedMessage,
  type ToolInteraction,
  projectMessage,
} from "./message.js"

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

export interface MessagePartProjection {
  readonly assistant: ReadonlyArray<
    | Prompt.TextPart
    | Prompt.ReasoningPart
    | Prompt.FilePart
    | Prompt.ToolCallPart
    | Prompt.ToolApprovalRequestPart
  >
  readonly tool: ReadonlyArray<Prompt.ToolResultPart | Prompt.ToolApprovalResponsePart>
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

export const messagePartToPromptPart = (
  part: MessagePart,
): Prompt.UserMessagePart | Prompt.AssistantMessagePart | Prompt.ToolMessagePart | undefined => {
  switch (part.type) {
    case "text":
      return Prompt.textPart({ text: part.text })
    case "reasoning":
      return Prompt.reasoningPart({ text: part.text })
    case "file":
      return part
    case "tool-call":
      return part
    case "tool-result":
      return part
    case "tool-approval-request":
    case "tool-approval-response":
      return part
  }
}

export const userMessagePartToPromptPart = (
  part: Prompt.TextPart | Prompt.FilePart,
): Prompt.UserMessagePart => {
  switch (part.type) {
    case "text":
      return part
    case "file":
      return part
  }
}

export const assistantMessagePartToPromptPart = (
  part:
    | Prompt.TextPart
    | Prompt.ReasoningPart
    | Prompt.FilePart
    | Prompt.ToolCallPart
    | Prompt.ToolApprovalRequestPart,
): Prompt.AssistantMessagePart => {
  switch (part.type) {
    case "text":
      return part
    case "reasoning":
      return part
    case "file":
      return part
    case "tool-call":
      return part
    case "tool-approval-request":
      return part
  }
}

export const toolMessagePartToPromptPart = (
  part: Prompt.ToolResultPart | Prompt.ToolApprovalResponsePart,
): Prompt.ToolMessagePart => part

export const assistantMessagePartToResponsePart = (
  part:
    | Prompt.TextPart
    | Prompt.ReasoningPart
    | Prompt.FilePart
    | Prompt.ToolCallPart
    | Prompt.ToolApprovalRequestPart,
): Response.AnyPart => {
  switch (part.type) {
    case "text":
      return Response.makePart("text", { text: part.text })
    case "reasoning":
      return Response.makePart("reasoning", { text: part.text })
    case "file":
      return imagePartToResponseFilePart(part)
    case "tool-call":
      return Response.makePart("tool-call", {
        id: part.id,
        name: part.name,
        params: part.params,
        providerExecuted: part.providerExecuted,
      })
    case "tool-approval-request":
      return Response.makePart("tool-approval-request", {
        approvalId: part.approvalId,
        toolCallId: part.toolCallId,
      })
  }
}

export const toolResultPartToResponsePart = (part: Prompt.ToolResultPart): Response.AnyPart =>
  Response.makePart("tool-result", {
    id: part.id,
    name: part.name,
    isFailure: part.isFailure,
    result: part.result,
    encodedResult: part.result,
    providerExecuted: false,
    preliminary: false,
  })

export const responsePartToAssistantMessagePart = (
  part: Response.AnyPart,
):
  | Prompt.TextPart
  | Prompt.ReasoningPart
  | Prompt.FilePart
  | Prompt.ToolCallPart
  | Prompt.ToolApprovalRequestPart
  | undefined => {
  switch (part.type) {
    case "text":
      return Prompt.textPart({ text: part.text })
    case "reasoning":
      return Prompt.reasoningPart({ text: part.text })
    case "file":
      return responseFilePartToImagePart(part)
    case "tool-call":
      return Prompt.toolCallPart({
        id: part.id,
        name: part.name,
        params: part.params,
        providerExecuted: part.providerExecuted,
      })
    case "tool-approval-request":
      return Prompt.toolApprovalRequestPart({
        approvalId: part.approvalId,
        toolCallId: part.toolCallId,
      })
    default:
      return undefined
  }
}

export const responsePartToToolResultPart = (
  part: Response.AnyPart,
): Prompt.ToolResultPart | undefined =>
  part.type === "tool-result" && part.preliminary !== true
    ? Prompt.toolResultPart({
        id: part.id,
        name: part.name,
        isFailure: part.isFailure,
        result: part.encodedResult,
      })
    : undefined

export const responsePartsFromMessages = (
  messages: ReadonlyArray<Message>,
): ReadonlyArray<Response.AnyPart> =>
  normalizeResponseParts(
    messages.flatMap((message): ReadonlyArray<Response.AnyPart> => {
      switch (message.role) {
        case "assistant":
          return message.parts.flatMap((part): ReadonlyArray<Response.AnyPart> => {
            switch (part.type) {
              case "text":
              case "reasoning":
              case "tool-call":
              case "file":
              case "tool-approval-request":
                return [assistantMessagePartToResponsePart(part)]
              default:
                return []
            }
          })
        case "tool":
          return message.parts.flatMap(
            (part): ReadonlyArray<Response.AnyPart> =>
              part.type === "tool-result" ? [toolResultPartToResponsePart(part)] : [],
          )
        default:
          return []
      }
    }),
  )

export const projectResponsePartsToMessageParts = (
  parts: ReadonlyArray<Response.AnyPart>,
): MessagePartProjection => {
  const normalized = normalizeResponseParts(parts)
  const assistant: Array<
    | Prompt.TextPart
    | Prompt.ReasoningPart
    | Prompt.FilePart
    | Prompt.ToolCallPart
    | Prompt.ToolApprovalRequestPart
  > = []
  const tool: Array<Prompt.ToolResultPart | Prompt.ToolApprovalResponsePart> = []

  for (const part of normalized) {
    const assistantPart = responsePartToAssistantMessagePart(part)
    if (assistantPart !== undefined) {
      assistant.push(assistantPart)
      continue
    }
    const toolPart = responsePartToToolResultPart(part)
    if (toolPart !== undefined) tool.push(toolPart)
  }

  return { assistant, tool }
}

const responsePartsToPromptAssistantMessage = (
  parts: ReadonlyArray<Response.AnyPart>,
): Prompt.AssistantMessage | undefined => {
  const content: Prompt.AssistantMessagePart[] = []

  for (const part of parts) {
    switch (part.type) {
      case "text":
        content.push(Prompt.textPart({ text: part.text }))
        break
      case "reasoning":
        content.push(Prompt.reasoningPart({ text: part.text }))
        break
      case "file":
        content.push(Prompt.filePart({ data: part.data, mediaType: part.mediaType }))
        break
      case "tool-call":
        content.push(
          Prompt.toolCallPart({
            id: part.id,
            name: part.name,
            params: part.params,
            providerExecuted: false,
          }),
        )
        break
      case "tool-approval-request":
        content.push(
          Prompt.toolApprovalRequestPart({
            approvalId: part.approvalId,
            toolCallId: part.toolCallId,
          }),
        )
        break
      default:
        break
    }
  }

  return content.length > 0 ? Prompt.assistantMessage({ content }) : undefined
}

const responsePartsToPromptToolMessage = (
  parts: ReadonlyArray<Response.AnyPart>,
): Prompt.ToolMessage | undefined => {
  const content = parts.flatMap(
    (part): ReadonlyArray<Prompt.ToolMessagePart> =>
      part.type === "tool-result" && part.preliminary !== true
        ? [
            Prompt.toolResultPart({
              id: part.id,
              name: part.name,
              isFailure: part.isFailure,
              result: part.encodedResult,
            }),
          ]
        : [],
  )

  return content.length > 0 ? Prompt.toolMessage({ content }) : undefined
}

export const promptFromResponseParts = (parts: ReadonlyArray<Response.AnyPart>): Prompt.Prompt => {
  const normalized = normalizeResponseParts(parts)
  if (!normalized.some((part) => part.type === "file")) {
    return Prompt.fromResponseParts(normalized)
  }

  const promptMessages: Prompt.Message[] = []
  const assistant = responsePartsToPromptAssistantMessage(normalized)
  const tool = responsePartsToPromptToolMessage(normalized)
  if (assistant !== undefined) promptMessages.push(assistant)
  if (tool !== undefined) promptMessages.push(tool)
  return Prompt.fromMessages(promptMessages)
}

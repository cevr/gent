import * as Prompt from "effect/unstable/ai/Prompt"
import * as Response from "effect/unstable/ai/Response"
import { ToolCallId } from "./ids.js"
import { stringifyOutput, summarizeOutput } from "./tool-output.js"
import {
  ImagePart,
  ReasoningPart,
  TextPart,
  ToolCallPart,
  ToolResultPart,
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
  part.type === "image"
    ? {
        image: part.image,
        mediaType: part.mediaType ?? "image",
        rawMediaType: part.mediaType,
      }
    : undefined

export const messagePartToolCall = (part: MessagePart): ToolCallPartProjection | undefined =>
  part.type === "tool-call"
    ? {
        id: part.toolCallId,
        toolName: part.toolName,
        input: part.input,
      }
    : undefined

export const messagePartToolResult = (part: MessagePart): ToolResultPartProjection | undefined =>
  part.type === "tool-result"
    ? {
        id: part.toolCallId,
        toolName: part.toolName,
        value: part.output.value,
        summary: summarizeOutput(part.output),
        text: stringifyOutput(part.output.value),
        isError: part.output.type === "error-json",
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
): ReadonlyArray<ToolCallPart> => parts.flatMap((part) => (part.type === "tool-call" ? [part] : []))

export const messagePartsToolResults = (
  parts: ReadonlyArray<MessagePart>,
): ReadonlyArray<ToolResultPartProjection> =>
  parts.flatMap((part) => {
    const toolResult = messagePartToolResult(part)
    return toolResult === undefined ? [] : [toolResult]
  })

export const messagePartsToolResultParts = (
  parts: ReadonlyArray<MessagePart>,
): ReadonlyArray<ToolResultPart> =>
  parts.flatMap((part) => (part.type === "tool-result" ? [part] : []))

const buildToolResultMapFromMessages = (
  messages: ReadonlyArray<Message>,
): ReadonlyMap<string, ReadonlyArray<IndexedToolResultState>> => {
  const resultMap = new Map<string, IndexedToolResultState[]>()
  for (const [messageIndex, message] of messages.entries()) {
    if (message.role !== "tool") continue
    for (const result of messagePartsToolResults(message.parts)) {
      const results = resultMap.get(result.id) ?? []
      results.push({
        messageIndex,
        summary: result.summary,
        output: result.text,
        isError: result.isError,
      })
      resultMap.set(result.id, results)
    }
  }
  return resultMap
}

const messageHasToolCall = (message: Message, toolCallId: string): boolean =>
  message.parts.some((part) => part.type === "tool-call" && part.toolCallId === toolCallId)

const findResultForToolCall = (
  messages: ReadonlyArray<Message>,
  callMessageIndex: number,
  toolCallId: string,
  resultMap: ReadonlyMap<string, ReadonlyArray<IndexedToolResultState>>,
): ToolResultState | undefined => {
  const results = resultMap.get(toolCallId)
  if (results === undefined) return undefined
  const nextDuplicateIndex = messages.findIndex(
    (message, index) => index > callMessageIndex && messageHasToolCall(message, toolCallId),
  )
  return results.find(
    (result) =>
      result.messageIndex > callMessageIndex &&
      (nextDuplicateIndex === -1 || result.messageIndex < nextDuplicateIndex),
  )
}

const messagePartsToolInteractions = (
  parts: ReadonlyArray<MessagePart>,
  resultForToolCall: (toolCallId: string) => ToolResultState | undefined,
): ReadonlyArray<ToolInteraction> =>
  messagePartsToolCalls(parts).map((toolCall) => {
    const id = ToolCallId.make(toolCall.id)
    const result = resultForToolCall(toolCall.id)
    let status: ToolInteraction["status"] = "running"
    if (result !== undefined) status = result.isError ? "error" : "completed"
    return {
      id,
      toolName: toolCall.toolName,
      status,
      input: toolCall.input,
      summary: result?.summary,
      output: result?.output,
    }
  })

export const projectMessagesWithToolInteractions = (
  messages: ReadonlyArray<Message>,
): ReadonlyArray<ProjectedMessage> => {
  const resultMap = buildToolResultMapFromMessages(messages)
  return messages.map((message, index) =>
    projectMessage(
      message,
      messagePartsToolInteractions(message.parts, (toolCallId) =>
        findResultForToolCall(messages, index, toolCallId, resultMap),
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

export const fileDataFromImage = (part: ImagePart): string | URL => {
  if (part.image.startsWith("data:")) return part.image
  try {
    return new URL(part.image)
  } catch {
    return part.image
  }
}

export const dataUrlToBytes = (value: string): Uint8Array | undefined => {
  const match = /^data:([^;,]+);base64,(.+)$/u.exec(value)
  if (match === null) return undefined
  const data = match[2]
  if (data === undefined) return undefined
  return Uint8Array.from(Buffer.from(data, "base64"))
}

export const imagePartToResponseFilePart = (part: ImagePart): Response.FilePart => {
  const data = dataUrlToBytes(part.image)
  if (data === undefined) {
    throw new Error(
      `responsePartsFromMessages only supports data URL images; cannot encode URL-backed image "${part.image}"`,
    )
  }
  return Response.makePart("file", {
    data,
    mediaType: part.mediaType ?? "image/png",
  })
}

export const messagePartToPromptPart = (
  part: MessagePart,
): Prompt.UserMessagePart | Prompt.AssistantMessagePart | Prompt.ToolMessagePart | undefined => {
  switch (part.type) {
    case "text":
      return Prompt.textPart({ text: part.text })
    case "reasoning":
      return Prompt.reasoningPart({ text: part.text })
    case "image":
      return Prompt.filePart({
        data: fileDataFromImage(part),
        mediaType: part.mediaType ?? "image/png",
      })
    case "tool-call":
      return Prompt.toolCallPart({
        id: part.toolCallId,
        name: part.toolName,
        params: part.input,
        providerExecuted: false,
      })
    case "tool-result":
      return Prompt.toolResultPart({
        id: part.toolCallId,
        name: part.toolName,
        isFailure: part.output.type === "error-json",
        result: part.output.value,
      })
  }
}

export const userMessagePartToPromptPart = (part: TextPart | ImagePart): Prompt.UserMessagePart => {
  switch (part.type) {
    case "text":
      return Prompt.textPart({ text: part.text })
    case "image":
      return Prompt.filePart({
        data: fileDataFromImage(part),
        mediaType: part.mediaType ?? "image/png",
      })
  }
}

export const assistantMessagePartToPromptPart = (
  part: TextPart | ReasoningPart | ImagePart | ToolCallPart,
): Prompt.AssistantMessagePart => {
  switch (part.type) {
    case "text":
      return Prompt.textPart({ text: part.text })
    case "reasoning":
      return Prompt.reasoningPart({ text: part.text })
    case "image":
      return Prompt.filePart({
        data: fileDataFromImage(part),
        mediaType: part.mediaType ?? "image/png",
      })
    case "tool-call":
      return Prompt.toolCallPart({
        id: part.toolCallId,
        name: part.toolName,
        params: part.input,
        providerExecuted: false,
      })
  }
}

export const toolMessagePartToPromptPart = (part: ToolResultPart): Prompt.ToolMessagePart =>
  Prompt.toolResultPart({
    id: part.toolCallId,
    name: part.toolName,
    isFailure: part.output.type === "error-json",
    result: part.output.value,
  })

export const assistantMessagePartToResponsePart = (
  part: TextPart | ReasoningPart | ImagePart | ToolCallPart,
): Response.AnyPart => {
  switch (part.type) {
    case "text":
      return Response.makePart("text", { text: part.text })
    case "reasoning":
      return Response.makePart("reasoning", { text: part.text })
    case "image":
      return imagePartToResponseFilePart(part)
    case "tool-call":
      return Response.makePart("tool-call", {
        id: part.toolCallId,
        name: part.toolName,
        params: part.input,
        providerExecuted: false,
      })
  }
}

export const toolResultPartToResponsePart = (part: ToolResultPart): Response.AnyPart =>
  Response.makePart("tool-result", {
    id: part.toolCallId,
    name: part.toolName,
    isFailure: part.output.type === "error-json",
    result: part.output.value,
    encodedResult: part.output.value,
    providerExecuted: false,
    preliminary: false,
  })

export const responseFilePartToImagePart = (part: Response.FilePart): ImagePart | undefined =>
  part.mediaType.startsWith("image/")
    ? new ImagePart({
        type: "image",
        image: `data:${part.mediaType};base64,${Buffer.from(part.data).toString("base64")}`,
        mediaType: part.mediaType,
      })
    : undefined

export const responsePartToAssistantMessagePart = (
  part: Response.AnyPart,
): TextPart | ReasoningPart | ImagePart | ToolCallPart | undefined => {
  switch (part.type) {
    case "text":
      return new TextPart({ type: "text", text: part.text })
    case "reasoning":
      return new ReasoningPart({ type: "reasoning", text: part.text })
    case "file":
      return responseFilePartToImagePart(part)
    case "tool-call":
      return new ToolCallPart({
        type: "tool-call",
        toolCallId: ToolCallId.make(part.id),
        toolName: part.name,
        input: part.params,
      })
    default:
      return undefined
  }
}

export const responsePartToToolResultPart = (part: Response.AnyPart): ToolResultPart | undefined =>
  part.type === "tool-result" && part.preliminary !== true
    ? new ToolResultPart({
        type: "tool-result",
        toolCallId: ToolCallId.make(part.id),
        toolName: part.name,
        output: {
          type: part.isFailure ? "error-json" : "json",
          value: part.encodedResult,
        },
      })
    : undefined

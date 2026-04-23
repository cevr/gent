import * as Prompt from "effect/unstable/ai/Prompt"
import * as Response from "effect/unstable/ai/Response"
import { ToolCallId } from "../domain/ids.js"
import {
  ImagePart,
  ReasoningPart,
  TextPart,
  ToolCallPart,
  ToolResultPart,
  type Message,
} from "../domain/message.js"

export const GENT_MESSAGE_METADATA_FIELDS = [
  "id",
  "sessionId",
  "branchId",
  "kind",
  "createdAt",
  "turnDurationMs",
  "metadata",
] as const satisfies ReadonlyArray<keyof Message>

export const EFFECT_AI_CONTENT_FIELDS = ["role", "parts"] as const satisfies ReadonlyArray<
  keyof Message
>

export interface PromptTranscriptOptions {
  readonly systemPrompt?: string
  readonly includeHidden?: boolean
}

export interface ResponseMessageParts {
  readonly assistant: ReadonlyArray<TextPart | ReasoningPart | ImagePart | ToolCallPart>
  readonly tool: ReadonlyArray<ToolResultPart>
}

const toPromptFileData = (value: string): string | URL => {
  if (value.startsWith("data:")) return value
  try {
    return new URL(value)
  } catch {
    return value
  }
}

const appendNormalizedTextPart = (parts: Array<Response.AnyPart>, text: string): void => {
  if (text === "") return
  const last = parts.at(-1)
  if (last?.type === "text") {
    parts[parts.length - 1] = Response.makePart("text", { text: `${last.text}${text}` })
    return
  }
  parts.push(Response.makePart("text", { text }))
}

const appendNormalizedReasoningPart = (parts: Array<Response.AnyPart>, text: string): void => {
  if (text === "") return
  const last = parts.at(-1)
  if (last?.type === "reasoning") {
    parts[parts.length - 1] = Response.makePart("reasoning", {
      text: `${last.text}${text}`,
    })
    return
  }
  parts.push(Response.makePart("reasoning", { text }))
}

interface NormalizedResponseState {
  readonly normalized: Array<Response.AnyPart>
  readonly activeTextDeltas: Map<string, string>
  readonly activeReasoningDeltas: Map<string, string>
}

type TextResponsePart = Extract<
  Response.AnyPart,
  { readonly type: "text" | "text-start" | "text-delta" | "text-end" }
>

type ReasoningResponsePart = Extract<
  Response.AnyPart,
  { readonly type: "reasoning" | "reasoning-start" | "reasoning-delta" | "reasoning-end" }
>

const normalizeTextResponsePart = (
  state: NormalizedResponseState,
  part: TextResponsePart,
): void => {
  switch (part.type) {
    case "text":
      appendNormalizedTextPart(state.normalized, part.text)
      return
    case "text-start":
      state.activeTextDeltas.set(part.id, "")
      return
    case "text-delta":
      if (state.activeTextDeltas.has(part.id)) {
        state.activeTextDeltas.set(
          part.id,
          `${state.activeTextDeltas.get(part.id) ?? ""}${part.delta}`,
        )
      } else {
        appendNormalizedTextPart(state.normalized, part.delta)
      }
      return
    case "text-end":
      appendNormalizedTextPart(state.normalized, state.activeTextDeltas.get(part.id) ?? "")
      state.activeTextDeltas.delete(part.id)
      return
  }
}

const normalizeReasoningResponsePart = (
  state: NormalizedResponseState,
  part: ReasoningResponsePart,
): void => {
  switch (part.type) {
    case "reasoning":
      appendNormalizedReasoningPart(state.normalized, part.text)
      return
    case "reasoning-start":
      state.activeReasoningDeltas.set(part.id, "")
      return
    case "reasoning-delta":
      if (state.activeReasoningDeltas.has(part.id)) {
        state.activeReasoningDeltas.set(
          part.id,
          `${state.activeReasoningDeltas.get(part.id) ?? ""}${part.delta}`,
        )
      } else {
        appendNormalizedReasoningPart(state.normalized, part.delta)
      }
      return
    case "reasoning-end":
      appendNormalizedReasoningPart(
        state.normalized,
        state.activeReasoningDeltas.get(part.id) ?? "",
      )
      state.activeReasoningDeltas.delete(part.id)
      return
  }
}

const normalizePassthroughResponsePart = (
  state: NormalizedResponseState,
  part: Response.AnyPart,
): void => {
  switch (part.type) {
    case "tool-result":
      if (part.preliminary !== true) state.normalized.push(part)
      return
    case "file":
    case "tool-call":
    case "tool-approval-request":
    case "source":
    case "response-metadata":
    case "finish":
      state.normalized.push(part)
      return
    default:
      return
  }
}

export const normalizeResponseParts = (
  parts: ReadonlyArray<Response.AnyPart>,
): ReadonlyArray<Response.AnyPart> => {
  const state: NormalizedResponseState = {
    normalized: [],
    activeTextDeltas: new Map<string, string>(),
    activeReasoningDeltas: new Map<string, string>(),
  }

  for (const part of parts) {
    if (
      part.type === "text" ||
      part.type === "text-start" ||
      part.type === "text-delta" ||
      part.type === "text-end"
    ) {
      normalizeTextResponsePart(state, part)
      continue
    }

    if (
      part.type === "reasoning" ||
      part.type === "reasoning-start" ||
      part.type === "reasoning-delta" ||
      part.type === "reasoning-end"
    ) {
      normalizeReasoningResponsePart(state, part)
      continue
    }

    normalizePassthroughResponsePart(state, part)
  }

  for (const text of state.activeTextDeltas.values()) {
    appendNormalizedTextPart(state.normalized, text)
  }
  for (const text of state.activeReasoningDeltas.values()) {
    appendNormalizedReasoningPart(state.normalized, text)
  }

  return state.normalized
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
            data: toPromptFileData(part.image),
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
      case "image":
        content.push(
          Prompt.filePart({
            data: part.image,
            mediaType: part.mediaType ?? "image/png",
          }),
        )
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

const dataUrlToBytes = (value: string): Uint8Array | undefined => {
  const match = /^data:([^;,]+);base64,(.+)$/u.exec(value)
  if (match === null) return undefined
  const data = match[2]
  if (data === undefined) return undefined
  return Uint8Array.from(Buffer.from(data, "base64"))
}

const imagePartToResponseFilePart = (part: ImagePart): Response.FilePart => {
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
                return [Response.makePart("text", { text: part.text })]
              case "reasoning":
                return [Response.makePart("reasoning", { text: part.text })]
              case "tool-call":
                return [
                  Response.makePart("tool-call", {
                    id: part.toolCallId,
                    name: part.toolName,
                    params: part.input,
                    providerExecuted: false,
                  }),
                ]
              case "image": {
                return [imagePartToResponseFilePart(part)]
              }
              default:
                return []
            }
          })
        case "tool":
          return message.parts.flatMap(
            (part): ReadonlyArray<Response.AnyPart> =>
              part.type === "tool-result"
                ? [
                    Response.makePart("tool-result", {
                      id: part.toolCallId,
                      name: part.toolName,
                      isFailure: part.output.type === "error-json",
                      result: part.output.value,
                      encodedResult: part.output.value,
                      providerExecuted: false,
                      preliminary: false,
                    }),
                  ]
                : [],
          )
        default:
          return []
      }
    }),
  )

const responseFilePartToImagePart = (part: Response.FilePart): ImagePart | undefined =>
  part.mediaType.startsWith("image/")
    ? new ImagePart({
        type: "image",
        image: `data:${part.mediaType};base64,${Buffer.from(part.data).toString("base64")}`,
        mediaType: part.mediaType,
      })
    : undefined

interface ResponsePartsAccumulator {
  readonly assistant: Array<TextPart | ReasoningPart | ImagePart | ToolCallPart>
  readonly tool: ToolResultPart[]
  readonly activeTextDeltas: Map<string, string>
  readonly activeReasoningDeltas: Map<string, string>
}

const appendTextResponsePart = (
  part: Response.AnyPart,
  state: ResponsePartsAccumulator,
): boolean => {
  switch (part.type) {
    case "text":
      state.assistant.push(new TextPart({ type: "text", text: part.text }))
      return true
    case "text-start":
      state.activeTextDeltas.set(part.id, "")
      return true
    case "text-delta":
      if (state.activeTextDeltas.has(part.id)) {
        state.activeTextDeltas.set(
          part.id,
          `${state.activeTextDeltas.get(part.id) ?? ""}${part.delta}`,
        )
      }
      return true
    case "text-end": {
      const text = state.activeTextDeltas.get(part.id)
      if (text !== undefined) {
        state.assistant.push(new TextPart({ type: "text", text }))
        state.activeTextDeltas.delete(part.id)
      }
      return true
    }
    default:
      return false
  }
}

const appendReasoningResponsePart = (
  part: Response.AnyPart,
  state: ResponsePartsAccumulator,
): boolean => {
  switch (part.type) {
    case "reasoning":
      state.assistant.push(new ReasoningPart({ type: "reasoning", text: part.text }))
      return true
    case "reasoning-start":
      state.activeReasoningDeltas.set(part.id, "")
      return true
    case "reasoning-delta":
      if (state.activeReasoningDeltas.has(part.id)) {
        state.activeReasoningDeltas.set(
          part.id,
          `${state.activeReasoningDeltas.get(part.id) ?? ""}${part.delta}`,
        )
      }
      return true
    case "reasoning-end": {
      const text = state.activeReasoningDeltas.get(part.id)
      if (text !== undefined) {
        state.assistant.push(new ReasoningPart({ type: "reasoning", text }))
        state.activeReasoningDeltas.delete(part.id)
      }
      return true
    }
    default:
      return false
  }
}

const appendAssistantResponsePart = (
  part: Response.AnyPart,
  state: ResponsePartsAccumulator,
): boolean => {
  switch (part.type) {
    case "file": {
      const imagePart = responseFilePartToImagePart(part)
      if (imagePart !== undefined) state.assistant.push(imagePart)
      return true
    }
    case "tool-call":
      state.assistant.push(
        new ToolCallPart({
          type: "tool-call",
          toolCallId: ToolCallId.of(part.id),
          toolName: part.name,
          input: part.params,
        }),
      )
      return true
    default:
      return false
  }
}

const appendToolResponsePart = (
  part: Response.AnyPart,
  state: ResponsePartsAccumulator,
): boolean => {
  if (part.type !== "tool-result") return false
  if (part.preliminary === true) return true

  state.tool.push(
    new ToolResultPart({
      type: "tool-result",
      toolCallId: ToolCallId.of(part.id),
      toolName: part.name,
      output: {
        type: part.isFailure ? "error-json" : "json",
        value: part.encodedResult,
      },
    }),
  )
  return true
}

export const responsePartsToMessageParts = (
  parts: ReadonlyArray<Response.AnyPart>,
): ResponseMessageParts => {
  const normalized = normalizeResponseParts(parts)
  const state: ResponsePartsAccumulator = {
    assistant: [],
    tool: [],
    activeTextDeltas: new Map(),
    activeReasoningDeltas: new Map(),
  }

  for (const part of normalized) {
    if (appendTextResponsePart(part, state)) continue
    if (appendReasoningResponsePart(part, state)) continue
    if (appendAssistantResponsePart(part, state)) continue
    appendToolResponsePart(part, state)
  }

  return { assistant: state.assistant, tool: state.tool }
}

const toPromptFromToolParts = (
  parts: ReadonlyArray<ToolResultPart>,
): Prompt.ToolMessage | undefined => {
  const content = parts.map((part) =>
    Prompt.toolResultPart({
      id: part.toolCallId,
      name: part.toolName,
      isFailure: part.output.type === "error-json",
      result: part.output.value,
    }),
  )

  return content.length > 0 ? Prompt.toolMessage({ content }) : undefined
}

const toPromptFromResponseAssistantParts = (
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

export const promptFromResponseParts = (parts: ReadonlyArray<Response.AnyPart>): Prompt.Prompt => {
  const normalized = normalizeResponseParts(parts)
  if (!normalized.some((part) => part.type === "file")) {
    return Prompt.fromResponseParts(normalized)
  }

  const promptMessages: Prompt.Message[] = []
  const assistant = toPromptFromResponseAssistantParts(normalized)
  const tool = toPromptFromToolParts(responsePartsToMessageParts(normalized).tool)
  if (assistant !== undefined) promptMessages.push(assistant)
  if (tool !== undefined) promptMessages.push(tool)
  return Prompt.fromMessages(promptMessages)
}

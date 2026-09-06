import { Option } from "effect"
import * as Prompt from "effect/unstable/ai/Prompt"
import type * as Response from "effect/unstable/ai/Response"
import { responseFilePartToImagePart } from "./message-image-conversion.js"
import { normalizeResponseParts } from "./response-part-normalization.js"

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

type AssistantMessagePart =
  | Prompt.TextPart
  | Prompt.ReasoningPart
  | Prompt.FilePart
  | Prompt.ToolCallPart
  | Prompt.ToolApprovalRequestPart

const responsePartToAssistantMessagePartOption = (
  part: Response.AnyPart,
): Option.Option<AssistantMessagePart> => {
  switch (part.type) {
    case "text":
      return Option.some(Prompt.textPart({ text: part.text }))
    case "reasoning":
      return Option.some(Prompt.reasoningPart({ text: part.text }))
    case "file":
      return responseFilePartToImagePart(part)
    case "tool-call":
      return Option.some(
        Prompt.toolCallPart({
          id: part.id,
          name: part.name,
          params: part.params,
          providerExecuted: part.providerExecuted,
        }),
      )
    case "tool-approval-request":
      return Option.some(
        Prompt.toolApprovalRequestPart({
          approvalId: part.approvalId,
          toolCallId: part.toolCallId,
        }),
      )
    default:
      return Option.none()
  }
}

export const responsePartToAssistantMessagePart = (
  part: Response.AnyPart,
  // oxlint-disable-next-line effect/noNullish -- This projection helper preserves the established public absence contract.
): AssistantMessagePart | undefined =>
  Option.getOrUndefined(responsePartToAssistantMessagePartOption(part))

const responsePartToToolResultPartOption = (
  part: Response.AnyPart,
): Option.Option<Prompt.ToolResultPart> => {
  if (part.type !== "tool-result" || part.preliminary === true) return Option.none()
  return Option.some(
    Prompt.toolResultPart({
      id: part.id,
      name: part.name,
      isFailure: part.isFailure,
      providerExecuted: false,
      result: part.encodedResult,
    }),
  )
}

export const responsePartToToolResultPart = (
  part: Response.AnyPart,
  // oxlint-disable-next-line effect/noNullish -- This projection helper preserves the established public absence contract.
): Prompt.ToolResultPart | undefined =>
  Option.getOrUndefined(responsePartToToolResultPartOption(part))

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
    const assistantPart = responsePartToAssistantMessagePartOption(part)
    if (Option.isSome(assistantPart)) {
      assistant.push(assistantPart.value)
      continue
    }
    const toolPart = responsePartToToolResultPartOption(part)
    if (Option.isSome(toolPart)) tool.push(toolPart.value)
  }

  return { assistant, tool }
}

const responsePartsToPromptAssistantMessage = (
  parts: ReadonlyArray<Response.AnyPart>,
): Option.Option<Prompt.AssistantMessage> => {
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

  if (content.length === 0) return Option.none()
  return Option.some(Prompt.assistantMessage({ content }))
}

const responsePartsToPromptToolMessage = (
  parts: ReadonlyArray<Response.AnyPart>,
): Option.Option<Prompt.ToolMessage> => {
  const content = parts.flatMap((part): ReadonlyArray<Prompt.ToolMessagePart> => {
    if (part.type !== "tool-result" || part.preliminary === true) return []
    return [
      Prompt.toolResultPart({
        id: part.id,
        name: part.name,
        isFailure: part.isFailure,
        providerExecuted: false,
        result: part.encodedResult,
      }),
    ]
  })

  if (content.length === 0) return Option.none()
  return Option.some(Prompt.toolMessage({ content }))
}

export const promptFromResponseParts = (parts: ReadonlyArray<Response.AnyPart>): Prompt.Prompt => {
  const normalized = normalizeResponseParts(parts)
  if (!normalized.some((part) => part.type === "file")) {
    return Prompt.fromResponseParts(normalized)
  }

  const promptMessages: Prompt.Message[] = []
  const assistant = responsePartsToPromptAssistantMessage(normalized)
  const tool = responsePartsToPromptToolMessage(normalized)
  if (Option.isSome(assistant)) promptMessages.push(assistant.value)
  if (Option.isSome(tool)) promptMessages.push(tool.value)
  return Prompt.fromMessages(promptMessages)
}

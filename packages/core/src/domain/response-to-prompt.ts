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

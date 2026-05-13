import * as Prompt from "effect/unstable/ai/Prompt"
import * as Response from "effect/unstable/ai/Response"
import { imagePartToResponseFilePart } from "./message-image-conversion.js"
import { type Message, type MessagePart } from "./message.js"
import { normalizeResponseParts } from "./response-part-normalization.js"

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

import { Option, Predicate } from "effect"
import * as Prompt from "effect/unstable/ai/Prompt"
import type * as Response from "effect/unstable/ai/Response"
import { normalizeResponseParts } from "./response-part-normalization.js"
import type { Usage } from "./event.js"

export const responseUsage = (usage: Response.FinishPart["usage"]): Option.Option<Usage> => {
  const inputTokens = usage?.inputTokens?.total
  const outputTokens = usage?.outputTokens?.total
  if (
    Predicate.isUndefined(inputTokens) ||
    Predicate.isUndefined(outputTokens) ||
    !Number.isSafeInteger(inputTokens) ||
    !Number.isSafeInteger(outputTokens) ||
    inputTokens < 0 ||
    outputTokens < 0
  )
    return Option.none()
  const cacheReadTokens = Option.fromUndefinedOr(usage.inputTokens.cacheRead).pipe(
    Option.filter((count) => Number.isSafeInteger(count) && count >= 0),
  )
  const cacheWriteTokens = Option.fromUndefinedOr(usage.inputTokens.cacheWrite).pipe(
    Option.filter((count) => Number.isSafeInteger(count) && count >= 0),
  )
  return Option.some({
    inputTokens,
    outputTokens,
    cacheReadTokens: Option.getOrUndefined(cacheReadTokens),
    cacheWriteTokens: Option.getOrUndefined(cacheWriteTokens),
  })
}

type AssistantMessagePart =
  | Prompt.TextPart
  | Prompt.ReasoningPart
  | Prompt.FilePart
  | Prompt.ToolCallPart
  | Prompt.ToolApprovalRequestPart

interface MessagePartProjection {
  readonly assistant: ReadonlyArray<AssistantMessagePart>
  readonly tool: ReadonlyArray<Prompt.ToolResultPart | Prompt.ToolApprovalResponsePart>
}

const responsePartToAssistantMessagePart = (
  part: Response.AnyPart,
): Option.Option<AssistantMessagePart> => {
  switch (part.type) {
    case "text":
      return Option.some(Prompt.textPart({ text: part.text }))
    case "reasoning":
      return Option.some(Prompt.reasoningPart({ text: part.text }))
    case "file":
      // Only images replay into the transcript; the provider gets a data URL back.
      if (!part.mediaType.startsWith("image/")) return Option.none()
      return Option.some(
        Prompt.filePart({
          data: `data:${part.mediaType};base64,${Buffer.from(part.data).toString("base64")}`,
          mediaType: part.mediaType,
        }),
      )
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

const responsePartToToolResultPart = (
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

export const projectResponsePartsToMessageParts = (
  parts: ReadonlyArray<Response.AnyPart>,
): MessagePartProjection => {
  const normalized = normalizeResponseParts(parts)
  const assistant: Array<AssistantMessagePart> = []
  const tool: Array<Prompt.ToolResultPart | Prompt.ToolApprovalResponsePart> = []

  for (const part of normalized) {
    const assistantPart = responsePartToAssistantMessagePart(part)
    if (Option.isSome(assistantPart)) {
      assistant.push(assistantPart.value)
      continue
    }
    const toolPart = responsePartToToolResultPart(part)
    if (Option.isSome(toolPart)) tool.push(toolPart.value)
  }

  return { assistant, tool }
}

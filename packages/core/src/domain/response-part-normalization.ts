import * as Response from "effect/unstable/ai/Response"

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
  readonly toolCallIds: Set<string>
  readonly toolResultIds: Set<string>
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
      if (part.preliminary === true || state.toolResultIds.has(part.id)) return
      state.toolResultIds.add(part.id)
      state.normalized.push(part)
      return
    case "tool-call":
      if (!state.toolCallIds.has(part.id)) {
        state.toolCallIds.add(part.id)
        state.normalized.push(part)
      }
      return
    case "file":
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
    toolCallIds: new Set<string>(),
    toolResultIds: new Set<string>(),
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

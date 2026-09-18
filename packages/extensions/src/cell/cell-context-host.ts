import { type Message, MessageId, ToolCallId, type BranchId } from "@gent/core/extensions/api"
import {
  ContextDirective,
  MessageStorage,
  ModelContextLedger,
  partToText,
} from "@gent/core/extensions/branch-tools"
import { Effect, Option, Predicate, Schema } from "effect"
import { CellToolOperationStorage } from "./cell-tool-operation-storage.js"
import { CellEvaluationError } from "../cell-protocol.js"

/** Host calls under this prefix serve the cell's `context` namespace, not a selected tool. */
const CONTEXT_CALL_PREFIX = "context."

export const isContextCall = (name: string): boolean => name.startsWith(CONTEXT_CALL_PREFIX)

const DEFAULT_READ_CHARS = 20_000
const MAXIMUM_READ_CHARS = 100_000

const ReadInput = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1)),
  offset: Schema.optional(Schema.Natural),
  limit: Schema.optional(Schema.Natural),
})

const DEFAULT_HISTORY_LIMIT = 50
const MAXIMUM_HISTORY_LIMIT = 200
const HISTORY_PREVIEW_CHARS = 120

const HistoryInput = Schema.Struct({
  offset: Schema.optional(Schema.Natural),
  limit: Schema.optional(Schema.Natural),
})

const CompactInput = Schema.Struct({
  instructions: Schema.optional(Schema.String.check(Schema.isMaxLength(2000))),
})

const WINDOW_NOTICE =
  "Earlier context was dropped from the model view by context.newWindow(). It stays durable: context.history({ offset, limit }) lists it and context.read(messageId) or context.read(toolCallId) recovers any of it."

const ContextOperation = Schema.Literals(["status", "history", "read", "compact", "newWindow"])

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

const failure = (message: string) =>
  new CellEvaluationError({ phase: "execute", message, output: "" })

const messageText = (message: Message): string => message.parts.map(partToText).join("\n")

/** Locate durable text by message id, by a tool result id in the transcript, or by an inner cell operation id. */
const locateText = Effect.fn("CellContextHost.locate")(function* (branchId: BranchId, id: string) {
  const messages = yield* MessageStorage
  const message = yield* messages.getMessage(MessageId.make(id))
  if (Predicate.isNotUndefined(message) && message.branchId === branchId) {
    return Option.some({ kind: "message", text: messageText(message) })
  }
  const toolCallId = ToolCallId.make(id)
  for (const candidate of yield* messages.listMessages(branchId)) {
    for (const part of candidate.parts) {
      if (part.type === "tool-result" && part.id === toolCallId) {
        return Option.some({ kind: "tool-result", text: encodeJson(part.result) })
      }
    }
  }
  const operations = yield* CellToolOperationStorage
  const operation = yield* operations.findByToolCallId({ branchId, toolCallId })
  if (Option.isSome(operation) && operation.value.state._tag === "Completed") {
    return Option.some({
      kind: "cell-operation",
      text: encodeJson(operation.value.state.result.result),
    })
  }
  return Option.none<{ readonly kind: string; readonly text: string }>()
})

/** One line of the branch's durable transcript: enough to decide what to `read`. */
const historyEntry = (message: Message): Schema.Json => {
  const text = messageText(message)
  const base = {
    id: message.id,
    role: message.role,
    chars: text.length,
    preview: text.slice(0, HISTORY_PREVIEW_CHARS).replace(/\s+/g, " "),
    createdAt: message.createdAt.toISOString(),
  }
  return Option.match(Option.fromUndefinedOr(message.metadata?.customType), {
    onNone: (): Schema.Json => base,
    onSome: (kind): Schema.Json => ({ ...base, kind }),
  })
}

interface ReadPage {
  readonly text: string
  readonly totalChars: number
  readonly offset: number
  readonly nextOffset: number
  readonly done: boolean
}

/** A page of characters; every byte of a stored result is reachable by continuing from `nextOffset`. */
export const pageText = (text: string, offset: number, limit: number): ReadPage => {
  const start = Math.min(offset, text.length)
  const boundedLimit = Math.max(1, Math.min(limit, MAXIMUM_READ_CHARS))
  const end = Math.min(text.length, start + boundedLimit)
  return {
    text: text.slice(start, end),
    totalChars: text.length,
    offset: start,
    nextOffset: end,
    done: end >= text.length,
  }
}

/** Serve one `context.*` host call. History and reads are durable lookups; the rest schedule work for the next projection. */
export const handleContextCall = Effect.fn("CellContextHost.call")(function* (params: {
  readonly branchId: BranchId
  readonly name: string
  readonly input: Schema.Json
}) {
  const operation = yield* Schema.decodeUnknownEffect(ContextOperation)(
    params.name.slice(CONTEXT_CALL_PREFIX.length),
  ).pipe(Effect.mapError(() => failure(`Unknown context operation ${params.name}`)))
  const ledger = yield* ModelContextLedger
  switch (operation) {
    case "status": {
      const status = yield* ledger.status
      return Option.match(status, {
        onNone: (): Schema.Json => ({ projected: false }),
        onSome: (value): Schema.Json => ({
          projected: true,
          tokens: value.estimatedTokens,
          limit: value.contextLimitTokens,
          available: value.availableInputTokens,
          percent: Math.round(
            (value.estimatedTokens / Math.max(1, value.contextLimitTokens)) * 100,
          ),
          omittedMessages: value.omittedMessages,
          handoffMessageId: value.handoffMessageId ?? "",
        }),
      })
    }
    case "history": {
      const input = yield* Schema.decodeUnknownEffect(HistoryInput)(params.input).pipe(
        Effect.mapError((cause) => failure(`context.history input is invalid: ${cause.message}`)),
      )
      const messages = yield* MessageStorage
      const all = yield* messages
        .listMessages(params.branchId)
        .pipe(Effect.mapError((cause) => failure(`context.history failed: ${cause.message}`)))
      const offset = Math.min(input.offset ?? 0, all.length)
      const limit = Math.max(
        1,
        Math.min(input.limit ?? DEFAULT_HISTORY_LIMIT, MAXIMUM_HISTORY_LIMIT),
      )
      const page = all.slice(offset, offset + limit)
      const reply: Schema.Json = {
        branchId: params.branchId,
        total: all.length,
        offset,
        nextOffset: offset + page.length,
        done: offset + page.length >= all.length,
        entries: page.map(historyEntry),
      }
      return reply
    }
    case "read": {
      const input = yield* Schema.decodeUnknownEffect(ReadInput)(params.input).pipe(
        Effect.mapError((cause) => failure(`context.read input is invalid: ${cause.message}`)),
      )
      const located = yield* locateText(params.branchId, input.id).pipe(
        Effect.mapError((cause) => failure(`context.read failed: ${cause.message}`)),
      )
      if (Option.isNone(located))
        return yield* failure(`No stored message or result has id ${input.id}`)
      const page = pageText(
        located.value.text,
        input.offset ?? 0,
        input.limit ?? DEFAULT_READ_CHARS,
      )
      const reply: Schema.Json = { id: input.id, kind: located.value.kind, ...page }
      return reply
    }
    case "compact": {
      const input = yield* Schema.decodeUnknownEffect(CompactInput)(params.input).pipe(
        Effect.mapError((cause) => failure(`context.compact input is invalid: ${cause.message}`)),
      )
      yield* ledger.schedule(
        ContextDirective.cases.Compact.make({ instructions: input.instructions }),
      )
      return { scheduled: "compact" } satisfies Schema.Json
    }
    case "newWindow": {
      yield* ledger.schedule(ContextDirective.cases.NewWindow.make({ notice: WINDOW_NOTICE }))
      return { scheduled: "newWindow" } satisfies Schema.Json
    }
  }
})

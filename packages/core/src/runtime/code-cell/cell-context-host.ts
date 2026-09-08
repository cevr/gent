import { Effect, Option, Predicate, Schema } from "effect"
import { type BranchId, MessageId, ToolCallId } from "../../domain/ids.js"
import type { Message } from "../../domain/message.js"
import { MessageStorage } from "../../storage/message-storage.js"
import { CellToolOperationStorage } from "../../storage/cell-tool-operation-storage.js"
import { partToText } from "../model-compaction.js"
import { ContextDirective, ModelContextLedger } from "../model-context-ledger.js"
import { CellEvaluationError } from "./cell-protocol.js"

/** Host calls under this prefix serve the cell's `context` namespace, not a selected tool. */
export const CONTEXT_CALL_PREFIX = "context."

export const isContextCall = (name: string): boolean => name.startsWith(CONTEXT_CALL_PREFIX)

const DEFAULT_READ_LINES = 200
const MAXIMUM_READ_LINES = 2000
const MAXIMUM_READ_CHARS = 100_000

const ReadInput = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1)),
  offset: Schema.optional(Schema.Natural),
  limit: Schema.optional(Schema.Natural),
})

const CompactInput = Schema.Struct({
  instructions: Schema.optional(Schema.String.check(Schema.isMaxLength(2000))),
})

const ContextOperation = Schema.Literals(["status", "read", "compact", "newWindow"])

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

export interface ReadPage {
  readonly text: string
  readonly totalLines: number
  readonly offset: number
  readonly nextOffset: number
  readonly done: boolean
  readonly truncated: boolean
}

/** A page of lines; the reply names how to continue. */
export const pageLines = (text: string, offset: number, limit: number): ReadPage => {
  const lines = text.split("\n")
  const start = Math.min(offset, lines.length)
  const boundedLimit = Math.max(1, Math.min(limit, MAXIMUM_READ_LINES))
  let page = lines.slice(start, start + boundedLimit).join("\n")
  let truncated = false
  if (page.length > MAXIMUM_READ_CHARS) {
    page = page.slice(0, MAXIMUM_READ_CHARS)
    truncated = true
  }
  const end = Math.min(lines.length, start + boundedLimit)
  return {
    text: page,
    totalLines: lines.length,
    offset: start,
    nextOffset: end,
    done: end >= lines.length,
    truncated,
  }
}

/** Serve one `context.*` host call. Reads are durable lookups; the rest schedule work for the next projection. */
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
          compactedRevision: value.compactedRevision ?? "",
        }),
      })
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
      const page = pageLines(
        located.value.text,
        input.offset ?? 0,
        input.limit ?? DEFAULT_READ_LINES,
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
      yield* ledger.schedule(ContextDirective.cases.NewWindow.make({}))
      return { scheduled: "newWindow" } satisfies Schema.Json
    }
  }
})

/**
 * A child session's turns, read through the public facade: how one turn
 * ended (`turnEnd`), its bill (`usageOf`, `receiptTotal`), the messages of
 * the turn one message opened (`startTurnMessages`), and the calls and time
 * of those messages (`turnToolLines`, `toolCountsOf`, `turnDuration`). A
 * thread's round is read this way.
 */
import { Effect, Option, Predicate, Record, Schema, Stream } from "effect"
import {
  type AgentEvent,
  type BranchId,
  ExtensionContext,
  isRuntimeUserMessage,
  type Message,
  type MessageId,
  type SessionId,
  type TurnUsage,
} from "@gent/core/extensions/api"

type TurnCompleted = Extract<AgentEvent, { readonly _tag: "TurnCompleted" }>
const isSynchronized = (event: AgentEvent) => event._tag === "StreamSynchronized"

interface TurnTarget {
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly messageId: MessageId
}

/** How one turn ended: its receipt, and the error the turn ended on, if any. */
interface TurnEnd {
  readonly receipt: TurnCompleted
  /** The last `ErrorOccurred` after the previous receipt that is not a notice. */
  readonly error: Option.Option<string>
  /** When the usage limit that error names resets (its `retryAt`), in epoch milliseconds. */
  readonly retryAt: Option.Option<number>
}

/**
 * The end of one turn, read from the child's durable history alone. The
 * receipt names only that the stream failed; the error before it says why,
 * and a starter that cannot tell a sign-in failure from a flake sends the
 * same work again. A thread's round and a delegate child's start turn are
 * read the same way.
 */
export const turnEnd = (target: TurnTarget) =>
  Effect.gen(function* () {
    const ctx = yield* ExtensionContext
    const folded = yield* ctx.Session.events(target).pipe(
      Stream.takeUntil(isSynchronized),
      Stream.runFold(
        () => ({
          error: Option.none<string>(),
          retryAt: Option.none<number>(),
          end: Option.none<TurnEnd>(),
        }),
        (state, event) => {
          if (event._tag === "ErrorOccurred") {
            if (event.notice === true) return state
            return {
              ...state,
              error: Option.some(event.error),
              retryAt: Option.fromUndefinedOr(event.retryAt),
            }
          }
          if (event._tag !== "TurnCompleted") return state
          // Each receipt closes its turn: an error before it is not the next turn's.
          const cleared = { error: Option.none<string>(), retryAt: Option.none<number>() }
          if (event.messageId !== target.messageId) return { ...state, ...cleared }
          return {
            ...cleared,
            end: Option.some({ receipt: event, error: state.error, retryAt: state.retryAt }),
          }
        },
      ),
    )
    return folded.end
  })

/**
 * A child turn's bill. The cache counts and the cost came later: older rows
 * carry only the tokens. A zero cache count and an unpriced model are left out.
 */
export const ChildUsage = Schema.Struct({
  input: Schema.Finite,
  output: Schema.Finite,
  cacheRead: Schema.optionalKey(Schema.Finite),
  cacheWrite: Schema.optionalKey(Schema.Finite),
  costUsd: Schema.optionalKey(Schema.Finite),
})

/**
 * The bill from a complete turn total. The `turnAfter` hook and the
 * `TurnCompleted` receipt race to write it, so both go through here and a zero
 * or an absent value is dropped the same way.
 */
export const usageOf = (
  usage: Option.Option<TurnUsage["known"]>,
): Option.Option<typeof ChildUsage.Type> =>
  Option.map(usage, (value) => ({
    input: value.inputTokens,
    output: value.outputTokens,
    ...Record.filter(
      { cacheRead: value.cacheReadTokens, cacheWrite: value.cacheWriteTokens },
      (count) => count > 0,
    ),
    ...Option.match(value.costUsd, {
      onNone: () => ({}),
      onSome: (costUsd) => ({ costUsd }),
    }),
  }))

/** A `TurnCompleted` receipt's total, in the shape the `turnAfter` hook gets. */
export const receiptTotal = (receipt: TurnCompleted): Option.Option<TurnUsage["known"]> =>
  Option.map(Option.fromUndefinedOr(receipt.usage), (usage) => ({
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: Option.getOrElse(Option.fromUndefinedOr(usage.cacheReadTokens), () => 0),
    cacheWriteTokens: Option.getOrElse(Option.fromUndefinedOr(usage.cacheWriteTokens), () => 0),
    costUsd: Option.fromUndefinedOr(receipt.costUsd),
  }))

/**
 * The messages of the turn one message opened: that message and every
 * message up to the next one that opened a turn. A forked child's branch
 * begins with a copy of the parent's window; those rows are the parent's,
 * never the child's. The loop's own user-role lines inside the turn (a
 * continuation, the max-steps instruction, a model-change notice, a
 * compaction marker) and a message joined into the running turn open no
 * turn, so the slice reads past them to the answer. A later turn (a wake, a
 * queued message, an interjection that woke the child) opens with a user
 * message of its own, and the slice ends there.
 */
export const startTurnMessages = <
  M extends { readonly id: MessageId } & Parameters<typeof isRuntimeUserMessage>[0],
>(
  messages: ReadonlyArray<M>,
  startId: MessageId,
): ReadonlyArray<M> => {
  const start = messages.findIndex((message) => message.id === startId)
  if (start === -1) return []
  const end = messages
    .slice(start + 1)
    .findIndex((message) => message.role === "user" && !isRuntimeUserMessage(message))
  if (end === -1) return messages.slice(start)
  return messages.slice(start, start + 1 + end)
}

/** One call a turn made, as the round-end row draws it. */
export const ChildToolLine = Schema.Struct({
  name: Schema.String,
  summary: Schema.String,
  status: Schema.Literals(["completed", "error", "incomplete"]),
})
type ChildToolLine = typeof ChildToolLine.Type

/**
 * The receipts a saved cell result carries under `operations`, read
 * leniently. The cell extension writes them (`CellOperationReceipt`).
 */
const CellReceipts = Schema.Struct({
  operations: Schema.Array(
    Schema.Struct({
      tool: Schema.String,
      outcome: Schema.Literals(["succeeded", "failed", "incomplete"]),
      summary: Schema.String,
    }),
  ),
})
const decodeCellReceipts = Schema.decodeUnknownOption(CellReceipts)

const receiptStatus = (outcome: "succeeded" | "failed" | "incomplete"): ChildToolLine["status"] => {
  if (outcome === "succeeded") return "completed"
  if (outcome === "failed") return "error"
  return "incomplete"
}

/** The calls a turn made, from its saved tool results: a cell's receipts stand for the calls it admitted. */
export const turnToolLines = (
  messages: ReadonlyArray<{ readonly parts: ReadonlyArray<Message["parts"][number]> }>,
): ReadonlyArray<ChildToolLine> =>
  messages.flatMap((message) =>
    message.parts.flatMap((part): ReadonlyArray<ChildToolLine> => {
      if (part.type !== "tool-result") return []
      const receipts = Option.filter(decodeCellReceipts(part.result), () => part.name === "cell")
      if (Option.isSome(receipts)) {
        return receipts.value.operations.map((receipt) => ({
          name: receipt.tool,
          summary: receipt.summary,
          status: receiptStatus(receipt.outcome),
        }))
      }
      let status: ChildToolLine["status"] = "completed"
      if (part.isFailure) status = "error"
      return [{ name: part.name, summary: "", status }]
    }),
  )

/** Every call by tool and outcome, in the order each pair first ran. */
export const toolCountsOf = (tools: ReadonlyArray<ChildToolLine>) => {
  const counts = new Map<string, { name: string; status: ChildToolLine["status"]; count: number }>()
  for (const tool of tools) {
    const key = `${tool.name}\u0000${tool.status}`
    const current = counts.get(key)
    if (Predicate.isUndefined(current))
      counts.set(key, { name: tool.name, status: tool.status, count: 1 })
    else current.count += 1
  }
  return Array.from(counts.values())
}

/** The time a turn took: its first message to its last. */
export const turnDuration = (messages: ReadonlyArray<{ readonly createdAt: Date }>): number => {
  const first = messages.at(0)
  const last = messages.at(-1)
  if (Predicate.isUndefined(first) || Predicate.isUndefined(last)) return 0
  return Math.max(0, last.createdAt.getTime() - first.createdAt.getTime())
}

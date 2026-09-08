import { describe, expect, it } from "effect-bun-test"
import { Effect, Layer, Option, Schema } from "effect"
import * as Prompt from "effect/unstable/ai/Prompt"
import { BranchId, MessageId, SessionId, ToolCallId } from "@gent/core-internal/domain/ids"
import { Message, dateFromMillis } from "@gent/core-internal/domain/message"
import { ensureStorageParents } from "@gent/core-internal/test-utils"
import { MessageStorage } from "@gent/core-internal/storage/message-storage"
import { SqliteStorage } from "@gent/core-internal/storage/sqlite-storage"
import { GentPlatform } from "../../src/runtime/gent-platform"
import { handleContextCall, pageText } from "../../src/runtime/code-cell/cell-context-host"
import { ModelContextLedger } from "../../src/runtime/model-context-ledger"

const sessionId = SessionId.make("context-host-session")
const branchId = BranchId.make("context-host-branch")
const decodeReply = Schema.decodeUnknownSync(
  Schema.Struct({
    id: Schema.optional(Schema.String),
    kind: Schema.optional(Schema.String),
    text: Schema.optional(Schema.String),
    totalChars: Schema.optional(Schema.Finite),
    nextOffset: Schema.optional(Schema.Finite),
    done: Schema.optional(Schema.Boolean),
    projected: Schema.optional(Schema.Boolean),
    percent: Schema.optional(Schema.Finite),
    scheduled: Schema.optional(Schema.String),
  }),
)

const layer = Layer.mergeAll(
  SqliteStorage.TestWithSql(),
  GentPlatform.Test(),
  ModelContextLedger.Branch,
)

const seedTranscript = Effect.gen(function* () {
  yield* ensureStorageParents({ sessionId, branchId })
  const storage = yield* MessageStorage
  const lines = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join("\n")
  yield* storage.createMessage(
    Message.cases.regular.make({
      id: MessageId.make("m-long"),
      sessionId,
      branchId,
      role: "assistant",
      parts: [Prompt.textPart({ text: lines })],
      createdAt: dateFromMillis(1_000),
    }),
  )
  yield* storage.createMessage(
    Message.cases.regular.make({
      id: MessageId.make("m-tool"),
      sessionId,
      branchId,
      role: "tool",
      parts: [
        Prompt.toolResultPart({
          id: ToolCallId.make("call-1"),
          name: "read",
          result: { content: "full file body" },
          isFailure: false,
          providerExecuted: false,
        }),
      ],
      createdAt: dateFromMillis(2_000),
    }),
  )
})

describe("cell context host", () => {
  it.live("status reports the last projection or that none exists yet", () =>
    Effect.gen(function* () {
      const before = decodeReply(
        yield* handleContextCall({ branchId, name: "context.status", input: {} }),
      )
      expect(before.projected).toBe(false)
      const ledger = yield* ModelContextLedger
      yield* ledger.recordProjection({
        estimatedTokens: 42,
        availableInputTokens: 58,
        contextLimitTokens: 100,
        omittedMessages: 3,
      })
      const after = decodeReply(
        yield* handleContextCall({ branchId, name: "context.status", input: {} }),
      )
      expect(after.projected).toBe(true)
      expect(after.percent).toBe(42)
    }).pipe(Effect.provide(layer)),
  )

  it.live("read pages a durable message by id and finds a tool result by call id", () =>
    Effect.gen(function* () {
      yield* seedTranscript
      const page = decodeReply(
        yield* handleContextCall({
          branchId,
          name: "context.read",
          input: { id: "m-long", offset: 7, limit: 13 },
        }),
      )
      expect(page.kind).toBe("message")
      expect(page.text).toBe("line 2\nline 3")
      expect(page.totalChars).toBeGreaterThan(200)
      expect(page.nextOffset).toBe(20)
      expect(page.done).toBe(false)
      const result = decodeReply(
        yield* handleContextCall({ branchId, name: "context.read", input: { id: "call-1" } }),
      )
      expect(result.kind).toBe("tool-result")
      expect(result.text).toContain("full file body")
      const missing = yield* handleContextCall({
        branchId,
        name: "context.read",
        input: { id: "nope" },
      }).pipe(Effect.flip)
      expect(missing.message).toContain("No stored message or result has id nope")
    }).pipe(Effect.provide(layer)),
  )

  it.live("compact and newWindow schedule directives the next projection takes", () =>
    Effect.gen(function* () {
      const ledger = yield* ModelContextLedger
      const compact = decodeReply(
        yield* handleContextCall({
          branchId,
          name: "context.compact",
          input: { instructions: "keep file paths" },
        }),
      )
      expect(compact.scheduled).toBe("compact")
      const directive = Option.getOrThrow(yield* ledger.pendingDirective)
      expect(directive._tag).toBe("Compact")
      if (directive._tag === "Compact") expect(directive.instructions).toBe("keep file paths")
      yield* handleContextCall({ branchId, name: "context.newWindow", input: {} })
      expect(Option.map(yield* ledger.pendingDirective, (d) => d._tag)).toEqual(
        Option.some("NewWindow"),
      )
      const unknown = yield* handleContextCall({
        branchId,
        name: "context.reset",
        input: {},
      }).pipe(Effect.flip)
      expect(unknown.message).toContain("Unknown context operation")
    }).pipe(Effect.provide(layer)),
  )

  it.effect("a page clamps its window to the text and reports completion", () =>
    Effect.sync(() => {
      const page = pageText("abcdef", 2, 10)
      expect(page).toEqual({ text: "cdef", totalChars: 6, offset: 2, nextOffset: 6, done: true })
      expect(pageText("ab", 5, 1).text).toBe("")
    }),
  )

  it.effect("a large single-line result is read in full by continuing from nextOffset", () =>
    Effect.sync(() => {
      const text = "x".repeat(250_000)
      let offset = 0
      const pages: Array<string> = []
      for (let guard = 0; guard < 10; guard += 1) {
        const page = pageText(text, offset, 100_000)
        pages.push(page.text)
        offset = page.nextOffset
        if (page.done) break
      }
      expect(pages.map((page) => page.length)).toEqual([100_000, 100_000, 50_000])
      expect(pages.join("")).toBe(text)
    }),
  )
})

/**
 * Compaction reads what the cell dispatched.
 *
 * Core does not know which tools dispatch inner operations; it asks the
 * receipts. The cell is the feature that writes them, so these tests live
 * with the cell rather than with core's compaction unit tests.
 */
import { describe, expect, it } from "effect-bun-test"
import { Effect, Layer, Option, Schema, Stream } from "effect"
import { LanguageModel } from "effect/unstable/ai"
import * as Prompt from "effect/unstable/ai/Prompt"
import {
  BranchId,
  ExtensionId,
  MessageId,
  SessionId,
  ToolCallId,
  ToolId,
} from "@gent/core-internal/domain/ids.js"
import { Message, dateFromMillis } from "@gent/core-internal/domain/message.js"
import { ModelId } from "@gent/core-internal/domain/model.js"
import {
  finishPart,
  LanguageModelLayers,
  textDeltaPart,
} from "@gent/core-internal/test-utils/language-model.js"
import { ensureStorageParents } from "@gent/core-internal/test-utils/index.js"
import {
  makeToolBindingIdentity,
  ToolBindingSource,
  ToolSchemaRevision,
  ToolSourceRevision,
} from "@gent/core-internal/domain/tool-binding.js"
import { CellExecutionStorage } from "../../src/cell/cell-execution-storage.js"
import { CellToolOperationStorage } from "../../src/cell/cell-tool-operation-storage.js"
import { MessageStorage } from "@gent/core-internal/storage/message-storage.js"
import { SqliteStorage } from "@gent/core-internal/storage/sqlite-storage.js"
import { GentPlatform } from "@gent/core-internal/runtime/gent-platform.js"
import { ModelCompactionDetails } from "../../src/compaction/summary-record.js"
import { compactModelContext } from "../../src/compaction/model-compaction.js"
import { ModelContextBudget } from "@gent/core-internal/runtime/model-context.js"
import { CellBranchTools } from "../../src/cell/cell-storage.js"

// The cell's storage carries the projections core reads from it, so this is
// the same wiring production uses.
const storageWithReceipts = SqliteStorage.TestWithSql(
  CellBranchTools.storage,
  CellBranchTools.migrations,
)

const sessionId = SessionId.make("compaction-session")
const branchId = BranchId.make("compaction-branch")
const modelId = ModelId.make("debug/compaction")

const budget = (contextLimitTokens = 20_000): ModelContextBudget =>
  ModelContextBudget.make({
    contextLimitTokens,
    reservedSystemTokens: 0,
    reservedToolTokens: 0,
    reservedOutputTokens: 64,
  })

const textMessage = (id: string, role: "user" | "assistant", text: string, ordinal: number) =>
  Message.cases.regular.make({
    id: MessageId.make(id),
    sessionId,
    branchId,
    role,
    parts: [Prompt.textPart({ text })],
    createdAt: dateFromMillis(1_000 + ordinal),
  })

const createTranscript = Effect.fn("ModelCompactionTest.createTranscript")(function* (
  messages: ReadonlyArray<Message>,
) {
  yield* ensureStorageParents({ sessionId, branchId })
  const storage = yield* MessageStorage
  yield* Effect.forEach(messages, (message) => storage.createMessage(message), { discard: true })
})

describe("compaction over dispatched operations", () => {
  it.live("a dispatching tool reports the paths its inner operations touched", () => {
    // The outer call's own params describe the dispatch, not the files. Core
    // does not know which tools dispatch — the receipts say so.
    const outerCallId = ToolCallId.make("dispatch-outer")
    const outerMessageId = MessageId.make("dispatch-assistant")
    const cell = {
      sessionId,
      branchId,
      assistantMessageId: outerMessageId,
      toolCallId: outerCallId,
    }
    const round = [
      textMessage("dispatch-ask", "user", "read the file through a dispatcher", 1),
      Message.cases.regular.make({
        id: outerMessageId,
        sessionId,
        branchId,
        role: "assistant",
        parts: [
          Prompt.toolCallPart({
            id: outerCallId,
            // A path in the dispatcher's own params, to prove it is ignored.
            name: "cell",
            params: { code: "await tools.call('read', {})", path: "/repo/dispatch.ts" },
            providerExecuted: false,
          }),
        ],
        createdAt: dateFromMillis(1_002),
      }),
      Message.cases.regular.make({
        id: MessageId.make("dispatch-tool"),
        sessionId,
        branchId,
        role: "tool",
        parts: [
          Prompt.toolResultPart({
            id: outerCallId,
            name: "cell",
            isFailure: false,
            providerExecuted: false,
            result: { ok: true },
          }),
        ],
        createdAt: dateFromMillis(1_003),
      }),
      textMessage("dispatch-latest", "user", "next", 10),
    ]
    const binding = makeToolBindingIdentity({
      toolId: ToolId.make("read"),
      extensionId: ExtensionId.make("files"),
      source: ToolBindingSource.cases.Static.make({
        sourceRevision: ToolSourceRevision.make("source-1"),
      }),
      schemaRevision: ToolSchemaRevision.make("schema-1"),
    })
    const providerLayer = LanguageModelLayers.testStream(() =>
      Effect.succeed(
        Stream.fromIterable([
          textDeltaPart("summary"),
          finishPart({ finishReason: "stop", usage: { inputTokens: 20, outputTokens: 4 } }),
        ]),
      ),
    )

    return Effect.scoped(
      Effect.gen(function* () {
        yield* createTranscript(round)
        yield* (yield* CellExecutionStorage).claim(cell)
        yield* (yield* CellToolOperationStorage).admit({
          cell,
          operationId: "1",
          binding,
          input: { path: "/repo/inner.ts" },
        })
        const model = yield* LanguageModel.LanguageModel
        const result = yield* compactModelContext({
          modelId,
          sessionId,
          branchId,
          messages: round,
          budget: budget(),
          force: {},
          summaryModel: Effect.succeed(model),
        })
        expect(result.compacted).toBe(true)
        const details = Option.filter(
          Option.fromNullishOr(
            result.projection.messages.findLast(
              (message) => message.metadata?.customType === "model-compaction",
            )?.metadata?.details,
          ),
          Schema.is(ModelCompactionDetails),
        )
        expect(Option.getOrThrow(details).paths).toEqual({
          read: ["/repo/inner.ts"],
          modified: [],
        })
      }),
    ).pipe(
      Effect.provide(Layer.mergeAll(storageWithReceipts, GentPlatform.Test(), providerLayer)),
      Effect.timeout("10 seconds"),
    )
  })

  it.live("a failed cell without an execution receipt does not block compaction", () => {
    const cellCallId = ToolCallId.make("cell-without-receipt")
    const messages = [
      textMessage("ask", "user", "run a cell", 1),
      Message.cases.regular.make({
        id: MessageId.make("assistant-cell"),
        sessionId,
        branchId,
        role: "assistant",
        parts: [
          Prompt.toolCallPart({
            id: cellCallId,
            name: "cell",
            params: { code: "throw new Error('before run')" },
            providerExecuted: false,
          }),
        ],
        createdAt: dateFromMillis(1_002),
      }),
      Message.cases.regular.make({
        id: MessageId.make("tool-cell"),
        sessionId,
        branchId,
        role: "tool",
        parts: [
          Prompt.toolResultPart({
            id: cellCallId,
            name: "cell",
            isFailure: true,
            providerExecuted: false,
            result: { error: "before run" },
          }),
        ],
        createdAt: dateFromMillis(1_003),
      }),
      textMessage("latest", "user", "next", 10),
    ]
    const providerLayer = LanguageModelLayers.testStream(() =>
      Effect.succeed(
        Stream.fromIterable([
          textDeltaPart("summary"),
          finishPart({ finishReason: "stop", usage: { inputTokens: 20, outputTokens: 4 } }),
        ]),
      ),
    )
    return Effect.scoped(
      Effect.gen(function* () {
        yield* createTranscript(messages)
        const model = yield* LanguageModel.LanguageModel
        const result = yield* compactModelContext({
          modelId,
          sessionId,
          branchId,
          messages,
          budget: budget(),
          force: {},
          summaryModel: Effect.succeed(model),
        })
        expect(result.compacted).toBe(true)
        const details = result.projection.messages.findLast(
          (message) => message.metadata?.customType === "model-compaction",
        )?.metadata?.details
        expect(Schema.is(ModelCompactionDetails)(details)).toBe(true)
        if (Schema.is(ModelCompactionDetails)(details)) {
          expect(details.paths).toEqual({ read: [], modified: [] })
        }
      }),
    ).pipe(
      Effect.provide(Layer.mergeAll(storageWithReceipts, GentPlatform.Test(), providerLayer)),
      Effect.timeout("10 seconds"),
    )
  })
})

import { describe, expect, test } from "bun:test"
import { Option, Result, Schema } from "effect"
import * as Prompt from "effect/unstable/ai/Prompt"
import { BranchId, MessageId, SessionId, ToolCallId } from "@gent/core-internal/domain/ids"
import { dateFromMillis, Message, type MessagePart } from "@gent/core-internal/domain/message"
import { estimateTokens } from "../../src/runtime/context-estimation"
import {
  ModelContextBudget,
  ModelContextError,
  ModelContextProjection,
  projectModelContext,
  type ModelContextError as ModelContextErrorValue,
  type ModelContextProjection as ModelContextProjectionValue,
} from "../../src/runtime/model-context"

interface TestMessageOptional {
  metadata?: {
    readonly customType?: string
    readonly extensionId?: string
    readonly hidden?: boolean
    readonly details?: unknown
  }
}

const sessionId = SessionId.make("session")
const branchId = BranchId.make("branch")
const createdAt = dateFromMillis(1_767_225_600_000)

const text = (value: string): MessagePart => Prompt.textPart({ text: value })

const call = (id: string, name = "read"): MessagePart =>
  Prompt.toolCallPart({
    id: ToolCallId.make(id),
    name,
    params: { path: id },
    providerExecuted: false,
  })

const result = (id: string, name = "read"): MessagePart =>
  Prompt.toolResultPart({
    id: ToolCallId.make(id),
    name,
    isFailure: false,
    providerExecuted: false,
    result: { value: id },
  })

const message = (
  id: string,
  role: "user" | "assistant" | "system" | "tool",
  parts: ReadonlyArray<MessagePart>,
  metadata?: TestMessageOptional["metadata"],
): Message => {
  const optional: TestMessageOptional = {}
  const maybeMetadata = Option.fromNullishOr(metadata)
  if (Option.isSome(maybeMetadata)) optional.metadata = maybeMetadata.value
  return Message.cases.regular.make({
    id: MessageId.make(id),
    sessionId,
    branchId,
    role,
    parts: [...parts],
    createdAt,
    ...optional,
  })
}

const budget = (contextLimitTokens: number): ModelContextBudget =>
  ModelContextBudget.make({
    contextLimitTokens,
    reservedSystemTokens: 0,
    reservedToolTokens: 0,
    reservedOutputTokens: 0,
  })

const success = (value: ReturnType<typeof projectModelContext>): ModelContextProjectionValue =>
  Result.getOrThrow(value)

const failure = (value: ReturnType<typeof projectModelContext>): ModelContextErrorValue =>
  Result.getOrThrow(Result.flip(value))

const ids = (projection: ModelContextProjectionValue): ReadonlyArray<string> =>
  projection.messages.map((item) => item.id)

describe("projectModelContext", () => {
  test("selects a newest suffix and reports separate reservations", () => {
    const messages = [
      message("old", "assistant", [text("old!")]),
      message("user", "user", [text("user")]),
      message("answer", "assistant", [text("done")]),
    ]
    const result = projectModelContext(
      messages,
      ModelContextBudget.make({
        contextLimitTokens: 5,
        reservedSystemTokens: 1,
        reservedToolTokens: 1,
        reservedOutputTokens: 1,
      }),
    )

    const projection = success(result)
    expect(projection.availableInputTokens).toBe(2)
    expect(projection.estimatedTokens).toBe(2)
    expect(ids(projection)).toEqual(["user", "answer"])
    expect(projection.omittedMessageIds).toEqual([MessageId.make("old")])
    expect(projection.truncated).toBe(true)
  })

  test("is deterministic for the same ordered input and does not mutate it", () => {
    const messages = [
      message("first", "user", [text("first")]),
      message("second", "assistant", [text("second")]),
      message("latest", "user", [text("latest")]),
    ]
    const snapshot = [...messages]
    const first = success(projectModelContext(messages, budget(2)))
    const second = success(projectModelContext(messages, budget(2)))
    const firstIds = ids(first)

    expect(firstIds).toEqual(ids(second))
    expect(first.omittedMessageIds).toEqual(second.omittedMessageIds)
    expect(messages).toEqual(snapshot)
    expect(first.messages).not.toBe(messages)
    messages.reverse()
    expect(ids(first)).toEqual(firstIds)
  })

  test("keeps a complete single tool group indivisible", () => {
    const user = message("user", "user", [text("user")])
    const assistant = message("call", "assistant", [call("call-1")])
    const tool = message("result", "tool", [result("call-1")])
    const old = message("old", "assistant", [text("old")])
    const available = estimateTokens([user, assistant, tool])

    const projection = success(projectModelContext([old, user, assistant, tool], budget(available)))

    expect(ids(projection)).toEqual(["user", "call", "result"])
    expect(projection.omittedMessageIds).toEqual([MessageId.make("old")])
  })

  test("keeps parallel calls and all results in one selection unit", () => {
    const user = message("user", "user", [text("user")])
    const assistant = message("calls", "assistant", [call("call-1"), call("call-2")])
    const firstResult = message("result-1", "tool", [result("call-1")])
    const secondResult = message("result-2", "tool", [result("call-2")])
    const old = message("old", "assistant", [text("old")])
    const available = estimateTokens([user, assistant, firstResult, secondResult])

    const projection = success(
      projectModelContext([old, user, assistant, firstResult, secondResult], budget(available)),
    )

    expect(ids(projection)).toEqual(["user", "calls", "result-1", "result-2"])
    expect(projection.omittedMessageIds).toEqual([MessageId.make("old")])
  })

  test("rejects an oversized newest user turn instead of returning an empty prompt", () => {
    const messages = [
      message("old", "assistant", [text("old")]),
      message("latest", "user", [text("latest")]),
    ]
    const available = estimateTokens([messages[1]!])
    const error = failure(projectModelContext(messages, budget(available - 1)))

    expect(error._tag).toBe("BudgetExceeded")
    if (error._tag === "BudgetExceeded") {
      expect(error.messageIds).toEqual([MessageId.make("latest")])
      expect(error.estimatedTokens).toBe(2)
      expect(error.availableInputTokens).toBe(1)
    }
  })

  test("rejects reservations that leave no valid input budget", () => {
    const error = failure(
      projectModelContext(
        [message("user", "user", [text("user")])],
        ModelContextBudget.make({
          contextLimitTokens: 3,
          reservedSystemTokens: 1,
          reservedToolTokens: 1,
          reservedOutputTokens: 2,
        }),
      ),
    )

    expect(error).toEqual(
      ModelContextError.cases.ReserveExhausted.make({
        contextLimitTokens: 3,
        reservedTokens: 4,
      }),
    )
  })

  test("requires decoded non-negative finite budget fields", () => {
    const decodeBudget = Schema.decodeSync(ModelContextBudget)

    expect(() =>
      decodeBudget({
        contextLimitTokens: -1,
        reservedSystemTokens: 0,
        reservedToolTokens: 0,
        reservedOutputTokens: 0,
      }),
    ).toThrow()
    expect(() =>
      decodeBudget({
        contextLimitTokens: Number.NaN,
        reservedSystemTokens: 0,
        reservedToolTokens: 0,
        reservedOutputTokens: 0,
      }),
    ).toThrow()
  })

  test("omits a hidden complete tool group without breaking visible history", () => {
    const messages = [
      message("hidden-call", "assistant", [call("hidden")], { hidden: true }),
      message("hidden-result", "tool", [result("hidden")], { hidden: true }),
      message("visible", "user", [text("visible")]),
    ]

    const projection = success(projectModelContext(messages, budget(10)))

    expect(ids(projection)).toEqual(["visible"])
    expect(projection.omittedMessageIds).toEqual([])
    expect(projection.truncated).toBe(false)
  })

  test("rejects a visible result whose call is hidden", () => {
    const error = failure(
      projectModelContext(
        [
          message("hidden-call", "assistant", [call("hidden")], { hidden: true }),
          message("visible-result", "tool", [result("hidden")]),
        ],
        budget(10),
      ),
    )

    expect(error._tag).toBe("OrphanToolResult")
  })

  test("rejects a visible call whose result is hidden", () => {
    const error = failure(
      projectModelContext(
        [
          message("visible-call", "assistant", [call("hidden-result")]),
          message("hidden-result", "tool", [result("hidden-result")], { hidden: true }),
        ],
        budget(10),
      ),
    )

    expect(error._tag).toBe("IncompleteToolCallGroup")
  })

  test("rejects duplicate call and result IDs", () => {
    const duplicateCall = failure(
      projectModelContext(
        [
          message("call-1", "assistant", [call("duplicate")]),
          message("call-2", "assistant", [call("duplicate")]),
        ],
        budget(10),
      ),
    )
    expect(duplicateCall).toEqual(
      ModelContextError.cases.DuplicateToolCallId.make({ id: ToolCallId.make("duplicate") }),
    )

    const duplicateResult = failure(
      projectModelContext(
        [
          message("call", "assistant", [call("duplicate-result")]),
          message("result-1", "tool", [result("duplicate-result")]),
          message("result-2", "tool", [result("duplicate-result")]),
        ],
        budget(10),
      ),
    )
    expect(duplicateResult).toEqual(
      ModelContextError.cases.DuplicateToolResultId.make({
        id: ToolCallId.make("duplicate-result"),
      }),
    )
  })

  test("rejects orphan, incomplete, and mismatched tool groups", () => {
    const orphan = failure(
      projectModelContext([message("orphan", "tool", [result("missing")])], budget(10)),
    )
    expect(orphan._tag).toBe("OrphanToolResult")

    const incomplete = failure(
      projectModelContext(
        [message("incomplete", "assistant", [call("missing-result")])],
        budget(10),
      ),
    )
    expect(incomplete._tag).toBe("IncompleteToolCallGroup")

    const mismatched = failure(
      projectModelContext(
        [
          message("call", "assistant", [call("mismatch", "read")]),
          message("result", "tool", [result("mismatch", "write")]),
        ],
        budget(10),
      ),
    )
    expect(mismatched).toEqual(
      ModelContextError.cases.MismatchedToolResultName.make({
        id: ToolCallId.make("mismatch"),
        expectedName: "read",
        actualName: "write",
      }),
    )
  })

  test("rejects tool parts in roles that cannot represent them", () => {
    const callError = failure(
      projectModelContext([message("user-call", "user", [call("wrong-role")])], budget(10)),
    )
    expect(callError._tag).toBe("ToolCallWrongRole")

    const resultError = failure(
      projectModelContext(
        [message("assistant-result", "assistant", [result("wrong-role")])],
        budget(10),
      ),
    )
    expect(resultError._tag).toBe("ToolResultWrongRole")
  })

  test("returns a schema-decodable success value", () => {
    const projection = success(
      projectModelContext([message("user", "user", [text("hello")])], budget(10)),
    )

    expect(Schema.decodeSync(ModelContextProjection)(projection)).toEqual(projection)
  })
})

import { Option, Result, Schema } from "effect"
import type { ToolCapability } from "../domain/capability/tool.js"
import { Message, MessageRole } from "../domain/message.js"
import { MessageId, ToolCallId } from "../domain/ids.js"
import { estimateTokens } from "./context-estimation.js"

/** Output budget used by the native model request and its context projection. */
export const MODEL_OUTPUT_RESERVE_TOKENS = 4_096

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

const estimateTextTokens = (text: string): number => Math.ceil(text.length / 4)

/** Estimate the tokens occupied by the resolved system prompt. */
export const estimateSystemPromptTokens = (systemPrompt: string): number =>
  estimateTextTokens(systemPrompt)

/**
 * Estimate the tokens occupied by the tool definitions sent to the provider.
 * The provider owns the exact encoding. This estimate uses the same advertised
 * names, descriptions, and JSON parameter schemas supplied to Effect AI.
 */
export const estimateToolSchemaTokens = (tools: ReadonlyArray<ToolCapability>): number => {
  const definitions = tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: Schema.toJsonSchemaDocument(tool.parametersSchema),
  }))
  return estimateTextTokens(encodeJson(definitions))
}

/** The separate context reservations supplied by the model host. */
export const ModelContextBudget = Schema.Struct({
  contextLimitTokens: Schema.Natural,
  reservedSystemTokens: Schema.Natural,
  reservedToolTokens: Schema.Natural,
  reservedOutputTokens: Schema.Natural,
})
export type ModelContextBudget = typeof ModelContextBudget.Type

/** Schema-backed failures found before a prompt projection is returned. */
export const ModelContextError = Schema.TaggedUnion({
  ReserveExhausted: {
    contextLimitTokens: Schema.Natural,
    reservedTokens: Schema.Natural,
  },
  DuplicateToolCallId: {
    id: ToolCallId,
  },
  DuplicateToolResultId: {
    id: ToolCallId,
  },
  OrphanToolResult: {
    id: ToolCallId,
    name: Schema.String,
  },
  MismatchedToolResultName: {
    id: ToolCallId,
    expectedName: Schema.String,
    actualName: Schema.String,
  },
  ToolResultBeforeCall: {
    id: ToolCallId,
  },
  ToolCallWrongRole: {
    id: ToolCallId,
    role: MessageRole,
  },
  ToolResultWrongRole: {
    id: ToolCallId,
    role: MessageRole,
  },
  IncompleteToolCallGroup: {
    ids: Schema.Array(ToolCallId),
  },
  InterleavedToolCallGroup: {
    messageIds: Schema.Array(MessageId),
  },
  BudgetExceeded: {
    messageIds: Schema.Array(MessageId),
    estimatedTokens: Schema.Natural,
    availableInputTokens: Schema.Natural,
  },
})
export type ModelContextError = typeof ModelContextError.Type

/** Capability failures found before a model prompt can be projected. */
export const ModelContextCapabilityFailure = Schema.TaggedUnion({
  UnknownModel: {
    modelId: Schema.String,
  },
  MissingContextLimit: {
    modelId: Schema.String,
  },
  InvalidContextLimit: {
    modelId: Schema.String,
    reason: Schema.String,
  },
})
export type ModelContextCapabilityFailure = typeof ModelContextCapabilityFailure.Type

export class ModelContextCapabilityError extends Schema.TaggedError<ModelContextCapabilityError>()(
  "ModelContextCapabilityError",
  {
    failure: ModelContextCapabilityFailure,
  },
) {}

export class ModelContextProjectionError extends Schema.TaggedError<ModelContextProjectionError>()(
  "ModelContextProjectionError",
  {
    modelId: Schema.String,
    failure: ModelContextError,
  },
) {}

/** A bounded, model-only snapshot of durable messages. */
export const ModelContextProjection = Schema.Struct({
  messages: Schema.Array(Message),
  estimatedTokens: Schema.Natural,
  availableInputTokens: Schema.Natural,
  omittedMessageIds: Schema.Array(MessageId),
  truncated: Schema.Boolean,
})
export type ModelContextProjection = typeof ModelContextProjection.Type

interface ToolCallRecord {
  readonly id: ToolCallId
  readonly name: string
  readonly messageIndex: number
}

interface ToolResultRecord {
  readonly id: ToolCallId
  readonly name: string
  readonly messageIndex: number
}

interface ToolGroup {
  readonly start: number
  readonly end: number
}

interface ProjectionUnit {
  readonly start: number
  readonly end: number
  readonly messages: ReadonlyArray<Message>
  readonly estimatedTokens: number
}

interface ToolRecords {
  readonly calls: ReadonlyMap<ToolCallId, ToolCallRecord>
  readonly results: ReadonlyMap<ToolCallId, ToolResultRecord>
}

const compareIds = (left: string, right: string): number => {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

const sortedIds = (ids: ReadonlyArray<ToolCallId>): ReadonlyArray<ToolCallId> =>
  [...ids].sort(compareIds)

const visibleSnapshot = (messages: ReadonlyArray<Message>): ReadonlyArray<Message> => {
  const snapshot = [...messages]
  return snapshot.filter((message) => message.metadata?.hidden !== true)
}

const addToolCall = (
  calls: Map<ToolCallId, ToolCallRecord>,
  message: Message,
  messageIndex: number,
  id: ToolCallId,
  name: string,
): Result.Result<void, ModelContextError> => {
  if (message.role !== "assistant") {
    return Result.fail(
      ModelContextError.cases.ToolCallWrongRole.make({
        id,
        role: message.role,
      }),
    )
  }
  if (calls.has(id)) return Result.fail(ModelContextError.cases.DuplicateToolCallId.make({ id }))
  calls.set(id, {
    id,
    name,
    messageIndex,
  })
  return Result.void
}

const addToolResult = (
  results: Map<ToolCallId, ToolResultRecord>,
  message: Message,
  messageIndex: number,
  id: ToolCallId,
  name: string,
): Result.Result<void, ModelContextError> => {
  if (message.role !== "tool") {
    return Result.fail(
      ModelContextError.cases.ToolResultWrongRole.make({
        id,
        role: message.role,
      }),
    )
  }
  if (results.has(id))
    return Result.fail(ModelContextError.cases.DuplicateToolResultId.make({ id }))
  results.set(id, {
    id,
    name,
    messageIndex,
  })
  return Result.void
}

const collectMessageToolRecords = (
  message: Message,
  messageIndex: number,
  calls: Map<ToolCallId, ToolCallRecord>,
  results: Map<ToolCallId, ToolResultRecord>,
): Result.Result<void, ModelContextError> => {
  for (const part of message.parts) {
    if (part.type === "tool-call") {
      const added = addToolCall(calls, message, messageIndex, ToolCallId.make(part.id), part.name)
      if (Result.isFailure(added)) return Result.fail(added.failure)
      continue
    }
    if (part.type === "tool-result") {
      const added = addToolResult(
        results,
        message,
        messageIndex,
        ToolCallId.make(part.id),
        part.name,
      )
      if (Result.isFailure(added)) return Result.fail(added.failure)
    }
  }
  return Result.void
}

const validateToolRecords = (
  calls: ReadonlyMap<ToolCallId, ToolCallRecord>,
  results: ReadonlyMap<ToolCallId, ToolResultRecord>,
): Result.Result<void, ModelContextError> => {
  for (const result of results.values()) {
    const call = Option.fromNullishOr(calls.get(result.id))
    if (Option.isNone(call)) {
      return Result.fail(
        ModelContextError.cases.OrphanToolResult.make({
          id: result.id,
          name: result.name,
        }),
      )
    }
    if (result.messageIndex <= call.value.messageIndex) {
      return Result.fail(ModelContextError.cases.ToolResultBeforeCall.make({ id: result.id }))
    }
    if (result.name !== call.value.name) {
      return Result.fail(
        ModelContextError.cases.MismatchedToolResultName.make({
          id: result.id,
          expectedName: call.value.name,
          actualName: result.name,
        }),
      )
    }
  }

  const incomplete: Array<ToolCallId> = []
  for (const call of calls.values()) {
    if (!results.has(call.id)) incomplete.push(call.id)
  }
  if (incomplete.length > 0) {
    return Result.fail(
      ModelContextError.cases.IncompleteToolCallGroup.make({
        ids: sortedIds(incomplete),
      }),
    )
  }
  return Result.void
}

const collectToolRecords = (
  messages: ReadonlyArray<Message>,
): Result.Result<ToolRecords, ModelContextError> => {
  const calls = new Map<ToolCallId, ToolCallRecord>()
  const results = new Map<ToolCallId, ToolResultRecord>()

  for (const [messageIndex, message] of messages.entries()) {
    const collected = collectMessageToolRecords(message, messageIndex, calls, results)
    if (Result.isFailure(collected)) return Result.fail(collected.failure)
  }

  const validated = validateToolRecords(calls, results)
  if (Result.isFailure(validated)) return Result.fail(validated.failure)
  return Result.succeed({ calls, results })
}

const addCallToGroupMap = (
  callsByMessage: Map<number, Array<ToolCallRecord>>,
  call: ToolCallRecord,
): void => {
  const calls = Option.fromNullishOr(callsByMessage.get(call.messageIndex))
  if (Option.isSome(calls)) {
    calls.value.push(call)
    return
  }
  callsByMessage.set(call.messageIndex, [call])
}

const resultIndexesForCalls = (
  calls: ReadonlyArray<ToolCallRecord>,
  results: ReadonlyMap<ToolCallId, ToolResultRecord>,
): ReadonlyArray<number> => {
  const indexes: Array<number> = []
  for (const call of calls) {
    const result = Option.fromNullishOr(results.get(call.id))
    if (Option.isSome(result)) indexes.push(result.value.messageIndex)
  }
  return indexes
}

const interleavedMessageIds = (
  messages: ReadonlyArray<Message>,
  start: number,
  end: number,
): Option.Option<ReadonlyArray<MessageId>> => {
  for (let index = start + 1; index < end; index += 1) {
    const message = Option.fromNullishOr(messages[index])
    if (Option.isSome(message) && message.value.role !== "tool") {
      return Option.some(messages.slice(start, end + 1).map((item) => item.id))
    }
  }
  return Option.none()
}

const groupToolCalls = (
  messages: ReadonlyArray<Message>,
  records: ToolRecords,
): Result.Result<ReadonlyArray<ToolGroup>, ModelContextError> => {
  const callsByMessage = new Map<number, Array<ToolCallRecord>>()
  for (const call of records.calls.values()) addCallToGroupMap(callsByMessage, call)

  const callMessageIndexes = [...callsByMessage.keys()].sort((left, right) => left - right)
  const groups: Array<ToolGroup> = []
  let previousEnd = -1
  for (const start of callMessageIndexes) {
    const calls = Option.fromNullishOr(callsByMessage.get(start))
    if (Option.isNone(calls)) continue
    const resultIndexes = resultIndexesForCalls(calls.value, records.results)
    const end = Math.max(...resultIndexes)
    const messageIds = messages.slice(start, end + 1).map((message) => message.id)
    if (start <= previousEnd) {
      return Result.fail(ModelContextError.cases.InterleavedToolCallGroup.make({ messageIds }))
    }
    const interleaved = interleavedMessageIds(messages, start, end)
    if (Option.isSome(interleaved)) {
      return Result.fail(
        ModelContextError.cases.InterleavedToolCallGroup.make({
          messageIds: interleaved.value,
        }),
      )
    }
    groups.push({ start, end })
    previousEnd = end
  }
  return Result.succeed(groups)
}

const buildUnits = (
  messages: ReadonlyArray<Message>,
  groups: ReadonlyArray<ToolGroup>,
): ReadonlyArray<ProjectionUnit> => {
  const groupByStart = new Map<number, ToolGroup>()
  const groupedIndexes = new Set<number>()
  for (const group of groups) {
    groupByStart.set(group.start, group)
    for (let index = group.start; index <= group.end; index += 1) groupedIndexes.add(index)
  }

  const units: Array<ProjectionUnit> = []
  for (let index = 0; index < messages.length; index += 1) {
    const group = Option.fromNullishOr(groupByStart.get(index))
    if (Option.isSome(group)) {
      const groupMessages = messages.slice(group.value.start, group.value.end + 1)
      units.push({
        start: group.value.start,
        end: group.value.end,
        messages: groupMessages,
        estimatedTokens: estimateTokens(groupMessages),
      })
      index = group.value.end
      continue
    }
    if (groupedIndexes.has(index)) continue
    const message = Option.fromNullishOr(messages[index])
    if (Option.isSome(message)) {
      units.push({
        start: index,
        end: index,
        messages: [message.value],
        estimatedTokens: estimateTokens([message.value]),
      })
    }
  }
  return units
}

const messageIds = (units: ReadonlyArray<ProjectionUnit>): ReadonlyArray<MessageId> => {
  const ids: Array<MessageId> = []
  for (const unit of units) {
    for (const message of unit.messages) ids.push(message.id)
  }
  return ids
}

const latestUserUnit = (units: ReadonlyArray<ProjectionUnit>): Option.Option<number> => {
  let latest: Option.Option<number> = Option.none()
  for (const [index, unit] of units.entries()) {
    if (unit.messages.some((message) => message.role === "user")) latest = Option.some(index)
  }
  return latest
}

const reserveTotal = (budget: ModelContextBudget): number =>
  budget.reservedSystemTokens + budget.reservedToolTokens + budget.reservedOutputTokens

interface SelectedUnits {
  readonly start: number
  readonly estimatedTokens: number
}

const budgetExceeded = (
  units: ReadonlyArray<ProjectionUnit>,
  availableInputTokens: number,
): Result.Result<never, ModelContextError> => {
  const estimatedTokens = units.reduce((total, unit) => total + unit.estimatedTokens, 0)
  return Result.fail(
    ModelContextError.cases.BudgetExceeded.make({
      messageIds: messageIds(units),
      estimatedTokens,
      availableInputTokens,
    }),
  )
}

const selectWithLatestUser = (
  units: ReadonlyArray<ProjectionUnit>,
  latestUserIndex: number,
  availableInputTokens: number,
): Result.Result<SelectedUnits, ModelContextError> => {
  const tail = units.slice(latestUserIndex)
  const tailTokens = tail.reduce((total, unit) => total + unit.estimatedTokens, 0)
  if (tailTokens > availableInputTokens) return budgetExceeded(tail, availableInputTokens)

  let selectedStart = latestUserIndex
  let selectedTokens = tailTokens
  for (let index = latestUserIndex - 1; index >= 0; index -= 1) {
    const unit = Option.fromNullishOr(units[index])
    if (Option.isNone(unit)) continue
    if (selectedTokens + unit.value.estimatedTokens > availableInputTokens) break
    selectedStart = index
    selectedTokens += unit.value.estimatedTokens
  }
  return Result.succeed({ start: selectedStart, estimatedTokens: selectedTokens })
}

const selectWithoutUser = (
  units: ReadonlyArray<ProjectionUnit>,
  availableInputTokens: number,
): Result.Result<SelectedUnits, ModelContextError> => {
  const lastUnit = Option.fromNullishOr(units[units.length - 1])
  if (Option.isSome(lastUnit) && lastUnit.value.estimatedTokens > availableInputTokens) {
    return budgetExceeded([lastUnit.value], availableInputTokens)
  }

  let selectedStart = units.length
  let selectedTokens = 0
  for (let index = units.length - 1; index >= 0; index -= 1) {
    const unit = Option.fromNullishOr(units[index])
    if (Option.isNone(unit)) continue
    if (selectedTokens + unit.value.estimatedTokens > availableInputTokens) break
    selectedStart = index
    selectedTokens += unit.value.estimatedTokens
  }
  return Result.succeed({ start: selectedStart, estimatedTokens: selectedTokens })
}

const selectUnits = (
  units: ReadonlyArray<ProjectionUnit>,
  latestUser: Option.Option<number>,
  availableInputTokens: number,
): Result.Result<SelectedUnits, ModelContextError> => {
  if (Option.isSome(latestUser)) {
    return selectWithLatestUser(units, latestUser.value, availableInputTokens)
  }
  return selectWithoutUser(units, availableInputTokens)
}

const projectUnits = (
  units: ReadonlyArray<ProjectionUnit>,
  budget: ModelContextBudget,
): Result.Result<ModelContextProjection, ModelContextError> => {
  const reservedTokens = reserveTotal(budget)
  if (reservedTokens > budget.contextLimitTokens) {
    return Result.fail(
      ModelContextError.cases.ReserveExhausted.make({
        contextLimitTokens: budget.contextLimitTokens,
        reservedTokens,
      }),
    )
  }

  const availableInputTokens = budget.contextLimitTokens - reservedTokens
  const latestUser = latestUserUnit(units)
  const selected = selectUnits(units, latestUser, availableInputTokens)
  if (Result.isFailure(selected)) return Result.fail(selected.failure)

  const selectedUnits = units.slice(selected.success.start)
  const selectedMessages = selectedUnits.flatMap((unit) => unit.messages)
  const omittedMessageIds = messageIds(units.slice(0, selected.success.start))
  return Result.succeed(
    ModelContextProjection.make({
      messages: [...selectedMessages],
      estimatedTokens: selected.success.estimatedTokens,
      availableInputTokens,
      omittedMessageIds: [...omittedMessageIds],
      truncated: omittedMessageIds.length > 0,
    }),
  )
}

/**
 * Build a pure, bounded model-context snapshot.
 *
 * Token counts are estimates. The caller must provide separate reservations
 * for the system prompt, tool definitions, and model output. Decode untrusted
 * budget input with `Schema.decodeUnknown` before calling this typed function.
 */
export const projectModelContext = (
  messages: ReadonlyArray<Message>,
  budget: ModelContextBudget,
): Result.Result<ModelContextProjection, ModelContextError> => {
  const visible = visibleSnapshot(messages)
  const records = collectToolRecords(visible)
  if (Result.isFailure(records)) return Result.fail(records.failure)

  const groups = groupToolCalls(visible, records.success)
  if (Result.isFailure(groups)) return Result.fail(groups.failure)

  return projectUnits(buildUnits(visible, groups.success), budget)
}

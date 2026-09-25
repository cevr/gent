import {
  Context,
  DateTime,
  Effect,
  Layer,
  Option,
  Predicate,
  Record,
  Ref,
  Result,
  Schema,
  type Scope,
} from "effect"
import * as Prompt from "effect/unstable/ai/Prompt"
import {
  encodeToolOutput,
  headTailChars,
  isRuntimeUserMessage,
  Message,
  MessageRole,
  messageWithParts,
  type RuntimeUserMessageType,
} from "../domain/message.js"
import { ErrorOccurred, EventStore, type EventStoreError, UsageSchema } from "../domain/event.js"
import { type BranchId, MessageId, type SessionId, ToolCallId } from "../domain/ids.js"
import { ModelId } from "../domain/agent.js"
import type { ToolCapability } from "../domain/capability.js"
import type { TurnNotice } from "../domain/extension.js"
import type { LanguageModel } from "effect/unstable/ai"
import type { ProviderAuthError } from "../domain/driver.js"
import type { ProviderError, StorageError } from "../domain/errors.js"
import type { EventStorageError } from "../storage/storage.js"

// ── ai-transcript ───────────────────────────────────────────────────────────

interface PromptTranscriptOptions {
  /**
   * The system prompt in cache blocks, one leading system message each: a
   * driver can end a cached prefix at a block (see `systemPromptBlocks`).
   */
  readonly systemPrompt?: ReadonlyArray<string>
  readonly includeHidden?: boolean
  /** The turn's notices, placed after the conversation; see `turnNoticesText`. */
  readonly notices?: ReadonlyArray<TurnNotice>
}

const isAiVisibleMessage = (message: Message): boolean => message.metadata?.hidden !== true

const toSystemMessage = (message: Message): Option.Option<Prompt.SystemMessage> => {
  const text = message.parts
    .filter((part): part is Prompt.TextPart => part.type === "text")
    .map((part) => part.text)
    .join("\n")

  if (text.length === 0) return Option.none()
  return Option.some(Prompt.systemMessage({ content: text }))
}

const toUserMessage = (message: Message): Option.Option<Prompt.UserMessage> => {
  const content: Prompt.UserMessagePart[] = []

  for (const part of message.parts) {
    switch (part.type) {
      case "text":
      case "file":
        content.push(part)
        break
      default:
        break
    }
  }

  if (content.length === 0) return Option.none()
  return Option.some(Prompt.userMessage({ content }))
}

/**
 * Whether an assistant message's reasoning goes back with its provider state
 * (a thinking signature, encrypted reasoning). That state is valid only for
 * the model that produced it, so a message above the latest model-change
 * notice sends its reasoning as text alone, which the providers drop.
 *
 * The state has other bindings the loop cannot see, and each provider adapter
 * keeps them from failing a request: Anthropic binds a signature to the
 * system prompt, the tools and the earlier messages, and the adapter asks the
 * API to drop a block that fails (`block_binding` in `anthropic.ts`); OpenAI
 * binds encrypted reasoning to the organization, and the adapter retries once
 * without the items the API could not decrypt (`openai.ts`).
 */
type ReasoningReplay = "with-provider-state" | "text-only"

const toAssistantMessage = (
  message: Message,
  reasoning: ReasoningReplay,
): Option.Option<Prompt.AssistantMessage> => {
  const content: Prompt.AssistantMessagePart[] = []

  for (const part of message.parts) {
    switch (part.type) {
      case "reasoning":
        if (reasoning === "with-provider-state") content.push(part)
        else content.push(Prompt.reasoningPart({ text: part.text }))
        break
      case "text":
      case "file":
      case "tool-call":
      case "tool-approval-request":
        content.push(part)
        break
      default:
        break
    }
  }

  if (content.length === 0) return Option.none()
  return Option.some(Prompt.assistantMessage({ content }))
}

/**
 * Model-facing tool results keep this many characters; anything larger is
 * spilled. The transcript keeps the full result, and the bounded result
 * carries the locator the model uses to page through it.
 */
export const maximumModelToolResultChars = 8_000

const encodeToolResultJson = Schema.encodeUnknownOption(Schema.fromJsonString(Schema.Json))

const decodeToolResultJson = Schema.decodeUnknownOption(Schema.Json)

/**
 * The shortest string cap a bounded result may use. Below it, most of a cut
 * string would be its marker, so a result with that many strings is cut as
 * JSON text instead.
 */
const MINIMUM_STRING_CAP = 256

const isJsonArray = (value: Schema.Json): value is Schema.JsonArray => Array.isArray(value)
const isJsonObject = (value: Schema.Json): value is Schema.JsonObject =>
  Predicate.isObject(value) && !Array.isArray(value)

/** `value` with each string longer than `cap` cut to its head and tail. */
const capStrings = (value: Schema.Json, cap: number): Schema.Json => {
  if (Predicate.isString(value)) return headTailChars(value, cap).text
  if (isJsonArray(value)) return value.map((item) => capStrings(item, cap))
  if (isJsonObject(value)) return Record.map(value, (item) => capStrings(item, cap))
  return value
}

/** Each string of `value`, in document order. */
const jsonStrings = (value: Schema.Json): ReadonlyArray<string> => {
  if (Predicate.isString(value)) return [value]
  if (isJsonArray(value)) return value.flatMap(jsonStrings)
  if (isJsonObject(value)) return Object.values(value).flatMap(jsonStrings)
  return []
}

/** The characters `capStrings(value, cap)` cuts out of the strings of `value`. */
const cutStringChars = (value: Schema.Json, cap: number): number =>
  jsonStrings(value).reduce((sum, text) => sum + headTailChars(text, cap).omittedChars, 0)

/**
 * The largest size in `[low, high]` whose bounded result the provider
 * encodes within `maxChars`, whole, paging fields included; none when even
 * `low` does not fit. Larger sizes encode longer, so a binary search finds it.
 */
const largestFitting = (
  low: number,
  high: number,
  maxChars: number,
  boundedAt: (size: number) => Schema.Json,
): Option.Option<Schema.Json> => {
  const fits = (size: number) =>
    Option.exists(encodeToolResultJson(boundedAt(size)), (text) => text.length <= maxChars)
  if (!fits(low)) return Option.none()
  let fitting = low
  let above = high
  while (fitting < above) {
    const mid = Math.ceil((fitting + above) / 2)
    if (fits(mid)) fitting = mid
    else above = mid - 1
  }
  return Option.some(boundedAt(fitting))
}

/**
 * Bound one tool result for the model, with a locator for the rest. The
 * stored message and its events keep the full result;
 * `context.read(toolCallId, { offset, limit })` in the cell pages its JSON
 * text, `totalChars` long. The whole bounded result, paging fields included,
 * encodes within `maxChars`.
 *
 * The bounded result keeps the result's shape in `result`, each long string
 * cut to its head and tail, so the provider encodes the content once, as it
 * does an unbounded result. `omittedChars` counts the string characters cut.
 * A result whose strings cannot carry the cut (many short strings, or bulk
 * that is not string: numbers, keys, nesting) is cut as JSON text in `text`
 * instead, which the provider then encodes a second time.
 */
export const boundToolResultForModel = (
  part: Prompt.ToolResultPart,
  maxChars: number = maximumModelToolResultChars,
): Prompt.ToolResultPart => {
  const encoded = encodeToolResultJson(part.result)
  if (Option.isNone(encoded) || encoded.value.length <= maxChars) return part
  const locator = {
    truncated: true,
    totalChars: encoded.value.length,
    read: `context.read("${part.id}", { offset, limit })`,
  }
  const structured = Option.flatMap(decodeToolResultJson(part.result), (value) =>
    largestFitting(MINIMUM_STRING_CAP, maxChars, maxChars, (cap) => ({
      ...locator,
      omittedChars: cutStringChars(value, cap),
      result: capStrings(value, cap),
    })),
  )
  const asText = (size: number): Schema.Json => {
    const bounded = headTailChars(encoded.value, size)
    return { ...locator, omittedChars: bounded.omittedChars, text: bounded.text }
  }
  return Prompt.toolResultPart({
    id: part.id,
    name: part.name,
    isFailure: part.isFailure,
    providerExecuted: part.providerExecuted,
    result: Option.getOrElse(
      Option.orElse(structured, () => largestFitting(0, maxChars, maxChars, asText)),
      // Only a bound smaller than the paging fields leaves nothing to fit.
      () => asText(0),
    ),
  })
}

/**
 * Each stored part's bound at `maximumModelToolResultChars`, by the part
 * object. A step reads its messages once, then its budget estimate and its
 * prompt both bound every tool result: the second reads the first's bound. A
 * stored result never changes, and the entry goes when the step drops the part.
 */
const modelToolResults = new WeakMap<Prompt.ToolResultPart, Prompt.ToolResultPart>()

/** `boundToolResultForModel` at the default bound, once per part object. */
const modelToolResult = (part: Prompt.ToolResultPart): Prompt.ToolResultPart => {
  const known = modelToolResults.get(part)
  if (Predicate.isNotUndefined(known)) return known
  const bounded = boundToolResultForModel(part)
  modelToolResults.set(part, bounded)
  return bounded
}

const toToolMessage = (message: Message): Option.Option<Prompt.ToolMessage> => {
  const content = message.parts.flatMap((part): ReadonlyArray<Prompt.ToolMessagePart> => {
    if (part.type === "tool-result") return [modelToolResult(part)]
    if (part.type !== "tool-approval-response") return []
    return [part]
  })

  if (content.length === 0) return Option.none()
  return Option.some(Prompt.toolMessage({ content }))
}

const toPromptMessage = (
  message: Message,
  reasoning: ReasoningReplay,
): Option.Option<Prompt.Message> => {
  switch (message.role) {
    case "system":
      return toSystemMessage(message)
    case "user":
      return toUserMessage(message)
    case "assistant":
      return toAssistantMessage(message, reasoning)
    case "tool":
      return toToolMessage(message)
  }
}

/** Only a message after the latest model-change notice was produced by the current model. */
const reasoningReplayAt = (index: number, lastModelChange: number): ReasoningReplay => {
  if (index > lastModelChange) return "with-provider-state"
  return "text-only"
}

export const toPromptMessages = (
  messages: ReadonlyArray<Message>,
  options?: Pick<PromptTranscriptOptions, "includeHidden">,
): ReadonlyArray<Prompt.Message> => {
  const result: Prompt.Message[] = []
  const lastModelChange = messages.findLastIndex(
    (message) => message.metadata?.customType === MODEL_CHANGE_MESSAGE_TYPE,
  )

  for (const [index, message] of messages.entries()) {
    if (options?.includeHidden !== true && !isAiVisibleMessage(message)) continue
    const promptMessage = toPromptMessage(message, reasoningReplayAt(index, lastModelChange))
    if (Option.isSome(promptMessage)) result.push(promptMessage.value)
  }

  return result
}

/** Opens the notices message, so the model does not read host facts as the user speaking. */
const TURN_NOTICES_HEADING = "Host status for this turn, not a message from the user."

/**
 * The turn's notices as one text, in projection order, under
 * `TURN_NOTICES_HEADING`; none when there are none. The extension host
 * already dropped any notice with no text.
 */
export const turnNoticesText = (notices: ReadonlyArray<TurnNotice>): Option.Option<string> =>
  Option.map(
    Option.liftPredicate(notices, (all) => all.length > 0),
    (all) => [TURN_NOTICES_HEADING, ...all.map((notice) => notice.content)].join("\n\n"),
  )

/**
 * The request a step sends: the system prompt (a system message per cache
 * block; the OpenAI-compatible drivers join them into one), the conversation,
 * then the turn's notices as one system message after the last message.
 *
 * The notices change from turn to turn and the rest does not, so they go
 * last: the system prompt and the conversation stay one cacheable prefix
 * whether a notice comes or goes. A later system message is the host
 * speaking, not the user: a driver sends it as a context update after the
 * conversation (the Anthropic and OpenAI-compatible drivers as a
 * `<host-context-update>` user message, which takes no cache marker; the
 * OpenAI driver as a developer message). Both rank below the system prompt,
 * so a user instruction wins over a notice, and `TURN_NOTICES_HEADING` says
 * the text is the host's.
 */
export const toPrompt = (
  messages: ReadonlyArray<Message>,
  options?: PromptTranscriptOptions,
): Prompt.Prompt => {
  const systemBlocks = (options?.systemPrompt ?? []).filter((block) => block !== "")
  const promptMessages = [
    ...systemBlocks.map((block) => Prompt.systemMessage({ content: block })),
    ...toPromptMessages(messages, options),
  ]
  const notices = turnNoticesText(options?.notices ?? [])
  if (Option.isSome(notices)) promptMessages.push(Prompt.systemMessage({ content: notices.value }))

  return Prompt.fromMessages(promptMessages)
}

// ── model-context-window ────────────────────────────────────────────────────

/** Custom type of the durable marker that starts a context window. */
export const CONTEXT_WINDOW_MESSAGE_TYPE: RuntimeUserMessageType = "context-window"

/** The durable line the loop writes when a branch's model changes between steps. */
export const MODEL_CHANGE_MESSAGE_TYPE: RuntimeUserMessageType = "model-change"

/** What a model-change notice announced; the next boundary compares against it. */
const ModelChangeDetails = Schema.TaggedStruct(MODEL_CHANGE_MESSAGE_TYPE, {
  nextModelId: ModelId,
})
const isModelChangeDetails = Schema.is(ModelChangeDetails)

/**
 * A user-role line the model reads when the step it is about to run uses
 * another model than the branch's last settled step, so attribution of the
 * turns above stays honest. The loop writes it at a step boundary, never
 * between a tool call and its result. The id names the turn, the step and
 * both models: a replayed step with the same switch writes it once, and a
 * replay after a further switch writes the notice that switch needs.
 */
export const modelChangeNotice = (params: {
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly turnMessageId: MessageId
  readonly step: number
  readonly previousModelId: ModelId
  readonly nextModelId: ModelId
  readonly createdAt: Date
}): Message =>
  Message.cases.regular.make({
    id: MessageId.make(
      `model-change:${params.turnMessageId}:${params.step}:${params.previousModelId}:${params.nextModelId}`,
    ),
    sessionId: params.sessionId,
    branchId: params.branchId,
    role: "user",
    parts: [
      Prompt.textPart({
        text: `[model changed: the turns above were generated by ${params.previousModelId}; the session continues with ${params.nextModelId}]`,
      }),
    ],
    createdAt: params.createdAt,
    metadata: {
      customType: MODEL_CHANGE_MESSAGE_TYPE,
      details: ModelChangeDetails.make({ nextModelId: params.nextModelId }),
    },
  })

/** The model a notice announced. Notices written before this detail existed announce nothing. */
export const announcedModel = (message: Message): Option.Option<ModelId> => {
  if (message.metadata?.customType !== MODEL_CHANGE_MESSAGE_TYPE) return Option.none()
  const details = message.metadata.details
  if (!isModelChangeDetails(details)) return Option.none()
  return Option.some(details.nextModelId)
}

/** The history a handoff marker summarizes; every message in it stays durable and readable by id. */
const ContextHandoffSummary = Schema.Struct({
  firstMessageId: MessageId,
  lastMessageId: MessageId,
  count: Schema.Natural,
  modelId: Schema.optional(ModelId),
  usage: Schema.optional(UsageSchema),
})
type ContextHandoffSummary = typeof ContextHandoffSummary.Type

const ContextWindowDetails = Schema.TaggedStruct(CONTEXT_WINDOW_MESSAGE_TYPE, {
  /** The first durable message the model still sees; everything earlier leaves the projection. */
  keepFromMessageId: MessageId,
  /** Present when the marker's notice carries a summary of what left the window. */
  summarized: Schema.optional(ContextHandoffSummary),
})
type ContextWindowDetails = typeof ContextWindowDetails.Type

const isWindowDetails = Schema.is(ContextWindowDetails)

/**
 * The marker is a user message so every provider accepts it at the head of the
 * window. A bare window carries the issuer's notice; a handoff carries the
 * summary and the ids that let the model read what it replaced.
 */
export const windowMarkerMessage = (params: {
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly keepFromMessageId: MessageId
  readonly notice: string
  readonly summarized?: ContextHandoffSummary
  readonly createdAt: Date
}) => {
  let kind = "context-window"
  if (Predicate.isNotUndefined(params.summarized)) kind = "context-handoff"
  return Message.cases.regular.make({
    id: MessageId.make(`${kind}:${params.branchId}:${params.keepFromMessageId}`),
    sessionId: params.sessionId,
    branchId: params.branchId,
    role: "user",
    parts: [Prompt.textPart({ text: params.notice })],
    metadata: {
      customType: CONTEXT_WINDOW_MESSAGE_TYPE,
      details: ContextWindowDetails.make({
        keepFromMessageId: params.keepFromMessageId,
        summarized: params.summarized,
      }),
    },
    createdAt: params.createdAt,
  })
}

export const windowDetails = (message: Message): Option.Option<ContextWindowDetails> => {
  if (message.metadata?.customType !== CONTEXT_WINDOW_MESSAGE_TYPE) return Option.none()
  const details = message.metadata.details
  if (!isWindowDetails(details)) return Option.none()
  return Option.some(details)
}

/**
 * The newest user message anchors a window: the model keeps that unit and loses
 * what came before. A line the runtime wrote inside a turn (a window marker, a
 * model-change notice, a max-steps or continuation line, a joined steer) is part
 * of that turn, never its start; anchoring on it would summarize the prompt away.
 */
export const latestUserMessageId = (messages: ReadonlyArray<Message>): Option.Option<MessageId> => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (Predicate.isNotUndefined(message) && message.role === "user") {
      if (isRuntimeUserMessage(message)) continue
      return Option.some(message.id)
    }
  }
  return Option.none()
}

/**
 * Applies the newest valid window marker: the marker leads, then every message from
 * the anchor onward. A marker whose anchor is missing is ignored so nothing is lost.
 * An older marker stored after the anchor (one the newest replaced at the same
 * message) is left out: only the newest marker speaks for the history.
 */
export const messagesInCurrentWindow = (
  messages: ReadonlyArray<Message>,
): ReadonlyArray<Message> => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const marker = messages[index]
    if (Predicate.isUndefined(marker)) continue
    const details = windowDetails(marker)
    if (Option.isNone(details)) continue
    const anchor = messages.findIndex((message) => message.id === details.value.keepFromMessageId)
    if (anchor < 0) continue
    return [
      marker,
      ...messages.slice(anchor).filter((message) => Option.isNone(windowDetails(message))),
    ]
  }
  return messages
}

/**
 * Drops every tool call that has no result in the run, every result whose
 * call is not in the run, and any message left with no parts. A copy taken
 * while a step is in flight would otherwise carry a call the model must not
 * see without its result; a window cut between a call and its result would
 * carry the orphan result.
 */
export const settledMessages = (messages: ReadonlyArray<Message>): ReadonlyArray<Message> => {
  const called = new Set<string>()
  const answered = new Set<string>()
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type === "tool-call") called.add(part.id)
      if (part.type === "tool-result") answered.add(part.id)
    }
  }
  return messages.flatMap((message) => {
    const parts = message.parts.filter((part) => {
      if (part.type === "tool-call") return answered.has(part.id)
      if (part.type === "tool-result") return called.has(part.id)
      return true
    })
    if (parts.length === message.parts.length) return [message]
    if (parts.length === 0) return []
    return [messageWithParts(message, parts)]
  })
}

/** The id of the handoff marker leading a window, when the window starts with a summary. */
export const currentHandoffId = (window: ReadonlyArray<Message>): Option.Option<MessageId> => {
  const first = Option.fromUndefinedOr(window[0])
  return Option.flatMap(first, (marker) =>
    Option.flatMap(windowDetails(marker), (details) => {
      if (Predicate.isUndefined(details.summarized)) return Option.none()
      return Option.some(marker.id)
    }),
  )
}

// ── model-context ───────────────────────────────────────────────────────────

/** A catalog token limit a budget can use: a positive safe integer. */
export const isTokenLimit = (limit: number): boolean => Number.isSafeInteger(limit) && limit > 0

/** The most output one request reserves and asks for. Prior art: opencode's `OUTPUT_TOKEN_MAX`. */
const MAX_OUTPUT_RESERVE_TOKENS = 32_000

/** The share of the window the output may take: the input keeps at least three quarters. */
const OUTPUT_RESERVE_WINDOW_DIVISOR = 4

/**
 * The tokens one request keeps free for the reply, and the output cap it
 * sends (`ProviderHints.maxTokens`): one number, so input within the budget
 * plus the output the request asks for never passes the window. It is the
 * model's own output cap (`Model.outputLimit`) up to 32k, and at most a
 * quarter of the window. The quarter binds only below a 128k window: a 32k
 * local model keeps 8k for output and 24k for input.
 */
export const outputReserveTokens = (params: {
  readonly contextLimitTokens: number
  readonly outputLimitTokens: Option.Option<number>
}): number => {
  const outputLimit = Option.filter(params.outputLimitTokens, isTokenLimit)
  return Math.min(
    Option.getOrElse(outputLimit, () => MAX_OUTPUT_RESERVE_TOKENS),
    MAX_OUTPUT_RESERVE_TOKENS,
    Math.floor(params.contextLimitTokens / OUTPUT_RESERVE_WINDOW_DIVISOR),
  )
}

/** ~4 chars per token, the estimate every budget in the projection shares. */
export const estimateTextTokens = (text: string): number => Math.ceil(text.length / 4)

/** Estimate the tokens occupied by a run of messages: ~4 chars per token. */
export const estimateTokens = (messages: ReadonlyArray<Message>): number => {
  let chars = 0
  for (const msg of messages) {
    for (const part of msg.parts) {
      switch (part.type) {
        case "text":
          chars += part.text.length
          break
        case "tool-call":
          chars += encodeToolOutput(part.params).length
          break
        case "tool-result":
          // The model sees the bounded result, so the budget counts that, not the stored one.
          chars += encodeToolOutput(modelToolResult(part).result).length
          break
        case "file":
          chars += 1000 // ~250 tokens estimate for image references
          break
        case "reasoning":
          chars += part.text.length
          break
      }
    }
  }
  return Math.ceil(chars / 4)
}

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
  return estimateTextTokens(encodeToolOutput(definitions))
}

/** The separate context reservations supplied by the model host. */
export const ModelContextBudget = Schema.Struct({
  contextLimitTokens: Schema.Natural,
  /** The model's input cap, when it is below the window less the output (the GPT-5 family). */
  inputLimitTokens: Schema.optional(Schema.Natural),
  reservedSystemTokens: Schema.Natural,
  reservedToolTokens: Schema.Natural,
  reservedOutputTokens: Schema.Natural,
})
export type ModelContextBudget = typeof ModelContextBudget.Type

/**
 * The input one request may carry: the window less the output reserve, and
 * never past the model's input cap. Prior art: opencode's `promptCeiling`
 * (`session/compaction.ts`).
 */
const inputCeilingOf = (params: {
  readonly contextLimitTokens: number
  readonly reservedOutputTokens: number
  readonly inputLimitTokens: Option.Option<number>
}): number =>
  Math.min(
    params.contextLimitTokens - params.reservedOutputTokens,
    Option.getOrElse(params.inputLimitTokens, () => Number.POSITIVE_INFINITY),
  )

const inputCeiling = (budget: ModelContextBudget): number =>
  inputCeilingOf({
    contextLimitTokens: budget.contextLimitTokens,
    reservedOutputTokens: budget.reservedOutputTokens,
    inputLimitTokens: Option.fromUndefinedOr(budget.inputLimitTokens),
  })

/**
 * The input one request to this model may carry, from its catalog limits
 * alone: the window less the output reserve (`outputReserveTokens`), never
 * past the input cap. The turn's budget uses the same ceiling; a reader that
 * has no projection (a session from before projections) measures against
 * this, so its gauge reads full where the turn hands off.
 */
export const modelInputCeilingTokens = (params: {
  readonly contextLimitTokens: number
  readonly inputLimitTokens: Option.Option<number>
  readonly outputLimitTokens: Option.Option<number>
}): number =>
  inputCeilingOf({
    contextLimitTokens: params.contextLimitTokens,
    reservedOutputTokens: outputReserveTokens({
      contextLimitTokens: params.contextLimitTokens,
      outputLimitTokens: params.outputLimitTokens,
    }),
    inputLimitTokens: Option.filter(params.inputLimitTokens, isTokenLimit),
  })

/** What the messages may take once the system prompt and tool definitions are in. */
const messageBudget = (budget: ModelContextBudget): number =>
  inputCeiling(budget) - budget.reservedSystemTokens - budget.reservedToolTokens

/**
 * What the provider reported one step's request took, and the reply message
 * that step stored. The request held the messages before that reply, so the
 * next projection counts those at the measured size and estimates the reply
 * and what came after at chars/4. The step's output is not in the measure:
 * only its stored reply comes back as input, and that is counted as a message.
 */
export interface StepMeasure {
  readonly replyId: MessageId
  /** Input tokens of that step's request, cached ones included. */
  readonly inputTokens: number
  /**
   * The chars/4 estimate of the system prompt, notices and tool definitions
   * that request carried. The measure subtracts it, not the current one: the
   * agent or its tools can change between steps.
   */
  readonly overheadTokens: number
}

/**
 * The measure, when the window it measured is still the current one: its
 * reply is stored after every window marker. A marker stored later replaced
 * the history the measure counted, so the estimate falls back to chars/4.
 */
const measureInCurrentWindow = (
  messages: ReadonlyArray<Message>,
  measure: Option.Option<StepMeasure>,
): Option.Option<StepMeasure> =>
  Option.filter(measure, (value) => {
    const at = messages.findIndex((message) => message.id === value.replyId)
    if (at < 0) return false
    return messages.slice(at + 1).every((message) => Option.isNone(windowDetails(message)))
  })

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
) {
  override get message(): string {
    return `${this.failure._tag} projecting the context for ${this.modelId}`
  }
}

/**
 * A bounded, model-only snapshot of durable messages. It never crosses a
 * wire or a store; `ModelContextProjected` carries its numbers out.
 */
export interface ModelContextProjection {
  readonly messages: ReadonlyArray<Message>
  readonly estimatedTokens: number
  readonly availableInputTokens: number
  readonly omittedMessageIds: ReadonlyArray<MessageId>
}

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

/** The new-window notice is pinned: it must survive however tight the projection gets. */
const isWindowMarkerUnit = (unit: ProjectionUnit): boolean =>
  unit.messages.length === 1 &&
  unit.messages[0]?.metadata?.customType === CONTEXT_WINDOW_MESSAGE_TYPE

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
  const pinned = units.slice(0, latestUserIndex).filter(isWindowMarkerUnit)
  const tail = units.slice(latestUserIndex)
  const tailTokens = [...pinned, ...tail].reduce((total, unit) => total + unit.estimatedTokens, 0)
  if (tailTokens > availableInputTokens) {
    return budgetExceeded([...pinned, ...tail], availableInputTokens)
  }

  let selectedStart = latestUserIndex
  let selectedTokens = tailTokens
  for (let index = latestUserIndex - 1; index >= 0; index -= 1) {
    const unit = Option.fromNullishOr(units[index])
    if (Option.isNone(unit)) continue
    // Already counted with the tail; it stays in view either way.
    if (isWindowMarkerUnit(unit.value)) {
      selectedStart = index
      continue
    }
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
  const availableInputTokens = messageBudget(budget)
  if (availableInputTokens < 0) {
    return Result.fail(
      ModelContextError.cases.ReserveExhausted.make({
        contextLimitTokens: budget.contextLimitTokens,
        reservedTokens: reserveTotal(budget),
      }),
    )
  }

  const latestUser = latestUserUnit(units)
  const selected = selectUnits(units, latestUser, availableInputTokens)
  if (Result.isFailure(selected)) return Result.fail(selected.failure)

  const earlier = units.slice(0, selected.success.start)
  const selectedUnits = [
    ...earlier.filter(isWindowMarkerUnit),
    ...units.slice(selected.success.start),
  ]
  const selectedMessages = selectedUnits.flatMap((unit) => unit.messages)
  const omittedMessageIds = messageIds(earlier.filter((unit) => !isWindowMarkerUnit(unit)))
  // The stored message objects, not copies: `make` would decode each message
  // again, and the prompt reads the tool-result bounds the estimate took by
  // part object (`modelToolResult`).
  const projection: ModelContextProjection = {
    messages: selectedMessages,
    estimatedTokens: selected.success.estimatedTokens,
    availableInputTokens,
    omittedMessageIds,
  }
  return Result.succeed(projection)
}

/**
 * Where a window hands off when the newest turn alone overflows: the newest
 * step boundaries that fit half the input budget stay, and the handoff anchors
 * at the first kept message. The first unit always leaves, so a turn that is
 * one unit has nothing to hand off.
 */
const handoffAnchorWithinTurn = (
  messages: ReadonlyArray<Message>,
  budget: ModelContextBudget,
  measure: Option.Option<StepMeasure>,
): Option.Option<MessageId> => {
  const measured = measuredUnits(messages, measure)
  if (Result.isFailure(measured)) return Option.none()
  const units = measured.success
  const target = Math.floor(messageBudget(budget) / 2)
  let start = units.length - 1
  let kept = 0
  for (let index = units.length - 1; index > 0; index -= 1) {
    const unit = Option.fromNullishOr(units[index])
    if (Option.isNone(unit)) continue
    if (kept + unit.value.estimatedTokens > target) break
    start = index
    kept += unit.value.estimatedTokens
  }
  if (start <= 0) return Option.none()
  return Option.fromNullishOr(units[start]).pipe(
    Option.flatMap((unit) => Option.fromNullishOr(unit.messages[0])),
    Option.map((message) => message.id),
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
  measure: Option.Option<StepMeasure> = Option.none(),
): Result.Result<ModelContextProjection, ModelContextError> => {
  const units = measuredUnits(messages, measure)
  if (Result.isFailure(units)) return Result.fail(units.failure)
  return projectUnits(units.success, budget)
}

/**
 * The projection units of `messages`, each with its estimate. chars/4 counts
 * low: it leaves out the wire encoding, and code and JSON tokenize denser.
 * When the provider measured a step of this window (`measure`), the units
 * before that step's reply (what its request held) take the measured size,
 * spread by their chars/4 share; the reply and what came after keep chars/4.
 * The measure only ever raises an estimate.
 */
const measuredUnits = (
  messages: ReadonlyArray<Message>,
  measure: Option.Option<StepMeasure>,
): Result.Result<ReadonlyArray<ProjectionUnit>, ModelContextError> => {
  const visible = visibleSnapshot(messages)
  const records = collectToolRecords(visible)
  if (Result.isFailure(records)) return Result.fail(records.failure)
  const groups = groupToolCalls(visible, records.success)
  if (Result.isFailure(groups)) return Result.fail(groups.failure)
  const units = buildUnits(visible, groups.success)

  const reply = Option.flatMap(measure, (value) => {
    const index = visible.findIndex((message) => message.id === value.replyId)
    if (index < 0) return Option.none()
    return Option.some({ index, measured: value.inputTokens - value.overheadTokens })
  })
  if (Option.isNone(reply)) return Result.succeed(units)
  const { index, measured } = reply.value
  // A reply opens its own unit, so the units before it are exactly what the
  // measured request held.
  const inRequest = (unit: ProjectionUnit) => unit.start < index
  const estimated = units.filter(inRequest).reduce((sum, unit) => sum + unit.estimatedTokens, 0)
  if (estimated <= 0 || measured <= estimated) return Result.succeed(units)
  const scale = measured / estimated
  return Result.succeed(
    units.map((unit) => {
      if (!inRequest(unit)) return unit
      return { ...unit, estimatedTokens: Math.ceil(unit.estimatedTokens * scale) }
    }),
  )
}

// ── model-context-compactor ─────────────────────────────────────────────────

/**
 * The context compaction seam.
 *
 * The loop decides when a window hands off: on overflow, or when the model
 * asks. It gives the history that leaves the window to whichever extension
 * installs a `ModelContextCompactor` as a process resource and gets back the
 * notice the handoff marker carries. With none installed, an overflowing
 * transcript is simply truncated. The loop owns the marker, its ids, and the
 * transaction; the extension owns the summary prompt and the notice text.
 *
 * @module
 */

/** Why a summary was not produced. Every failure degrades to a truncated window. */
export class ModelCompactionError extends Schema.TaggedError<ModelCompactionError>()(
  "ModelCompactionError",
  {
    modelId: ModelId,
    reason: Schema.NonEmptyString,
  },
) {}

/** What the handoff marker carries: the notice the model reads, and the receipt of producing it. */
export const CompactionSummary = Schema.Struct({
  notice: Schema.NonEmptyString,
  modelId: ModelId,
  usage: Schema.optional(UsageSchema),
})
export type CompactionSummary = typeof CompactionSummary.Type

export interface CompactionRequest {
  readonly modelId: ModelId
  readonly sessionId: SessionId
  readonly branchId: BranchId
  /** The history leaving the window, oldest first, an earlier handoff marker included. */
  readonly history: ReadonlyArray<Message>
  /** The messages that stay in the window after the handoff, oldest first. */
  readonly kept: ReadonlyArray<Message>
  readonly budget: ModelContextBudget
  /** What the model asked the summary to focus on, when it asked. */
  readonly instructions?: string
  /** The admitted model for a summary bounded to `maxOutputTokens`. */
  readonly summaryModel: (
    maxOutputTokens: number,
  ) => Effect.Effect<LanguageModel.Service, ProviderError | ProviderAuthError, Scope.Scope>
}

interface ModelContextCompactorService {
  readonly compact: (
    request: CompactionRequest,
  ) => Effect.Effect<CompactionSummary, ModelCompactionError, Scope.Scope>
}

/** Installed by an extension as a process resource; absent when nothing summarises. */
export class ModelContextCompactor extends Context.Service<
  ModelContextCompactor,
  ModelContextCompactorService
>()("@gent/core/src/runtime/model-context/ModelContextCompactor") {}

// ── model-context-ledger ────────────────────────────────────────────────────

/** What the model last saw as its context, recorded after each projection. */
const ModelContextStatus = Schema.Struct({
  estimatedTokens: Schema.Natural,
  availableInputTokens: Schema.Natural,
  contextLimitTokens: Schema.Natural,
  omittedMessages: Schema.Natural,
  /** The handoff marker leading the window; absent when the window carries no summary. */
  handoffMessageId: Schema.optional(MessageId),
})
type ModelContextStatus = typeof ModelContextStatus.Type

/** A request the model made from inside a cell; the next projection consumes it. */
export const ContextDirective = Schema.TaggedUnion({
  Compact: { instructions: Schema.optional(Schema.String) },
  /** The issuer says how the model recovers what the window dropped; core only keeps it durable. */
  NewWindow: { notice: Schema.NonEmptyString },
})
export type ContextDirective = typeof ContextDirective.Type

interface ModelContextLedgerService {
  readonly status: Effect.Effect<Option.Option<ModelContextStatus>>
  readonly recordProjection: (status: ModelContextStatus) => Effect.Effect<void>
  /** A later directive replaces an earlier one; only the newest is honored. */
  readonly schedule: (directive: ContextDirective) => Effect.Effect<void>
  /** The directive waiting for the next projection; it stays until acknowledged or discarded. */
  readonly pendingDirective: Effect.Effect<Option.Option<ContextDirective>>
  /** Clears the directive once its projection succeeded; a newer directive survives. */
  readonly acknowledgeDirective: (directive: ContextDirective) => Effect.Effect<void>
  /** Drops whatever is pending; a new turn starts without the last turn's request. */
  readonly discardDirective: Effect.Effect<void>
}

/** One branch's view of its model context: the last projection and any pending directive. */
export class ModelContextLedger extends Context.Service<
  ModelContextLedger,
  ModelContextLedgerService
>()("@gent/core/src/runtime/model-context/ModelContextLedger") {
  static make = Effect.gen(function* () {
    const statusRef = yield* Ref.make(Option.none<ModelContextStatus>())
    const directiveRef = yield* Ref.make(Option.none<ContextDirective>())
    return ModelContextLedger.of({
      status: Ref.get(statusRef),
      recordProjection: (status) => Ref.set(statusRef, Option.some(status)),
      schedule: (directive) => Ref.set(directiveRef, Option.some(directive)),
      pendingDirective: Ref.get(directiveRef),
      acknowledgeDirective: (directive) =>
        Ref.update(directiveRef, (current) =>
          Option.filter(current, (value) => value !== directive),
        ),
      discardDirective: Ref.set(directiveRef, Option.none()),
    })
  })

  static Branch = Layer.effect(ModelContextLedger, ModelContextLedger.make)

  /**
   * The ledger a branch gets when nothing schedules directives.
   *
   * Only a dispatching tool writes this ledger -- the model asks for a fresh
   * window or a focused summary from inside one. A branch without such a tool
   * still projects its context every turn, so the read side must resolve to
   * something rather than fail. Absence means "no directive, and nowhere to
   * record", not an error.
   */
  static readonly inert: ModelContextLedgerService = {
    status: Effect.succeedNone,
    recordProjection: () => Effect.void,
    schedule: () => Effect.void,
    pendingDirective: Effect.succeedNone,
    acknowledgeDirective: () => Effect.void,
    discardDirective: Effect.void,
  }
}

// ── turn-window ─────────────────────────────────────────────────────────────

/** What the model asked the summary to focus on, when the pending directive is a compaction. */
const compactionInstructions = (
  directive: Option.Option<ContextDirective>,
): Option.Option<string> =>
  directive.pipe(
    Option.filter((value) => value._tag === "Compact"),
    Option.flatMap((value) => Option.fromUndefinedOr(value.instructions)),
  )

/** The handoff marker's record of what it replaced, taken from the history's ends. */
const summarizedRange = (history: ReadonlyArray<Message>, summary: CompactionSummary) =>
  Option.all([Option.fromUndefinedOr(history[0]), Option.fromUndefinedOr(history.at(-1))]).pipe(
    Option.map(([first, last]) => ({
      firstMessageId: first.id,
      lastMessageId: last.id,
      count: history.length,
      modelId: summary.modelId,
      usage: summary.usage,
    })),
  )

type WindowProjection = {
  readonly durableMessages: ReadonlyArray<Message>
  readonly compacted: boolean
  /** The summary this projection paid for, whether or not a marker kept it. */
  readonly summary: Option.Option<CompactionSummary>
}

/**
 * Where the window hands off and whether it must. The newest user message
 * anchors it; when the newest turn alone exceeds the budget the anchor moves
 * inside the turn, to a step boundary. A provider that refused the last
 * request as too long (`overflowed`) makes the window overflow whatever the
 * estimate says; with no history before the newest user message to give up,
 * the anchor moves inside the turn. Any other projection failure is the
 * caller's to raise.
 */
const handoffPlan = (params: {
  readonly window: ReadonlyArray<Message>
  readonly budget: ModelContextBudget
  readonly measure: Option.Option<StepMeasure>
  readonly overflowed: boolean
  readonly fit: Result.Result<ModelContextProjection, ModelContextProjectionError>
}): Result.Result<
  { readonly anchor: Option.Option<MessageId>; readonly overflowing: boolean },
  ModelContextProjectionError
> => {
  const withinTurn = () => handoffAnchorWithinTurn(params.window, params.budget, params.measure)
  return Result.match(params.fit, {
    onSuccess: (projection) => {
      const latestUser = latestUserMessageId(params.window)
      if (!params.overflowed) {
        return Result.succeed({
          anchor: latestUser,
          overflowing: projection.omittedMessageIds.length > 0,
        })
      }
      const before = Option.match(latestUser, {
        onNone: () => [],
        onSome: (id) =>
          params.window.slice(
            0,
            Math.max(
              0,
              params.window.findIndex((m) => m.id === id),
            ),
          ),
      })
      if (before.some((message) => Option.isNone(windowDetails(message)))) {
        return Result.succeed({ anchor: latestUser, overflowing: true })
      }
      return Result.succeed({ anchor: withinTurn(), overflowing: true })
    },
    onFailure: (error) => {
      if (error.failure._tag !== "BudgetExceeded") return Result.fail(error)
      return Result.succeed({ anchor: withinTurn(), overflowing: true })
    },
  })
}

/** What the model reads at the head of a window cut after a provider refused it as too long. */
const OVERFLOW_TRUNCATION_NOTICE =
  "The conversation before this point was dropped: the provider refused the request as longer than the model accepts, and no summary of it is kept. If you need something from it, ask the user."

/**
 * The window of `messages` as the model sees it, bounded to `budget`. The
 * measure counts only when the window it measured is still the current one.
 */
export const projectCurrentWindow = (params: {
  readonly modelId: string
  readonly messages: ReadonlyArray<Message>
  readonly budget: ModelContextBudget
  readonly measure: Option.Option<StepMeasure>
}): Effect.Effect<ModelContextProjection, ModelContextProjectionError> => {
  const projection = projectModelContext(
    messagesInCurrentWindow(params.messages),
    params.budget,
    measureInCurrentWindow(params.messages, params.measure),
  )
  if (Result.isSuccess(projection)) return Effect.succeed(projection.success)
  return Effect.fail(
    new ModelContextProjectionError({ modelId: params.modelId, failure: projection.failure }),
  )
}

/**
 * The window the model sees this step. A fresh window puts the issuer's notice
 * at the head; a handoff moves the history before the newest user message
 * behind one marker that summarizes it and names the ids it replaced. The
 * loop hands off when the window overflows, when the model asked, or when
 * the provider refused the last request as too long (`overflowed`). That last
 * handoff happens even with no summary: the history is then dropped behind a
 * marker that says so, since the same window would be refused again.
 */
export const projectContextWindow = Effect.fn("TurnHelpers.projectContextWindow")(function* <
  PersistR = never,
>(params: {
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly modelId: ModelId
  readonly messages: ReadonlyArray<Message>
  readonly budget: ModelContextBudget
  /** The provider's measure of the last step, if one was reported. */
  readonly measure: Option.Option<StepMeasure>
  /** The provider refused the last request of this turn as too long. */
  readonly overflowed: boolean
  readonly directive: Option.Option<ContextDirective>
  readonly persist: (
    message: Message,
  ) => Effect.Effect<Message, StorageError | EventStoreError | EventStorageError, PersistR>
  readonly summaryModel: CompactionRequest["summaryModel"]
}) {
  const eventStore = yield* EventStore
  const now = yield* DateTime.nowAsDate
  let durableMessages = params.messages
  const newWindow = params.directive.pipe(Option.filter((value) => value._tag === "NewWindow"))
  const newWindowAnchor = Option.all([newWindow, latestUserMessageId(durableMessages)])
  if (Option.isSome(newWindowAnchor)) {
    const [directive, anchor] = newWindowAnchor.value
    const marker = yield* params.persist(
      windowMarkerMessage({
        sessionId: params.sessionId,
        branchId: params.branchId,
        keepFromMessageId: anchor,
        notice: directive.notice,
        createdAt: now,
      }),
    )
    durableMessages = [...durableMessages, marker]
  }

  const window = messagesInCurrentWindow(durableMessages)
  const measure = measureInCurrentWindow(durableMessages, params.measure)
  const fit = yield* Effect.result(
    projectCurrentWindow({
      modelId: params.modelId,
      messages: durableMessages,
      budget: params.budget,
      measure: params.measure,
    }),
  )
  const plan = yield* Effect.fromResult(
    handoffPlan({
      window,
      budget: params.budget,
      measure,
      overflowed: params.overflowed,
      fit,
    }),
  )
  const anchor = plan.anchor.pipe(
    Option.flatMap((id) => Option.fromUndefinedOr(window.find((message) => message.id === id))),
  )
  const anchorIndex = Math.max(
    0,
    window.findIndex((m) => Option.contains(anchor, m)),
  )
  const history = window.slice(0, anchorIndex)
  const kept = window.slice(anchorIndex)
  const requested = params.directive.pipe(Option.exists((value) => value._tag === "Compact"))
  const overflowing = plan.overflowing
  // A history that is only an earlier marker has nothing new to summarize: a
  // second handoff to the same anchor would reuse that marker's id, spend a
  // summary call, and report a compaction that changed nothing.
  const summarizable = history.some((message) => Option.isNone(windowDetails(message)))
  // A refused window whose only history is an earlier handoff: that
  // handoff's summary is all that is left to give up. A truncation marker at
  // the same message replaces it, so the retry sends a smaller window. A
  // window already cut to a bare marker has nothing left to drop.
  const headSummary = Option.fromUndefinedOr(window[0]).pipe(
    Option.flatMap(windowDetails),
    Option.filter((details) => Predicate.isNotUndefined(details.summarized)),
  )
  if (params.overflowed && !summarizable && Option.isSome(headSummary)) {
    const marker = yield* params.persist(
      windowMarkerMessage({
        sessionId: params.sessionId,
        branchId: params.branchId,
        keepFromMessageId: headSummary.value.keepFromMessageId,
        notice: OVERFLOW_TRUNCATION_NOTICE,
        createdAt: now,
      }),
    )
    return {
      durableMessages: [...durableMessages, marker],
      compacted: true,
      summary: Option.none(),
    } satisfies WindowProjection
  }
  if (!(requested || overflowing) || !summarizable) {
    return { durableMessages, compacted: false, summary: Option.none() } satisfies WindowProjection
  }
  // The window the provider refused is not sent again: without a summary, the
  // history leaves behind a marker that says it was dropped.
  const dropHistory = (summary: Option.Option<CompactionSummary>) =>
    Effect.gen(function* () {
      if (!params.overflowed || Option.isNone(anchor)) {
        return { durableMessages, compacted: false, summary } satisfies WindowProjection
      }
      const marker = yield* params.persist(
        windowMarkerMessage({
          sessionId: params.sessionId,
          branchId: params.branchId,
          keepFromMessageId: anchor.value.id,
          notice: OVERFLOW_TRUNCATION_NOTICE,
          createdAt: now,
        }),
      )
      return {
        durableMessages: [...durableMessages, marker],
        compacted: true,
        summary,
      } satisfies WindowProjection
    })
  // Summarising is an extension's job. With no compactor installed the
  // projection truncates the transcript and reports the omission as usual;
  // a refused window drops its history.
  const compactor = yield* Effect.serviceOption(ModelContextCompactor)
  if (Option.isNone(compactor)) return yield* dropHistory(Option.none())
  const summary = yield* compactor.value
    .compact({
      modelId: params.modelId,
      sessionId: params.sessionId,
      branchId: params.branchId,
      history,
      kept,
      budget: params.budget,
      instructions: Option.getOrUndefined(compactionInstructions(params.directive)),
      summaryModel: params.summaryModel,
    })
    .pipe(
      Effect.asSome,
      Effect.catchTag("ModelCompactionError", (error) =>
        // A summary that cannot be produced must not cost the turn: the window
        // is truncated instead, with a visible notice.
        Effect.gen(function* () {
          let outcome = "the history before the kept messages is dropped"
          if (!params.overflowed) {
            const plain = yield* Effect.fromResult(fit)
            outcome = `continuing with ${plain.omittedMessageIds.length} older messages omitted`
          }
          yield* eventStore.publish(
            ErrorOccurred.make({
              sessionId: params.sessionId,
              branchId: params.branchId,
              error: `Context compaction failed (${error.reason}); ${outcome}`,
              notice: true,
            }),
          )
          return Option.none()
        }),
      ),
    )
  const handoff = Option.all([summary, anchor]).pipe(
    Option.flatMap(([value, anchorMessage]) =>
      summarizedRange(history, value).pipe(
        Option.map((summarized) => ({ notice: value.notice, summarized, anchorMessage })),
      ),
    ),
  )
  if (Option.isNone(handoff)) return yield* dropHistory(summary)
  const marker = yield* params.persist(
    windowMarkerMessage({
      sessionId: params.sessionId,
      branchId: params.branchId,
      keepFromMessageId: handoff.value.anchorMessage.id,
      notice: handoff.value.notice,
      summarized: handoff.value.summarized,
      createdAt: now,
    }),
  )
  return {
    durableMessages: [...durableMessages, marker],
    compacted: true,
    summary,
  } satisfies WindowProjection
})

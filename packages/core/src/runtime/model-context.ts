import {
  Context,
  DateTime,
  Effect,
  Layer,
  Option,
  Order,
  Predicate,
  Record,
  Ref,
  Result,
  Schema,
  type Scope,
} from "effect"
import * as Prompt from "effect/ai/Prompt"
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
import {
  type AgentName,
  cacheWriteRate,
  ImageCost,
  type ImageLimit,
  ImagePartOptions,
  type Model,
  ModelId,
  type ModelPricing,
} from "../domain/agent.js"
import { readToolImage, type ToolImage, toolImageBase64Chars, toolImagesOf } from "./tool-image.js"
import { omitUndefined } from "../domain/guards.js"
import type { ToolCapability } from "../domain/capability.js"
import type { ExtensionContext, TurnNotice } from "../domain/extension.js"
import type { LanguageModel } from "effect/ai"
import type { ProviderAuthError, RunEffort } from "../domain/driver.js"
import type { ProviderError, StorageError } from "../domain/errors.js"
import type { EventStorageError } from "../storage/storage.js"

// ── ai-transcript ───────────────────────────────────────────────────────────

interface PromptTranscriptOptions {
  /**
   * The system prompt in cache blocks, one leading system message each: a
   * driver can end a cached prefix at a block (see `systemPromptBlocks`).
   */
  readonly systemPrompt?: ReadonlyArray<string>
  /** The turn's notices, placed after the conversation; see `turnNoticesText`. */
  readonly notices?: ReadonlyArray<TurnNotice>
  /**
   * What stands for each tool image, by the id of the tool call whose result
   * holds it, in the result's order (`toolImagePrompt`). Absent: the tool
   * results go without their images.
   */
  readonly toolImages?: ToolImagePrompt
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

// ── tool images ─────────────────────────────────────────────────────────────

/** Each stored tool result's images, by the part object, as `modelToolResults` keeps bounds. */
const toolResultImageCache = new WeakMap<Prompt.ToolResultPart, ReadonlyArray<ToolImage>>()

/** The images a stored tool result holds (`toolImagesOf`), read from the stored, unbounded result. */
const toolResultImages = (part: Prompt.ToolResultPart): ReadonlyArray<ToolImage> => {
  const known = toolResultImageCache.get(part)
  if (Predicate.isNotUndefined(known)) return known
  const images = Option.match(decodeToolResultJson(part.result), {
    onNone: (): ReadonlyArray<ToolImage> => [],
    onSome: toolImagesOf,
  })
  toolResultImageCache.set(part, images)
  return images
}

/** `width` x `height` scaled by `factor`, never up, each side at least 1 pixel. */
const scaledDown = (width: number, height: number, factor: number) => {
  const scale = Math.min(1, factor)
  return {
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
  }
}

/** The tokens one `width` x `height` image costs at `cost` (`ImageCost`). */
const tokensAtCost = (cost: ImageCost, width: number, height: number): number =>
  ImageCost.match(cost, {
    Pixels: ({ pixelsPerToken }) => Math.ceil((width * height) / pixelsPerToken),
    Tiles: ({ baseTokens, tileTokens }) => {
      // Fit in 2048x2048, then cut the short side to 768, as OpenAI's `high` detail does.
      const fit = scaledDown(width, height, 2_048 / Math.max(width, height))
      const cut = scaledDown(fit.width, fit.height, 768 / Math.min(fit.width, fit.height))
      const tiles = Math.ceil(cut.width / 512) * Math.ceil(cut.height / 512)
      return baseTokens + tileTokens * tiles
    },
    Patches: ({ multiplier, maxPatches }) => {
      const patchesOf = (size: { readonly width: number; readonly height: number }) =>
        Math.ceil(size.width / 32) * Math.ceil(size.height / 32)
      let patches = patchesOf({ width, height })
      if (patches > maxPatches) {
        const shrunk = scaledDown(
          width,
          height,
          Math.sqrt((32 * 32 * maxPatches) / (width * height)),
        )
        patches = Math.min(patchesOf(shrunk), maxPatches)
      }
      return Math.ceil(patches * multiplier)
    },
  })

/**
 * Every cost a shipped API class counts an image at: Anthropic's pixels, and
 * each OpenAI rate of tiles and patches (`gpt-4o-mini`'s tiles the highest).
 * A model whose class names no cost counts each image at the highest of
 * these, so no known rule counts more. A test holds each shipped class's
 * costs to this list.
 */
export const KNOWN_IMAGE_COSTS: ReadonlyArray<ImageCost> = [
  ImageCost.cases.Pixels.make({ pixelsPerToken: 750 }),
  ImageCost.cases.Tiles.make({ baseTokens: 2_833, tileTokens: 5_667 }),
  ImageCost.cases.Tiles.make({ baseTokens: 85, tileTokens: 170 }),
  ImageCost.cases.Tiles.make({ baseTokens: 75, tileTokens: 150 }),
  ImageCost.cases.Tiles.make({ baseTokens: 70, tileTokens: 140 }),
  ImageCost.cases.Patches.make({ multiplier: 1.2, maxPatches: 2_500 }),
  ImageCost.cases.Patches.make({ multiplier: 1.2, maxPatches: 6_144 }),
  ImageCost.cases.Patches.make({ multiplier: 1.2, maxPatches: 1_536 }),
  ImageCost.cases.Patches.make({ multiplier: 1.5, maxPatches: 1_536 }),
  ImageCost.cases.Patches.make({ multiplier: 1.62, maxPatches: 6_144 }),
  ImageCost.cases.Patches.make({ multiplier: 1.72, maxPatches: 1_536 }),
  ImageCost.cases.Patches.make({ multiplier: 2.46, maxPatches: 1_536 }),
]

/**
 * The tokens `image` costs a model whose API class counts at `cost`; none:
 * the highest of `KNOWN_IMAGE_COSTS`. The estimate counts every image of the
 * window, whether the request sends it or a line in its place.
 */
const imageTokens = (cost: Option.Option<ImageCost>, image: ToolImage): number =>
  Option.match(cost, {
    onSome: (known) => tokensAtCost(known, image.width, image.height),
    onNone: () =>
      Math.max(...KNOWN_IMAGE_COSTS.map((known) => tokensAtCost(known, image.width, image.height))),
  })

/** One image of a tool result the prompt holds: the call, its tool, the image. */
interface PromptToolImage {
  readonly toolCallId: string
  readonly toolName: string
  readonly image: ToolImage
}

/** The images of the visible tool results in `messages`, oldest first. */
const promptToolImages = (messages: ReadonlyArray<Message>): ReadonlyArray<PromptToolImage> =>
  messages.flatMap((message) => {
    if (!isAiVisibleMessage(message) || message.role !== "tool") return []
    return message.parts.flatMap((part) => {
      if (part.type !== "tool-result") return []
      return toolResultImages(part).map((image) => ({
        toolCallId: part.id,
        toolName: part.name,
        image,
      }))
    })
  })

/**
 * What stands for one tool image in a request: its bytes in base64 under a
 * label line, or a line alone. Each text depends only on the image, its tool
 * and the model, never on the request, so a request's prefix stays the same
 * bytes from one step to the next.
 */
const ToolImageContent = Schema.TaggedUnion({
  Bytes: {
    label: Schema.String,
    mediaType: Schema.String,
    data: Schema.String,
    options: Schema.optional(ImagePartOptions),
  },
  Line: { text: Schema.String },
})
type ToolImageContent = typeof ToolImageContent.Type

/** What stands for each image, by tool call id, in the result's order. */
type ToolImagePrompt = ReadonlyMap<string, ReadonlyArray<ToolImageContent>>

/** How a line names an image: its tool, its source when it has one, and its size. */
const toolImageName = (entry: PromptToolImage): string =>
  [
    entry.toolName,
    ...Option.toArray(Option.fromUndefinedOr(entry.image.source)),
    `${entry.image.width}x${entry.image.height}`,
  ].join(" ")

/**
 * The line above an image the model sees. A scaled image's line names the
 * size the tool saved and the factors from the stored image to it, in pi's
 * and Claude Code's words (`PRIOR_ARTS.md`), so the model can map a
 * coordinate back. Whole-pixel sides leave the two factors apart, by a lot
 * in a thin image (1x6000 stored as 1x2000): the line names one factor only
 * when both read the same. Three decimals keep a mapped coordinate within one
 * original pixel at the stored image's 2,000-pixel edge. It reads stored
 * fields only, so it stays the same bytes.
 */
const toolImageLabel = (entry: PromptToolImage, name: string): string => {
  const { width, height, originalWidth, originalHeight } = entry.image
  if (Predicate.isUndefined(originalWidth) || Predicate.isUndefined(originalHeight)) {
    return `Image from ${name}:`
  }
  const x = (originalWidth / width).toFixed(3)
  const y = (originalHeight / height).toFixed(3)
  const scaled = `Image from ${name}, scaled from ${originalWidth}x${originalHeight}`
  if (x === y) return `${scaled} (multiply coordinates by ${x} to map to the original):`
  return `${scaled} (multiply x by ${x} and y by ${y} to map to the original):`
}

/**
 * The tool images a request carries when the model's API class names no
 * bound (`Model.imageLimit`): the newest 20, and about 12 MB of base64. Both
 * sit well inside what the Messages and Responses APIs take in one request.
 */
const DEFAULT_IMAGE_LIMIT: ImageLimit = { images: 20, base64Chars: 12_000_000 }

/**
 * A request past its image bound leaves out this many more of its oldest
 * images at a time: its prefix changes once each time, not at every image.
 */
const IMAGE_DROP_STEP = 5

const roundUpToStep = (count: number) => Math.ceil(count / IMAGE_DROP_STEP) * IMAGE_DROP_STEP

/**
 * How many of a request's oldest tool images it leaves out, given each
 * image's base64 size, oldest first: enough to keep at most `limit.images`
 * images and `limit.base64Chars` characters, rounded up to a multiple of
 * `IMAGE_DROP_STEP`. The newest image stays unless it alone is past the
 * character bound. The count grows only when the images pass a bound again,
 * so every request between two drops sends the same prefix.
 */
export const toolImagesToDrop = (sizes: ReadonlyArray<number>, limit: ImageLimit): number => {
  const total = sizes.length
  const byCount = roundUpToStep(Math.max(0, total - limit.images))
  let chars = sizes.reduce((sum, size) => sum + size, 0)
  let first = 0
  while (first < total && chars > limit.base64Chars) {
    chars -= sizes[first] ?? 0
    first += 1
  }
  const byChars = roundUpToStep(first)
  // The newest image stays, unless no request could carry it.
  let most = Math.max(0, total - 1)
  if ((sizes[total - 1] ?? 0) > limit.base64Chars) most = total
  return Math.min(Math.max(byCount, byChars), most)
}

/**
 * What stands for each tool image in the window `messages`, for `model`, read
 * from the blob store under `directory`. A model the catalog says reads no
 * images gets a line for each. Past the model's image bound
 * (`toolImagesToDrop`), the oldest images get a line each; so does an image
 * whose blob is gone. The stored session never changes: only the request
 * leaves an image out.
 */
export const toolImagePrompt = Effect.fn("ModelContext.toolImagePrompt")(function* (params: {
  readonly messages: ReadonlyArray<Message>
  readonly model: Pick<Model, "imageInput" | "imageLimit" | "imagePartOptions">
  readonly directory: string
}) {
  const images = promptToolImages(params.messages)
  const limit = params.model.imageLimit ?? DEFAULT_IMAGE_LIMIT
  const sizes = images.map((entry) => toolImageBase64Chars(entry.image.bytes))
  const dropped = toolImagesToDrop(sizes, limit)
  const contents = yield* Effect.forEach(
    images,
    (entry, index) =>
      Effect.gen(function* () {
        const name = toolImageName(entry)
        if (params.model.imageInput === false) {
          return ToolImageContent.cases.Line.make({
            text: `[image not shown: this model takes no image input: ${name}]`,
          })
        }
        // Each line depends on the image alone, so it stays the same bytes
        // in every later request.
        if ((sizes[index] ?? 0) > limit.base64Chars) {
          return ToolImageContent.cases.Line.make({
            text: `[image left out: larger than one request to this model takes: ${name}]`,
          })
        }
        if (index < dropped) {
          return ToolImageContent.cases.Line.make({
            text: `[earlier image left out to keep the request small: ${name}]`,
          })
        }
        return Option.match(yield* readToolImage(params.directory, entry.image), {
          onNone: () =>
            ToolImageContent.cases.Line.make({ text: `[image no longer stored: ${name}]` }),
          onSome: (data) =>
            ToolImageContent.cases.Bytes.make({
              label: toolImageLabel(entry, name),
              mediaType: entry.image.mediaType,
              data,
              ...omitUndefined({ options: params.model.imagePartOptions }),
            }),
        })
      }),
    { concurrency: 4 },
  )
  const byCall = new Map<string, Array<ToolImageContent>>()
  for (const [index, entry] of images.entries()) {
    const content = contents[index]
    if (Predicate.isUndefined(content)) continue
    const known = byCall.get(entry.toolCallId) ?? []
    known.push(content)
    byCall.set(entry.toolCallId, known)
  }
  const prompt: ToolImagePrompt = byCall
  return prompt
})

/**
 * The user message that carries a tool message's images, right after it:
 * each image under its label, or the line that stands for it. A driver sends
 * it in the same user turn as the tool results where its API allows
 * (Anthropic), else as a user message after them (OpenAI Responses, Chat
 * Completions): tool results take no image there.
 */
const toolImageMessage = (
  message: Prompt.ToolMessage,
  toolImages: ToolImagePrompt,
): Option.Option<Prompt.UserMessage> => {
  const content = message.content.flatMap((part): ReadonlyArray<Prompt.UserMessagePart> => {
    if (part.type !== "tool-result") return []
    return (toolImages.get(part.id) ?? []).flatMap((image) =>
      ToolImageContent.match(image, {
        Bytes: (bytes) => [
          Prompt.textPart({ text: bytes.label }),
          Prompt.filePart({
            mediaType: bytes.mediaType,
            data: `data:${bytes.mediaType};base64,${bytes.data}`,
            ...omitUndefined({ options: bytes.options }),
          }),
        ],
        Line: (line) => [Prompt.textPart({ text: line.text })],
      }),
    )
  })
  if (content.length === 0) return Option.none()
  return Option.some(Prompt.userMessage({ content }))
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

/** Each visible message with the prompt message it becomes, in order; one that becomes none is left out. */
const promptEntries = (
  messages: ReadonlyArray<Message>,
): ReadonlyArray<readonly [Message, Prompt.Message]> => {
  const result: Array<readonly [Message, Prompt.Message]> = []
  const lastModelChange = messages.findLastIndex(
    (message) => message.metadata?.customType === MODEL_CHANGE_MESSAGE_TYPE,
  )

  for (const [index, message] of messages.entries()) {
    if (!isAiVisibleMessage(message)) continue
    const promptMessage = toPromptMessage(message, reasoningReplayAt(index, lastModelChange))
    if (Option.isSome(promptMessage)) result.push([message, promptMessage.value])
  }

  return result
}

export const toPromptMessages = (messages: ReadonlyArray<Message>): ReadonlyArray<Prompt.Message> =>
  promptEntries(messages).map(([, prompt]) => prompt)

/**
 * One entry per run of consecutive assistant messages in the prompt
 * `toPromptMessages` builds, in order: the effort `effortOf` reads for the
 * run's last message. A driver sends such a run as one assistant turn, so
 * the entries line up with the turns on the wire
 * (`ProviderHints.reasoningHistory`).
 */
export const assistantRunEfforts = (
  messages: ReadonlyArray<Message>,
  effortOf: (message: Message) => Option.Option<RunEffort>,
): ReadonlyArray<Option.Option<RunEffort>> => {
  const runs: Array<Option.Option<RunEffort>> = []
  let previousRole: Prompt.Message["role"] = "system"
  for (const [message, prompt] of promptEntries(messages)) {
    if (prompt.role === "assistant") {
      if (previousRole === "assistant") runs.pop()
      runs.push(effortOf(message))
    }
    previousRole = prompt.role
  }
  return runs
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
 * block; the OpenAI driver's Codex path joins the leading ones into one
 * `instructions` text), the conversation, then the turn's notices as one
 * system message after the last message.
 *
 * The notices change from turn to turn and the rest does not, so they go
 * last: the system prompt and the conversation stay one cacheable prefix
 * whether a notice comes or goes. A later system message is the host
 * speaking, not the user: a driver sends it as a context update after the
 * conversation (the Anthropic driver as a `<host-context-update>` user
 * message, which takes no cache marker; the OpenAI driver as a developer
 * message). Both rank below the system prompt,
 * so a user instruction wins over a notice, and `TURN_NOTICES_HEADING` says
 * the text is the host's.
 */
export const toPrompt = (
  messages: ReadonlyArray<Message>,
  options?: PromptTranscriptOptions,
): Prompt.Prompt => {
  const systemBlocks = (options?.systemPrompt ?? []).filter((block) => block !== "")
  const toolImages: ToolImagePrompt = options?.toolImages ?? new Map()
  const promptMessages = [
    ...systemBlocks.map((block) => Prompt.systemMessage({ content: block })),
    ...toPromptMessages(messages).flatMap((message): ReadonlyArray<Prompt.Message> => {
      if (message.role !== "tool" || toolImages.size === 0) return [message]
      return [message, ...Option.toArray(toolImageMessage(message, toolImages))]
    }),
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
const tokensForChars = (chars: number): number => Math.ceil(chars / 4)

export const estimateTextTokens = (text: string): number => tokensForChars(text.length)

/** Estimate the tokens occupied by a run of messages, at `tokensForChars`. */
export const estimateTokens = (
  messages: ReadonlyArray<Message>,
  imageCost: Option.Option<ImageCost> = Option.none(),
): number => {
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
          // And each image the result holds, at the tokens it costs a model.
          for (const image of toolResultImages(part)) chars += imageTokens(imageCost, image) * 4
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
  return tokensForChars(chars)
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
  /** What one tool image costs the model (`Model.imageCost`); absent: the highest known cost. */
  imageCost: Schema.optional(ImageCost),
  /** The model's input cap, when it is below the window less the output (the GPT-5 family). */
  inputLimitTokens: Schema.optional(Schema.Natural),
  reservedSystemTokens: Schema.Natural,
  reservedToolTokens: Schema.Natural,
  reservedOutputTokens: Schema.Natural,
})
export type ModelContextBudget = typeof ModelContextBudget.Type

const imageCostOf = (budget: ModelContextBudget) => Option.fromUndefinedOr(budget.imageCost)

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
  /** The catalog marks the model a classifier: the cell's `models.decide` asks it, no turn runs on it. */
  ClassifierModel: {
    modelId: Schema.String,
  },
})
export type ModelContextCapabilityFailure = typeof ModelContextCapabilityFailure.Type

const capabilityFailureMessage = ModelContextCapabilityFailure.match({
  UnknownModel: (failure) => `${failure.modelId} is not in the model catalog`,
  MissingContextLimit: (failure) => `${failure.modelId} has no context window in the catalog`,
  InvalidContextLimit: (failure) => `${failure.modelId}: ${failure.reason}`,
  ClassifierModel: (failure) =>
    `${failure.modelId} is a classifier model: it runs no turn; a cell asks it with models.decide`,
})

export class ModelContextCapabilityError extends Schema.TaggedError<ModelContextCapabilityError>()(
  "ModelContextCapabilityError",
  {
    failure: ModelContextCapabilityFailure,
  },
) {
  override get message(): string {
    return capabilityFailureMessage(this.failure)
  }
}

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
  /**
   * The part of `estimatedTokens` before the anchor (the turn's prompt, else
   * the newest handoff marker): the history a handoff at the anchor replaces.
   * The anchor and what follows it stay in the window either way.
   */
  readonly historyTokens: number
  readonly availableInputTokens: number
  readonly omittedMessageIds: ReadonlyArray<MessageId>
}

/** A tool-call or tool-result part: its id, its tool, and the message that holds it. */
interface ToolPartRecord {
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
  readonly calls: ReadonlyMap<ToolCallId, ToolPartRecord>
  readonly results: ReadonlyMap<ToolCallId, ToolPartRecord>
}

const sortedIds = (ids: ReadonlyArray<ToolCallId>): ReadonlyArray<ToolCallId> =>
  ids.toSorted(Order.String)

const addToolCall = (
  calls: Map<ToolCallId, ToolPartRecord>,
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
  results: Map<ToolCallId, ToolPartRecord>,
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
  calls: Map<ToolCallId, ToolPartRecord>,
  results: Map<ToolCallId, ToolPartRecord>,
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
  calls: ReadonlyMap<ToolCallId, ToolPartRecord>,
  results: ReadonlyMap<ToolCallId, ToolPartRecord>,
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
  const calls = new Map<ToolCallId, ToolPartRecord>()
  const results = new Map<ToolCallId, ToolPartRecord>()

  for (const [messageIndex, message] of messages.entries()) {
    const collected = collectMessageToolRecords(message, messageIndex, calls, results)
    if (Result.isFailure(collected)) return Result.fail(collected.failure)
  }

  const validated = validateToolRecords(calls, results)
  if (Result.isFailure(validated)) return Result.fail(validated.failure)
  return Result.succeed({ calls, results })
}

const addCallToGroupMap = (
  callsByMessage: Map<number, Array<ToolPartRecord>>,
  call: ToolPartRecord,
): void => {
  const calls = Option.fromNullishOr(callsByMessage.get(call.messageIndex))
  if (Option.isSome(calls)) {
    calls.value.push(call)
    return
  }
  callsByMessage.set(call.messageIndex, [call])
}

const resultIndexesForCalls = (
  calls: ReadonlyArray<ToolPartRecord>,
  results: ReadonlyMap<ToolCallId, ToolPartRecord>,
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
  const callsByMessage = new Map<number, Array<ToolPartRecord>>()
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
  imageCost: Option.Option<ImageCost>,
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
        estimatedTokens: estimateTokens(groupMessages, imageCost),
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
        estimatedTokens: estimateTokens([message.value], imageCost),
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

/** The new-window notice is pinned: it must survive however tight the projection gets. */
const isWindowMarkerUnit = (unit: ProjectionUnit): boolean =>
  unit.messages.length === 1 &&
  unit.messages[0]?.metadata?.customType === CONTEXT_WINDOW_MESSAGE_TYPE

/**
 * The unit a projection keeps with everything after it: the one that holds
 * the turn's prompt (`latestUserMessageId`, which a line the runtime writes
 * inside the turn never is), else the newest handoff marker. So a turn that
 * outgrows the window overflows and hands off; it never drops its prompt.
 */
const anchorUnit = (units: ReadonlyArray<ProjectionUnit>): Option.Option<number> => {
  const prompt = latestUserMessageId(units.flatMap((unit) => unit.messages))
  const newest = (holds: (unit: ProjectionUnit) => boolean): Option.Option<number> => {
    for (let index = units.length - 1; index >= 0; index -= 1) {
      const unit = units[index]
      if (Predicate.isNotUndefined(unit) && holds(unit)) return Option.some(index)
    }
    return Option.none()
  }
  return Option.match(prompt, {
    onNone: () => newest(isWindowMarkerUnit),
    onSome: (id) => newest((unit) => unit.messages.some((message) => message.id === id)),
  })
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

const selectWithAnchor = (
  units: ReadonlyArray<ProjectionUnit>,
  anchorIndex: number,
  availableInputTokens: number,
): Result.Result<SelectedUnits, ModelContextError> => {
  const pinned = units.slice(0, anchorIndex).filter(isWindowMarkerUnit)
  const tail = units.slice(anchorIndex)
  const tailTokens = [...pinned, ...tail].reduce((total, unit) => total + unit.estimatedTokens, 0)
  if (tailTokens > availableInputTokens) {
    return budgetExceeded([...pinned, ...tail], availableInputTokens)
  }

  let selectedStart = anchorIndex
  let selectedTokens = tailTokens
  for (let index = anchorIndex - 1; index >= 0; index -= 1) {
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

const selectWithoutAnchor = (
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
  anchor: Option.Option<number>,
  availableInputTokens: number,
): Result.Result<SelectedUnits, ModelContextError> => {
  if (Option.isSome(anchor)) {
    return selectWithAnchor(units, anchor.value, availableInputTokens)
  }
  return selectWithoutAnchor(units, availableInputTokens)
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

  const anchor = anchorUnit(units)
  const selected = selectUnits(units, anchor, availableInputTokens)
  if (Result.isFailure(selected)) return Result.fail(selected.failure)

  const earlier = units.slice(0, selected.success.start)
  const selectedUnits = [
    ...earlier.filter(isWindowMarkerUnit),
    ...units.slice(selected.success.start),
  ]
  const selectedMessages = selectedUnits.flatMap((unit) => unit.messages)
  const omittedMessageIds = messageIds(earlier.filter((unit) => !isWindowMarkerUnit(unit)))
  // The selected units before the anchor, each at the estimate the total took.
  const historyTokens = Option.match(anchor, {
    onNone: () => 0,
    onSome: (anchorIndex) =>
      units
        .slice(0, anchorIndex)
        .filter((unit, index) => index >= selected.success.start || isWindowMarkerUnit(unit))
        .reduce((sum, unit) => sum + unit.estimatedTokens, 0),
  })
  // The stored message objects, not copies: `make` would decode each message
  // again, and the prompt reads the tool-result bounds the estimate took by
  // part object (`modelToolResult`).
  const projection: ModelContextProjection = {
    messages: selectedMessages,
    estimatedTokens: selected.success.estimatedTokens,
    historyTokens,
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
  const measured = measuredUnits(messages, measure, imageCostOf(budget))
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
  const units = measuredUnits(messages, measure, imageCostOf(budget))
  if (Result.isFailure(units)) return Result.fail(units.failure)
  return projectUnits(units.success, budget)
}

/**
 * The tokens of the current window before the turn's prompt: what a request
 * on another model writes to its cache again. It is the estimate
 * `coldHandoffPays` reads (`ModelContextProjection.historyTokens`) for a
 * window that fits: chars/4 per unit, raised by the last measure. A history
 * whose tool calls do not pair counts at chars/4.
 */
export const estimateHistoryTokens = (
  messages: ReadonlyArray<Message>,
  measure: Option.Option<StepMeasure>,
  model: Pick<Model, "imageCost">,
): number => {
  const window = messagesInCurrentWindow(messages)
  const imageCost = Option.fromUndefinedOr(model.imageCost)
  const units = measuredUnits(window, measureInCurrentWindow(window, measure), imageCost)
  if (Result.isFailure(units)) return estimateTokens(window, imageCost)
  return Option.match(anchorUnit(units.success), {
    onNone: () => 0,
    onSome: (anchor) =>
      units.success.slice(0, anchor).reduce((sum, unit) => sum + unit.estimatedTokens, 0),
  })
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
  imageCost: Option.Option<ImageCost>,
): Result.Result<ReadonlyArray<ProjectionUnit>, ModelContextError> => {
  const visible = messages.filter(isAiVisibleMessage)
  const records = collectToolRecords(visible)
  if (Result.isFailure(records)) return Result.fail(records.failure)
  const groups = groupToolCalls(visible, records.success)
  if (Result.isFailure(groups)) return Result.fail(groups.failure)
  const units = buildUnits(visible, groups.success, imageCost)

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

/*
 * The context compaction seam.
 *
 * The loop decides when a window hands off: on overflow, when the model
 * asks, or when a turn starts on a large window whose prompt cache went
 * cold. It gives the history that leaves the window to whichever extension
 * installs a `ModelContextCompactor` as a process resource and gets back the
 * notice the handoff marker carries. Several installed compactors form one
 * chain (`chainCompactors`), project first, then user, then builtin. With
 * none installed, or each one refusing, an overflowing transcript is simply
 * truncated. The loop owns the marker, its ids, and the transaction; the
 * extension owns the summary prompt and the notice text.
 *
 * A compactor runs with the `ExtensionContext` of the session and branch whose
 * window it compacts, under its own extension's id, as a tool call of that
 * extension on that branch does: `ctx.cwd` is the session's cwd, not the cwd
 * its extension's setup saw, so one process resource serves the sessions of
 * every profile that shares it.
 */

/**
 * Why a summary was not produced. The window goes to the next compactor of
 * the chain; when none is left, the loop truncates it.
 */
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
  /**
   * The agent whose window is compacted. A compactor that serves only some
   * agents fails with `ModelCompactionError` for the others: the window goes
   * to the next compactor of the chain, and the loop truncates it only when
   * no compactor is left.
   */
  readonly agentName: AgentName
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
  ) => Effect.Effect<LanguageModel.LanguageModel, ProviderError | ProviderAuthError, Scope.Scope>
}

interface ModelContextCompactorService {
  /** Runs with the compacted branch's `ExtensionContext`. */
  readonly compact: (
    request: CompactionRequest,
  ) => Effect.Effect<CompactionSummary, ModelCompactionError, Scope.Scope | ExtensionContext>
}

/** Installed by an extension as a process resource; absent when nothing summarises. */
export class ModelContextCompactor extends Context.Service<
  ModelContextCompactor,
  ModelContextCompactorService
>()("@gent/core/src/runtime/model-context/ModelContextCompactor") {}

/**
 * Two compactors as one: `first` is asked, and a window it refuses with
 * `ModelCompactionError` goes to `next`, whose answer (or refusal) stands.
 * The host chains each extension's compactor over the ones of lower scope.
 */
export const chainCompactors = (
  first: ModelContextCompactor["Service"],
  next: ModelContextCompactor["Service"],
) =>
  ModelContextCompactor.of({
    compact: (request) =>
      first
        .compact(request)
        .pipe(Effect.catchTag("ModelCompactionError", () => next.compact(request))),
  })

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
 * The branch's last model call and how long the provider keeps a prompt
 * cached after one.
 */
export interface PromptCache {
  /**
   * When the branch's last model request started: the newest `StreamStarted`
   * of the branch, in epoch milliseconds. The provider refreshes its cache
   * when a request reads or writes it, so the lifetime runs from there, and
   * a long response uses it up as idle time does.
   */
  readonly lastCallAtMillis: number
  /** The lifetime `promptCacheTtlMsFor` reads for the model the turn calls and its session. */
  readonly ttlMs: number
  /** The catalog price of the model the turn calls, which also writes the summary; none when unpriced. */
  readonly pricing: Option.Option<ModelPricing>
}

// ── cold handoff cost rule ──────────────────────────────────────────────────

/**
 * The most input one summary call carries, its prompt included. A compactor
 * keeps its call inside this bound (`@gent/compaction` cuts the history it
 * summarizes to fit), and the cold handoff prices the call by it.
 */
export const COMPACTION_SUMMARY_INPUT_TOKENS = 32_768

/**
 * The output cap a summary call asks the provider for. The cold handoff
 * prices the summary at this cap, not at the size of earlier summaries:
 * at catalog prices (output at most 8× input) the output is under a tenth
 * of the summary call's cost, so a recorded size would move the decision
 * by under a few percent, and the TUI's label could not read it without a
 * second fold over the session's summary receipts.
 */
export const COMPACTION_SUMMARY_OUTPUT_TOKENS = 384

/**
 * The handoff marker the next call sends in place of the history: the
 * summary (at most its output cap), up to 12 of the user's messages by id
 * with a 120-character preview each, and the fixed text that says where the
 * history is. About 1.2k tokens; this rounds up.
 */
const HANDOFF_MARKER_TOKENS = 1_536

/**
 * The smallest window a cold start hands off on a model whose budget holds
 * it. The owner (Pass 30): "for the auto-compaction, we should probably only
 * autocompact after a certain treshold - how many tokens we would be
 * sending to refresh the cache for example. something like if its over 150k
 * tokens or something its better to compact, or measure against the amount
 * of tokens the handoff would generate as well". Under it the window is sent
 * whole: the resend costs less than the detail a summary loses and the
 * re-reads the model then makes through `context.read`. A model whose budget
 * is under twice the floor hands off from half its budget instead, so a
 * small-window model still can.
 */
const COLD_HANDOFF_FLOOR_TOKENS = 150_000

/**
 * The share of the resend a handoff must save. A summary is a 150-word
 * bridge: the model reads back by id what it needs, and that costs calls
 * the rule does not count. A handoff that saves at least half the resend
 * pays for them; one that saves less keeps the window whole.
 */
const COLD_HANDOFF_MARGIN = 0.5

/**
 * Whether a turn that starts on a lapsed prompt cache hands its window off
 * first. The one cost rule: the loop's cold check and the TUI's cache label
 * (`@gent/core/protocol`) both read it, so the label never disagrees.
 *
 * Both sides price only the history the handoff replaces: N tokens, the
 * window before the new prompt, at the projection's estimate. The new
 * prompt and what follows it are sent either way, so neither side counts it.
 *
 * - The history is at least the floor: 150k, or half the budget when that
 *   is smaller.
 * - The resend is N tokens at the cache-write price of the lifetime the
 *   request asks for (`cacheWriteRate`: 2× input for Anthropic's one hour,
 *   the input price where no write is priced).
 * - The handoff is the summary call (min(N, its input cap) at the input
 *   price, its output cap at the output price; it names no cache key, so it
 *   writes no cache) plus the marker written to the cache in place of the
 *   history.
 * - It hands off when the handoff costs at most half the resend. An
 *   unpriced model hands off on the floor alone.
 */
export const coldHandoffPays = (params: {
  /** The estimated size of the history before the new prompt: what a handoff replaces. */
  readonly historyTokens: number
  /** The input budget the window is projected against. */
  readonly availableInputTokens: number
  readonly pricing: Option.Option<ModelPricing>
  /** The lifetime the turn's requests ask for, which picks the write price. */
  readonly cacheTtlMs: number
}): boolean => {
  const floor = Math.min(COLD_HANDOFF_FLOOR_TOKENS, Math.floor(params.availableInputTokens / 2))
  if (params.historyTokens < floor) return false
  return Option.match(params.pricing, {
    onNone: () => true,
    onSome: (pricing) => {
      const write = cacheWriteRate(pricing, Option.some(params.cacheTtlMs))
      const resend = params.historyTokens * write
      const handoff =
        Math.min(params.historyTokens, COMPACTION_SUMMARY_INPUT_TOKENS) * pricing.input +
        COMPACTION_SUMMARY_OUTPUT_TOKENS * pricing.output +
        HANDOFF_MARKER_TOKENS * write
      return handoff <= (1 - COLD_HANDOFF_MARGIN) * resend
    },
  })
}

/**
 * The window the model sees this step. A fresh window puts the issuer's notice
 * at the head; a handoff moves the history before the newest user message
 * behind one marker that summarizes it and names the ids it replaced. The
 * loop hands off when the window overflows, when the model asked, when the
 * provider refused the last request as too long (`overflowed`), or when a
 * turn starts on a large window whose prompt cache lapsed (cold). The
 * refusal handoff happens even with no summary: the history is then dropped
 * behind a marker that says so, since the same window would be refused
 * again. The others need a compactor; without one the window stays whole.
 */
export const projectContextWindow = Effect.fn("TurnHelpers.projectContextWindow")(function* <
  PersistR = never,
>(params: {
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly modelId: ModelId
  readonly agentName: AgentName
  readonly messages: ReadonlyArray<Message>
  readonly budget: ModelContextBudget
  /** The provider's measure of the last step, if one was reported. */
  readonly measure: Option.Option<StepMeasure>
  /** The provider refused the last request of this turn as too long. */
  readonly overflowed: boolean
  readonly directive: Option.Option<ContextDirective>
  /** This projection comes before the turn's first model call. */
  readonly turnStart: boolean
  /** The branch's last model call and its provider's cache lifetime; none when either is unknown. */
  readonly promptCache: Option.Option<PromptCache>
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
  // A turn that starts after the provider's prompt cache lapsed resends the
  // whole window as a cache write. When the history before the new prompt is
  // past the floor, and a summary call plus a marker cost at most half its
  // resend (`coldHandoffPays`), the window hands off first, anchored at the
  // new prompt. The prompt is sent either way. Only the turn's first call
  // hands off: a later step continues the work of the step before it,
  // whatever its tools took. The first projection holds no directive, since
  // the loop discards what an earlier turn left. Keeping the cache warm with
  // idle pings is not done: each costs a cache read per lifetime with no
  // knowledge the user returns, and a cache already cold cannot be warmed
  // for less than one resend.
  const cold =
    params.turnStart &&
    Result.isSuccess(fit) &&
    Option.exists(
      params.promptCache,
      (cache) =>
        now.getTime() - cache.lastCallAtMillis >= cache.ttlMs &&
        coldHandoffPays({
          historyTokens: fit.success.historyTokens,
          availableInputTokens: fit.success.availableInputTokens,
          pricing: cache.pricing,
          cacheTtlMs: cache.ttlMs,
        }),
    )
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
  if (!(requested || overflowing || cold) || !summarizable) {
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
      agentName: params.agentName,
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
        // Every compactor of the chain refused. A summary that cannot be
        // produced must not cost the turn: the window is truncated instead,
        // with a visible notice.
        Effect.gen(function* () {
          let outcome = "the history before the kept messages is dropped"
          if (!params.overflowed) {
            outcome = Result.match(fit, {
              onSuccess: (plain) =>
                `continuing with ${plain.omittedMessageIds.length} older messages omitted`,
              onFailure: () => "the window is still over budget",
            })
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

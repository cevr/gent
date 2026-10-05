import { Context, DateTime, Effect, Option, Predicate, Result, Schema } from "effect"
import {
  ExtensionId,
  type ExtensionId as ExtensionIdType,
  MessageId,
  RpcId,
  ToolCallId,
  ToolId,
} from "./ids.js"
import * as Prompt from "effect/ai/Prompt"
import type * as Response from "effect/ai/Response"
import * as AiTool from "effect/ai/Tool"
import type {
  AnyResourceContribution,
  DeclaredResourceServices,
  ExtensionContext,
  TurnNotice,
} from "./extension.js"
import type { ExtensionPlatformServices } from "../runtime/gent-platform.js"
import type {
  BranchToolHostServices,
  ToolCallRecoveryError,
  ToolCallRecoveryOutcome,
  ToolRecoveryCall,
} from "../runtime/tools.js"
import { clipSummary, summarizeToolResult } from "./message.js"

// ── prompt ──────────────────────────────────────────────────────────────────

/**
 * System prompt construction via ordered sections.
 *
 * Core writes the environment section. Extensions add sections from a
 * `turnProjection` hook, which runs each turn.
 */
export interface PromptSection {
  readonly id: string
  readonly content: string
  /**
   * Lower = earlier in the prompt. Sections every agent of a workspace reads
   * the same (persona, environment, project instructions, skills) sit below
   * `AGENT_PROMPT_PRIORITY`; a section that differs by agent sits at or above it.
   */
  readonly priority: number
}

/**
 * The first priority of the agent's own part of the prompt. The sections
 * below it are the part a session shares with its children and its sibling
 * sessions, byte for byte, so a child's first request reads that part from
 * the provider's prompt cache. A section that one agent has and another lacks
 * goes at or above it: whatever follows the tool set (the tool list, the tool
 * guidelines, the cell guide), the children guidance, an agent addendum; so
 * does anything a `systemPrompt` hook appends.
 */
export const AGENT_PROMPT_PRIORITY = 100

const PROMPT_SECTION_SEPARATOR = "\n\n"

export const compileSystemPrompt = (sections: ReadonlyArray<PromptSection>): string =>
  [...sections]
    .sort((a, b) => a.priority - b.priority)
    .map((s) => s.content)
    .join(PROMPT_SECTION_SEPARATOR)

/** The prompt of the shared sections: every section below `AGENT_PROMPT_PRIORITY`. */
export const compileSharedSystemPrompt = (sections: ReadonlyArray<PromptSection>): string =>
  compileSystemPrompt(sections.filter((section) => section.priority < AGENT_PROMPT_PRIORITY))

/**
 * The system prompt as the blocks a driver caches: the shared part, then the
 * agent's own part; joined by a blank line they are `prompt` again. One block
 * when nothing follows the shared part, or when a `systemPrompt` hook rewrote it.
 */
export const systemPromptBlocks = (prompt: string, shared: string): ReadonlyArray<string> => {
  const head = `${shared}${PROMPT_SECTION_SEPARATOR}`
  if (prompt === "") return []
  if (shared === "" || !prompt.startsWith(head) || prompt.length === head.length) return [prompt]
  return [shared, prompt.slice(head.length)]
}

/**
 * The section core writes once per profile: where the loop is running.
 * Everything an agent *is* comes from extensions. Nothing in it changes while
 * the profile lives; the date is `dateSection`, written per turn.
 */
export function environmentSection(options: {
  cwd: string
  platform: string
  isGitRepo: boolean
  shell?: string
  osVersion?: string
}): PromptSection {
  const { cwd, platform, isGitRepo, shell, osVersion } = options
  let platformDisplay = platform
  if (!Predicate.isUndefined(osVersion)) platformDisplay = `${platform} (${osVersion})`
  let shellDisplay = "unknown"
  if (!Predicate.isUndefined(shell)) shellDisplay = shell
  let gitRepository = "no"
  if (isGitRepo) gitRepository = "yes"
  return {
    id: "environment",
    content: `# Environment\n\nWorking directory: ${cwd}\nPlatform: ${platformDisplay}\nShell: ${shellDisplay}\nGit repository: ${gitRepository}`,
    priority: 60,
  }
}

/** A date line: the user's local date with its time zone (a UTC date is a day ahead every evening west of Greenwich). */
const dateLine = (day: DateTime.Zoned): string =>
  `Date: ${DateTime.formatIsoDate(day)} (${DateTime.zoneToString(day.zone)})`

/**
 * The date in the system prompt, right after the environment section: the
 * day the session tree's root session started. It is fixed for the tree, so
 * the cached prefix stays byte-identical past midnight and a child reads its
 * parent's cache entry. `dateNotice` tells a later turn today's date.
 */
export const dateSection = (day: DateTime.Zoned): PromptSection => ({
  id: "date",
  content: dateLine(day),
  priority: 61,
})

/**
 * Today's date as a turn notice, after the conversation, when today is not
 * the prompt's date: the model learns the new date without a rewrite of the
 * cached prefix. Nothing stores it.
 */
export const dateNotice = (
  prompted: DateTime.Zoned,
  today: DateTime.Zoned,
): Option.Option<TurnNotice> =>
  Option.liftPredicate(
    { id: "date", content: dateLine(today), keys: [] },
    () => DateTime.formatIsoDate(prompted) !== DateTime.formatIsoDate(today),
  )

// ── capability ──────────────────────────────────────────────────────────────

// Shared extension callable primitives: the errors and host contexts that
// the tool and request sections below both use.

/** Failure raised by a Capability handler. Carries audience + id for diagnostics. */
export class CapabilityError extends Schema.TaggedError<CapabilityError>()(
  "@gent/core/src/domain/capability/CapabilityError",
  {
    extensionId: ExtensionId,
    capabilityId: Schema.String,
    reason: Schema.String,
  },
) {}

/** Failure raised when a Capability is invoked with an id that has no contribution. */
export class CapabilityNotFoundError extends Schema.TaggedError<CapabilityNotFoundError>()(
  "@gent/core/src/domain/capability/CapabilityNotFoundError",
  {
    extensionId: ExtensionId,
    capabilityId: Schema.String,
  },
) {}

type CapabilityEffect<Input = unknown, Output = unknown, R = never, E = CapabilityError> = {
  bivarianceHack(input: Input): Effect.Effect<Output, E, R>
}["bivarianceHack"]

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- existential runtime leaf boundary; factories keep author-facing input/output typed
type ErasedCapabilityEffect<E = any> = (
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- existential runtime leaf boundary; factories keep author-facing input/output typed
  input: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- existential runtime leaf boundary; factories keep author-facing input/output typed
) => Effect.Effect<any, E, any>

/**
 * What a tool may declare about itself beyond its schemas and body.
 *
 * Every one is optional, and each travels the same route: the author's input,
 * the metadata annotation, the capability. Declaring them once here means a
 * new one is added in a single place rather than three, where forgetting a
 * site drops the declaration silently instead of failing to compile.
 */
interface ToolDeclarations {
  /** One-liner for the system prompt tool list (distinct from `description`,
   *  which is sent to the LLM as part of the tool schema). */
  readonly promptSnippet?: string
  /** Behavioral guidelines injected into the system prompt when this tool is active. */
  readonly promptGuidelines?: ReadonlyArray<string>
  /** If true, requires an interactive session — filtered out in headless
   *  mode and subagent contexts. */
  readonly interactive?: boolean
  /**
   * If true, this tool runs other tools inside itself.
   *
   * The loop restores host tool bindings for a dispatching tool on crash
   * recovery, because its inner calls need them; a plain tool needs only its
   * own binding. Declaring it keeps the loop from having to know tool names.
   */
  readonly dispatches?: boolean
}

/**
 * Erased runtime shape of a `request({...})` Capability. The author-facing
 * branded `RequestCapability` is in the request section below.
 */
interface RequestCapabilityApi {
  readonly _tag: "request"
  readonly id: RpcId
  readonly input: unknown
  readonly output: unknown
  readonly effect: unknown
  readonly slash?: unknown
  readonly description?: string
  /** See `RequestInput.answersDuringTurn`. */
  readonly answersDuringTurn?: boolean
  /** The resources the handler names; its extension must register each of these definitions. */
  readonly resources: ReadonlyArray<AnyResourceContribution>
}

/**
 * Reference object handed to transport callers so they can route + decode
 * through the runtime's public capability dispatcher.
 */
export interface CapabilityRef<Input = unknown, Output = unknown> {
  readonly extensionId: ExtensionId
  readonly capabilityId: RpcId
  readonly input: Schema.Decoder<Input, never>
  readonly output: Schema.Decoder<Output, never>
}

/**
 * The services every root gives a tool body and a request handler: its
 * `ExtensionContext`, the extension platform, and the core services the
 * branch-tools entry exports. Any other service a leaf yields comes from a
 * resource it names.
 */
type LeafServices = ExtensionContext | ExtensionPlatformServices | BranchToolHostServices

// ── request capability ──────────────────────────────────────────────────────

/*
 * `request(...)` — typed factory for extension-to-extension Capabilities.
 *
 * Authors call `request({ id, input, output, execute })`.
 *
 * Extension registries dispatch by factory-origin metadata; authors never
 * write an audience array or read/write intent marker.
 *
 * Host/session authority is imported through `ExtensionContext`; runtime
 * dispatch provides the `ExtensionContext` facade. Request handlers receive
 * decoded params only.
 */

/**
 * `RequestCapability` — `request({...})` return type. The
 * `ExtensionContributions.requests` bucket is the discrimination; non-request
 * leaves (`tool`) cannot be slotted into `requests:`.
 */
const REQUEST_REF: unique symbol = Symbol("@gent/core/request/ref")
const REQUEST_REF_STATE: unique symbol = Symbol("@gent/core/request/ref-state")
const RequestCapabilityBrand: unique symbol = Symbol("@gent/core/RequestCapability")
declare const RequestCapabilityType: unique symbol

interface RequestRefState<Input = unknown, Output = unknown> {
  extensionId: Option.Option<ExtensionIdType>
  readonly capabilityId: RpcId
  readonly input: Schema.Codec<Input, unknown, never, never>
  readonly output: Schema.Codec<Output, unknown, never, never>
}

export type RequestCapability<Input = unknown, Output = unknown> = RequestCapabilityApi & {
  readonly [RequestCapabilityBrand]: true
  readonly [RequestCapabilityType]?: {
    readonly input: Input
    readonly output: Output
  }
  readonly id: RpcId
  readonly slash?: RequestInput<Input, Output>["slash"]
  readonly description?: string
  readonly input: Schema.Codec<Input, unknown, never, never>
  readonly output: Schema.Codec<Output, unknown, never, never>
  /**
   * A bound request fails with `CapabilityError` under its ids; an unbound
   * one passes the handler's own error to the registry, which seals it.
   */
  readonly effect: ErasedCapabilityEffect<RequestFailure>
  readonly [REQUEST_REF]: CapabilityRef<Input, Output>
  readonly [REQUEST_REF_STATE]: RequestRefState<Input, Output>
}

/** What a request handler may fail with: its own tagged error, or a `CapabilityError` it built. */
interface RequestFailure {
  readonly message: string
}

/**
 * A leaf type that grants services makes the declaration that grants them
 * required: a `Resources` argument other than the empty default requires
 * `resources`. So no typed input or explicit type argument grants a service
 * without the value that provides it.
 */
type RequiredDeclarations<Resources> = [Resources] extends [ReadonlyArray<never>]
  ? unknown
  : { readonly resources: Resources }

/** Author-facing input to `request({...})`. */
export type RequestInput<
  Input = unknown,
  Output = unknown,
  R = never,
  E extends RequestFailure = CapabilityError,
  Resources extends ReadonlyArray<AnyResourceContribution> = ReadonlyArray<never>,
> = RequestInputFields<Input, Output, R, E, Resources> & RequiredDeclarations<Resources>

interface RequestInputFields<
  Input,
  Output,
  R,
  E extends RequestFailure,
  Resources extends ReadonlyArray<AnyResourceContribution>,
> {
  /** Stable id (capability-local). Used for routing. */
  readonly id: string
  /** Schema for validating `input` at the boundary. */
  readonly input: Schema.Codec<Input, unknown, never, never>
  /** Schema for validating `output` at the boundary. */
  readonly output: Schema.Codec<Output, unknown, never, never>
  /** Human-readable description for registry/listing surfaces. */
  readonly description?: string
  /**
   * The request does not need this branch's side-mutation permit, so it
   * answers while a turn runs. Without it the request waits: the running turn
   * holds the permit until it ends, so a client read or a `/btw` fork would
   * freeze for the whole turn.
   *
   * Reads and extension-owned writes under their own lock qualify. The
   * Session facade's queued send and dequeueFollowUp also qualify: their
   * queue owner serializes admission and removal independently of the turn.
   * Changes that need the branch's side-mutation permit wait for the turn.
   */
  readonly answersDuringTurn?: boolean
  /** Optional slash-command presentation for public transport clients. */
  readonly slash?: {
    /** Slash trigger without the leading `/`. Defaults to `id`. */
    readonly trigger?: string
    readonly name?: string
    readonly description?: string
    readonly category?: string
    readonly keybind?: string
  }
  /**
   * The resources whose services the handler yields. Each is a
   * `defineResource` value the same extension registers; the loader fails
   * the extension when it does not.
   */
  readonly resources?: Resources
  /**
   * The request handler. It fails with its own tagged error; the factory
   * wraps that into the `CapabilityError` the wire carries, under the id
   * this input names and the extension `defineRequests`/`defineExtension` bind.
   * It may yield `LeafServices` and the services of its `resources`; a
   * handler that needs any other service does not compile.
   */
  readonly execute: CapabilityEffect<Input, Output, R, E>
}

/**
 * Lower a `RequestInput` to a typed `RequestCapability<Input, Output>`.
 * The returned capability also carries a typed `CapabilityRef<Input, Output>` under a local symbol,
 * read via the `ref(capability)` accessor, so a caller needs no separate
 * `*Ref` const next to each request.
 */
export function request<
  Input,
  Output,
  R extends LeafServices | DeclaredResourceServices<Resources> = never,
  E extends RequestFailure = CapabilityError,
  const Resources extends ReadonlyArray<AnyResourceContribution> = ReadonlyArray<never>,
>(input: RequestInput<Input, Output, R, E, Resources>): RequestCapability<Input, Output>
export function request(input: {
  readonly id: string
  readonly input: Schema.Codec<unknown, unknown, never, never>
  readonly output: Schema.Codec<unknown, unknown, never, never>
  readonly description?: string
  readonly answersDuringTurn?: boolean
  readonly slash?: RequestInput<unknown, unknown>["slash"]
  readonly resources?: ReadonlyArray<AnyResourceContribution>
  readonly execute: ErasedCapabilityEffect<RequestFailure>
}): RequestCapability {
  const rpcId = RpcId.make(input.id)
  const refState: RequestRefState = {
    extensionId: Option.none(),
    capabilityId: rpcId,
    input: input.input,
    output: input.output,
  }
  // CapabilityRef requires `Schema.Decoder<X, never>` for sync decoding at the
  // dispatcher boundary. The implementation signature erases Input/Output to
  // `unknown`, and a `Schema.Codec<unknown, unknown, never, never>` is such a
  // decoder; the public overloads restore the author types.
  const refValue: CapabilityRef = {
    get extensionId() {
      if (Option.isNone(refState.extensionId)) {
        // oxlint-disable-next-line effect/noThrowStatement, effect/noNewError -- Reading an unbound capability reference is programmer misuse.
        throw new Error(
          `request "${String(rpcId)}" is not bound to an extension; register it with host.register("request", ...) inside defineExtension's setup, or bind it with defineRequests(extensionId, ...), before reading ref(...)`,
        )
      }
      return refState.extensionId.value
    },
    capabilityId: refState.capabilityId,
    input: refState.input,
    output: refState.output,
  }
  // A handler's own error becomes the wire error under the ids this factory
  // and the binding already hold; an unbound request leaves the error to the
  // registry, which names the ids it routed by.
  const asCapabilityError = (error: RequestFailure): RequestFailure =>
    Option.match(refState.extensionId, {
      onNone: () => error,
      onSome: (extensionId) => {
        if (Schema.is(CapabilityError)(error)) return error
        return new CapabilityError({ extensionId, capabilityId: rpcId, reason: error.message })
      },
    })
  const effect: ErasedCapabilityEffect<RequestFailure> = (value) =>
    // @effect-diagnostics-next-line anyUnknownInErrorContext:off -- the erased handler crosses the runtime membrane; the public overloads keep authors typed.
    Effect.mapError(input.execute(value), asCapabilityError)
  // The factory applies its private brand and typed reference here; the
  // public overload restores the author's Input/Output.
  const capability: RequestCapability = {
    _tag: "request",
    id: rpcId,
    slash: input.slash,
    description: input.description,
    answersDuringTurn: input.answersDuringTurn,
    resources: input.resources ?? [],
    input: input.input,
    output: input.output,
    effect,
    [RequestCapabilityBrand]: true,
    [REQUEST_REF]: refValue,
    [REQUEST_REF_STATE]: refState,
  }
  return capability
}

export const bindRequestCapabilityExtension = <Input, Output>(
  capability: RequestCapability<Input, Output>,
  extensionId: ExtensionIdType,
): RequestCapability<Input, Output> => {
  capability[REQUEST_REF_STATE].extensionId = Option.some(extensionId)
  return capability
}

type RequestCapabilityMap = Record<string, RequestCapability>

export const defineRequests = <T extends RequestCapabilityMap>(
  extensionId: ExtensionIdType | string,
  requests: T,
): T => {
  const boundExtensionId = ExtensionId.make(extensionId)
  for (const capability of Object.values(requests)) {
    bindRequestCapabilityExtension(capability, boundExtensionId)
  }
  return requests
}

export const ref = <Input, Output>(
  capability: RequestCapability<Input, Output>,
): CapabilityRef<Input, Output> => capability[REQUEST_REF]

// ── tool capability ─────────────────────────────────────────────────────────

/*
 * `tool(...)` — typed factory for LLM-callable Capabilities.
 *
 * Authors call `tool({ id, description, params, execute, ... })` directly.
 * The factory enforces the LLM-tool shape at the type level: `params`
 * must be an LLM-JSON-schema-able `Schema.Schema`, `execute` returns an
 * `Effect`, and the request-only fields (`slash`, `input`) are forbidden.
 *
 * Lowering: produces a branded native Effect AI tool annotated with Gent
 * metadata. Runtime code reads Gent-only fields from that annotation instead
 * of widening Effect's tool surface.
 */

const ToolCapabilityBrand: unique symbol = Symbol("@gent/core/ToolCapability")
declare const ToolCapabilityType: unique symbol

/**
 * The declarations `source` actually carries, with absent ones left out.
 *
 * Omission matters: these are exact optional properties, so a key present and
 * set to `undefined` is not the same as a key that is missing. A conditional
 * spread drops the key entirely, and each field keeps its own type.
 */
const declarationsOf = (source: ToolDeclarations): ToolDeclarations => ({
  ...(Predicate.isNotUndefined(source.promptSnippet) && { promptSnippet: source.promptSnippet }),
  ...(Predicate.isNotUndefined(source.promptGuidelines) && {
    promptGuidelines: source.promptGuidelines,
  }),
  ...(Predicate.isNotUndefined(source.interactive) && { interactive: source.interactive }),
  ...(Predicate.isNotUndefined(source.dispatches) && { dispatches: source.dispatches }),
})

interface GentToolMetadata<
  Input = unknown,
  Output = unknown,
  Error = unknown,
> extends ToolDeclarations {
  readonly id: ToolId
  readonly readonly: boolean
  readonly input: Schema.Decoder<Input, never>
  readonly output: Schema.Encoder<unknown, never>
  // oxlint-disable-next-line effect/noUnknownParameters -- The toolkit decodes wire inputs; the factory validates the decoded value.
  readonly effect: (input: unknown) => Effect.Effect<Output, Error, never>
  /** The author's one-line result summary over wire values; see `ToolInput.summary`. */
  // oxlint-disable-next-line effect/noUnknownParameters -- Stored results are wire values; the author's typed function reads them.
  readonly summary?: (input: unknown, output: unknown) => string
  /** The resources the tool names; its extension must register each of these definitions. */
  readonly resources: ReadonlyArray<AnyResourceContribution>
  /** See `ToolInput.recover`; the loop runs it as a leaf of the tool's extension. */
  readonly recover?: (
    call: ToolRecoveryCall,
  ) => Effect.Effect<ToolCallRecoveryOutcome, ToolCallRecoveryError, never>
}

// oxlint-disable-next-line effect/noNullish -- The metadata annotation is absent on native tools outside the Gent factory.
export const GentToolMetadataTag = Context.Reference<GentToolMetadata | undefined>(
  "@gent/core/src/domain/capability/GentToolMetadata",
  // oxlint-disable-next-line effect/noNullish -- Native tools do not carry Gent metadata.
  { defaultValue: () => undefined },
)

/**
 * `ToolCapability` — `tool({...})` return type. Gent tools are native Effect AI
 * tools annotated with Gent execution metadata. Runtime code reads Gent-only
 * fields from the annotation instead of widening Effect's tool surface.
 */
type GentParametersSchema = Schema.Codec<unknown, unknown, never, never>
type GentResultSchema = Schema.Encoder<unknown, never>
type GentFailureSchema = Schema.Codec<Error, unknown, never, never>

type GentAiTool = AiTool.Tool<
  string,
  {
    readonly parameters: GentParametersSchema
    readonly success: GentResultSchema
    readonly failure: GentFailureSchema
    readonly failureMode: "error"
  },
  never
>

export type ToolCapability<Input = unknown, Output = unknown, Error = unknown> = GentAiTool & {
  /**
   * Effect's own tool id, `effect/ai/Tool/<id>`; it is not the Gent tool id.
   * Read that with `getToolId(tool)`: a comparison of this field with a
   * `ToolId` does not compile.
   */
  readonly id: `effect/ai/Tool/${string}`
  readonly [ToolCapabilityBrand]: true
  readonly [ToolCapabilityType]?: {
    readonly input: Input
    readonly output: Output
    readonly error: Error
  }
}

// oxlint-disable-next-line effect/noNullish -- Native tools do not carry Gent metadata.
const getToolMetadataOption = (tool: AiTool.Any): GentToolMetadata | undefined =>
  Context.get(tool.annotations, GentToolMetadataTag)

export const isToolCapability = (value: unknown): value is ToolCapability => {
  if (!AiTool.isDynamic(value) || !(ToolCapabilityBrand in value)) {
    return false
  }
  return !Predicate.isUndefined(getToolMetadataOption(value))
}

/**
 * Invariant violation: a `ToolCapability` should always carry `GentToolMetadata`.
 * Surfaces as a typed defect (via `Effect.die`) when callers thread through
 * an Effect; surfaces as a synchronous throw otherwise. Either path is a
 * programmer-misuse-only signal — no runtime code can construct a `ToolCapability`
 * without metadata through the public `tool({...})` factory.
 */
class ToolMetadataMissingError extends Schema.TaggedError<ToolMetadataMissingError>()(
  "ToolMetadataMissingError",
  {
    toolName: Schema.String,
  },
) {
  override get message(): string {
    return `Tool "${this.toolName}" is missing Gent metadata`
  }
}

export const getToolMetadata = <Input, Output, Error>(
  tool: ToolCapability<Input, Output, Error>,
): GentToolMetadata<Input, Output, Error> => {
  const metadata = getToolMetadataOption(tool)
  if (Predicate.isUndefined(metadata)) {
    // oxlint-disable-next-line effect/noThrowStatement -- Missing Gent metadata is programmer misuse of the synchronous accessor.
    throw new ToolMetadataMissingError({ toolName: tool.name })
  }
  // oxlint-disable-next-line effect/noAs, typescript/no-unsafe-type-assertion -- Annotation storage is heterogeneous; the branded ToolCapability carries the requested phantom types.
  return metadata as GentToolMetadata<Input, Output, Error>
}

export const getToolId = (tool: ToolCapability): ToolId => getToolMetadata(tool).id

/**
 * The one-line summary of a tool result: the tool's own `summary` for a
 * success when it has one, otherwise the head of the output. A throwing
 * author summary falls back, so a summary can never fail a call.
 */
export const toolResultSummary = (
  tool: Option.Option<ToolCapability>,
  // oxlint-disable-next-line effect/noUnknownParameters -- Tool input is the wire value the model sent.
  input: unknown,
  result: { readonly isFailure: boolean; readonly result: unknown },
): string => {
  const fallback = () => summarizeToolResult(result)
  if (result.isFailure) return fallback()
  const summarize = Option.flatMap(tool, (found) =>
    Option.fromUndefinedOr(getToolMetadata(found).summary),
  )
  if (Option.isNone(summarize)) return fallback()
  return Option.match(Result.getSuccess(Result.try(() => summarize.value(input, result.result))), {
    onNone: fallback,
    onSome: clipSummary,
  })
}

/** Prompt text for extension-owned tool catalogs, without execution metadata. */
export const getToolPrompt = (
  tool: ToolCapability,
): Pick<GentToolMetadata, "promptSnippet" | "promptGuidelines"> => {
  const { promptSnippet, promptGuidelines } = getToolMetadata(tool)
  return { promptSnippet, promptGuidelines }
}

/** Author-facing input to `tool(...)`. Mirrors the LLM-tool fields as a
 *  standalone leaf with no shared capability parent.
 *
 *  `Params` is a `Schema.Codec<I, E, never, never>` — the tool adapter
 *  decodes JSON synchronously, and Effect AI encodes the streamed tool-call
 *  parameters, so neither direction may have a context requirement. */
export type ToolInput<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- schema and brand factory owns nominal type boundary
  Params extends Schema.Codec<any, any, never, never> = Schema.Codec<any, any, never, never>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- schema and brand factory owns nominal type boundary
  Output extends Schema.Encoder<any, never> = Schema.Encoder<any, never>,
  Error = never,
  Deps = never,
  Resources extends ReadonlyArray<AnyResourceContribution> = ReadonlyArray<never>,
  RecoverDeps = never,
> = ToolInputFields<Params, Output, Error, Deps, Resources, RecoverDeps> &
  RequiredDeclarations<Resources>

interface ToolInputFields<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- schema and brand factory owns nominal type boundary
  Params extends Schema.Codec<any, any, never, never>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- schema and brand factory owns nominal type boundary
  Output extends Schema.Encoder<any, never>,
  Error,
  Deps,
  Resources extends ReadonlyArray<AnyResourceContribution>,
  RecoverDeps,
> extends ToolDeclarations {
  /** Stable id (extension-local). Used by the LLM as the tool name. */
  readonly id: string
  /** Sent to the LLM as part of the tool schema — describes what the tool does. */
  readonly description: string
  /** Marks a tool as side-effect-free for Effect AI provider metadata.
   *  Defaults to `false`. Read-only tools (e.g. `fs-tools/read`, `grep`,
   *  `glob`) should pass `readonly: true`. */
  readonly readonly?: boolean
  /** Marks a write tool as destructive for Effect AI provider metadata. */
  readonly destructive?: boolean
  /**
   * Schema for `execute` input. Must have no context requirement in either
   * direction: the tool adapter decodes JSON synchronously, and Effect AI
   * encodes the streamed tool-call parameters.
   */
  readonly params: Params
  /** Schema for successful `execute` output. Effect AI owns result encoding
   *  through this schema, and Gent stores the same schema in metadata for
   *  lifecycle hooks and direct tool-runner invocation. */
  readonly output: Output
  /**
   * The resources whose services the body yields. Each is a `defineResource`
   * value the same extension registers; the loader fails the extension when
   * it does not.
   */
  readonly resources?: Resources
  /**
   * The tool body. Receives decoded `params`. It may yield `LeafServices` and
   * the services of its `resources`; a body that needs any other service does
   * not compile.
   */
  readonly execute: (
    params: Schema.Schema.Type<Params>,
  ) => Effect.Effect<Schema.Schema.Type<Output>, Error, Deps>
  /**
   * One line that says what a successful call did, e.g. `exit 0, 12 lines`.
   * It is the summary on the tool's terminal event, on a cell's operation
   * receipt, and on every row a client draws from those, including after a
   * reload. It reads the wire values: the input as the model sent it and the
   * output as `output` encoded it. Without it (or when it throws), the head
   * of the output is the summary.
   */
  readonly summary?: (input: Params["Encoded"], output: Output["Encoded"]) => string
  /**
   * Settles a call of this tool that a crash left in flight. When a turn
   * resumes, the loop calls it once for each call of the tool that has no
   * result, as a leaf of this extension, with the same services the body
   * gets. It answers `Settled` with the result a durable receipt gives,
   * `Suspended` when the call waits on an interaction, or `NotRecovered`. A
   * tool without it, or one that answers `NotRecovered`, is reported to the
   * model as interrupted, unless its last run parked on an interaction.
   */
  readonly recover?: (
    call: ToolRecoveryCall,
  ) => Effect.Effect<ToolCallRecoveryOutcome, ToolCallRecoveryError, RecoverDeps>
}

/**
 * Lower a `ToolInput` to a `ToolCapability`. Defaults to a write tool unless
 * `readonly: true`; destructive metadata is opt-in.
 */
export const tool = <
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- schema and brand factory owns nominal type boundary
  Params extends Schema.Codec<any, any, never, never>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- schema and brand factory owns nominal type boundary
  Output extends Schema.Encoder<any, never>,
  Error,
  Deps extends LeafServices | DeclaredResourceServices<Resources>,
  const Resources extends ReadonlyArray<AnyResourceContribution> = ReadonlyArray<never>,
  RecoverDeps extends LeafServices | DeclaredResourceServices<Resources> = never,
>(
  input: ToolInput<Params, Output, Error, Deps, Resources, RecoverDeps>,
): ToolCapability<Schema.Schema.Type<Params>, Schema.Schema.Type<Output>, Error> => {
  const params = input.params
  const id = ToolId.make(input.id)
  const metadata: GentToolMetadata<
    Schema.Schema.Type<Params>,
    Schema.Schema.Type<Output>,
    Error
  > = {
    id,
    readonly: input.readonly === true,
    input: input.params,
    output: input.output,
    effect: (params) => {
      const decoded = Schema.decodeUnknownSync(Schema.toType(input.params))(params)
      // oxlint-disable-next-line effect/noAs, typescript/no-unsafe-type-assertion -- The bound on `Deps` admits only services every tool body gets; the runtime provides them at execution boundaries.
      return input.execute(decoded) as Effect.Effect<Schema.Schema.Type<Output>, Error, never>
    },
    resources: input.resources ?? [],
  }
  Object.assign(metadata, declarationsOf(input))
  const recover = input.recover
  if (Predicate.isNotUndefined(recover)) {
    const erased: GentToolMetadata["recover"] = (call) =>
      // oxlint-disable-next-line effect/noAs, typescript/no-unsafe-type-assertion -- The bound on `RecoverDeps` admits only services every tool body gets; the loop provides them at the recovery boundary.
      recover(call) as Effect.Effect<ToolCallRecoveryOutcome, ToolCallRecoveryError, never>
    Object.assign(metadata, { recover: erased })
  }
  const summarize = input.summary
  if (Predicate.isNotUndefined(summarize)) {
    // Stored values are wire values; the tool's own schemas check them
    // before the author's typed function reads them.
    const decodeInput = Schema.decodeUnknownSync(Schema.toEncoded(input.params))
    const decodeOutput = Schema.decodeUnknownSync(Schema.toEncoded(input.output))
    const summary: GentToolMetadata["summary"] = (wireInput, wireOutput) =>
      summarize(decodeInput(wireInput), decodeOutput(wireOutput))
    Object.assign(metadata, { summary })
  }

  const native = AiTool.dynamic(input.id, {
    description: input.description,
    parameters: params,
    success: input.output,
  })
    .annotate(GentToolMetadataTag, metadata)
    .annotate(AiTool.Readonly, metadata.readonly)
    .annotate(AiTool.Destructive, input.destructive === true)
  const brand: ToolCapability<
    Schema.Schema.Type<Params>,
    Schema.Schema.Type<Output>,
    Error
  >[typeof ToolCapabilityBrand] = true
  // The value `AiTool.dynamic` already set; restated so the type names its form.
  const nativeId: ToolCapability["id"] = `effect/ai/Tool/${input.id}`
  const branded = Object.assign(native, { id: nativeId, [ToolCapabilityBrand]: brand })

  return branded
}

// ── tool-wire-name ──────────────────────────────────────────────────────────

/**
 * The name a model provider sees for a tool. Provider APIs take only
 * `^[a-zA-Z0-9_-]+$`: Anthropic up to 128 characters, OpenAI up to 64. A
 * tool id may name a namespace with dots (`session.send`, `delegate.start`),
 * so each dot goes on the wire as `__`. `isWireToolId` keeps the mapping
 * reversible: an id is dot-separated segments of letters, digits and `-`
 * joined by single `_`, so no segment holds `__` or starts or ends with `_`.
 * Only the provider request and its reply use the wire name; events,
 * messages and tool dispatch keep the id. Extension validation rejects any
 * other id, so no loaded tool has a name the mapping cannot carry back
 * (decided by make-impossible-states-unrepresentable; the mapping sits at the
 * model boundary, decided by boundary-discipline).
 */
const WIRE_NAMESPACE_SEPARATOR = "__"

/** The longest wire name every provider accepts (OpenAI's limit). */
const WIRE_TOOL_NAME_MAX = 64

const TOOL_ID_PATTERN = /^[a-zA-Z0-9-]+(?:_[a-zA-Z0-9-]+)*(?:\.[a-zA-Z0-9-]+(?:_[a-zA-Z0-9-]+)*)*$/

export const wireToolName = (id: string): string => id.replaceAll(".", WIRE_NAMESPACE_SEPARATOR)

const toolIdFromWire = (name: string): string => name.replaceAll(WIRE_NAMESPACE_SEPARATOR, ".")

/** True when `id` has a wire name every provider accepts and that decodes back to it. */
export const isWireToolId = (id: string): boolean =>
  TOOL_ID_PATTERN.test(id) && wireToolName(id).length <= WIRE_TOOL_NAME_MAX

/**
 * True when the tool's parameters can be written as the JSON Schema a model
 * request lists (a symbol-keyed struct cannot). Extension validation rejects
 * any other tool, so every loaded tool has one.
 */
export const hasWireParameters = (tool: ToolCapability): boolean =>
  Result.isSuccess(Result.try(() => AiTool.getJsonSchema(tool)))

/** A prompt as the provider sees it: every tool call and result under its tool's wire name. */
export const toWirePrompt = (prompt: Prompt.Prompt): Prompt.Prompt =>
  Prompt.fromMessages(
    prompt.content.map((message): Prompt.Message => {
      switch (message.role) {
        case "assistant":
          return Prompt.makeMessage("assistant", {
            content: message.content.map((part) => {
              if (part.type === "tool-call" || part.type === "tool-result") {
                return { ...part, name: wireToolName(part.name) }
              }
              return part
            }),
            options: message.options,
          })
        case "tool":
          return Prompt.makeMessage("tool", {
            content: message.content.map((part) => {
              if (part.type === "tool-result") return { ...part, name: wireToolName(part.name) }
              return part
            }),
            options: message.options,
          })
        default:
          return message
      }
    }),
  )

/** A part of the model's reply, with each tool named by its id again. */
export const fromWireToolPart = (part: Response.AnyPart): Response.AnyPart => {
  switch (part.type) {
    case "tool-params-start":
    case "tool-call":
    case "tool-result":
      return { ...part, name: toolIdFromWire(part.name) }
    default:
      return part
  }
}

// ── tool-binding ────────────────────────────────────────────────────────────

/** Revision of the loaded source snapshot that produced a tool binding. */
export const ToolSourceRevision = Schema.NonEmptyString.pipe(Schema.brand("ToolSourceRevision"))
export type ToolSourceRevision = typeof ToolSourceRevision.Type

/** Revision of the schema advertised for a tool binding. */
export const ToolSchemaRevision = Schema.NonEmptyString.pipe(Schema.brand("ToolSchemaRevision"))
export type ToolSchemaRevision = typeof ToolSchemaRevision.Type

/** The source identity for a tool binding.
 *
 * A static binding names a build artifact and replays across processes. A
 * process-local binding is replayable only inside the process that recorded it.
 */
export const ToolBindingSource = Schema.TaggedUnion({
  Static: {
    sourceRevision: ToolSourceRevision,
  },
  /**
   * A static tool loaded without a build-owned artifact, as in a source run.
   * The revision names one resource generation of one process. It is valid for
   * resume inside that generation and never across a process restart.
   */
  ProcessLocal: {
    sourceRevision: ToolSourceRevision,
  },
})
export type ToolBindingSource = typeof ToolBindingSource.Type

/** JSON-safe identity captured when a tool was advertised. */
export const ToolBindingIdentity = Schema.Struct({
  toolId: ToolId,
  extensionId: ExtensionId,
  source: ToolBindingSource,
  schemaRevision: ToolSchemaRevision,
})
export type ToolBindingIdentity = typeof ToolBindingIdentity.Type

export const validateToolBindingIdentity = Schema.decodeUnknownEffect(ToolBindingIdentity)

/** JSON codec used by the durable binding storage. */
const ToolBindingIdentityJson = Schema.fromJsonString(ToolBindingIdentity)

export const encodeToolBindingIdentity = Schema.encodeEffect(ToolBindingIdentityJson)
export const decodeToolBindingIdentity = Schema.decodeUnknownEffect(ToolBindingIdentityJson)

/** Key for one assistant tool call binding row. */
export const ToolCallBindingKey = Schema.Struct({
  assistantMessageId: MessageId,
  toolCallId: ToolCallId,
})
export type ToolCallBindingKey = typeof ToolCallBindingKey.Type

/** The immutable row already contains a different binding identity. */
export class ToolCallBindingConflictError extends Schema.TaggedError<ToolCallBindingConflictError>()(
  "ToolCallBindingConflictError",
  {
    assistantMessageId: MessageId,
    toolCallId: ToolCallId,
  },
) {}

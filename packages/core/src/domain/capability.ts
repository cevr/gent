import { Context, Effect, Option, Predicate, Schema } from "effect"
import {
  ExtensionId,
  type ExtensionId as ExtensionIdType,
  MessageId,
  RpcId,
  ToolCallId,
  ToolId,
} from "./ids.js"
import * as AiTool from "effect/unstable/ai/Tool"

// ── prompt ──────────────────────────────────────────────────────────────────

/**
 * System prompt construction via ordered sections.
 *
 * Static prompt sections are bundled on capability leaf `prompt`. Dynamic
 * content resolved per-turn from services lives on extension hooks.
 */
export interface PromptSection {
  readonly id: string
  readonly content: string
  /** Lower = earlier in the prompt. Default sections use 0-80 range. */
  readonly priority: number
}

export const compileSystemPrompt = (sections: ReadonlyArray<PromptSection>): string =>
  [...sections]
    .sort((a, b) => a.priority - b.priority)
    .map((s) => s.content)
    .join("\n\n")

/** The one section core writes: where the loop is running. Everything an agent *is* comes from extensions. */
export function environmentSection(options: {
  cwd: string
  platform: string
  isGitRepo: boolean
  date: string
  shell?: string
  osVersion?: string
}): PromptSection {
  const { cwd, platform, isGitRepo, date, shell, osVersion } = options
  let platformDisplay = platform
  if (!Predicate.isUndefined(osVersion)) platformDisplay = `${platform} (${osVersion})`
  let shellDisplay = "unknown"
  if (!Predicate.isUndefined(shell)) shellDisplay = shell
  let gitRepository = "no"
  if (isGitRepo) gitRepository = "yes"
  return {
    id: "environment",
    content: `# Environment\n\nWorking directory: ${cwd}\nPlatform: ${platformDisplay}\nShell: ${shellDisplay}\nGit repository: ${gitRepository}\nDate: ${date}`,
    priority: 60,
  }
}

// ── capability ──────────────────────────────────────────────────────────────

/** Shared extension callable primitives. Tool and request leaves are
 * independent; this file holds only errors, host contexts, and typed request
 * references used across those leaves.
 *
 * @module
 */

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
  /** Static system-prompt section bundled with this tool. For dynamic
   *  prompt fragments resolved per-turn from services, use a turn projection hook. */
  readonly prompt?: PromptSection
}

/**
 * Erased runtime shape of a `tool({...})` Capability. The author-facing branded
 * `ToolCapability` is in the tool section below; runtime code reads Gent-only
 * fields from the `GentToolMetadata` annotation, not this shape.
 */
interface ToolCapabilityApi extends ToolDeclarations {
  readonly _tag: "tool"
  readonly id: ToolId
  readonly readonly: boolean
  readonly input: unknown
  readonly output: unknown
  readonly effect: unknown
  readonly description: string
  readonly metadata: unknown
}

/**
 * Erased runtime shape of a `request({...})` Capability. The author-facing
 * branded `RequestCapability` is in the request section below.
 */
interface RequestCapabilityApi {
  readonly _tag: "request"
  readonly id: RpcId
  readonly prompt?: PromptSection
  readonly input: unknown
  readonly output: unknown
  readonly effect: unknown
  readonly slash?: unknown
  readonly description?: string
  /** Answers during a turn: runs without the loop's mutation permit. Must not change loop state. */
  readonly readonly?: boolean
  readonly ref: unknown
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

// ── capability/request ──────────────────────────────────────────────────────

/**
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
 *
 * @module
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
  readonly prompt?: PromptSection
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

/** Author-facing input to `request({...})`. */
export interface RequestInput<
  Input = unknown,
  Output = unknown,
  R = never,
  E extends RequestFailure = CapabilityError,
> {
  /** Stable id (capability-local). Used for routing. */
  readonly id: string
  /** Schema for validating `input` at the boundary. */
  readonly input: Schema.Codec<Input, unknown, never, never>
  /** Schema for validating `output` at the boundary. */
  readonly output: Schema.Codec<Output, unknown, never, never>
  /** Static system-prompt section bundled with this request. */
  readonly prompt?: PromptSection
  /** Human-readable description for registry/listing surfaces. */
  readonly description?: string
  /**
   * A read-only request answers while a turn is running: it skips the loop's
   * mutation permit, which the running turn otherwise holds until it ends. It
   * must not change loop state. Default: the request waits for the turn.
   */
  readonly readonly?: boolean
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
   * The request handler. It fails with its own tagged error; the factory
   * wraps that into the `CapabilityError` the wire carries, under the id
   * this input names and the extension `defineRequests`/`defineExtension` bind.
   */
  readonly execute: CapabilityEffect<Input, Output, R, E>
}

/**
 * Lower a `RequestInput` to a typed `RequestCapability<Input, Output>`.
 * The returned capability also carries a typed `CapabilityRef<Input, Output>` under a local symbol,
 * read via the `ref(capability)` accessor — so callers no longer hand-roll a
 * parallel `*Ref` const next to every request.
 */
export function request<Input, Output, R = never, E extends RequestFailure = CapabilityError>(
  input: RequestInput<Input, Output, R, E>,
): RequestCapability<Input, Output>
export function request(input: {
  readonly id: string
  readonly input: Schema.Codec<unknown, unknown, never, never>
  readonly output: Schema.Codec<unknown, unknown, never, never>
  readonly prompt?: PromptSection
  readonly description?: string
  readonly readonly?: boolean
  readonly slash?: RequestInput<unknown, unknown>["slash"]
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
  // dispatcher boundary. Author-supplied schemas always satisfy this — the
  // overload signatures (above) constrain Input/Output to `Schema.Schema<X>`
  // which has `DecodingServices: never`. The cast is at the implementation
  // signature only; type-safety is restored by the public overloads.
  // oxlint-disable-next-line effect/noAs, effect/noChainedTypeAssertions, typescript/no-unsafe-type-assertion -- The implementation overload erases the author schema types; public overloads restore them.
  const refValue = {
    get extensionId() {
      if (Option.isNone(refState.extensionId)) {
        // oxlint-disable-next-line effect/noThrowStatement, effect/noNewError -- Reading an unbound capability reference is programmer misuse.
        throw new Error(
          `request "${String(rpcId)}" is not bound to an extension; include it in defineExtension({ id, requests }) before reading ref(...)`,
        )
      }
      return refState.extensionId.value
    },
    capabilityId: refState.capabilityId,
    input: refState.input,
    output: refState.output,
  } as unknown as CapabilityRef
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
    // @effect-diagnostics-next-line anyUnknownInErrorContext:off — the erased handler crosses the runtime membrane; the public overloads keep authors typed.
    Effect.mapError(input.execute(value), asCapabilityError)
  const capability: RequestCapabilityApi = {
    _tag: "request",
    id: rpcId,
    slash: input.slash,
    description: input.description,
    readonly: input.readonly,
    input: input.input,
    output: input.output,
    prompt: input.prompt,
    effect,
    ref: refValue,
  }
  // oxlint-disable-next-line effect/noAs, effect/noChainedTypeAssertions, typescript/no-unsafe-type-assertion -- The factory applies its private brand and typed reference at the runtime membrane.
  return Object.assign(capability, {
    [RequestCapabilityBrand]: true,
    [REQUEST_REF]: refValue,
    [REQUEST_REF_STATE]: refState,
  }) as unknown as RequestCapability
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

// ── capability/tool ─────────────────────────────────────────────────────────

/**
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
 *
 * @module
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
  ...(Predicate.isNotUndefined(source.prompt) && { prompt: source.prompt }),
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
type GentParametersSchema = Schema.Decoder<unknown, never>
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
  readonly [ToolCapabilityBrand]: true
  readonly [ToolCapabilityType]?: {
    readonly input: Input
    readonly output: Output
    readonly error: Error
  }
} & ToolCapabilityApi

// oxlint-disable-next-line effect/noNullish -- Native tools do not carry Gent metadata.
const getToolMetadataOption = (tool: AiTool.Any): GentToolMetadata | undefined =>
  Context.get(tool.annotations, GentToolMetadataTag)

// oxlint-disable-next-line effect/noUnknownParameters -- Native Effect tools are narrowed by their runtime predicates below.
export const isToolCapability = (value: unknown): value is ToolCapability => {
  if (
    !(AiTool.isUserDefined(value) || AiTool.isDynamic(value) || AiTool.isProviderDefined(value)) ||
    !(ToolCapabilityBrand in value)
  ) {
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
 *  `Params` is a `Schema.Decoder<I, never>` — the tool adapter needs to
 *  decode JSON synchronously without resolving services, so the decoder
 *  may not have a context requirement. */
export interface ToolInput<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- schema and brand factory owns nominal type boundary
  Params extends Schema.Decoder<any, never> = Schema.Decoder<any, never>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- schema and brand factory owns nominal type boundary
  Output extends Schema.Encoder<any, never> = Schema.Encoder<any, never>,
  Error = never,
  Deps = never,
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
   * Schema for `execute` input. Must have no context requirement so the
   * tool adapter can decode JSON synchronously without resolving services.
   * `Schema.Decoder<I, never>` ⊆ `Schema.Schema<I, _, never>`.
   */
  readonly params: Params
  /** Schema for successful `execute` output. Effect AI owns result encoding
   *  through this schema, and Gent stores the same schema in metadata for
   *  lifecycle hooks and direct tool-runner invocation. */
  readonly output: Output
  /** The tool body. Receives decoded `params`; host capabilities are imported
   *  as constrained Effect services such as `ExtensionContext`. */
  readonly execute: (
    params: Schema.Schema.Type<Params>,
  ) => Effect.Effect<Schema.Schema.Type<Output>, Error, Deps>
}

/**
 * Lower a `ToolInput` to a `ToolCapability` (defaults to a write/destructive
 * tool unless `readonly: true` is set).
 */
export const tool = <
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- schema and brand factory owns nominal type boundary
  Params extends Schema.Decoder<any, never>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- schema and brand factory owns nominal type boundary
  Output extends Schema.Encoder<any, never>,
  Error,
  Deps,
>(
  input: ToolInput<Params, Output, Error, Deps>,
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
      // oxlint-disable-next-line effect/noAs, typescript/no-unsafe-type-assertion -- The factory erases author service requirements; the runtime provides them at execution boundaries.
      return input.execute(decoded) as Effect.Effect<Schema.Schema.Type<Output>, Error, never>
    },
  }
  Object.assign(metadata, declarationsOf(input))

  const native = AiTool.dynamic(input.id, {
    description: input.description,
    parameters: params,
    success: input.output,
  })
    .annotate(GentToolMetadataTag, metadata)
    .annotate(AiTool.Readonly, metadata.readonly)
    .annotate(AiTool.Destructive, input.destructive === true)
  type MutableCapability = { -readonly [K in keyof ToolCapabilityApi]: ToolCapabilityApi[K] }
  const capability: MutableCapability = {
    _tag: "tool",
    id,
    readonly: metadata.readonly,
    input: metadata.input,
    output: metadata.output,
    effect: metadata.effect,
    description: input.description,
    metadata,
  }
  Object.assign(capability, declarationsOf(metadata))
  const brand: ToolCapability<
    Schema.Schema.Type<Params>,
    Schema.Schema.Type<Output>,
    Error
  >[typeof ToolCapabilityBrand] = true
  const branded = Object.assign(native, capability, { [ToolCapabilityBrand]: brand })

  return branded
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

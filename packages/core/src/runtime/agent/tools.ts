import {
  Cause,
  Context,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Match,
  Option,
  Path,
  Predicate,
  Schema,
  Sink,
  Stream,
} from "effect"
import type { OwnedToolCallAddress } from "../../storage/sqlite/owned-tool-call.js"
import {
  type BranchId,
  type ExtensionId,
  type MessageId,
  type ProcessGenerationId,
  type SessionId,
  ToolCallId,
  ToolId,
} from "../../domain/ids.js"
import type { ExtensionHostContext, LoadedExtension } from "../../domain/extension.js"
import * as Prompt from "effect/unstable/ai/Prompt"
import { ToolCallBindingStorage } from "../../storage/tool-call-binding-storage.js"
import {
  getToolId,
  getToolMetadata,
  ToolBindingIdentity,
  ToolBindingSource,
  type ToolCapability,
  ToolSchemaRevision,
  ToolSourceRevision,
} from "../../domain/capability.js"
import { ExtensionRegistry, type ExtensionRegistryService } from "../extensions/registry.js"
import { canonicalJsonString } from "effect-encore"
import * as AiTool from "effect/unstable/ai/Tool"
import { GentPlatform } from "../gent-platform.js"
import type { ExtraRepositories } from "../../storage/sqlite-storage.js"
import type { FeatureMigrations } from "../../storage/schema.js"
import {
  emptyErasedResourceLayer,
  type ErasedResourceLayer,
  provideExtensionLeaf,
} from "../extensions/extension-effect-membrane.js"
import {
  stopWithTurn,
  type TurnInterruptionStatus,
  TurnInterruptSignal,
} from "./turn-interruption.js"
import { InteractionPendingError } from "../../domain/interaction.js"
import {
  EventPublisher,
  ToolCallFailed,
  ToolCallStarted,
  ToolCallSucceeded,
} from "../../domain/event.js"
import {
  encodeToolOutput,
  stringifyOutput,
  summarizeOutput,
  ToolResultFailure,
} from "../../domain/message.js"
import { WideEvent, WideEventBoundary, withWideEvent } from "../wide-event-boundary.js"
import * as AiToolkit from "effect/unstable/ai/Toolkit"
import * as AiError from "effect/unstable/ai/AiError"
import type { AgentName as AgentNameType } from "../../domain/agent.js"

// ── current-tool-call ───────────────────────────────────────────────────────

/** Set by transcript dispatch. Model input and worker frames cannot select this address. */
export class CurrentToolCall extends Context.Service<
  CurrentToolCall,
  OwnedToolCallAddress & {
    readonly toolBindings: ReadonlyMap<string, ResolvedToolCapability>
  }
>()("@gent/core/src/runtime/agent/tools/CurrentToolCall") {}

// ── current-dispatching-call ────────────────────────────────────────────────

/**
 * The tool call that dispatched the call running right now, if any.
 *
 * A tool that runs other tools inside itself sets this for the duration of an
 * inner call, so events raised by that call can name their parent and attach
 * to the assistant message that holds the dispatching part. Absent means the
 * call came straight from the model.
 *
 * Host-owned: never set from tool code.
 */

interface DispatchingCall {
  readonly assistantMessageId: MessageId
  readonly toolCallId: ToolCallId
}

export class CurrentDispatchingCall extends Context.Service<
  CurrentDispatchingCall,
  DispatchingCall
>()("@gent/core/src/runtime/agent/tools/CurrentDispatchingCall") {}

// ── current-extension-host-context ──────────────────────────────────────────

export class CurrentExtensionHostContext extends Context.Service<
  CurrentExtensionHostContext,
  ExtensionHostContext
>()("@gent/core/src/runtime/agent/tools/CurrentExtensionHostContext") {}

export const provideCurrentHostCtx =
  (hostCtx: ExtensionHostContext) =>
  <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, Exclude<R, CurrentExtensionHostContext>> =>
    effect.pipe(Effect.provideService(CurrentExtensionHostContext, hostCtx))

// ── tool-binding-resolution ─────────────────────────────────────────────────

/** Capture the loaded capability and its durable identity. */
export const captureCurrentToolBinding = Effect.fn("ToolBinding.captureCurrent")(function* (
  toolName: string,
) {
  const runner = yield* ToolRunner
  const registry = yield* ExtensionRegistry
  const captured = yield* runner.capture({ toolName })
  if (Option.isNone(captured)) return Option.none<ResolvedToolCapability>()
  return Option.some(
    yield* attachToolBindingIdentity(captured.value, registry.getResolved().extensions),
  )
})

/**
 * The identity a dispatching tool records for one inner host operation. A
 * build-owned binding is durable. A source run has none, so the operation names
 * the live process instead; resume is then valid only inside that process. A
 * turn without a process identity cannot bind a source-run tool at all.
 */
export const innerOperationBindingIdentity = Effect.fn("ToolBinding.innerOperationIdentity")(
  function* (entry: ResolvedToolCapability, generationId?: ProcessGenerationId) {
    if (Predicate.isNotUndefined(entry.binding)) return Option.some(entry.binding)
    if (Predicate.isUndefined(generationId)) return Option.none<ToolBindingIdentity>()
    return yield* processLocalToolBindingIdentity(entry, generationId)
  },
)

/** Validate an owned durable binding without assuming a model-message storage layout.
 * The caller verifies receipt ownership.
 */
export const resolveStoredToolBinding = Effect.fn("ToolBinding.resolveStored")(function* (params: {
  readonly sessionId: SessionId
  readonly assistantMessageId: MessageId
  readonly toolCallId: ToolCallId
  readonly binding: ToolBindingIdentity
  readonly generationId?: ProcessGenerationId
}) {
  const toolName = String(params.binding.toolId)
  const fail = (reason: ToolBindingReplayReason, message: string) =>
    makeBindingReplayError({
      assistantMessageId: params.assistantMessageId,
      toolCallId: params.toolCallId,
      toolId: params.binding.toolId,
      reason,
      message,
    })
  const current = yield* captureCurrentToolBinding(toolName)
  if (Option.isNone(current)) {
    return yield* fail(
      "ToolUnavailable",
      `Tool ${toolName} is not available in the loaded extension profile`,
    )
  }
  if (params.binding.source._tag === "ProcessLocal") {
    const generationId = Option.fromUndefinedOr(params.generationId)
    if (Option.isNone(generationId)) {
      return yield* fail(
        "SourceMismatch",
        `Tool ${toolName} was bound to a process that is no longer live`,
      )
    }
    const live = yield* processLocalToolBindingIdentity(current.value, generationId.value)
    if (Option.isNone(live)) {
      return yield* fail(
        "SourceMismatch",
        `Tool ${toolName} now has a different source identity than its process-local binding`,
      )
    }
    if (!sameToolBindingIdentity(params.binding, live.value)) {
      const reason = bindingMismatchReason(params.binding, live.value)
      return yield* fail(reason, `Tool ${toolName} binding identity changed (${reason})`)
    }
    return current.value
  }
  if (Predicate.isUndefined(current.value.binding)) {
    return yield* fail(
      "MissingSourceIdentity",
      `Tool ${toolName} has no trusted loaded source identity`,
    )
  }
  if (!sameToolBindingIdentity(params.binding, current.value.binding)) {
    const reason = bindingMismatchReason(params.binding, current.value.binding)
    return yield* fail(reason, `Tool ${toolName} binding identity changed (${reason})`)
  }
  return current.value
})

/**
 * Resolve replay authority for native, external, and direct tool adapters.
 * Durable rows take precedence. A missing row can use only a same-process
 * capability that never had a durable identity.
 * Callers own result persistence and interaction policy.
 */
export const resolveReplayToolBinding = Effect.fn("ToolBinding.resolveReplay")(function* (params: {
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly assistantMessageId: MessageId
  readonly toolCall: Prompt.ToolCallPart
  readonly generationId?: ProcessGenerationId
}) {
  const storage = yield* ToolCallBindingStorage
  const localReplay = yield* ProcessLocalToolReplay
  const address = {
    sessionId: params.sessionId,
    branchId: params.branchId,
    assistantMessageId: params.assistantMessageId,
    toolCallId: ToolCallId.make(params.toolCall.id),
  }
  const key = processLocalReplayBindingKey(address)
  const toolName = params.toolCall.name
  const fail = (reason: ToolBindingReplayReason, message: string) =>
    Effect.andThen(
      localReplay.removeBinding(key),
      makeBindingReplayError({
        ...address,
        toolId: ToolId.make(toolName),
        reason,
        message,
      }),
    )
  const stored = Option.fromUndefinedOr(yield* storage.get(address))
  if (Option.isNone(stored)) {
    const local = yield* localReplay.getBinding(key)
    if (Option.isNone(local) || Predicate.isNotUndefined(local.value.entry.binding)) {
      return yield* fail("MissingBinding", `No durable binding was recorded for tool ${toolName}`)
    }
    const current = yield* captureCurrentToolBinding(toolName)
    if (Option.isNone(current)) {
      return yield* fail(
        "ToolUnavailable",
        `Tool ${toolName} is not available in the loaded extension profile`,
      )
    }
    if (
      local.value.entry.extensionId !== current.value.extensionId ||
      local.value.entry.capability !== current.value.capability
    ) {
      return yield* fail("SourceMismatch", `Tool ${toolName} changed before same-process replay`)
    }
    if (Predicate.isNotUndefined(current.value.binding)) {
      return yield* fail(
        "MissingSourceIdentity",
        `Tool ${toolName} binding identity changed before replay`,
      )
    }
    return current.value
  }

  return yield* resolveStoredToolBinding({
    ...address,
    binding: stored.value,
    generationId: params.generationId,
  }).pipe(Effect.onError(() => localReplay.removeBinding(key)))
})

// ── tool-binding-replay ─────────────────────────────────────────────────────

type ToolBindingReplayReason =
  | "MissingBinding"
  | "ToolUnavailable"
  | "MissingSourceIdentity"
  | "SourceMismatch"
  | "SchemaMismatch"

export class ToolBindingReplayError extends Schema.TaggedError<ToolBindingReplayError>()(
  "ToolBindingReplayError",
  {
    assistantMessageId: Schema.String,
    toolCallId: Schema.String,
    toolId: Schema.String,
    reason: Schema.Literals([
      "MissingBinding",
      "ToolUnavailable",
      "MissingSourceIdentity",
      "SourceMismatch",
      "SchemaMismatch",
    ]),
    message: Schema.String,
  },
) {}

const advertisedSchemaJson = (tool: ToolCapability): string =>
  canonicalJsonString(
    Schema.decodeUnknownSync(Schema.Json)({
      name: String(getToolId(tool)),
      description: tool.description,
      parameters: AiTool.getJsonSchema(tool),
    }),
  )

const schemaRevisionFor = (tool: ToolCapability) =>
  Effect.map(GentPlatform, (platform) =>
    ToolSchemaRevision.make(`schema:${platform.hash("sha256", advertisedSchemaJson(tool))}`),
  )

const sourceRevisionFor = (extension: LoadedExtension): Option.Option<ToolSourceRevision> => {
  if (Predicate.isUndefined(extension.artifactIdentity)) return Option.none()
  const sourceParts = [
    "artifact",
    extension.artifactIdentity,
    extension.scope,
    extension.sourcePath,
    extension.manifest.id,
  ]
  return Option.some(ToolSourceRevision.make(sourceParts.join(":")))
}

/** Attach the durable identity available for one freshly selected capability. */
export const attachToolBindingIdentity = Effect.fn("ToolBinding.attachIdentity")(function* (
  entry: ResolvedToolCapability,
  extensions: ReadonlyArray<LoadedExtension>,
) {
  const extension = extensions.find((candidate) => candidate.manifest.id === entry.extensionId)
  let sourceRevision = Option.none<ToolSourceRevision>()
  if (Predicate.isNotUndefined(extension)) {
    const revision = sourceRevisionFor(extension)
    if (Option.isSome(revision)) sourceRevision = revision
  }
  if (Option.isNone(sourceRevision)) return entry

  const source = ToolBindingSource.cases.Static.make({ sourceRevision: sourceRevision.value })
  const binding = ToolBindingIdentity.make({
    toolId: getToolId(entry.capability),
    extensionId: entry.extensionId,
    source,
    schemaRevision: yield* schemaRevisionFor(entry.capability),
  })
  return { ...entry, binding }
})

/** Identity for a static tool without a build artifact. It names one process generation. */
const processLocalToolBindingIdentity = Effect.fn("ToolBinding.processLocalIdentity")(function* (
  entry: ResolvedToolCapability,
  generationId: ProcessGenerationId,
) {
  if (Predicate.isNotUndefined(entry.binding)) return Option.none<ToolBindingIdentity>()
  return Option.some(
    ToolBindingIdentity.make({
      toolId: getToolId(entry.capability),
      extensionId: entry.extensionId,
      source: ToolBindingSource.cases.ProcessLocal.make({
        sourceRevision: ToolSourceRevision.make(`process:${generationId}`),
      }),
      schemaRevision: yield* schemaRevisionFor(entry.capability),
    }),
  )
})

const sameToolBindingIdentity = (left: ToolBindingIdentity, right: ToolBindingIdentity): boolean =>
  left.toolId === right.toolId &&
  left.extensionId === right.extensionId &&
  left.schemaRevision === right.schemaRevision &&
  left.source._tag === right.source._tag &&
  left.source.sourceRevision === right.source.sourceRevision

const bindingMismatchReason = (
  stored: ToolBindingIdentity,
  current: ToolBindingIdentity,
): Exclude<
  ToolBindingReplayReason,
  "MissingBinding" | "ToolUnavailable" | "MissingSourceIdentity"
> => {
  if (stored.source.sourceRevision !== current.source.sourceRevision) return "SourceMismatch"
  if (stored.schemaRevision !== current.schemaRevision) return "SchemaMismatch"
  return "SourceMismatch"
}

const makeBindingReplayError = (params: {
  readonly assistantMessageId: MessageId
  readonly toolCallId: ToolCallId
  readonly toolId: ToolId
  readonly reason: ToolBindingReplayReason
  readonly message: string
}) => new ToolBindingReplayError(params)

// ── process-local-tool-replay ───────────────────────────────────────────────

export const processLocalReplayBindingKey = (params: {
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly assistantMessageId: string
  readonly toolCallId: string
}): string =>
  `${params.sessionId}:${params.branchId}:${params.assistantMessageId}:${params.toolCallId}`

export const processLocalReplayResultKey = (params: {
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly toolResultMessageId: string
}): string => `${params.sessionId}:${params.branchId}:${params.toolResultMessageId}`

interface ProcessLocalReplayBinding {
  readonly entry: ResolvedToolCapability
}

interface ProcessLocalToolReplayService {
  readonly getBinding: (key: string) => Effect.Effect<Option.Option<ProcessLocalReplayBinding>>
  readonly setBinding: (key: string, binding: ProcessLocalReplayBinding) => Effect.Effect<void>
  readonly removeBinding: (key: string) => Effect.Effect<void>
  readonly clearBindingsWithPrefix: (prefix: string) => Effect.Effect<void>
  readonly getResults: (key: string) => Effect.Effect<ReadonlyMap<string, Prompt.ToolResultPart>>
  readonly setResults: (
    key: string,
    results: ReadonlyMap<string, Prompt.ToolResultPart>,
  ) => Effect.Effect<void>
  readonly removeResults: (key: string) => Effect.Effect<void>
  readonly clearResultsWithPrefix: (prefix: string) => Effect.Effect<void>
}

export class ProcessLocalToolReplay extends Context.Service<
  ProcessLocalToolReplay,
  ProcessLocalToolReplayService
>()("@gent/core/src/runtime/agent/tools/ProcessLocalToolReplay") {
  static Live: Layer.Layer<ProcessLocalToolReplay> = Layer.effect(
    ProcessLocalToolReplay,
    Effect.gen(function* () {
      const bindings = new Map<string, ProcessLocalReplayBinding>()
      const results = new Map<string, Map<string, Prompt.ToolResultPart>>()

      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          bindings.clear()
          results.clear()
        }),
      )

      return ProcessLocalToolReplay.of({
        getBinding: (key) => Effect.sync(() => Option.fromUndefinedOr(bindings.get(key))),
        setBinding: (key, binding) =>
          Effect.sync(() => {
            bindings.set(key, binding)
          }),
        removeBinding: (key) =>
          Effect.sync(() => {
            bindings.delete(key)
          }),
        clearBindingsWithPrefix: (prefix) =>
          Effect.sync(() => {
            for (const key of bindings.keys()) {
              if (key.startsWith(prefix)) bindings.delete(key)
            }
          }),
        getResults: (key) =>
          Effect.sync(() => {
            const value = results.get(key)
            if (Predicate.isUndefined(value)) return new Map<string, Prompt.ToolResultPart>()
            return new Map(value)
          }),
        setResults: (key, value) =>
          Effect.sync(() => {
            results.set(key, new Map(value))
          }),
        removeResults: (key) =>
          Effect.sync(() => {
            results.delete(key)
          }),
        clearResultsWithPrefix: (prefix) =>
          Effect.sync(() => {
            for (const key of results.keys()) {
              if (key.startsWith(prefix)) results.delete(key)
            }
          }),
      })
    }),
  )
}

// ── branch-tool-feature ─────────────────────────────────────────────────────

/**
 * Everything a branch-tool feature contributes to the runtime it plugs into.
 *
 * A feature whose tools hold branch-scoped state — a worker process, a
 * namespace, a dispatch log — installs three things that only work together:
 * the migrations creating its tables, the storage tags reading them, and the
 * factory building its per-branch services. Install one without the others and
 * the failure is silent until first use: tables with no migrations fail on
 * read, storage with no branch layer leaves the tools unbuilt.
 *
 * Binding them into one value makes that impossible to get half-right, and
 * gives composition roots a single thing to name. Core takes the feature as
 * input and never looks inside it; `noBranchTools` is the honest value for a
 * deployment whose tools are all stateless.
 */

interface BranchToolLayerInput {
  readonly sessionId: SessionId
  readonly branchId: BranchId
  /** Lets branch work notice that the turn was interrupted, and stop. */
  readonly turnInterruption: TurnInterruptionStatus
}

/**
 * Per-branch services a tool needs built with the loop and torn down with it:
 * a worker process, a session, a namespace. What the layer provides is erased
 * on purpose: the loop merges it into the branch context and reads only what
 * it knows to look for, such as `BranchToolWork`.
 */
export type BranchToolLayerFactory = (input: BranchToolLayerInput) => ErasedResourceLayer

interface BranchToolWorkApi {
  /** Cancel in-flight work. Must be safe to call when nothing is running. */
  readonly cancel: Effect.Effect<void>
}

/**
 * Cancellation for tool work that outlives a single call. A tool holding a
 * branch-scoped process must be told when the loop is interrupted; the turn's
 * fiber interrupt alone does not reach it. A tool with nothing to cancel does
 * not provide this, and interruption is a no-op.
 */
export class BranchToolWork extends Context.Service<BranchToolWork, BranchToolWorkApi>()(
  "@gent/core/src/runtime/agent/tools/BranchToolWork",
) {}

export interface BranchToolFeature<A> {
  /** Migrations creating the feature's tables, merged into core's chain. */
  readonly migrations: FeatureMigrations
  /**
   * The feature's storage tags, layered over core's SQL client. Generic in
   * the error and requirement channels so one feature serves the live,
   * memory, and test storage entries alike.
   */
  readonly storage: <E, R>(
    ...args: Parameters<ExtraRepositories<A, E, R>>
  ) => ReturnType<ExtraRepositories<A, E, R>>
  /** Per-branch services, built with the loop and torn down with it. */
  readonly branchLayer: BranchToolLayerFactory
}

/** The feature a deployment installs when its tools hold no branch state. */
export const noBranchTools: BranchToolFeature<never> = {
  migrations: {},
  storage: () => Layer.empty,
  branchLayer: () => emptyErasedResourceLayer,
}

/**
 * The branch-tool feature this runtime installs.
 *
 * A `Context.Reference`, not a required service: `noBranchTools` is a real
 * deployment (all tools stateless), not a stub that dies when used. A root
 * shipping a feature binds it; core reads it and merges what it gets.
 */
export const CurrentBranchToolFeature = Context.Reference<BranchToolFeature<never>>(
  "@gent/core/src/runtime/agent/tools/CurrentBranchToolFeature",
  { defaultValue: () => noBranchTools },
)

// ── tool-runner ─────────────────────────────────────────────────────────────

type ToolCapabilityMap = Record<string, ToolCapability>

export function convertTools(
  tools: ReadonlyArray<ToolCapability>,
): AiToolkit.Toolkit<ToolCapabilityMap> {
  return AiToolkit.make(...tools)
}

export type ToolCall = { toolCallId: ToolCallId; toolName: string; input: unknown }

type ToolCapabilityContext = ExtensionHostContext & {
  readonly toolCallId: ToolCallId
}

/** The exact owner and implementation selected for one tool surface. */
export interface ResolvedToolCapability {
  readonly extensionId: ExtensionId
  readonly capability: ToolCapability
  readonly binding?: ToolBindingIdentity
}

type ToolExecutionError = AiError.AiError | InteractionPendingError | Error

class ToolExecutionFailure extends Schema.TaggedError<ToolExecutionFailure>(
  "@gent/core/src/runtime/agent/tools/ToolExecutionFailure",
)("ToolExecutionFailure", {
  message: Schema.String,
}) {}

type ToolRunnerToolkit = AiToolkit.WithHandler<ToolCapabilityMap>

interface ToolRunnerService {
  /** Capture the currently visible implementation once for a direct invocation. */
  readonly capture: (params: {
    readonly toolName: string
  }) => Effect.Effect<Option.Option<ResolvedToolCapability>, never, ExtensionRegistry>
  readonly run: (
    toolCall: ToolCall,
  ) => Effect.Effect<
    Prompt.ToolResultPart,
    InteractionPendingError,
    CurrentExtensionHostContext | ExtensionRegistry | EventPublisher
  >
  /** Execute the exact entry captured by a resolved turn. */
  readonly runBound: (
    toolCall: ToolCall,
    entry: Option.Option<ResolvedToolCapability>,
  ) => Effect.Effect<
    Prompt.ToolResultPart,
    InteractionPendingError,
    CurrentExtensionHostContext | ExtensionRegistry | EventPublisher
  >
}

const errorResult = (toolCall: { toolCallId: ToolCallId; toolName: string }, message: string) =>
  Prompt.toolResultPart({
    id: toolCall.toolCallId,
    name: toolCall.toolName,
    isFailure: true,
    providerExecuted: false,
    result: { error: message },
  })

/** The dispatching call, when this call runs inside one. */
const parentToolCallId = Effect.map(Effect.serviceOption(CurrentDispatchingCall), (call) =>
  Option.getOrUndefined(Option.map(call, (parent) => parent.toolCallId)),
)

/** The assistant message holding the tool-call part: this call's, else the dispatcher's. */
const assistantMessageId = Effect.gen(function* () {
  const current = yield* Effect.serviceOption(CurrentToolCall)
  if (Option.isSome(current)) return current.value.assistantMessageId
  const parent = yield* Effect.serviceOption(CurrentDispatchingCall)
  return Option.getOrUndefined(Option.map(parent, (call) => call.assistantMessageId))
})

const publishStarted = (params: { ctx: ToolCapabilityContext; toolCall: ToolCall }) =>
  Effect.gen(function* () {
    const eventPublisher = yield* EventPublisher
    yield* eventPublisher
      .publish(
        ToolCallStarted.make({
          sessionId: params.ctx.sessionId,
          branchId: params.ctx.branchId,
          toolCallId: params.toolCall.toolCallId,
          toolName: params.toolCall.toolName,
          input: params.toolCall.input,
          parentToolCallId: yield* parentToolCallId,
          assistantMessageId: yield* assistantMessageId,
        }),
      )
      .pipe(Effect.orDie)
  })

const publishCompleted = (params: { ctx: ToolCapabilityContext; result: Prompt.ToolResultPart }) =>
  Effect.gen(function* () {
    const eventPublisher = yield* EventPublisher
    const outputSummary = summarizeOutput(params.result.result)
    const fields = {
      sessionId: params.ctx.sessionId,
      branchId: params.ctx.branchId,
      toolCallId: ToolCallId.make(params.result.id),
      toolName: params.result.name,
      summary: outputSummary,
      output: stringifyOutput(params.result.result),
      resultJson: encodeToolOutput(params.result.result),
      parentToolCallId: yield* parentToolCallId,
      assistantMessageId: yield* assistantMessageId,
    }
    if (params.result.isFailure) {
      yield* eventPublisher.publish(ToolCallFailed.make(fields)).pipe(Effect.orDie)
      return
    }
    yield* eventPublisher.publish(ToolCallSucceeded.make(fields)).pipe(Effect.orDie)
  })

const makeExecutionToolkit = (params: {
  tool: ToolCapability
  toolCall: ToolCall
  ctx: ToolCapabilityContext
  fileSystem: FileSystem.FileSystem
  path: Path.Path
}): Effect.Effect<ToolRunnerToolkit> =>
  Effect.gen(function* () {
    const metadata = getToolMetadata(params.tool)
    const toolkit = convertTools([params.tool])
    const toolName = String(getToolId(params.tool))

    const handlerMap: AiToolkit.HandlersFrom<ToolCapabilityMap> = {
      [toolName]: (decodedInput) =>
        // @effect-diagnostics-next-line anyUnknownInErrorContext:off
        metadata
          .effect(decodedInput)
          .pipe(stopWithTurn, Effect.mapError(normalizeToolExecutionError))
          .pipe(provideExtensionLeaf({}))
          .pipe(
            provideCurrentHostCtx(params.ctx),
            Effect.provideService(FileSystem.FileSystem, params.fileSystem),
            Effect.provideService(Path.Path, params.path),
          ),
    }

    const handlers = yield* toolkit.toHandlers(handlerMap)
    return yield* toolkit.pipe(Effect.provideContext(handlers))
  })

const terminalToolResult = (
  toolkit: ToolRunnerToolkit,
  toolCall: ToolCall,
): Effect.Effect<
  Prompt.ToolResultPart,
  ToolExecutionError,
  Effect.Services<ReturnType<typeof WideEvent.set>>
> =>
  Effect.gen(function* () {
    const resultStream = yield* toolkit.handle(toolCall.toolName, toolCall.input)
    const terminal = yield* resultStream.pipe(
      Stream.filter((result) => result.preliminary === false),
      Stream.run(Sink.last()),
    )
    if (terminal._tag === "None") {
      const message = "Tool handler did not produce a final result"
      yield* WideEvent.failDomain("execution_failed", { message })
      return errorResult(toolCall, message)
    }
    return Prompt.toolResultPart({
      id: toolCall.toolCallId,
      name: toolCall.toolName,
      isFailure: terminal.value.isFailure,
      providerExecuted: false,
      result: terminal.value.encodedResult,
    })
  })

const errorMessageFromAiError = (toolName: string, failure: ToolExecutionError) => {
  const fallback = `Tool '${toolName}' failed: ${String(failure)}`
  if (!AiError.isAiError(failure)) return fallback
  return Match.type<AiError.AiError["reason"]>().pipe(
    Match.when(
      { _tag: "ToolParameterValidationError" },
      (reason) => `Tool '${toolName}' input failed:\n${reason.description}`,
    ),
    Match.when(
      { _tag: "ToolResultEncodingError" },
      (reason) => `Tool '${toolName}' failed: ${reason.description}`,
    ),
    Match.orElse(() => fallback),
  )(failure.reason)
}

const isToolParameterValidationError = (failure: ToolExecutionError): boolean => {
  if (!AiError.isAiError(failure)) return false
  return Match.type<AiError.AiError["reason"]>().pipe(
    Match.when({ _tag: "ToolParameterValidationError" }, () => true),
    Match.orElse(() => false),
  )(failure.reason)
}

const normalizeToolExecutionError = (
  failure: Schema.Schema.Type<typeof Schema.Unknown>,
): InteractionPendingError | Error => {
  if (Schema.is(InteractionPendingError)(failure)) return failure
  if (failure instanceof Error) return failure
  return new ToolExecutionFailure({ message: String(failure) })
}

export const staticToolEntries = (
  activeRegistry: ExtensionRegistryService,
): ReadonlyArray<ResolvedToolCapability> => {
  const resolved = activeRegistry.getResolved()
  const entries: ResolvedToolCapability[] = []
  for (const capability of resolved.modelCapabilities.values()) {
    const extension = resolved.extensions.find((extension) =>
      (extension.contributions.tools ?? []).includes(capability),
    )
    if (!Predicate.isUndefined(extension)) {
      entries.push({
        extensionId: extension.manifest.id,
        capability,
      })
    }
  }
  return entries
}

const captureToolEntry = (params: {
  readonly toolName: string
  readonly activeRegistry: ExtensionRegistryService
}): Option.Option<ResolvedToolCapability> => {
  const entry = staticToolEntries(params.activeRegistry).find(
    (candidate) => String(getToolId(candidate.capability)) === params.toolName,
  )
  return Option.fromUndefinedOr(entry)
}

const runTool = Effect.fn("ToolRunner.execute")(function* (
  toolCall: ToolCall,
  toolEntry: Option.Option<ResolvedToolCapability>,
) {
  const hostCtx = yield* CurrentExtensionHostContext
  const ctx: ToolCapabilityContext = { ...hostCtx, toolCallId: toolCall.toolCallId }
  return yield* Effect.gen(function* () {
    yield* WideEvent.set({ sessionId: ctx.sessionId, branchId: ctx.branchId })
    yield* publishStarted({ ctx, toolCall })

    const finish = (result: Prompt.ToolResultPart) =>
      Effect.gen(function* () {
        yield* publishCompleted({
          ctx,
          result,
        })
        yield* Effect.logInfo("tool.completed").pipe(
          Effect.annotateLogs({
            toolName: toolCall.toolName,
            toolCallId: toolCall.toolCallId,
            isError: result.isFailure,
          }),
        )
        return result
      })

    if (Option.isNone(toolEntry)) {
      yield* WideEvent.failDomain("unknown", {
        message: `Unknown tool: ${toolCall.toolName}`,
      })
      yield* Effect.logInfo("tool.unknown").pipe(
        Effect.annotateLogs({
          toolName: toolCall.toolName,
          toolCallId: toolCall.toolCallId,
        }),
      )
      return yield* finish(errorResult(toolCall, `Unknown tool: ${toolCall.toolName}`))
    }
    const toolCtx: ToolCapabilityContext = {
      ...ctx,
      extensionId: toolEntry.value.extensionId,
    }
    const fileSystem = yield* Effect.serviceOption(FileSystem.FileSystem)
    const path = yield* Effect.serviceOption(Path.Path)
    if (Option.isNone(fileSystem) || Option.isNone(path)) {
      return yield* finish(errorResult(toolCall, "Tool execution services unavailable"))
    }
    const executeKnownTool = Effect.gen(function* () {
      const executionToolkit = yield* makeExecutionToolkit({
        tool: toolEntry.value.capability,
        toolCall,
        ctx: toolCtx,
        fileSystem: fileSystem.value,
        path: path.value,
      })
      return yield* terminalToolResult(executionToolkit, toolCall)
    })

    const executeResult = yield* executeKnownTool.pipe(Effect.result)

    if (executeResult._tag === "Failure") {
      const failure: ToolExecutionError = executeResult.failure
      if (Schema.is(InteractionPendingError)(failure)) {
        return yield* failure
      }
      if (Schema.is(ToolResultFailure)(failure)) {
        yield* WideEvent.failDomain("execution_failed", { message: failure.message })
        return yield* finish(
          Prompt.toolResultPart({
            id: toolCall.toolCallId,
            name: toolCall.toolName,
            isFailure: true,
            providerExecuted: false,
            result: failure.result,
          }),
        )
      }

      const message = errorMessageFromAiError(toolCall.toolName, failure)
      const schemaFailure = isToolParameterValidationError(failure)
      let failureDomain: "schema_decode" | "execution_failed" = "execution_failed"
      let failureLog = "tool.execute.failed"
      if (schemaFailure) {
        failureDomain = "schema_decode"
        failureLog = "tool.schema.failed"
      }
      yield* WideEvent.failDomain(failureDomain, { message })
      yield* Effect.logWarning(failureLog).pipe(
        Effect.annotateLogs({
          toolName: toolCall.toolName,
          toolCallId: toolCall.toolCallId,
        }),
      )
      return yield* finish(errorResult(toolCall, message))
    }

    return yield* finish(executeResult.success)
  }).pipe(
    provideCurrentHostCtx(ctx),
    withWideEvent(
      WideEventBoundary.tool(toolCall.toolName, {
        envelope: { toolCallId: toolCall.toolCallId },
      }),
    ),
  )
})

/**
 * Runs every call as a no-op that still publishes the started and completed
 * events, so a test can drive a turn to its next step without a real tool.
 *
 * It stays here rather than in `test-utils` because the two publishes reach
 * five private helpers in this file; moving it would export the whole publish
 * path to save one layer. Thirteen services in the repo carry a `Test` layer
 * this way, so this is the shape, not an exception to it.
 */
const runTestTool = (toolCall: ToolCall) =>
  Effect.gen(function* () {
    const hostCtx = yield* CurrentExtensionHostContext
    const ctx: ToolCapabilityContext = { ...hostCtx, toolCallId: toolCall.toolCallId }
    yield* publishStarted({ ctx, toolCall })
    const result = Prompt.toolResultPart({
      id: toolCall.toolCallId,
      name: toolCall.toolName,
      isFailure: false,
      providerExecuted: false,
      // oxlint-disable-next-line effect/noNullish -- The test runner preserves the provider-neutral empty result shape.
      result: null,
    })
    yield* publishCompleted({ ctx, result })
    return result
  })

/** @effect-expect-leaking ExtensionRegistry */
export class ToolRunner extends Context.Service<ToolRunner, ToolRunnerService>()(
  "@gent/core/src/runtime/agent/tools/ToolRunner",
) {
  static Live: Layer.Layer<ToolRunner> = Layer.succeed(
    ToolRunner,
    ToolRunner.of({
      capture: (params) =>
        Effect.gen(function* () {
          const activeRegistry = yield* ExtensionRegistry
          return captureToolEntry({ ...params, activeRegistry })
        }),
      run: Effect.fn("ToolRunner.run")(function* (toolCall) {
        const activeRegistry = yield* ExtensionRegistry
        const entry = captureToolEntry({ toolName: toolCall.toolName, activeRegistry })
        return yield* runTool(toolCall, entry)
      }),
      runBound: (toolCall, entry) => runTool(toolCall, entry),
    }),
  )

  static Test = (): Layer.Layer<ToolRunner> =>
    Layer.succeed(
      ToolRunner,
      ToolRunner.of({
        capture: () => Effect.succeedNone,
        run: runTestTool,
        runBound: (toolCall) => runTestTool(toolCall),
      }),
    )
}

// ── turn-tool-execution ─────────────────────────────────────────────────────

const TOOL_CONCURRENCY = 8

/** InteractionPendingError enriched with the toolCallId that triggered it */
export class ToolInteractionPending extends Schema.TaggedError<ToolInteractionPending>(
  "@gent/core/src/runtime/agent/tools/ToolInteractionPending",
)("ToolInteractionPending", {
  pending: InteractionPendingError,
  toolCallId: ToolCallId,
  completedResults: Schema.Array(Prompt.ToolResultPart),
}) {}

export const executeToolCalls = Effect.fn("TurnHelpers.executeToolCalls")(function* (params: {
  assistantMessageId: MessageId
  toolCalls: ReadonlyArray<Prompt.ToolCallPart>
  sessionId: SessionId
  branchId: BranchId
  currentTurnAgent: AgentNameType
  toolBindings: ReadonlyMap<string, ResolvedToolCapability>
  hostToolBindings: ReadonlyMap<string, ResolvedToolCapability>
  /** Completes when the turn is interrupted; a call still running then stops. */
  interruption: Effect.Effect<void>
}) {
  const toolRunner = yield* ToolRunner
  const hostCtx = yield* CurrentExtensionHostContext
  const exits = yield* Effect.forEach(
    params.toolCalls,
    (toolCall) =>
      Effect.exit(
        Effect.gen(function* () {
          const toolHostCtx = {
            ...hostCtx,
            agentName: params.currentTurnAgent,
            toolCallId: ToolCallId.make(toolCall.id),
          }
          const toolCallInput = {
            toolCallId: ToolCallId.make(toolCall.id),
            toolName: toolCall.name,
            input: toolCall.params,
          }
          return yield* toolRunner
            .runBound(toolCallInput, Option.fromUndefinedOr(params.toolBindings.get(toolCall.name)))
            .pipe(
              Effect.mapError(
                (e) =>
                  new ToolInteractionPending({
                    pending: e,
                    toolCallId: ToolCallId.make(toolCall.id),
                    completedResults: [],
                  }),
              ),
              provideCurrentHostCtx(toolHostCtx),
              Effect.provideService(CurrentToolCall, {
                toolBindings: params.hostToolBindings,
                sessionId: params.sessionId,
                branchId: params.branchId,
                assistantMessageId: params.assistantMessageId,
                toolCallId: toolCallInput.toolCallId,
              }),
              Effect.provideService(TurnInterruptSignal, params.interruption),
            )
        }),
      ),
    { concurrency: Math.max(1, TOOL_CONCURRENCY) },
  )
  const results: Array<Prompt.ToolResultPart> = []
  let pending = Option.none<ToolInteractionPending>()
  for (const exit of exits) {
    if (Exit.isSuccess(exit)) {
      results.push(exit.value)
      continue
    }
    const error = Cause.findErrorOption(exit.cause)
    if (Option.isSome(error)) {
      if (Option.isNone(pending)) pending = error
      continue
    }
    return yield* Effect.failCause(exit.cause)
  }
  if (Option.isSome(pending)) {
    return yield* new ToolInteractionPending({
      pending: pending.value.pending,
      toolCallId: pending.value.toolCallId,
      completedResults: results,
    })
  }
  return results
})

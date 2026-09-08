import {
  Context,
  Effect,
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
import { getToolId, getToolMetadata, type ToolCapability } from "../../domain/capability/tool.js"
import { ExtensionRegistry, type ExtensionRegistryService } from "../extensions/registry.js"
import { Permission, type PermissionService } from "../../domain/permission.js"
import { InteractionPendingError } from "../../domain/interaction-request.js"
import { ToolCallFailed, ToolCallStarted, ToolCallSucceeded } from "../../domain/event.js"
import { EventPublisher } from "../../domain/event-publisher.js"
import {
  DynamicExtensionRegistry,
  type DynamicExtensionRegistryService,
  type DynamicToolEntry,
} from "../../domain/dynamic-extension-registry.js"
import {
  encodeToolOutput,
  summarizeToolOutput,
  stringifyOutput,
  ToolResultFailure,
} from "../../domain/tool-output.js"
import { withWideEvent, WideEvent, WideEventBoundary } from "../wide-event-boundary"
import type { ExtensionHostContext } from "../../domain/extension-host-context.js"
import { ToolCallId, type ExtensionId, type SessionId } from "../../domain/ids.js"
import * as Prompt from "effect/unstable/ai/Prompt"
import * as AiToolkit from "effect/unstable/ai/Toolkit"
import * as AiError from "effect/unstable/ai/AiError"
import { CurrentCellToolOperation } from "../code-cell/current-cell-tool-operation.js"
import { CurrentToolCall } from "./current-tool-call.js"
import {
  CurrentExtensionHostContext,
  provideCurrentHostCtx,
} from "./current-extension-host-context.js"
import { provideExtensionLeaf } from "../extensions/extension-effect-membrane.js"
import type { ToolBindingIdentity } from "../../domain/tool-binding.js"

export type ToolCapabilityMap = Record<string, ToolCapability>

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
  readonly origin: "static" | "dynamic"
  readonly binding?: ToolBindingIdentity
}

type ToolExecutionError = AiError.AiError | InteractionPendingError | Error

class ToolExecutionFailure extends Schema.TaggedError<ToolExecutionFailure>(
  "@gent/core/src/runtime/agent/tool-runner/ToolExecutionFailure",
)("ToolExecutionFailure", {
  message: Schema.String,
}) {}

type ToolRunnerToolkit = AiToolkit.WithHandler<ToolCapabilityMap>

export interface ToolRunnerService {
  /** Capture the currently visible implementation once for a direct invocation. */
  readonly capture: (params: {
    readonly sessionId: SessionId
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

/** The admitting cell, when this call runs inside one. */
const parentToolCallId = Effect.map(Effect.serviceOption(CurrentCellToolOperation), (operation) =>
  Option.getOrUndefined(Option.map(operation, (key) => key.cell.toolCallId)),
)

/** The assistant message that holds the tool-call part: the direct call, else the admitting cell. */
const assistantMessageId = Effect.gen(function* () {
  const current = yield* Effect.serviceOption(CurrentToolCall)
  if (Option.isSome(current)) return current.value.assistantMessageId
  const operation = yield* Effect.serviceOption(CurrentCellToolOperation)
  return Option.getOrUndefined(Option.map(operation, (key) => key.cell.assistantMessageId))
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
    const outputSummary = summarizeToolOutput(params.result)
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
}): Effect.Effect<ToolRunnerToolkit, never, ExtensionRegistry> =>
  Effect.gen(function* () {
    const registry = yield* ExtensionRegistry
    const metadata = getToolMetadata(params.tool)
    const toolkit = convertTools([params.tool])
    const toolName = String(getToolId(params.tool))

    const handlerMap: AiToolkit.HandlersFrom<ToolCapabilityMap> = {
      [toolName]: (decodedInput) =>
        Effect.gen(function* () {
          const executeResult = yield* (
            // @effect-diagnostics-next-line anyUnknownInErrorContext:off
            metadata
              .effect(decodedInput)
              .pipe(Effect.mapError(normalizeToolExecutionError))
              .pipe(provideExtensionLeaf({}))
              .pipe(
                provideCurrentHostCtx(params.ctx),
                Effect.provideService(FileSystem.FileSystem, params.fileSystem),
                Effect.provideService(Path.Path, params.path),
              )
          )

          return yield* registry.extensionHooks
            .transformToolResult({
              toolCallId: params.toolCall.toolCallId,
              toolName: params.toolCall.toolName,
              input: decodedInput,
              result: executeResult,
              agentName: params.ctx.agentName,
              sessionId: params.ctx.sessionId,
              branchId: params.ctx.branchId,
            })
            .pipe(
              provideCurrentHostCtx(params.ctx),
              Effect.catchEager((e) =>
                Effect.logWarning("extension.hook.tool-result.failed").pipe(
                  Effect.annotateLogs({ error: String(e) }),
                  Effect.as(executeResult),
                ),
              ),
            )
        }),
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

const allowAllPermission: PermissionService = {
  check: () => Effect.succeed("allowed"),
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
        origin: "static",
      })
    }
  }
  return entries
}

export const dynamicToolEntry = (entry: DynamicToolEntry): ResolvedToolCapability => ({
  extensionId: entry.extensionId,
  capability: entry.capability,
  origin: "dynamic",
})

/** Merge visible tool entries with dynamic entries shadowing static entries. */
export const mergeResolvedToolEntries = (
  staticEntries: ReadonlyArray<ResolvedToolCapability>,
  dynamicEntries: ReadonlyArray<ResolvedToolCapability>,
): ReadonlyArray<ResolvedToolCapability> => {
  const winners = new Map<string, ResolvedToolCapability>()
  for (const entry of staticEntries) winners.set(String(getToolId(entry.capability)), entry)
  for (const entry of dynamicEntries) winners.set(String(getToolId(entry.capability)), entry)
  return [...winners.values()]
}

const captureToolEntry = (params: {
  readonly sessionId: SessionId
  readonly toolName: string
  readonly activeRegistry: ExtensionRegistryService
  readonly dynamicRegistry: Option.Option<DynamicExtensionRegistryService>
}): Effect.Effect<Option.Option<ResolvedToolCapability>> =>
  Effect.gen(function* () {
    const staticEntries = staticToolEntries(params.activeRegistry)
    let dynamicEntries: ReadonlyArray<ResolvedToolCapability> = []
    if (Option.isSome(params.dynamicRegistry)) {
      dynamicEntries = yield* params.dynamicRegistry.value
        .listToolEntries(params.sessionId)
        .pipe(Effect.map((entries) => entries.map(dynamicToolEntry)))
    }
    const entry = mergeResolvedToolEntries(staticEntries, dynamicEntries).find(
      (candidate) => String(getToolId(candidate.capability)) === params.toolName,
    )
    return Option.fromUndefinedOr(entry)
  })

const runTool = Effect.fn("ToolRunner.execute")(function* (
  toolCall: ToolCall,
  toolEntry: Option.Option<ResolvedToolCapability>,
) {
  const hostCtx = yield* CurrentExtensionHostContext
  const ctx: ToolCapabilityContext = { ...hostCtx, toolCallId: toolCall.toolCallId }
  const activeRegistry = yield* ExtensionRegistry
  const basePermissionOpt = yield* Effect.serviceOption(Permission)
  const activePermission: PermissionService = Option.getOrElse(
    basePermissionOpt,
    () => allowAllPermission,
  )
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
      const preflight = yield* activeRegistry.extensionHooks.preflightToolCall({
        toolCallId: toolCall.toolCallId,
        toolName: toolCall.toolName,
        input: toolCall.input,
        agentName: ctx.agentName,
        sessionId: ctx.sessionId,
        branchId: ctx.branchId,
      })
      if (preflight?._tag === "deny") {
        yield* WideEvent.failDomain("preflight_denied", { message: preflight.message })
        return Prompt.toolResultPart({
          id: toolCall.toolCallId,
          name: toolCall.toolName,
          isFailure: true,
          providerExecuted: false,
          result: preflight.result ?? { error: preflight.message },
        })
      }

      const permCheckResult = yield* activePermission.check(toolCall.toolName, toolCall.input).pipe(
        Effect.catchEager((e) =>
          WideEvent.failDomain("permission_check_failed", {
            message: String(e),
          }).pipe(Effect.as("interceptor_failed")),
        ),
      )

      if (permCheckResult === "interceptor_failed") {
        yield* Effect.logWarning("tool.permission.check.failed").pipe(
          Effect.annotateLogs({
            toolName: toolCall.toolName,
            toolCallId: toolCall.toolCallId,
          }),
        )
        return errorResult(toolCall, "Permission check failed")
      }

      if (permCheckResult === "denied") {
        yield* WideEvent.failDomain("permission_denied", { message: "Permission denied" })
        yield* Effect.logInfo("tool.permission.denied").pipe(
          Effect.annotateLogs({
            toolName: toolCall.toolName,
            toolCallId: toolCall.toolCallId,
          }),
        )
        return errorResult(toolCall, "Permission denied")
      }

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
  "@gent/core/src/runtime/agent/tool-runner/ToolRunner",
) {
  static Live: Layer.Layer<ToolRunner> = Layer.succeed(
    ToolRunner,
    ToolRunner.of({
      capture: (params) =>
        Effect.gen(function* () {
          const activeRegistry = yield* ExtensionRegistry
          const dynamicRegistry = yield* Effect.serviceOption(DynamicExtensionRegistry)
          return yield* captureToolEntry({
            ...params,
            activeRegistry,
            dynamicRegistry,
          })
        }),
      run: Effect.fn("ToolRunner.run")(function* (toolCall) {
        const activeRegistry = yield* ExtensionRegistry
        const dynamicRegistry = yield* Effect.serviceOption(DynamicExtensionRegistry)
        const hostCtx = yield* CurrentExtensionHostContext
        const entry = yield* captureToolEntry({
          sessionId: hostCtx.sessionId,
          toolName: toolCall.toolName,
          activeRegistry,
          dynamicRegistry,
        })
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

export { attachToolBindingIdentity } from "./tool-binding-replay.js"

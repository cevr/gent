import { Context, Effect, Layer, Schema, Sink, Stream } from "effect"
import {
  getToolId,
  getToolMetadata,
  type ToolCoreContext,
  type ToolCapability,
} from "../../domain/capability/tool.js"
import { provideExtensionServices } from "../../domain/extension-services.js"
import { ExtensionRegistry, type ExtensionRegistryService } from "../extensions/registry.js"
import { Permission, type PermissionService } from "../../domain/permission.js"
import { InteractionPendingError } from "../../domain/interaction-request.js"
import { ToolCallFailed, ToolCallStarted, ToolCallSucceeded } from "../../domain/event.js"
import { summarizeToolOutput, stringifyOutput } from "../../domain/tool-output.js"
import { withWideEvent, WideEvent, toolBoundary, ToolError } from "../wide-event-boundary"
import type { ExtensionHostContext } from "../../domain/extension-host-context.js"
import { extensionHostFacts } from "../make-extension-host-context.js"
import { ToolCallId } from "../../domain/ids.js"
import type * as AiTool from "effect/unstable/ai/Tool"
import * as Prompt from "effect/unstable/ai/Prompt"
import * as AiToolkit from "effect/unstable/ai/Toolkit"
import * as AiError from "effect/unstable/ai/AiError"

export type ToolCapabilityMap = Record<string, ToolCapability>

export function convertTools(
  tools: ReadonlyArray<ToolCapability>,
): AiToolkit.Toolkit<ToolCapabilityMap> {
  return AiToolkit.make(...tools)
}

type ToolCall = { toolCallId: ToolCallId; toolName: string; input: unknown }

type ToolLifecycleEvent = ToolCallStarted | ToolCallSucceeded | ToolCallFailed

type PublishToolEvent = (event: ToolLifecycleEvent) => Effect.Effect<unknown>

export interface ToolRunOptions {
  readonly publishEvent?: PublishToolEvent
}

type ToolCapabilityContext = ExtensionHostContext & {
  readonly toolCallId: ToolCallId
}

type ToolExecutionError = AiError.AiError | InteractionPendingError | Error
type ToolRuntimeContext = ToolCoreContext

const provideCapabilityContext = <A, E, R>(
  ctx: ToolCoreContext,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  ctx.capabilityContext === undefined
    ? effect
    : effect.pipe(Effect.provideContext(ctx.capabilityContext))

type ToolRunnerToolkit = AiToolkit.WithHandler<ToolCapabilityMap>

export interface ToolRunnerService {
  readonly run: (
    toolCall: ToolCall,
    ctx: ToolCapabilityContext,
    options?: ToolRunOptions,
  ) => Effect.Effect<Prompt.ToolResultPart, InteractionPendingError, ExtensionRegistry>
}

const deriveToolContext = (ctx: ToolCapabilityContext): ToolRuntimeContext => ({
  sessionId: ctx.sessionId,
  branchId: ctx.branchId,
  ...(ctx.agentName !== undefined ? { agentName: ctx.agentName } : {}),
  toolCallId: ctx.toolCallId,
  cwd: ctx.cwd,
  home: ctx.home,
  host: extensionHostFacts(ctx.host),
  ...(ctx.capabilityContext !== undefined ? { capabilityContext: ctx.capabilityContext } : {}),
})

const errorResult = (toolCall: { toolCallId: ToolCallId; toolName: string }, message: string) =>
  Prompt.toolResultPart({
    id: toolCall.toolCallId,
    name: toolCall.toolName,
    isFailure: true,
    result: { error: message },
  })

const publishStarted = (params: {
  publishEvent?: PublishToolEvent
  ctx: ToolCapabilityContext
  toolCall: ToolCall
}) =>
  params.publishEvent?.(
    ToolCallStarted.make({
      sessionId: params.ctx.sessionId,
      branchId: params.ctx.branchId,
      toolCallId: params.toolCall.toolCallId,
      toolName: params.toolCall.toolName,
      input: params.toolCall.input,
    }),
  ) ?? Effect.void

const publishCompleted = (params: {
  publishEvent?: PublishToolEvent
  ctx: ToolCapabilityContext
  result: Prompt.ToolResultPart
}) =>
  Effect.gen(function* () {
    if (params.publishEvent === undefined) return
    const outputSummary = summarizeToolOutput(params.result)
    const fields = {
      sessionId: params.ctx.sessionId,
      branchId: params.ctx.branchId,
      toolCallId: ToolCallId.make(params.result.id),
      toolName: params.result.name,
      summary: outputSummary,
      output: stringifyOutput(params.result.result),
    }
    yield* params.publishEvent(
      params.result.isFailure ? ToolCallFailed.make(fields) : ToolCallSucceeded.make(fields),
    )
  })

const makeExecutionToolkit = (params: {
  tool: ToolCapability
  toolCall: ToolCall
  ctx: ToolCapabilityContext
  registry: ExtensionRegistryService
}): Effect.Effect<ToolRunnerToolkit> => {
  const metadata = getToolMetadata(params.tool)
  const toolkit = convertTools([params.tool])
  const toolName = String(getToolId(params.tool))
  const toolCtx = deriveToolContext(params.ctx)

  const handlerMap: AiToolkit.HandlersFrom<ToolCapabilityMap> = {
    [toolName]: (decodedInput: unknown) =>
      Effect.gen(function* () {
        const executeResult = yield* provideExtensionServices(
          params.ctx,
          provideCapabilityContext(
            toolCtx,
            // @effect-diagnostics-next-line anyUnknownInErrorContext:off
            metadata
              .effect(decodedInput, toolCtx)
              .pipe(Effect.mapError(normalizeToolExecutionError)),
          ),
        )

        return yield* params.registry.extensionReactions
          .transformToolResult(
            {
              toolCallId: params.toolCall.toolCallId,
              toolName: params.toolCall.toolName,
              input: decodedInput,
              result: executeResult,
              agentName: params.ctx.agentName,
              sessionId: params.ctx.sessionId,
              branchId: params.ctx.branchId,
            },
            params.ctx,
          )
          .pipe(
            Effect.catchEager((e) =>
              Effect.logWarning("extension.reaction.tool-result.failed").pipe(
                Effect.annotateLogs({ error: String(e) }),
                Effect.as(executeResult),
              ),
            ),
          )
      }),
  }

  return Effect.gen(function* () {
    const handlers = yield* toolkit.toHandlers(handlerMap)
    return yield* toolkit.asEffect().pipe(Effect.provideContext(handlers))
  })
}

const closedHandlerResultStream = (
  stream: Stream.Stream<AiTool.HandlerResult<AiTool.Any>, ToolExecutionError, unknown>,
): Stream.Stream<AiTool.HandlerResult<AiTool.Any>, ToolExecutionError> =>
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Effect AI handler streams retain the handler environment in the stream R channel after `toolkit.asEffect()` has closed it; the runtime receives a closed toolkit from `makeExecutionToolkit`.
  stream as unknown as Stream.Stream<AiTool.HandlerResult<AiTool.Any>, ToolExecutionError>

const terminalToolResult = (toolkit: ToolRunnerToolkit, toolCall: ToolCall) =>
  Effect.gen(function* () {
    const resultStream = yield* toolkit
      .handle(toolCall.toolName, toolCall.input)
      .pipe(Effect.map(closedHandlerResultStream))
    const terminal = yield* resultStream.pipe(
      Stream.filter((result) => result.preliminary === false),
      Stream.run(Sink.last()),
    )
    if (terminal._tag === "None") {
      const message = "Tool handler did not produce a final result"
      yield* WideEvent.set({
        toolError: ToolError.ExecutionFailed,
        errorMessage: message,
      })
      return errorResult(toolCall, message)
    }
    return Prompt.toolResultPart({
      id: toolCall.toolCallId,
      name: toolCall.toolName,
      isFailure: terminal.value.isFailure,
      result: terminal.value.encodedResult,
    })
  })

const errorMessageFromAiError = (toolName: string, failure: unknown) => {
  if (AiError.isAiError(failure)) {
    if (failure.reason._tag === "ToolParameterValidationError") {
      return `Tool '${toolName}' input failed:\n${failure.reason.description}`
    }
    if (failure.reason._tag === "ToolResultEncodingError") {
      return `Tool '${toolName}' failed: ${failure.reason.description}`
    }
  }
  return `Tool '${toolName}' failed: ${String(failure)}`
}

const normalizeToolExecutionError = (failure: unknown): InteractionPendingError | Error => {
  if (Schema.is(InteractionPendingError)(failure)) return failure
  if (failure instanceof Error) return failure
  return new Error(String(failure))
}

const allowAllPermission: PermissionService = {
  check: () => Effect.succeed("allowed"),
  addRule: () => Effect.void,
  removeRule: () => Effect.void,
  getRules: () => Effect.succeed([]),
}

export class ToolRunner extends Context.Service<ToolRunner, ToolRunnerService>()(
  "@gent/core/src/runtime/agent/tool-runner/ToolRunner",
) {
  static Live: Layer.Layer<ToolRunner> = Layer.succeed(
    ToolRunner,
    ToolRunner.of({
      run: Effect.fn("ToolRunner.run")(function* (toolCall, ctx, options) {
        const activeRegistry = yield* ExtensionRegistry
        const basePermissionOpt = yield* Effect.serviceOption(Permission)
        const activePermission: PermissionService =
          basePermissionOpt._tag === "Some" ? basePermissionOpt.value : allowAllPermission

        return yield* Effect.gen(function* () {
          yield* WideEvent.set({ sessionId: ctx.sessionId, branchId: ctx.branchId })
          yield* publishStarted({ publishEvent: options?.publishEvent, ctx, toolCall })

          const tool: ToolCapability | undefined = yield* activeRegistry.getModelCapability(
            toolCall.toolName,
          )

          const finish = (result: Prompt.ToolResultPart) =>
            Effect.gen(function* () {
              yield* publishCompleted({
                publishEvent: options?.publishEvent,
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

          if (tool === undefined) {
            yield* WideEvent.set({ toolError: ToolError.Unknown })
            yield* Effect.logInfo("tool.unknown").pipe(
              Effect.annotateLogs({
                toolName: toolCall.toolName,
                toolCallId: toolCall.toolCallId,
              }),
            )
            return yield* finish(errorResult(toolCall, `Unknown tool: ${toolCall.toolName}`))
          }
          const executeKnownTool = Effect.gen(function* () {
            const permCheckResult = yield* activePermission
              .check(toolCall.toolName, toolCall.input)
              .pipe(
                Effect.catchEager((e) =>
                  WideEvent.set({
                    toolError: ToolError.PermissionCheckFailed,
                    errorMessage: String(e),
                  }).pipe(Effect.as("interceptor_failed" as const)),
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
              yield* WideEvent.set({ toolError: ToolError.PermissionDenied })
              yield* Effect.logInfo("tool.permission.denied").pipe(
                Effect.annotateLogs({
                  toolName: toolCall.toolName,
                  toolCallId: toolCall.toolCallId,
                }),
              )
              return errorResult(toolCall, "Permission denied")
            }

            const executionToolkit = yield* makeExecutionToolkit({
              tool,
              toolCall,
              ctx,
              registry: activeRegistry,
            })
            return yield* terminalToolResult(executionToolkit, toolCall)
          })

          const executeResult = yield* executeKnownTool.pipe(Effect.result)

          if (executeResult._tag === "Failure") {
            const failure: unknown = executeResult.failure
            if (Schema.is(InteractionPendingError)(failure)) {
              return yield* failure
            }

            const message = errorMessageFromAiError(toolCall.toolName, failure)
            yield* WideEvent.set({
              toolError:
                AiError.isAiError(failure) && failure.reason._tag === "ToolParameterValidationError"
                  ? ToolError.SchemaDecode
                  : ToolError.ExecutionFailed,
              errorMessage: message,
            })
            yield* Effect.logWarning(
              AiError.isAiError(failure) && failure.reason._tag === "ToolParameterValidationError"
                ? "tool.schema.failed"
                : "tool.execute.failed",
            ).pipe(
              Effect.annotateLogs({
                toolName: toolCall.toolName,
                toolCallId: toolCall.toolCallId,
              }),
            )
            return yield* finish(errorResult(toolCall, message))
          }

          return yield* finish(executeResult.success)
        }).pipe(withWideEvent(toolBoundary(toolCall.toolName, toolCall.toolCallId)))
      }),
    }),
  )

  static Test = (): Layer.Layer<ToolRunner> =>
    Layer.succeed(ToolRunner, {
      run: (toolCall, ctx, options) =>
        Effect.gen(function* () {
          yield* publishStarted({ publishEvent: options?.publishEvent, ctx, toolCall })
          const result = Prompt.toolResultPart({
            id: toolCall.toolCallId,
            name: toolCall.toolName,
            isFailure: false,
            result: null,
          })
          yield* publishCompleted({ publishEvent: options?.publishEvent, ctx, result })
          return result
        }),
    })
}

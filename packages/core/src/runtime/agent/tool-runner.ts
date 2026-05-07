import { Context, Effect, Layer, Schema, Sink, Stream } from "effect"
import {
  getToolId,
  getToolMetadata,
  type ToolCapabilityContext,
  type ToolCapability,
} from "../../domain/capability/tool.js"
import { ExtensionRegistry, type ExtensionRegistryService } from "../extensions/registry.js"
import type { ToolResultPart } from "../../domain/message.js"
import { Permission, type PermissionService } from "../../domain/permission.js"
import { InteractionPendingError } from "../../domain/interaction-request.js"
import { formatSchemaError } from "../format-schema-error"
import { ToolCallFailed, ToolCallStarted, ToolCallSucceeded } from "../../domain/event.js"
import { summarizeToolOutput, stringifyOutput } from "../../domain/tool-output.js"
import type { ResourceManagerService } from "../resource-manager.js"
import { withWideEvent, WideEvent, toolBoundary, ToolError } from "../wide-event-boundary"
import type { ExtensionHostContext } from "../../domain/extension-host-context.js"
import { ToolCallId } from "../../domain/ids.js"
import type { Option } from "effect"
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

interface ToolExecutionProfile {
  readonly registry: ExtensionRegistryService
  readonly permission?: PermissionService
  readonly resourceManager?: ResourceManagerService
  readonly publishEvent?: PublishToolEvent
}

type ToolExecutionError = AiError.AiError | InteractionPendingError | Error

const provideCapabilityContext = <A, E, R>(
  ctx: ToolCapabilityContext,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  ctx.capabilityContext === undefined
    ? effect
    : effect.pipe(Effect.provideContext(ctx.capabilityContext))

type ToolRunnerToolkit = Pick<AiToolkit.WithHandler<ToolCapabilityMap>, "tools"> & {
  readonly handle: (
    name: string,
    input: unknown,
  ) => Effect.Effect<
    Stream.Stream<AiTool.HandlerResult<AiTool.Any>, ToolExecutionError>,
    AiError.AiError
  >
}

export interface ToolRunnerService {
  readonly run: (
    toolCall: ToolCall,
    ctx: ToolCapabilityContext,
    profileOverride?: ToolExecutionProfile,
  ) => Effect.Effect<ToolResultPart, InteractionPendingError>
}

const allowAllPermission: PermissionService = {
  check: () => Effect.succeed("allowed"),
  addRule: () => Effect.void,
  removeRule: () => Effect.void,
  getRules: () => Effect.succeed([]),
}

const resolveActivePermission = (
  basePermissionOpt: Option.Option<PermissionService>,
  profileOverride:
    | {
        readonly registry: ExtensionRegistryService
        readonly permission?: PermissionService
      }
    | undefined,
): PermissionService =>
  profileOverride?.permission ??
  (basePermissionOpt._tag === "Some" ? basePermissionOpt.value : allowAllPermission)

const runPermissionCheck = (params: {
  toolCall: { toolName: string; input: unknown }
  ctx: ExtensionHostContext
  extensionReactions: ExtensionRegistryService["extensionReactions"]
  permission: PermissionService
}): Effect.Effect<"allowed" | "denied"> =>
  params.extensionReactions.checkPermission(
    { toolName: params.toolCall.toolName, input: params.toolCall.input },
    (input) => params.permission.check(input.toolName, input.input),
    params.ctx,
  )

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
  result: ToolResultPart
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
}): ToolRunnerToolkit => {
  const metadata = getToolMetadata(params.tool)
  const tools = { [String(getToolId(params.tool))]: params.tool }

  return {
    tools,
    handle: (name, input) =>
      Effect.gen(function* () {
        if (String(name) !== params.toolCall.toolName) {
          return yield* AiError.make({
            module: "ToolRunner",
            method: "makeExecutionToolkit.handle",
            reason: new AiError.ToolNotFoundError({
              toolName: String(name),
              availableTools: Object.keys(tools),
            }),
          })
        }

        const decodedInput = yield* Schema.decodeUnknownEffect(metadata.input)(input).pipe(
          Effect.mapError((cause) =>
            AiError.make({
              module: "ToolRunner",
              method: `${String(name)}.handle`,
              reason: new AiError.ToolParameterValidationError({
                toolName: String(name),
                toolParams: input,
                description: schemaErrorDescription(String(name), cause),
              }),
            }),
          ),
        )

        return Stream.fromEffect(
          Effect.gen(function* () {
            const executeResult = yield* params.registry.extensionReactions.executeTool(
              {
                toolCallId: params.toolCall.toolCallId,
                toolName: params.toolCall.toolName,
                input: decodedInput,
                sessionId: params.ctx.sessionId,
                branchId: params.ctx.branchId,
              },
              () => {
                const wrapped = Effect.gen(function* () {
                  const output = yield* provideCapabilityContext(
                    params.ctx,
                    // @effect-diagnostics-next-line anyUnknownInErrorContext:off
                    metadata
                      .effect(
                        decodedInput,
                        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- runtime internal owns erased generic boundary
                        params.ctx as Parameters<typeof metadata.effect>[1],
                      )
                      .pipe(Effect.mapError(normalizeToolExecutionError)),
                  )
                  return output
                })
                return wrapped
              },
              params.ctx,
            )

            const enrichedResult = yield* params.registry.extensionReactions
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

            const encodedResult = yield* Schema.encodeUnknownEffect(metadata.output)(
              enrichedResult,
            ).pipe(
              Effect.mapError((cause) =>
                AiError.make({
                  module: "ToolRunner",
                  method: `${String(name)}.handle`,
                  reason: new AiError.ToolResultEncodingError({
                    toolName: String(name),
                    toolResult: enrichedResult,
                    description: schemaErrorDescription(String(name), cause),
                  }),
                }),
              ),
            )

            return {
              result: enrichedResult,
              encodedResult,
              isFailure: false,
              preliminary: false,
            } satisfies AiTool.HandlerResult<AiTool.Any>
          }),
        )
      }),
  }
}

const terminalToolResult = (toolkit: ToolRunnerToolkit, toolCall: ToolCall) =>
  Effect.gen(function* () {
    const resultStream = yield* toolkit.handle(toolCall.toolName, toolCall.input)
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
      return failure.reason.description
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

const schemaErrorDescription = (toolName: string, cause: unknown): string =>
  Schema.isSchemaError(cause) ? formatSchemaError(toolName, cause) : String(cause)

export class ToolRunner extends Context.Service<ToolRunner, ToolRunnerService>()(
  "@gent/core/src/runtime/agent/tool-runner/ToolRunner",
) {
  static Live: Layer.Layer<ToolRunner, never, ExtensionRegistry> = Layer.effect(
    ToolRunner,
    Effect.gen(function* () {
      const extensionRegistry = yield* ExtensionRegistry
      const basePermissionOpt = yield* Effect.serviceOption(Permission)

      const run =
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- runtime internal owns erased generic boundary
        Effect.fn("ToolRunner.run")(function* (toolCall, ctx, profileOverride) {
          return yield* Effect.gen(function* () {
            yield* WideEvent.set({ sessionId: ctx.sessionId, branchId: ctx.branchId })
            yield* publishStarted({ publishEvent: profileOverride?.publishEvent, ctx, toolCall })

            // Use per-session profile when provided, falling back to server-wide
            const activeRegistry = profileOverride?.registry ?? extensionRegistry
            const activePermission = resolveActivePermission(basePermissionOpt, profileOverride)
            const tool: ToolCapability | undefined = yield* activeRegistry.getModelCapability(
              toolCall.toolName,
            )

            const finish = (result: ToolResultPart) =>
              Effect.gen(function* () {
                yield* publishCompleted({
                  publishEvent: profileOverride?.publishEvent,
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
            const metadata = getToolMetadata(tool)

            const executeKnownTool = Effect.gen(function* () {
              const permCheckResult = yield* runPermissionCheck({
                toolCall,
                ctx,
                extensionReactions: activeRegistry.extensionReactions,
                permission: activePermission,
              }).pipe(
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

              return yield* terminalToolResult(
                makeExecutionToolkit({
                  tool,
                  toolCall,
                  ctx,
                  registry: activeRegistry,
                }),
                toolCall,
              )
            })

            const scopedExecute =
              profileOverride?.resourceManager?.withNeeds(metadata.needs ?? [], executeKnownTool) ??
              executeKnownTool

            const executeResult = yield* scopedExecute.pipe(Effect.result)

            if (executeResult._tag === "Failure") {
              const failure = executeResult.failure as unknown
              if (Schema.is(InteractionPendingError)(failure)) {
                return yield* failure
              }

              const message = errorMessageFromAiError(toolCall.toolName, failure)
              yield* WideEvent.set({
                toolError:
                  AiError.isAiError(failure) &&
                  failure.reason._tag === "ToolParameterValidationError"
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
        }) as ToolRunnerService["run"]

      return ToolRunner.of({ run })
    }),
  )

  static Test = (): Layer.Layer<ToolRunner> =>
    Layer.succeed(ToolRunner, {
      run: (toolCall, ctx, profileOverride) =>
        Effect.gen(function* () {
          yield* publishStarted({ publishEvent: profileOverride?.publishEvent, ctx, toolCall })
          const result = Prompt.toolResultPart({
            id: toolCall.toolCallId,
            name: toolCall.toolName,
            isFailure: false,
            result: null,
          })
          yield* publishCompleted({ publishEvent: profileOverride?.publishEvent, ctx, result })
          return result
        }),
    })
}

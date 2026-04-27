import { Context, Effect, Layer, Schema } from "effect"
import type { AnyCapabilityContribution } from "../../domain/capability.js"
import { type ToolContext } from "../../domain/tool.js"
import { ExtensionRegistry, type ExtensionRegistryService } from "../extensions/registry.js"
import { ToolResultPart } from "../../domain/message.js"
import { Permission, type PermissionService } from "../../domain/permission.js"
import { InteractionPendingError } from "../../domain/interaction-request.js"
import { formatSchemaError } from "../format-schema-error"
import {
  withWideEvent,
  WideEvent,
  toolBoundary,
  ToolError,
  ToolWarning,
} from "../wide-event-boundary"
import type { ExtensionHostContext } from "../../domain/extension-host-context.js"
import type { ToolCallId } from "../../domain/ids.js"
import type { Option } from "effect"

export interface ToolRunnerService {
  readonly run: (
    toolCall: { toolCallId: ToolCallId; toolName: string; input: unknown },
    ctx: ToolContext,
    /** Per-session profile override. When provided, tool lookup and permission
     *  use this instead of the server-wide services. */
    profileOverride?: {
      readonly registry: ExtensionRegistryService
      readonly permission?: PermissionService
    },
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
  new ToolResultPart({
    type: "tool-result",
    toolCallId: toolCall.toolCallId,
    toolName: toolCall.toolName,
    output: {
      type: "error-json",
      value: { error: message },
    },
  })

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

            // Use per-session profile when provided, falling back to server-wide
            const activeRegistry = profileOverride?.registry ?? extensionRegistry
            const activePermission = resolveActivePermission(basePermissionOpt, profileOverride)
            const tool: AnyCapabilityContribution | undefined =
              yield* activeRegistry.getModelCapability(toolCall.toolName)
            if (tool === undefined) {
              yield* WideEvent.set({ toolError: ToolError.Unknown })
              yield* Effect.logInfo("tool.unknown").pipe(
                Effect.annotateLogs({
                  toolName: toolCall.toolName,
                  toolCallId: toolCall.toolCallId,
                }),
              )
              return errorResult(toolCall, `Unknown tool: ${toolCall.toolName}`)
            }

            // Run permission.check interceptor, falling back to base Permission service
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

            const decodedInput = yield* Schema.decodeUnknownEffect(tool.input)(toolCall.input).pipe(
              Effect.result,
            )
            if (decodedInput._tag === "Failure") {
              const failure = decodedInput.failure
              const message = Schema.isSchemaError(failure)
                ? formatSchemaError(toolCall.toolName, failure)
                : `Invalid tool input: ${String(failure)}`
              yield* WideEvent.set({ toolError: ToolError.SchemaDecode, errorMessage: message })
              yield* Effect.logWarning("tool.schema.failed").pipe(
                Effect.annotateLogs({
                  toolName: toolCall.toolName,
                  toolCallId: toolCall.toolCallId,
                }),
              )
              return errorResult(toolCall, message)
            }

            // Run the legacy tool.execute shim, falling back to direct tool execution.
            const executeResult = yield* activeRegistry.extensionReactions
              .executeTool(
                {
                  toolCallId: toolCall.toolCallId,
                  toolName: toolCall.toolName,
                  input: decodedInput.success,
                  sessionId: ctx.sessionId,
                  branchId: ctx.branchId,
                },
                () => {
                  const wrapped = Effect.gen(function* () {
                    const output = yield* tool.effect(
                      decodedInput.success,
                      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- runtime internal owns erased generic boundary
                      ctx as Parameters<typeof tool.effect>[1],
                    )
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- runtime internal owns erased generic boundary
                    yield* Schema.encodeUnknownEffect(tool.output as Schema.Any)(output).pipe(
                      Effect.orDie,
                    )
                    return output
                  })
                  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- runtime internal owns erased generic boundary
                  return wrapped as Effect.Effect<unknown>
                },
                ctx,
              )
              .pipe(Effect.result)

            if (executeResult._tag === "Failure") {
              // InteractionPendingError must escape the tool runner so the machine
              // transitions to WaitingForInteraction. The interceptor type system erases
              // the error to `never`, but the error exists at runtime.
              const failure = executeResult.failure as unknown
              if (Schema.is(InteractionPendingError)(failure)) {
                return yield* failure
              }

              const message = Schema.isSchemaError(failure)
                ? formatSchemaError(toolCall.toolName, failure)
                : `Tool '${toolCall.toolName}' failed: ${String(failure)}`
              yield* WideEvent.set({
                toolError: ToolError.ExecutionFailed,
                errorMessage: message,
              })
              yield* Effect.logWarning("tool.execute.failed").pipe(
                Effect.annotateLogs({
                  toolName: toolCall.toolName,
                  toolCallId: toolCall.toolCallId,
                }),
              )
              return errorResult(toolCall, message)
            }

            // Run explicit tool-result slots — extensions can enrich/append to tool results
            const enrichedResult = yield* activeRegistry.extensionReactions
              .transformToolResult(
                {
                  toolCallId: toolCall.toolCallId,
                  toolName: toolCall.toolName,
                  input: decodedInput.success,
                  result: executeResult.success,
                  agentName: ctx.agentName,
                  sessionId: ctx.sessionId,
                  branchId: ctx.branchId,
                },
                ctx,
              )
              .pipe(
                Effect.catchEager((e) =>
                  WideEvent.set({
                    toolWarning: ToolWarning.ResultEnrichmentFailed,
                    errorMessage: String(e),
                  }).pipe(Effect.as(executeResult.success)),
                ),
              )

            return new ToolResultPart({
              type: "tool-result",
              toolCallId: toolCall.toolCallId,
              toolName: toolCall.toolName,
              output: { type: "json", value: enrichedResult },
            })
          }).pipe(withWideEvent(toolBoundary(toolCall.toolName, toolCall.toolCallId)))
        }) as ToolRunnerService["run"]

      return ToolRunner.of({ run })
    }),
  )

  static Test = (): Layer.Layer<ToolRunner> =>
    Layer.succeed(ToolRunner, {
      run: (toolCall) =>
        Effect.succeed(
          new ToolResultPart({
            type: "tool-result",
            toolCallId: toolCall.toolCallId,
            toolName: toolCall.toolName,
            output: { type: "json", value: null },
          }),
        ),
    })
}

import { ServiceMap, Effect, Layer, Schema } from "effect"
import { type ToolContext, type AnyToolDefinition, type ToolDefinition } from "../../domain/tool.js"
import { ExtensionRegistry } from "../extensions/registry.js"
import { ToolResultPart } from "../../domain/message.js"
import { Permission } from "../../domain/permission.js"
import { formatSchemaError } from "../format-schema-error"
import {
  withWideEvent,
  WideEvent,
  toolBoundary,
  ToolError,
  ToolWarning,
} from "../wide-event-boundary"

export interface ToolRunnerService {
  readonly run: (
    toolCall: { toolCallId: ToolCallId; toolName: string; input: unknown },
    ctx: ToolContext,
  ) => Effect.Effect<ToolResultPart, never>
}

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

export class ToolRunner extends ServiceMap.Service<ToolRunner, ToolRunnerService>()(
  "@gent/core/src/runtime/agent/tool-runner/ToolRunner",
) {
  static Live: Layer.Layer<ToolRunner, never, ExtensionRegistry | Permission> = Layer.effect(
    ToolRunner,
    Effect.gen(function* () {
      const extensionRegistry = yield* ExtensionRegistry
      const permission = yield* Permission

      const { hooks } = extensionRegistry

      return ToolRunner.of({
        run: Effect.fn("ToolRunner.run")(function* (toolCall, ctx) {
          return yield* Effect.gen(function* () {
            yield* WideEvent.set({ sessionId: ctx.sessionId, branchId: ctx.branchId })

            const tool: AnyToolDefinition | undefined = yield* extensionRegistry.getTool(
              toolCall.toolName,
            )
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
            const permCheckResult = yield* hooks
              .runInterceptor(
                "permission.check",
                { toolName: toolCall.toolName, input: toolCall.input },
                (input) => permission.check(input.toolName, input.input),
              )
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

            const toolDefinition = tool as ToolDefinition<
              string,
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              Schema.Decoder<any, never>,
              unknown,
              unknown,
              never
            >
            const decodedInput = yield* Schema.decodeUnknownEffect(toolDefinition.params)(
              toolCall.input,
            ).pipe(Effect.result)
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

            // Run tool.execute interceptor, falling back to direct tool execution
            const executeResult = yield* hooks
              .runInterceptor(
                "tool.execute",
                {
                  toolCallId: toolCall.toolCallId,
                  toolName: toolCall.toolName,
                  input: decodedInput.success,
                  sessionId: ctx.sessionId,
                  branchId: ctx.branchId,
                },
                () => toolDefinition.execute(decodedInput.success, ctx) as Effect.Effect<unknown>,
              )
              .pipe(Effect.result)

            if (executeResult._tag === "Failure") {
              const failure = executeResult.failure
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

            // Run tool.result interceptor — extensions can enrich/append to tool results
            const enrichedResult = yield* hooks
              .runInterceptor(
                "tool.result",
                {
                  toolCallId: toolCall.toolCallId,
                  toolName: toolCall.toolName,
                  toolAction: toolDefinition.action,
                  input: decodedInput.success,
                  result: executeResult.success,
                  agentName: ctx.agentName,
                  sessionId: ctx.sessionId,
                  branchId: ctx.branchId,
                },
                (input) => Effect.succeed(input.result),
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
        }),
      })
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
import type { ToolCallId } from "../../domain/ids.js"

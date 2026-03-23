import { ServiceMap, Effect, Layer, Schema } from "effect"
import { type ToolContext, type AnyToolDefinition, type ToolDefinition } from "../../domain/tool.js"
import { ExtensionRegistry } from "../extensions/registry.js"
import { ToolResultPart } from "../../domain/message.js"
import { Permission, type PermissionDecision } from "../../domain/permission.js"
import { PermissionHandler } from "../../domain/interaction-handlers.js"
import { formatSchemaError } from "../format-schema-error"

export interface ToolRunnerService {
  readonly run: (
    toolCall: { toolCallId: ToolCallId; toolName: string; input: unknown },
    ctx: ToolContext,
    options?: { bypass?: boolean },
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
  static Live: Layer.Layer<ToolRunner, never, ExtensionRegistry | Permission | PermissionHandler> =
    Layer.effect(
      ToolRunner,
      Effect.gen(function* () {
        const extensionRegistry = yield* ExtensionRegistry
        const permission = yield* Permission
        const permissionHandler = yield* PermissionHandler

        const { hooks } = extensionRegistry

        return ToolRunner.of({
          run: Effect.fn("ToolRunner.run")(function* (toolCall, ctx, options) {
            const tool: AnyToolDefinition | undefined = yield* extensionRegistry.getTool(
              toolCall.toolName,
            )
            if (tool === undefined) {
              return errorResult(toolCall, `Unknown tool: ${toolCall.toolName}`)
            }

            // Run permission.check interceptor, falling back to base Permission service
            const permResult =
              options?.bypass === true
                ? ("allowed" as const)
                : yield* hooks.runInterceptor(
                    "permission.check",
                    { toolName: toolCall.toolName, input: toolCall.input },
                    (input) => permission.check(input.toolName, input.input),
                  )

            if (permResult === "ask") {
              const decision = yield* permissionHandler
                .request(
                  {
                    toolCallId: toolCall.toolCallId,
                    toolName: toolCall.toolName,
                    input: toolCall.input,
                  },
                  ctx,
                )
                .pipe(Effect.catchEager(() => Effect.succeed<PermissionDecision>("deny")))
              if (decision === "deny") {
                return errorResult(toolCall, "Permission denied")
              }
            } else if (permResult === "denied") {
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
              return errorResult(toolCall, message)
            }

            return new ToolResultPart({
              type: "tool-result",
              toolCallId: toolCall.toolCallId,
              toolName: toolCall.toolName,
              output: { type: "json", value: executeResult.success },
            })
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

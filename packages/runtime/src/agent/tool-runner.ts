import { Context, Effect, Layer, Schema } from "effect"
import {
  ToolRegistry,
  ToolResultPart,
  type ToolContext,
  Permission,
  PermissionHandler,
  type AnyToolDefinition,
  type ToolDefinition,
  type PermissionDecision,
} from "@gent/core"

export interface ToolRunnerService {
  readonly run: (
    toolCall: { toolCallId: string; toolName: string; input: unknown },
    ctx: ToolContext,
    options?: { bypass?: boolean },
  ) => Effect.Effect<ToolResultPart, never>
}

const errorResult = (toolCall: { toolCallId: string; toolName: string }, message: string) =>
  new ToolResultPart({
    type: "tool-result",
    toolCallId: toolCall.toolCallId,
    toolName: toolCall.toolName,
    output: {
      type: "error-json",
      value: { error: message },
    },
  })

export class ToolRunner extends Context.Tag("@gent/runtime/src/agent/tool-runner/ToolRunner")<
  ToolRunner,
  ToolRunnerService
>() {
  static Live: Layer.Layer<ToolRunner, never, ToolRegistry | Permission | PermissionHandler> =
    Layer.effect(
      ToolRunner,
      Effect.gen(function* () {
        const toolRegistry = yield* ToolRegistry
        const permission = yield* Permission
        const permissionHandler = yield* PermissionHandler

        return ToolRunner.of({
          run: Effect.fn("ToolRunner.run")(function* (toolCall, ctx, options) {
            const tool = (yield* toolRegistry.get(toolCall.toolName)) as
              | AnyToolDefinition
              | undefined
            if (tool === undefined) {
              return errorResult(toolCall, `Unknown tool: ${toolCall.toolName}`)
            }

            const permResult =
              options?.bypass === true
                ? ("allowed" as const)
                : yield* permission.check(toolCall.toolName, toolCall.input)

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
                .pipe(Effect.catchAll(() => Effect.succeed<PermissionDecision>("deny")))
              if (decision === "deny") {
                return errorResult(toolCall, "Permission denied")
              }
            } else if (permResult === "denied") {
              return errorResult(toolCall, "Permission denied")
            }

            const toolDefinition = tool as ToolDefinition<
              string,
              Schema.Schema.AnyNoContext,
              unknown,
              unknown,
              never
            >
            const decodedInput = yield* Schema.decodeUnknown(toolDefinition.params)(
              toolCall.input,
            ).pipe(Effect.either)
            if (decodedInput._tag === "Left") {
              return errorResult(toolCall, `Invalid tool input: ${String(decodedInput.left)}`)
            }
            const result = yield* toolDefinition
              .execute(decodedInput.right, ctx)
              .pipe(Effect.either)

            if (result._tag === "Left") {
              return errorResult(toolCall, `Tool failed: ${String(result.left)}`)
            }

            return new ToolResultPart({
              type: "tool-result",
              toolCallId: toolCall.toolCallId,
              toolName: toolCall.toolName,
              output: { type: "json", value: result.right },
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

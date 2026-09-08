import { Effect, Option, Schema } from "effect"
import type * as Prompt from "effect/unstable/ai/Prompt"
import { getToolId } from "../../domain/capability/tool.js"
import type { ToolCallId } from "../../domain/ids.js"
import { Permission } from "../../domain/permission.js"
import { ToolRunner, type ResolvedToolCapability } from "../agent/tool-runner.js"
import { CellToolCallSuspended } from "./cell-kernel.js"
import { CellEvaluationError, type CellResponse } from "./cell-protocol.js"

const JsonText = Schema.fromJsonString(Schema.Json)
// Tool results are Schema-encoded values. Optional fields left `undefined` are
// legal there but are not JSON values. The cell pipe carries JSON text, so the
// value is projected through the text codec before it crosses to the worker.
const UnknownText = Schema.fromJsonString(Schema.Unknown)

/** The caller owns the bound capability, operation receipt, and publication lease. */
export const executeBoundCellTool = Effect.fn("CellToolCall.executeBound")(function* (params: {
  readonly request: Pick<
    Extract<CellResponse, { _tag: "HostCall" }>,
    "operationId" | "name" | "input"
  >
  readonly toolCallId: ToolCallId
  readonly binding: Option.Option<ResolvedToolCapability>
}) {
  const runner = yield* ToolRunner
  // Require an explicit host policy. ToolRunner's legacy missing-policy default is not sufficient.
  const permission = yield* Permission
  if (
    Option.isSome(params.binding) &&
    getToolId(params.binding.value.capability) !== params.request.name
  ) {
    return yield* new CellEvaluationError({
      phase: "execute",
      message: "Cell tool name does not match its bound capability",
      output: "",
    })
  }
  return yield* runner
    .runBound(
      {
        toolCallId: params.toolCallId,
        toolName: params.request.name,
        input: params.request.input,
      },
      params.binding,
    )
    .pipe(
      Effect.provideService(Permission, permission),
      Effect.mapError(
        (pending) =>
          new CellToolCallSuspended({
            operationId: params.request.operationId,
            toolCallId: params.toolCallId,
            pending,
          }),
      ),
    )
})

export const cellToolResultValue = Effect.fn("CellToolCall.resultValue")(function* (
  result: Prompt.ToolResultPart,
) {
  const value = yield* Schema.encodeEffect(UnknownText)(result.result).pipe(
    Effect.flatMap(Schema.decodeEffect(JsonText)),
    Effect.mapError(
      (cause) =>
        new CellEvaluationError({
          phase: "execute",
          message: `Tool result is not JSON: ${String(cause)}`,
          output: "",
        }),
    ),
  )
  if (result.isFailure) {
    const message = yield* Schema.encodeEffect(JsonText)(value).pipe(
      Effect.mapError(
        (cause) =>
          new CellEvaluationError({ phase: "execute", message: String(cause), output: "" }),
      ),
    )
    return yield* new CellEvaluationError({ phase: "execute", message, output: "" })
  }
  return value
})

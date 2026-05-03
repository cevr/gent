/**
 * Executor tools — execute + resume.
 *
 * execute: run TypeScript in Executor's sandboxed runtime.
 * resume: continue a paused execution (waiting_for_interaction).
 *
 * Both read the executor runtime snapshot to get the baseUrl, then delegate to
 * ExecutorMcpBridge. isError results become Effect.fail.
 */

import { Effect, Schema } from "effect"
import { tool } from "@gent/core/extensions/api"
import { ExecutorRead } from "./controller.js"
import { type ExecutorMcpToolResult, type ResumeAction, ExecutorMcpError } from "./domain.js"
import { ExecutorMcpBridge } from "./mcp-bridge.js"

// ── Helpers ──

const requireReadyBaseUrl = (phase: "execute" | "resume") =>
  Effect.gen(function* () {
    const executor = yield* Effect.serviceOption(ExecutorRead)
    const snapshot =
      executor._tag === "Some"
        ? yield* executor.value.snapshot().pipe(Effect.catchEager(() => Effect.void))
        : undefined
    if (
      snapshot === undefined ||
      snapshot.status !== "ready" ||
      snapshot.baseUrl === undefined ||
      snapshot.baseUrl.length === 0
    ) {
      return yield* new ExecutorMcpError({ phase, message: "Executor not ready" })
    }
    return snapshot.baseUrl
  })

const failIfError = (result: ExecutorMcpToolResult, phase: "execute" | "resume") =>
  result.isError
    ? Effect.fail(new ExecutorMcpError({ phase, message: result.text }))
    : Effect.succeed(result)

// ── Execute Tool ──

export const ExecuteTool = tool({
  id: "execute",
  description: "Execute TypeScript in a sandboxed runtime with access to configured API tools.",
  promptSnippet: "Execute TypeScript in Executor's sandboxed runtime with configured API tools.",
  promptGuidelines: [
    "Use tools.search({ query }) inside execute to discover available API tools.",
    "Use tools.describe.tool({ path }) to get TypeScript shapes before calling.",
  ],
  params: Schema.Struct({
    code: Schema.String.annotate({
      description: "TypeScript code to execute in the Executor runtime.",
    }),
  }),
  execute: Effect.fn("ExecuteTool.execute")(function* (params) {
    const baseUrl = yield* requireReadyBaseUrl("execute")
    const bridge = yield* ExecutorMcpBridge
    const result = yield* bridge.execute(baseUrl, params.code)
    const checked = yield* failIfError(result, "execute")
    return {
      text: checked.text,
      structuredContent: checked.structuredContent,
      executionId: checked.executionId,
    }
  }),
})

// ── Resume Tool ──

export const ResumeTool = tool({
  id: "resume",
  description: "Resume a paused Executor execution. Use the exact executionId returned by execute.",
  promptGuidelines: [
    "Use the exact executionId returned by execute.",
    "action: 'accept' to approve, 'decline' to reject, 'cancel' to abort.",
  ],
  params: Schema.Struct({
    executionId: Schema.String.annotate({
      description: "The executionId from execute's result.",
    }),
    action: Schema.Literals(["accept", "decline", "cancel"]).annotate({
      description: "How to respond to the pending interaction.",
    }),
    content: Schema.optional(
      Schema.String.annotate({
        description: "Optional JSON string with additional content for the interaction.",
      }),
    ),
  }),
  execute: Effect.fn("ResumeTool.execute")(function* (params) {
    const baseUrl = yield* requireReadyBaseUrl("resume")
    const bridge = yield* ExecutorMcpBridge
    const contentStr = params.content
    const parsed = contentStr
      ? yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
        )(contentStr).pipe(
          Effect.mapError(
            () =>
              new ExecutorMcpError({
                phase: "resume",
                message: "Invalid JSON in content parameter",
              }),
          ),
        )
      : undefined
    const result = yield* bridge.resume(
      baseUrl,
      params.executionId,
      params.action as ResumeAction,
      parsed,
    )
    const checked = yield* failIfError(result, "resume")
    return {
      text: checked.text,
      structuredContent: checked.structuredContent,
    }
  }),
})

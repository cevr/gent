/**
 * Executor tools — execute + resume.
 *
 * execute: run TypeScript in Executor's sandboxed runtime.
 * resume: continue a paused execution (waiting_for_interaction).
 *
 * Both read the actor snapshot to get the baseUrl, then delegate to
 * ExecutorMcpBridge. isError results become Effect.fail.
 */

import { Effect, Schema } from "effect"
import { defineTool } from "../api.js"
import {
  type ExecutorMcpToolResult,
  type ResumeAction,
  ExecutorMcpError,
  EXECUTOR_EXTENSION_ID,
} from "./domain.js"
import { ExecutorMcpBridge } from "./mcp-bridge.js"
import type { ExecutorUiModel } from "./actor.js"

// ── Helpers ──

const requireReadyBaseUrl = (
  ctx: { extension: { getUiSnapshot: <T>(id: string) => Effect.Effect<T | undefined> } },
  phase: "execute" | "resume",
) =>
  Effect.gen(function* () {
    const snapshot = yield* ctx.extension.getUiSnapshot<ExecutorUiModel>(EXECUTOR_EXTENSION_ID)
    if (!snapshot || snapshot.status !== "ready" || !snapshot.baseUrl) {
      return yield* new ExecutorMcpError({ phase, message: "Executor not ready" })
    }
    return snapshot.baseUrl
  })

const failIfError = (result: ExecutorMcpToolResult, phase: "execute" | "resume") =>
  result.isError
    ? Effect.fail(new ExecutorMcpError({ phase, message: result.text }))
    : Effect.succeed(result)

// ── Execute Tool ──

export const ExecuteTool = defineTool({
  name: "execute",
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
  execute: Effect.fn("ExecuteTool.execute")(function* (params, ctx) {
    const baseUrl = yield* requireReadyBaseUrl(ctx, "execute")
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

export const ResumeTool = defineTool({
  name: "resume",
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
  execute: Effect.fn("ResumeTool.execute")(function* (params, ctx) {
    const baseUrl = yield* requireReadyBaseUrl(ctx, "resume")
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

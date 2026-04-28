import { Effect, Schema } from "effect"
import { request } from "@gent/core/extensions/api"
import { ExecutorRead, ExecutorWrite } from "./controller.js"
import { EXECUTOR_EXTENSION_ID } from "./domain.js"

/** Snapshot reply. Carries enough state for both:
 *   - the projection (status drives tool gating, executorPrompt feeds the
 *     executor-guidance prompt section),
 *   - the execute/resume tools (baseUrl needed for MCP dispatch). */
export const ExecutorSnapshotReply = Schema.Struct({
  status: Schema.Literals(["idle", "connecting", "ready", "error"]),
  baseUrl: Schema.optional(Schema.String),
  executorPrompt: Schema.optional(Schema.String),
  errorMessage: Schema.optional(Schema.String),
})
export type ExecutorSnapshotReply = typeof ExecutorSnapshotReply.Type

export const ExecutorRpc = {
  Start: request({
    id: "executor-start",
    extensionId: EXECUTOR_EXTENSION_ID,
    intent: "write",
    slash: {
      name: "Executor: Start",
      description: "Connect to the configured Executor endpoint.",
    },
    description: "Connect to the configured Executor endpoint.",
    input: Schema.String,
    output: Schema.Void,
    execute: Effect.fn("ExecutorRpc.Start")(function* (_input, ctx) {
      const executor = yield* ExecutorWrite
      yield* executor.connect(ctx.cwd)
    }),
  }),
  Stop: request({
    id: "executor-stop",
    extensionId: EXECUTOR_EXTENSION_ID,
    intent: "write",
    slash: { name: "Executor: Stop", description: "Disconnect from the Executor sidecar." },
    description: "Disconnect from the Executor sidecar.",
    input: Schema.String,
    output: Schema.Void,
    execute: Effect.fn("ExecutorRpc.Stop")(function* () {
      const executor = yield* ExecutorWrite
      yield* executor.disconnect()
    }),
  }),
  GetSnapshot: request({
    id: "executor.snapshot",
    extensionId: EXECUTOR_EXTENSION_ID,
    intent: "read",
    input: Schema.Struct({}),
    output: ExecutorSnapshotReply,
    execute: Effect.fn("ExecutorRpc.GetSnapshot")(function* () {
      const executor = yield* ExecutorRead
      return yield* executor.snapshot()
    }),
  }),
}

/**
 * Back-compat export for callers that imported the old protocol subpath.
 * Values are RPC capability tokens now, not actor-route ExtensionMessages.
 */
export const ExecutorProtocol = {
  Connect: ExecutorRpc.Start,
  Disconnect: ExecutorRpc.Stop,
  GetSnapshot: ExecutorRpc.GetSnapshot,
}

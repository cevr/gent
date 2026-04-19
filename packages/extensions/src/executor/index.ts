/**
 * @gent/executor extension — sandboxed TypeScript execution via Executor.
 */

import { Effect, Layer, Schema } from "effect"
import { action, defineExtension, defineResource } from "@gent/core/extensions/api"
import { EXECUTOR_EXTENSION_ID } from "./domain.js"
import { ExecutorSidecar } from "./sidecar.js"
import { ExecutorMcpBridge } from "./mcp-bridge.js"
import { executorActor } from "./actor.js"
import { ExecuteTool, ResumeTool } from "./tools.js"
import { ExecutorProtocol } from "./protocol.js"
import { ExecutorProjection } from "./projection.js"

export { ExecutorUiModel } from "./actor.js"
export { EXECUTOR_EXTENSION_ID } from "./domain.js"

export const ExecutorExtension = defineExtension({
  id: EXECUTOR_EXTENSION_ID,
  projections: [ExecutorProjection],
  capabilities: [
    ExecuteTool,
    ResumeTool,
    // Slash commands authored through the `action()` factory.
    // `surface: "slash"` derives `audiences: ["human-slash"]`, and
    // `public: true` adds `"transport-public"` so non-TUI clients
    // (SDK, future web UI) can also invoke them.
    action({
      id: "executor-start",
      name: "Executor: Start",
      description: "Connect to the configured Executor endpoint.",
      surface: "slash",
      public: true,
      promptSnippet: "Connect to the configured Executor endpoint.",
      input: Schema.String,
      output: Schema.Void,
      execute: (_args, extCtx) =>
        extCtx.extension.send(ExecutorProtocol.Connect({ cwd: extCtx.cwd })).pipe(Effect.orDie),
    }),
    action({
      id: "executor-stop",
      name: "Executor: Stop",
      description: "Disconnect from the Executor sidecar.",
      surface: "slash",
      public: true,
      promptSnippet: "Disconnect from the Executor sidecar.",
      input: Schema.String,
      output: Schema.Void,
      execute: (_args, extCtx) =>
        extCtx.extension.send(ExecutorProtocol.Disconnect()).pipe(Effect.orDie),
    }),
  ],
  // Single Resource carries the ExecutorSidecar/McpBridge layers AND the
  // executor actor machine. Per the C3.5 "Resource = layer + machine" merge.
  resources: ({ ctx }) => [
    defineResource({
      scope: "process",
      layer: Layer.merge(ExecutorSidecar.Live(ctx.home), ExecutorMcpBridge.Live),
      machine: executorActor,
    }),
  ],
})

/**
 * @gent/executor extension — sandboxed TypeScript execution via Executor.
 */

import { Effect, Layer, Schema } from "effect"
import { capability, defineExtension, defineResource, tool } from "@gent/core/extensions/api"
import type { ModelCapabilityContext } from "@gent/core/extensions/api"
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
    tool(ExecuteTool),
    tool(ResumeTool),
    // Slash commands as capabilities — `audiences: ["human-slash"]` keeps
    // them surfaced in the slash dispatcher; `intent: "write"` reflects that
    // they steer the executor sidecar lifecycle.
    capability({
      id: "executor-start",
      audiences: ["human-slash", "transport-public"],
      intent: "write",
      promptSnippet: "Connect to the configured Executor endpoint.",
      input: Schema.String,
      output: Schema.Void,
      effect: (_args: string, extCtx: ModelCapabilityContext) =>
        extCtx.extension.send(ExecutorProtocol.Connect({ cwd: extCtx.cwd })).pipe(Effect.orDie),
    }),
    capability({
      id: "executor-stop",
      audiences: ["human-slash", "transport-public"],
      intent: "write",
      promptSnippet: "Disconnect from the Executor sidecar.",
      input: Schema.String,
      output: Schema.Void,
      effect: (_args: string, extCtx: ModelCapabilityContext) =>
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

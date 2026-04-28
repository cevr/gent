/**
 * @gent/executor extension — sandboxed TypeScript execution via Executor.
 */

import { Layer } from "effect"
import { defineExtension, defineResource } from "@gent/core/extensions/api"
import { EXECUTOR_EXTENSION_ID } from "./domain.js"
import { ExecutorSidecar } from "./sidecar.js"
import { ExecutorMcpBridge } from "./mcp-bridge.js"
import { executorActor } from "./actor.js"
import { ExecutorConnectionRunner, ExecutorConnectionRunnerLayer } from "./connection-runner.js"
import { ExecuteTool, ResumeTool } from "./tools.js"
import { ExecutorRpc } from "./protocol.js"
import { ExecutorControllerLive } from "./controller.js"

export { ExecutorUiModel } from "./actor.js"
export { EXECUTOR_EXTENSION_ID } from "./domain.js"

export const ExecutorExtension = defineExtension({
  id: EXECUTOR_EXTENSION_ID,
  tools: [ExecuteTool, ResumeTool],
  rpc: [ExecutorRpc.Start, ExecutorRpc.Stop, ExecutorRpc.GetSnapshot],
  actors: [executorActor],
  // Resource carries the layer for ExecutorSidecar/McpBridge plus the
  // ExecutorConnectionRunner. The runner observes the actor's state and
  // drives the sidecar connection on entry to `Connecting` (the W10-1c
  // "Option G" pattern: connection effect outside the actor, hosted on
  // a Layer.scoped fiber).
  //
  // The runner depends on `ActorEngine | Receptionist` from the runtime
  // and `ExecutorSidecar | ExecutorMcpBridge` from this layer; we
  // provide the latter so only the runtime services flow through to
  // the resource host's `R` channel.
  resources: ({ ctx }) => [
    defineResource({
      tag: ExecutorConnectionRunner,
      scope: "process",
      layer: ExecutorConnectionRunnerLayer(ctx.cwd).pipe(
        Layer.provide(Layer.merge(ExecutorSidecar.Live(ctx.home), ExecutorMcpBridge.Live)),
      ),
    }),
    defineResource({
      scope: "process",
      layer: ExecutorControllerLive,
    }),
    defineResource({
      scope: "process",
      layer: Layer.merge(ExecutorSidecar.Live(ctx.home), ExecutorMcpBridge.Live),
    }),
  ],
})

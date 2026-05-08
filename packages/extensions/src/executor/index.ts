/**
 * @gent/executor extension — sandboxed TypeScript execution via Executor.
 */

import { Effect, Layer } from "effect"
import {
  defineResource,
  ExtensionId,
  type ExtensionContributions,
  type GentExtension,
} from "@gent/core/extensions/api"
import { EXECUTOR_EXTENSION_ID } from "./domain.js"
import { ExecutorSidecar } from "./sidecar.js"
import { ExecutorMcpBridge } from "./mcp-bridge.js"
import { ExecuteTool, ResumeTool } from "./tools.js"
import { ExecutorRpc } from "./protocol.js"
import { ExecutorControllerLive, ExecutorRuntime } from "./controller.js"

export { ExecutorUiModel } from "./actor.js"
export { EXECUTOR_EXTENSION_ID } from "./domain.js"

export const ExecutorExtension: GentExtension = {
  manifest: { id: ExtensionId.make(EXECUTOR_EXTENSION_ID) },
  setup: (ctx) => {
    const executorDependencies = Layer.merge(
      ExecutorSidecar.Live(ctx.home, ctx.host),
      ExecutorMcpBridge.Live,
    )
    const executorLayer = Layer.provideMerge(ExecutorControllerLive(ctx.cwd), executorDependencies)
    return Effect.succeed({
      tools: [ExecuteTool, ResumeTool],
      requests: [ExecutorRpc.Start, ExecutorRpc.Stop, ExecutorRpc.GetSnapshot],
      resources: [
        defineResource({
          scope: "process",
          layer: executorLayer,
        }),
      ],
      reactions: {
        turnProjection: () =>
          Effect.gen(function* () {
            const executor = yield* ExecutorRuntime
            return yield* executor.turnProjection()
          }),
      },
    } satisfies ExtensionContributions)
  },
}

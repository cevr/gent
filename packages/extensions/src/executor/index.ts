/**
 * @gent/executor extension — sandboxed TypeScript execution via Executor.
 */

import { Effect, Layer } from "effect"
import {
  defineExtension,
  defineResource,
  ExtensionSetupContext,
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

export const ExecutorExtension: GentExtension = defineExtension({
  id: EXECUTOR_EXTENSION_ID,
  resources: () =>
    Effect.gen(function* () {
      const ctx = yield* ExtensionSetupContext
      const executorDependencies = Layer.merge(
        ExecutorSidecar.LiveFromSetup(ctx.home, {
          execPath: ctx.host.execPath,
          pathListSeparator: ctx.host.pathListSeparator,
          platform: ctx.host.osInfo.platform,
          Process: ctx.Process,
        }),
        ExecutorMcpBridge.Live,
      )
      const executorLayer = Layer.provideMerge(
        ExecutorControllerLive(ctx.cwd),
        executorDependencies,
      )
      return [
        defineResource({
          scope: "process",
          layer: executorLayer,
        }),
      ]
    }),
  tools: [ExecuteTool, ResumeTool],
  requests: [ExecutorRpc.Start, ExecutorRpc.Stop, ExecutorRpc.GetSnapshot],
  reactions: {
    turnProjection: () =>
      Effect.gen(function* () {
        const executor = yield* ExecutorRuntime
        return yield* executor.turnProjection()
      }),
  },
})

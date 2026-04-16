/**
 * @gent/executor extension — sandboxed TypeScript execution via Executor.
 */

import { Effect, Layer } from "effect"
import { extension } from "@gent/core/extensions/api"
import { EXECUTOR_EXTENSION_ID } from "./domain.js"
import { ExecutorSidecar } from "./sidecar.js"
import { ExecutorMcpBridge } from "./mcp-bridge.js"
import { executorActor } from "./actor.js"
import { ExecuteTool, ResumeTool } from "./tools.js"
import { ExecutorProtocol } from "./protocol.js"

export { ExecutorUiModel } from "./actor.js"
export { EXECUTOR_EXTENSION_ID } from "./domain.js"

export const ExecutorExtension = extension(EXECUTOR_EXTENSION_ID, ({ ext, ctx }) =>
  ext
    .actor(executorActor)
    .tools(ExecuteTool, ResumeTool)
    .command("executor-start", {
      description: "Connect to the configured Executor endpoint.",
      handler: (_args, extCtx) =>
        extCtx.extension.send(ExecutorProtocol.Connect({ cwd: extCtx.cwd })).pipe(Effect.orDie),
    })
    .command("executor-stop", {
      description: "Disconnect from the Executor sidecar.",
      handler: (_args, extCtx) =>
        extCtx.extension.send(ExecutorProtocol.Disconnect()).pipe(Effect.orDie),
    })
    .layer(Layer.merge(ExecutorSidecar.Live(ctx.home), ExecutorMcpBridge.Live)),
)

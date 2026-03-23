import { Effect, Layer } from "effect"
import type { ServiceMap } from "effect"
import { RpcTest } from "effect/unstable/rpc"
import * as path from "node:path"
import { Agents } from "@gent/core/domain/agent.js"
import { AuthGuard } from "@gent/core/domain/auth-guard.js"
import { AuthStorage } from "@gent/core/domain/auth-storage.js"
import { AuthStore } from "@gent/core/domain/auth-store.js"
import { Permission } from "@gent/core/domain/permission.js"
import { Skills } from "@gent/core/domain/skills.js"
import { DebugProvider, DebugSlowProvider } from "@gent/core/debug/provider.js"
import {
  HandoffHandler,
  PermissionHandler,
  PromptHandler,
} from "@gent/core/domain/interaction-handlers.js"
import { ProviderAuth } from "@gent/core/providers/provider-auth.js"
import { AgentLoop } from "@gent/core/runtime/agent/agent-loop.js"
import { ToolRunner } from "@gent/core/runtime/agent/tool-runner.js"
import { ConfigService } from "@gent/core/runtime/config-service.js"
import { resolveExtensions, ExtensionRegistry } from "@gent/core/runtime/extensions/registry.js"
import { ModelRegistry } from "@gent/core/runtime/model-registry.js"
import { LocalActorProcessLive } from "@gent/core/runtime/actor-process.js"
import { EventStoreLive } from "@gent/core/server/event-store.js"
import { AppServicesLive } from "@gent/core/server/index.js"
import { RpcHandlersLive } from "@gent/core/server/rpc-handlers.js"
import { GentRpcs } from "@gent/core/server/rpcs.js"
import { Storage } from "@gent/core/storage/sqlite-storage.js"
import { AskUserHandler } from "@gent/core/tools/ask-user.js"
import { createClient, makeDirectGentClient, type GentClient, type GentRpcClient } from "@gent/sdk"
import { createTempDirFixture, createWorkerEnv, startWorkerWithClient } from "./seam-fixture"
export { waitFor } from "./seam-fixture"

const repoRoot = path.resolve(import.meta.dir, "..")
const makeTempDir = createTempDirFixture("gent-transport-worker-")

export interface TransportCase {
  readonly name: string
  readonly run: <A>(assertion: (client: GentClient) => Effect.Effect<A, Error>) => Promise<A>
}

type HarnessProviderMode = "debug-scripted" | "debug-slow"

const baseLocalLayer = (providerMode: HarnessProviderMode = "debug-scripted") => {
  const authStoreLive = Layer.provide(AuthStore.Live, AuthStorage.Test())
  const authGuardLive = Layer.provide(AuthGuard.Live, authStoreLive)
  const providerAuthLive = Layer.provide(ProviderAuth.Live, authStoreLive)
  const extensionRegistryLive = ExtensionRegistry.fromResolved(
    resolveExtensions([
      {
        manifest: { id: "test-agents" },
        kind: "builtin",
        sourcePath: "test",
        setup: { agents: Object.values(Agents), tools: [] },
      },
    ]),
  )

  const providerLive = providerMode === "debug-slow" ? DebugSlowProvider : DebugProvider

  const baseDeps = Layer.mergeAll(
    Storage.Memory(),
    providerLive,
    extensionRegistryLive,
    Permission.Test(),
    PermissionHandler.Test(["allow"]),
    PromptHandler.Test(["yes"]),
    HandoffHandler.Test(["confirm"]),
    AskUserHandler.Test([["yes"]]),
    Skills.Test(),
    ConfigService.Test(),
    ModelRegistry.Test(),
    ToolRunner.Test(),
    authStoreLive,
    authGuardLive,
    providerAuthLive,
  )

  const eventStoreLive = Layer.provide(EventStoreLive, baseDeps)

  const agentLoopLive = Layer.provide(
    AgentLoop.Live({ systemPrompt: "test system prompt" }),
    Layer.merge(baseDeps, eventStoreLive),
  )
  const actorProcessLive = Layer.provide(
    LocalActorProcessLive,
    Layer.mergeAll(baseDeps, eventStoreLive, agentLoopLive),
  )

  return Layer.provideMerge(
    AppServicesLive,
    Layer.mergeAll(baseDeps, eventStoreLive, agentLoopLive, actorProcessLive),
  )
}

const makeDirectCase = (providerMode: HarnessProviderMode = "debug-scripted"): TransportCase => ({
  name: "direct",
  run: (assertion) =>
    Effect.runPromise(
      Effect.scoped(
        Effect.flatMap(makeDirectGentClient, assertion).pipe(
          Effect.provide(baseLocalLayer(providerMode)),
        ),
      ),
    ),
})

const makeInProcessCase = (
  providerMode: HarnessProviderMode = "debug-scripted",
): TransportCase => ({
  name: "in-process-rpc",
  run: (assertion) =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(
            Layer.provide(RpcHandlersLive, baseLocalLayer(providerMode)),
          )
          const rpcClient = yield* RpcTest.makeClient(GentRpcs).pipe(Effect.provide(context))
          const services = yield* Effect.services<never>()
          const client = createClient(
            rpcClient as unknown as GentRpcClient,
            services as ServiceMap.ServiceMap<unknown>,
          )
          return yield* assertion(client)
        }),
      ),
    ),
})

const makeWorkerCase = (providerMode: HarnessProviderMode = "debug-scripted"): TransportCase => {
  return {
    name: "worker-http",
    run: (assertion) =>
      Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const root = makeTempDir()
            const worker = yield* startWorkerWithClient({
              cwd: repoRoot,
              startupTimeoutMs: 20_000,
              env: createWorkerEnv(root, { providerMode }),
            })
            return yield* assertion(worker.client)
          }),
        ),
      ),
  }
}

const makeTransportCases = (providerMode: HarnessProviderMode = "debug-scripted") => [
  makeDirectCase(providerMode),
  makeInProcessCase(providerMode),
  makeWorkerCase(providerMode),
]

export const transportCases = makeTransportCases()
export const slowTransportCases = makeTransportCases("debug-slow")
export const queueTransportCases = [makeWorkerCase("debug-slow")]

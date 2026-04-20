/**
 * Shared in-process test layer for integration tests.
 * Provides a complete service graph that can be used with Gent.test().
 *
 * Import from @gent/core/test-utils/in-process-layer.js
 */

import { Layer } from "effect"
import { BunServices } from "@effect/platform-bun"
import type { AgentDefinition } from "../domain/agent.js"
import { AuthGuard } from "../domain/auth-guard.js"
import { AuthStorage } from "../domain/auth-storage.js"
import { AuthStore } from "../domain/auth-store.js"
import { Permission } from "../domain/permission.js"
import { DebugProvider } from "../debug/provider.js"
import { ApprovalService } from "../runtime/approval-service.js"
import { ProviderAuth } from "../providers/provider-auth.js"
import type { Provider } from "../providers/provider.js"
import { AgentLoop } from "../runtime/agent/agent-loop.js"
import { ToolRunner } from "../runtime/agent/tool-runner.js"
import { ConfigService } from "../runtime/config-service.js"
import { MachineExecute } from "../runtime/extensions/machine-execute.js"
import { MachineEngine } from "../runtime/extensions/resource-host/machine-engine.js"
import { ExtensionTurnControl } from "../runtime/extensions/turn-control.js"
import { RuntimePlatform } from "../runtime/runtime-platform.js"
import { ModelRegistry } from "../runtime/model-registry.js"
import { ServerProfileService } from "../runtime/scope-brands.js"
import { LocalActorProcessLive } from "../runtime/actor-process.js"
import { ResourceManagerLive } from "../runtime/resource-manager.js"
import { EventStoreLive } from "../runtime/event-store-live.js"
import { EventPublisherLive } from "../server/event-publisher.js"
import { SessionCwdRegistry } from "../runtime/session-cwd-registry.js"
import { AppServicesLive } from "../server/index.js"
import { Storage } from "../storage/sqlite-storage.js"
import { testExtensionRegistryLayer } from "./reconciled-extensions.js"
import { FallbackFileIndexLive } from "../runtime/file-index/index.js"

type HarnessProviderMode = "debug-scripted" | "debug-slow"

const sharedInfra = (agents: ReadonlyArray<AgentDefinition>) => {
  const authStoreLive = Layer.provide(AuthStore.Live, AuthStorage.Test())
  const extensionRegistryLive = testExtensionRegistryLayer([
    {
      manifest: { id: "test-agents" },
      kind: "builtin",
      sourcePath: "test",
      contributions: { agents },
    },
  ])

  const authDeps = Layer.merge(authStoreLive, extensionRegistryLive)
  const authGuardLive = Layer.provide(AuthGuard.Live, authDeps)
  const providerAuthLive = Layer.provide(ProviderAuth.Live, authDeps)

  return { authStoreLive, extensionRegistryLive, authGuardLive, providerAuthLive }
}

export interface InProcessLayerConfig {
  readonly agents: ReadonlyArray<AgentDefinition>
  readonly extraLayers?: ReadonlyArray<Layer.Layer<never>>
}

const buildLayer = (providerLive: Layer.Layer<Provider>, config: InProcessLayerConfig) => {
  const { authStoreLive, extensionRegistryLive, authGuardLive, providerAuthLive } = sharedInfra(
    config.agents,
  )
  const extensionRuntimeLive = MachineEngine.Test().pipe(
    Layer.provideMerge(ExtensionTurnControl.Live),
  )
  // Mirror profile.ts / e2e-layer.ts so projections under `extraLayers`
  // resolve their `MachineExecute` dependency instead of silently defecting
  // through `ProjectionRegistry`'s failure isolation.
  const machineExecuteLive = MachineExecute.Live.pipe(Layer.provideMerge(extensionRuntimeLive))

  const baseDeps = Layer.mergeAll(
    Storage.MemoryWithSql(),
    providerLive,
    extensionRegistryLive,
    extensionRuntimeLive,
    machineExecuteLive,
    RuntimePlatform.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
    Permission.Test(),
    ConfigService.Test(),
    ModelRegistry.Test(),
    ToolRunner.Test(),
    ApprovalService.Test(),
    authStoreLive,
    authGuardLive,
    providerAuthLive,
    Layer.provide(FallbackFileIndexLive, BunServices.layer),
    ResourceManagerLive,
    // Server-scoped profile brand for `RuntimeComposer.ephemeral(...)` —
    // tests don't construct a real server composition root, so the test
    // layer fakes the brand with an empty extension set.
    ServerProfileService.Test(),
    // SessionCwdRegistry — fast (sessionId → cwd) cache used by the
    // per-cwd EventPublisher router (B11.6c). In-memory Test variant.
    SessionCwdRegistry.Test(),
    ...(config.extraLayers ?? []),
  )

  const eventStoreLive = Layer.provide(EventStoreLive, baseDeps)
  const eventPublisherLive = Layer.provide(
    EventPublisherLive,
    Layer.merge(baseDeps, eventStoreLive),
  )

  const agentLoopLive = Layer.provide(
    AgentLoop.Live({ baseSections: [{ id: "base", content: "test system prompt", priority: 0 }] }),
    Layer.mergeAll(baseDeps, eventStoreLive, eventPublisherLive),
  )
  const actorProcessLive = Layer.provide(
    LocalActorProcessLive,
    Layer.mergeAll(baseDeps, eventStoreLive, eventPublisherLive, agentLoopLive),
  )

  return Layer.provideMerge(
    AppServicesLive,
    Layer.mergeAll(baseDeps, eventStoreLive, eventPublisherLive, agentLoopLive, actorProcessLive),
  )
}

/** Build a complete in-process test layer with a standard debug provider mode. */
export const baseLocalLayer = (
  config: InProcessLayerConfig,
  providerMode: HarnessProviderMode = "debug-scripted",
) =>
  buildLayer(
    providerMode === "debug-slow" ? DebugProvider({ delayMs: 10 }) : DebugProvider(),
    config,
  )

/** Build a complete in-process test layer with a custom provider layer (e.g. createSignalProvider). */
export const baseLocalLayerWithProvider = (
  providerLayer: Layer.Layer<Provider>,
  config: InProcessLayerConfig,
) => buildLayer(providerLayer, config)

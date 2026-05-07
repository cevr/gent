/**
 * Shared in-process test layer for integration tests.
 * Provides a complete service graph that can be used with Gent.test().
 *
 * Import from @gent/core/test-utils/in-process-layer.js
 */

import { Layer } from "effect"
import { SingleRunner } from "effect/unstable/cluster"
import { BunServices } from "@effect/platform-bun"
import type { AgentDefinition } from "../domain/agent.js"
import { ExtensionId } from "../domain/ids.js"
import { Auth, AuthGuard } from "../domain/auth.js"
import { Permission } from "../domain/permission.js"
import { ApprovalService } from "../runtime/approval-service.js"
import { ProviderAuth } from "../providers/provider-auth.js"
import {
  DebugSlowProviderDelayMs,
  Provider,
  modelResolverFromProvider,
} from "../providers/provider.js"
import { ToolRunner } from "../runtime/agent/tool-runner.js"
import { ConfigService } from "../runtime/config-service.js"
import { BunGentPlatformLive } from "../runtime/gent-platform-bun.js"
import { RuntimePlatform } from "../runtime/runtime-platform.js"
import { ModelRegistry } from "../runtime/model-registry.js"
import { ServerProfileService } from "../runtime/scope-brands.js"
import { ResourceManagerLive } from "../runtime/resource-manager.js"
import { SessionRuntime } from "../runtime/session-runtime.js"
import { EventStoreLive } from "../runtime/event-store-live.js"
import { EventPublisherLive } from "../domain/event-publisher.js"
import { SessionCommands } from "../server/session-commands.js"
import { AppServicesLive } from "../server/index.js"
import { SqliteStorage } from "../storage/sqlite-storage.js"
import { ServerIdentity } from "../server/server-identity.js"
import { testExtensionRegistryLayer } from "./reconciled-extensions.js"
import { FallbackFileIndexLive } from "../runtime/file-index/index.js"

type HarnessProviderMode = "debug-scripted" | "debug-slow"

const sharedInfra = (agents: ReadonlyArray<AgentDefinition>) => {
  const authLive = Auth.Test()
  const extensionRegistryLive = testExtensionRegistryLayer([
    {
      manifest: { id: ExtensionId.make("test-agents") },
      scope: "builtin",
      sourcePath: "test",
      contributions: { agents },
    },
  ])

  const authDeps = Layer.mergeAll(authLive, extensionRegistryLive, BunGentPlatformLive)
  const authGuardLive = Layer.provide(AuthGuard.Live, authDeps)
  const providerAuthLive = Layer.provide(ProviderAuth.Live, authDeps)

  return { authLive, extensionRegistryLive, authGuardLive, providerAuthLive }
}

export interface InProcessLayerConfig {
  readonly agents: ReadonlyArray<AgentDefinition>
  readonly extraLayers?: ReadonlyArray<Layer.Layer<never>>
}

const buildLayer = (providerLive: Layer.Layer<Provider>, config: InProcessLayerConfig) => {
  const { authLive, extensionRegistryLive, authGuardLive, providerAuthLive } = sharedInfra(
    config.agents,
  )
  const memoryStorage = SqliteStorage.MemoryWithSql()
  const clusterRunnerLive = Layer.provide(
    SingleRunner.layer({ runnerStorage: "memory" }),
    memoryStorage,
  )
  const baseDeps = Layer.mergeAll(
    memoryStorage,
    clusterRunnerLive,
    providerLive,
    modelResolverFromProvider(providerLive),
    extensionRegistryLive,
    RuntimePlatform.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
    BunGentPlatformLive,
    Permission.Test(),
    ConfigService.Test(),
    ModelRegistry.Test(),
    ToolRunner.Test(),
    ApprovalService.Test(),
    authLive,
    authGuardLive,
    providerAuthLive,
    Layer.provide(FallbackFileIndexLive, BunServices.layer),
    ResourceManagerLive,
    // Server-scoped profile brand for ephemeral runtime construction —
    // tests don't construct a real server composition root, so the test
    // layer fakes the brand with an empty extension set.
    ServerProfileService.Test(),
    ...(config.extraLayers ?? []),
  )

  const eventStoreLive = Layer.provide(EventStoreLive, baseDeps)
  const eventPublisherLive = Layer.provide(
    EventPublisherLive,
    Layer.merge(baseDeps, eventStoreLive),
  )

  const sessionRuntimeLive = Layer.provide(
    SessionRuntime.LiveWithEntity({
      baseSections: [{ id: "base", content: "test system prompt", priority: 0 }],
    }),
    Layer.mergeAll(baseDeps, eventStoreLive, eventPublisherLive),
  )

  const sessionMutationsLive = Layer.provide(
    SessionCommands.SessionMutationsLive,
    Layer.mergeAll(baseDeps, eventStoreLive, eventPublisherLive, sessionRuntimeLive),
  )

  return Layer.provideMerge(
    AppServicesLive,
    Layer.mergeAll(
      baseDeps,
      eventStoreLive,
      eventPublisherLive,
      sessionRuntimeLive,
      sessionMutationsLive,
      ServerIdentity.Test(),
    ),
  )
}

/** Build a complete in-process test layer with a standard debug provider mode. */
export const baseLocalLayer = (
  config: InProcessLayerConfig,
  providerMode: HarnessProviderMode = "debug-scripted",
) =>
  buildLayer(
    providerMode === "debug-slow"
      ? Provider.Debug({ delayMs: DebugSlowProviderDelayMs })
      : Provider.Debug(),
    config,
  )

/** Build a complete in-process test layer with a custom provider layer (e.g. `Provider.Signal`). */
export const baseLocalLayerWithProvider = (
  providerLayer: Layer.Layer<Provider>,
  config: InProcessLayerConfig,
) => buildLayer(providerLayer, config)

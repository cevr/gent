/**
 * Shared in-process test layer for integration tests.
 * Provides a complete service graph that can be used with Gent.test().
 *
 * Import from @gent/core/test-utils/in-process-layer.js
 */

import { Layer } from "effect"
import { BunServices } from "@effect/platform-bun"
import type { AgentDefinition } from "../domain/agent.js"
import { ExtensionId } from "../domain/ids.js"
import { AuthStorage } from "../domain/auth-storage.js"
import { AuthStore } from "../domain/auth-store.js"
import { Permission } from "../domain/permission.js"
import { ApprovalService } from "../runtime/approval-service.js"
import { AuthGuardLive } from "../runtime/auth-guard-live.js"
import { ProviderAuth } from "../providers/provider-auth.js"
import { Provider } from "../providers/provider.js"
import { ToolRunner } from "../runtime/agent/tool-runner.js"
import { ConfigService } from "../runtime/config-service.js"
import { ExtensionRuntime } from "../runtime/extensions/resource-host/extension-runtime.js"
import { ExtensionTurnControl } from "../runtime/extensions/turn-control.js"
import { RuntimePlatform } from "../runtime/runtime-platform.js"
import { ModelRegistry } from "../runtime/model-registry.js"
import { ServerProfileService } from "../runtime/scope-brands.js"
import { ResourceManagerLive } from "../runtime/resource-manager.js"
import { SessionRuntime } from "../runtime/session-runtime.js"
import { EventStoreLive } from "../runtime/event-store-live.js"
import { EventPublisherLive } from "../server/event-publisher.js"
import { SessionCommands } from "../server/session-commands.js"
import { SessionCwdRegistry } from "../runtime/session-cwd-registry.js"
import { AppServicesLive } from "../server/index.js"
import { Storage, subTagLayers } from "../storage/sqlite-storage.js"
import { ServerIdentity } from "../server/server-identity.js"
import { testExtensionRegistryLayer } from "./reconciled-extensions.js"
import { FallbackFileIndexLive } from "../runtime/file-index/index.js"

type HarnessProviderMode = "debug-scripted" | "debug-slow"

const sharedInfra = (agents: ReadonlyArray<AgentDefinition>) => {
  const authStoreLive = Layer.provide(AuthStore.Live, AuthStorage.Test())
  const extensionRegistryLive = testExtensionRegistryLayer([
    {
      manifest: { id: ExtensionId.make("test-agents") },
      scope: "builtin",
      sourcePath: "test",
      contributions: { agents },
    },
  ])

  const authDeps = Layer.merge(authStoreLive, extensionRegistryLive)
  const authGuardLive = Layer.provide(AuthGuardLive, authDeps)
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
  const extensionRuntimeLive = ExtensionRuntime.Test().pipe(
    Layer.provideMerge(ExtensionTurnControl.Live),
  )
  const memoryStorage = Storage.MemoryWithSql()
  const baseDeps = Layer.mergeAll(
    memoryStorage,
    subTagLayers(memoryStorage),
    providerLive,
    extensionRegistryLive,
    extensionRuntimeLive,
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
    // Server-scoped profile brand for ephemeral runtime construction —
    // tests don't construct a real server composition root, so the test
    // layer fakes the brand with an empty extension set.
    ServerProfileService.Test(),
    // SessionCwdRegistry — fast (sessionId → cwd) cache used by the
    // per-cwd EventPublisher router (B11.6c). In-memory Test variant.
    SessionCwdRegistry.Test(),
    SessionCommands.SessionRuntimeTerminatorLive,
    ...(config.extraLayers ?? []),
  )

  const eventStoreLive = Layer.provide(EventStoreLive, baseDeps)
  const eventPublisherLive = Layer.provide(
    EventPublisherLive,
    Layer.merge(baseDeps, eventStoreLive),
  )
  const sessionMutationsLive = Layer.provide(
    SessionCommands.SessionMutationsLive,
    Layer.mergeAll(baseDeps, eventStoreLive, eventPublisherLive),
  )

  const sessionRuntimeLive = Layer.provide(
    SessionRuntime.Live({
      baseSections: [{ id: "base", content: "test system prompt", priority: 0 }],
    }),
    Layer.mergeAll(baseDeps, eventStoreLive, eventPublisherLive, sessionMutationsLive),
  )

  // Wire the live SessionRuntime into the terminator's empty Ref. Without
  // this, terminator.terminateSession / restoreSession silently no-op,
  // hiding the runtime-side cleanup half from any test that boots through
  // AppServicesLive.
  const registerTerminatorLive = Layer.provide(
    SessionCommands.RegisterSessionRuntimeTerminatorLive,
    Layer.mergeAll(baseDeps, sessionRuntimeLive),
  )

  return Layer.provideMerge(
    AppServicesLive,
    Layer.mergeAll(
      baseDeps,
      eventStoreLive,
      eventPublisherLive,
      sessionMutationsLive,
      sessionRuntimeLive,
      registerTerminatorLive,
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
    providerMode === "debug-slow" ? Provider.Debug({ delayMs: 10 }) : Provider.Debug(),
    config,
  )

/** Build a complete in-process test layer with a custom provider layer (e.g. `Provider.Signal`). */
export const baseLocalLayerWithProvider = (
  providerLayer: Layer.Layer<Provider>,
  config: InProcessLayerConfig,
) => buildLayer(providerLayer, config)

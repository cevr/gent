/**
 * Shared in-process test layer for integration tests.
 * Provides a complete service graph that can be used with Gent.test().
 *
 * Import from @gent/core/test-utils/in-process-layer.js
 */

import { Layer } from "effect"
import { Agents } from "../domain/agent.js"
import { AuthGuard } from "../domain/auth-guard.js"
import { AuthStorage } from "../domain/auth-storage.js"
import { AuthStore } from "../domain/auth-store.js"
import { Permission } from "../domain/permission.js"
import { Skills } from "../domain/skills.js"
import { DebugProvider } from "../debug/provider.js"
import { HandoffHandler, PromptHandler } from "../domain/interaction-handlers.js"
import { ProviderAuth } from "../providers/provider-auth.js"
import type { Provider } from "../providers/provider.js"
import { AgentLoop } from "../runtime/agent/agent-loop.js"
import { ToolRunner } from "../runtime/agent/tool-runner.js"
import { ConfigService } from "../runtime/config-service.js"
import { resolveExtensions, ExtensionRegistry } from "../runtime/extensions/registry.js"
import { ExtensionStateRuntime } from "../runtime/extensions/state-runtime.js"
import { ModelRegistry } from "../runtime/model-registry.js"
import { LocalActorProcessLive } from "../runtime/actor-process.js"
import { EventStoreLive } from "../server/event-store.js"
import { EventPublisherLive } from "../server/event-publisher.js"
import { AppServicesLive } from "../server/index.js"
import { Storage } from "../storage/sqlite-storage.js"
import { AskUserHandler } from "../tools/ask-user.js"

type HarnessProviderMode = "debug-scripted" | "debug-slow"

const sharedInfra = () => {
  const authStoreLive = Layer.provide(AuthStore.Live, AuthStorage.Test())
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

  const authDeps = Layer.merge(authStoreLive, extensionRegistryLive)
  const authGuardLive = Layer.provide(AuthGuard.Live, authDeps)
  const providerAuthLive = Layer.provide(ProviderAuth.Live, authDeps)

  return { authStoreLive, extensionRegistryLive, authGuardLive, providerAuthLive }
}

const buildLayer = (providerLive: Layer.Layer<Provider>) => {
  const { authStoreLive, extensionRegistryLive, authGuardLive, providerAuthLive } = sharedInfra()

  const baseDeps = Layer.mergeAll(
    Storage.MemoryWithSql(),
    providerLive,
    extensionRegistryLive,
    ExtensionStateRuntime.Test(),
    Permission.Test(),
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
export const baseLocalLayer = (providerMode: HarnessProviderMode = "debug-scripted") =>
  buildLayer(providerMode === "debug-slow" ? DebugProvider({ delayMs: 10 }) : DebugProvider())

/** Build a complete in-process test layer with a custom provider layer (e.g. createSignalProvider). */
export const baseLocalLayerWithProvider = (providerLayer: Layer.Layer<Provider>) =>
  buildLayer(providerLayer)

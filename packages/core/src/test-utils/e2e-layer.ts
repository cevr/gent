/**
 * E2E test layer with real extension actors, reducing event store, and tool execution.
 *
 * Unlike baseLocalLayerWithProvider (which stubs everything), this layer wires the
 * prod-shaped reducing event store, real ExtensionStateRuntime.Live, real ToolRunner.Live,
 * and real ExtensionTurnControl.Live — so QueueFollowUp actually drives multi-turn loops.
 *
 * Import from @gent/core/test-utils/e2e-layer
 */

import { Effect, Layer } from "effect"
import { tmpdir } from "node:os"
import { BunServices } from "@effect/platform-bun"
import {
  Agents,
  SubagentRunnerService,
  type AgentName,
  type SubagentRunner,
} from "../domain/agent.js"
import { AuthGuard } from "../domain/auth-guard.js"
import { AuthStorage } from "../domain/auth-storage.js"
import { AuthStore } from "../domain/auth-store.js"
import type { LoadedExtension } from "../domain/extension.js"
import type { SessionId } from "../domain/ids.js"
import { Permission } from "../domain/permission.js"
import { Skills } from "../domain/skills.js"
import { BuiltinExtensions } from "../extensions/index.js"
import { HandoffHandler, PermissionHandler, PromptHandler } from "../domain/interaction-handlers.js"
import type { Provider } from "../providers/provider.js"
import { ProviderAuth } from "../providers/provider-auth.js"
import { AgentLoop } from "../runtime/agent/agent-loop.js"
import { ToolRunner } from "../runtime/agent/tool-runner.js"
import { ConfigService } from "../runtime/config-service.js"
import { resolveExtensions, ExtensionRegistry } from "../runtime/extensions/registry.js"
import { ExtensionStateRuntime } from "../runtime/extensions/state-runtime.js"
import { ExtensionTurnControl } from "../runtime/extensions/turn-control.js"
import { ModelRegistry } from "../runtime/model-registry.js"
import { RuntimePlatform } from "../runtime/runtime-platform.js"
import { LocalActorProcessLive } from "../runtime/actor-process.js"
import { EventStoreLive } from "../server/event-store.js"
import { makeReducingEventStore } from "../server/dependencies.js"
import { AppServicesLive } from "../server/index.js"
import { Storage } from "../storage/sqlite-storage.js"
import { AskUserHandler } from "../tools/ask-user.js"
import { Test as MemoryVaultTest } from "../extensions/memory/vault.js"

/** Test-safe layer overrides for extension setup.layer fields */
const TEST_LAYER_OVERRIDES: Record<string, () => Layer.Layer<never>> = {
  "@gent/memory": () => MemoryVaultTest(`${tmpdir()}/gent-e2e-${Date.now()}`) as Layer.Layer<never>,
}

export interface E2ELayerConfig {
  /** Provider layer — typically from createSequenceProvider */
  readonly providerLayer: Layer.Layer<Provider>
  /** Extensions to wire. Default: all builtins */
  readonly extensions?: ReadonlyArray<LoadedExtension>
  /** SubagentRunner mock. Default: returns success with empty text */
  readonly subagentRunner?: SubagentRunner
  /** Extra layers to merge (e.g., additional service overrides) */
  readonly extraLayers?: ReadonlyArray<Layer.Layer<never>>
}

/**
 * Build a complete E2E test layer with real extension actors and reducing event store.
 *
 * Key differences from baseLocalLayerWithProvider:
 * - ExtensionStateRuntime.Live(extensions) — spawns real actors
 * - makeReducingEventStore — wraps EventStore so publish() feeds extension reducers
 * - ToolRunner.Live — executes tools for real
 * - ExtensionTurnControl.Live — QueueFollowUp calls agentLoop.followUp()
 */
export const createE2ELayer = (config: E2ELayerConfig) => {
  // Resolve extensions
  const builtinSetup = {
    agents: Object.values(Agents),
    tools: [] as const,
  }

  // Load all builtins, patching setup.layer for extensions that need test overrides
  const defaultExtensions: ReadonlyArray<LoadedExtension> = BuiltinExtensions.map((ext) => {
    const setup = Effect.runSync(ext.setup({ cwd: "/tmp", source: "test" }))
    const override = TEST_LAYER_OVERRIDES[ext.manifest.id]
    return {
      manifest: ext.manifest,
      kind: "builtin" as const,
      sourcePath: "builtin",
      setup: override ? { ...setup, layer: override() } : setup,
    }
  })

  const resolvedExtensions: LoadedExtension[] = config.extensions
    ? [
        {
          manifest: { id: "test-agents" },
          kind: "builtin",
          sourcePath: "test",
          setup: builtinSetup,
        },
        ...config.extensions,
      ]
    : [...defaultExtensions]

  const resolved = resolveExtensions(resolvedExtensions)

  // Collect extension-provided layers (mirrors makeExtensionLayers in dependencies.ts)
  const extensionLayers = resolvedExtensions
    .filter((ext) => ext.setup.layer !== undefined)
    .map((ext) => ext.setup.layer as Layer.Layer<never>)

  // Subagent runner
  const defaultRunner: SubagentRunner = {
    run: () =>
      Effect.succeed({
        _tag: "success" as const,
        text: "",
        sessionId: "test-subagent-session" as SessionId,
        agentName: "cowork" as AgentName,
      }),
  }
  const subagentRunnerLayer = Layer.succeed(
    SubagentRunnerService,
    config.subagentRunner ?? defaultRunner,
  )

  // Auth
  const authStoreLive = Layer.provide(AuthStore.Live, AuthStorage.Test())
  const extensionRegistryLive = ExtensionRegistry.fromResolved(resolved)
  const authDeps = Layer.merge(authStoreLive, extensionRegistryLive)
  const authGuardLive = Layer.provide(AuthGuard.Live, authDeps)
  const providerAuthLive = Layer.provide(ProviderAuth.Live, authDeps)

  // Base services — everything that doesn't depend on reducing event store
  const baseDeps = Layer.mergeAll(
    BunServices.layer,
    Storage.Memory(),
    config.providerLayer,
    extensionRegistryLive,
    ExtensionStateRuntime.Live(resolvedExtensions),
    Permission.Test(),
    PermissionHandler.Test(["allow"]),
    PromptHandler.Test(["yes"]),
    HandoffHandler.Test(["confirm"]),
    AskUserHandler.Test([["yes"]]),
    Skills.Test(),
    ConfigService.Test(),
    ModelRegistry.Test(),
    RuntimePlatform.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
    subagentRunnerLayer,
    authStoreLive,
    authGuardLive,
    providerAuthLive,
    // Extension-provided layers (e.g., MemoryVault) + caller extra layers
    ...extensionLayers,
    ...(config.extraLayers ?? []),
  )

  // Base event store (raw storage, provides BaseEventStore tag)
  const baseEventStoreLive = Layer.provide(EventStoreLive, baseDeps)

  // Reducing event store: wraps BaseEventStore with extension state reduction
  // This replaces the EventStore tag with a wrapper that feeds events to ExtensionStateRuntime.reduce
  const reducingEventStoreLive = Layer.provide(
    makeReducingEventStore,
    Layer.merge(baseDeps, baseEventStoreLive),
  )

  // Tool runner — real execution
  const toolRunnerLive = Layer.provide(ToolRunner.Live, baseDeps)

  // Agent loop — real turn lifecycle
  const agentLoopDeps = Layer.mergeAll(baseDeps, reducingEventStoreLive, toolRunnerLive)
  const agentLoopLive = Layer.provide(
    AgentLoop.Live({
      baseSections: [{ id: "base", content: "e2e test system prompt", priority: 0 }],
    }),
    agentLoopDeps,
  )

  // Turn control — real follow-up queuing (backed by real AgentLoop)
  const turnControlLive = Layer.provide(ExtensionTurnControl.Live, agentLoopLive)

  // Actor process
  const actorProcessLive = Layer.provide(
    LocalActorProcessLive,
    Layer.mergeAll(agentLoopDeps, agentLoopLive),
  )

  return Layer.provideMerge(
    AppServicesLive,
    Layer.mergeAll(
      baseDeps,
      reducingEventStoreLive,
      toolRunnerLive,
      agentLoopLive,
      turnControlLive,
      actorProcessLive,
    ),
  )
}

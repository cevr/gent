/** Test helpers for extension tool execution. */

import { Effect, Layer } from "effect"
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import {
  AgentName,
  AgentRunnerService,
  AgentRunResult,
  type AgentDefinition,
  type AgentRunner,
} from "../domain/agent.js"
import { EventStore } from "../domain/event.js"
import type { GentExtension, LoadedExtension } from "../domain/extension.js"
import type { GentPlatform } from "../runtime/gent-platform.js"
import { type ExtensionContributions } from "../domain/contribution.js"
import type { ToolCapabilityContext, ToolCapability } from "../domain/capability/tool.js"
import { BranchId, ExtensionId, SessionId, ToolCallId } from "../domain/ids.js"
import { Permission } from "../domain/permission.js"
import { PromptPresenter } from "../domain/prompt-presenter.js"
import { AgentLoopTestActor } from "../runtime/agent/agent-loop.actor.js"
import { AgentLoopBehaviorDeps } from "../runtime/agent/agent-loop.behavior-deps.js"
import { AgentLoopSessionGovernance } from "../runtime/agent/agent-loop.session-governance.js"
import { ToolRunner } from "../runtime/agent/tool-runner.js"
import { ConfigService } from "../runtime/config-service.js"
import {
  reconcileLoadedExtensions,
  setupBuiltinExtensions,
} from "../runtime/extensions/activation.js"
import { DriverRegistry } from "../runtime/extensions/driver-registry.js"
import { ExtensionRegistry } from "../runtime/extensions/registry.js"
import { BunGentPlatformLive, BunPlatformLive } from "../runtime/gent-platform-bun.js"
import { ModelRegistry } from "../runtime/model-registry.js"
import { ResourceManagerLive } from "../runtime/resource-manager.js"
import { RuntimeEnvironment } from "../runtime/runtime-environment.js"
import { EventPublisherLive } from "../domain/event-publisher.js"
import { ModelResolver } from "../providers/model-resolver.js"
import { LanguageModelLayers } from "./language-model.js"
import { SqliteStorage } from "../storage/sqlite-storage.js"

export interface ToolTestLayerConfig {
  /** Agents to register */
  readonly agents: ReadonlyArray<AgentDefinition>
  /** Extensions to load */
  readonly extensions?: ReadonlyArray<GentExtension<ChildProcessSpawner | GentPlatform>>
  /** Extra tools to register (authored via `tool({...})`). */
  readonly tools?: ReadonlyArray<ToolCapability>
  /** AgentRunner mock — default returns success with empty text */
  readonly subagentRunner?: AgentRunner
  /** Extra layers to merge (e.g., GitReader.Test) */
  readonly extraLayers?: ReadonlyArray<Layer.Layer<never>>
}

/**
 * Create a test layer for extension tool execution.
 *
 * Provides core services needed by most tools. Tools that need platform
 * services (FileSystem, Path) should compose with BunServices.layer.
 */
export const createToolTestLayer = (config: ToolTestLayerConfig) => {
  const builtinContributions: ExtensionContributions = {
    agents: config.agents,
    ...((config.tools ?? []).length > 0 ? { tools: config.tools } : {}),
  }

  const defaultRunner: AgentRunner = {
    run: () =>
      Effect.succeed(
        AgentRunResult.Success.make({
          text: "",
          sessionId: SessionId.make("test-subagent-session"),
          agentName: AgentName.make("cowork"),
        }),
      ),
  }
  const subagentRunnerLayer = Layer.succeed(
    AgentRunnerService,
    config.subagentRunner ?? defaultRunner,
  )

  return Layer.unwrap(
    Effect.gen(function* () {
      const setupResult = yield* setupBuiltinExtensions({
        extensions: config.extensions ?? [],
        cwd: "/tmp",
        home: "/tmp",
        disabled: new Set(),
      })

      const allExtensions: LoadedExtension[] = [
        {
          manifest: { id: ExtensionId.make("test-agents") },
          scope: "builtin" as const,
          sourcePath: "test",
          contributions: builtinContributions,
        },
        ...setupResult.active,
      ]

      const reconciled = yield* reconcileLoadedExtensions({
        extensions: allExtensions,
        failedExtensions: setupResult.failed,
        home: "/tmp",
        command: undefined,
      })

      const activeExtensions = reconciled.resolved.extensions
      const storageLayer = Layer.orDie(SqliteStorage.TestWithSql())
      const extensionRegistryLayer = ExtensionRegistry.fromResolved(reconciled.resolved)
      const driverRegistryLayer = DriverRegistry.fromResolved(reconciled.resolved)
      const languageModelLayer = LanguageModelLayers.debug()
      const baseDepsLayer = Layer.mergeAll(
        storageLayer,
        EventStore.Memory,
        extensionRegistryLayer,
        driverRegistryLayer,
        subagentRunnerLayer,
        PromptPresenter.Test(),
        Permission.Test(),
        RuntimeEnvironment.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
        languageModelLayer,
        ModelResolver.fromLanguageModel(languageModelLayer),
        ToolRunner.Test(),
        ResourceManagerLive,
        ConfigService.Test(),
        ModelRegistry.Test(),
        // Required for resource layers below: `Layer.provideMerge(r.layer,
        // baseLayerAny)` (line 123) feeds extension Resource layers from
        // `baseLayerAny`, and many of them yield `GentPlatform`. Outer
        // `Layer.provide(BunPlatformLive)` only reaches outer requirements,
        // not the requirements satisfied INSIDE `provideMerge`.
        BunGentPlatformLive,
        ...(config.extraLayers ?? []),
      )
      const eventPublisherLayer = Layer.provide(EventPublisherLive, baseDepsLayer)
      const baseWithRuntimeLayer = Layer.mergeAll(
        baseDepsLayer,
        eventPublisherLayer,
        AgentLoopSessionGovernance.Live,
      )
      const agentLoopLayer = AgentLoopTestActor.pipe(
        Layer.provide(AgentLoopBehaviorDeps.Live({ baseSections: [] })),
        Layer.provideMerge(baseWithRuntimeLayer),
      )
      const baseLayer = Layer.merge(baseWithRuntimeLayer, agentLoopLayer)
      const baseLayerAny: Layer.Layer<never, never, object> = baseLayer

      const contributedLayers: Array<Layer.Layer<never, never, object>> = activeExtensions.flatMap(
        (ext) =>
          (ext.contributions.resources ?? [])
            .filter((r) => r.scope === "process")
            .map((r) => {
              // Resource layers carry their own R/E; harness boundary.
              // @effect-diagnostics-next-line anyUnknownInErrorContext:off
              const merged = Layer.provideMerge(r.layer as Layer.Layer<any>, baseLayerAny) // eslint-disable-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-type-assertion -- test fixture owns intentionally partial typed values
              // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test fixture owns intentionally partial typed values
              return merged as Layer.Layer<never, never, object>
            }),
      )

      let extensionLayer: Layer.Layer<never, never, object> | undefined
      for (const layer of contributedLayers) {
        extensionLayer = extensionLayer === undefined ? layer : Layer.merge(extensionLayer, layer)
      }

      return extensionLayer === undefined ? baseLayerAny : Layer.merge(baseLayerAny, extensionLayer)
    }),
  ).pipe(Layer.provide(BunPlatformLive))
}

const dieStub = (label: string) => () => Effect.die(`${label} not wired in test`)

/** Default ToolCapabilityContext for tests — overridable via spread */
export const testToolContext = (
  overrides?: Partial<ToolCapabilityContext>,
): ToolCapabilityContext => ({
  sessionId: SessionId.make("test-session"),
  branchId: BranchId.make("test-branch"),
  toolCallId: ToolCallId.make("test-call"),
  cwd: "/tmp",
  home: "/tmp",
  agent: {
    get: dieStub("agent.get"),
    require: dieStub("agent.require"),
    run: dieStub("agent.run"),
    resolveDualModelPair: dieStub("agent.resolveDualModelPair"),
  },
  session: {
    listMessages: dieStub("session.listMessages"),
    getSession: dieStub("session.getSession"),
    getDetail: dieStub("session.getDetail"),
    renameCurrent: dieStub("session.renameCurrent"),
    estimateContextPercent: dieStub("session.estimateContextPercent"),
    search: dieStub("session.search"),
    queueFollowUp: dieStub("session.queueFollowUp"),
    listBranches: dieStub("session.listBranches"),
    createBranch: dieStub("session.createBranch"),
    forkBranch: dieStub("session.forkBranch"),
    switchBranch: dieStub("session.switchBranch"),
    createChildSession: dieStub("session.createChildSession"),
    getChildSessions: dieStub("session.getChildSessions"),
    getSessionAncestors: dieStub("session.getSessionAncestors"),
    deleteSession: dieStub("session.deleteSession"),
    deleteBranch: dieStub("session.deleteBranch"),
    deleteMessages: dieStub("session.deleteMessages"),
  },
  interaction: {
    approve: dieStub("interaction.approve"),
    present: dieStub("interaction.present"),
    confirm: dieStub("interaction.confirm"),
    review: dieStub("interaction.review"),
  },
  ...overrides,
})

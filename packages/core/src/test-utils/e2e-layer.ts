/**
 * E2E test layer with real extension actors, queued event publishing, and tool execution.
 *
 * Unlike baseLocalLayerWithProvider (which stubs everything), this layer wires the
 * prod-shaped event publisher, real MachineEngine.Live, real ToolRunner.Live,
 * and real ExtensionTurnControl.Live — so QueueFollowUp actually drives multi-turn loops.
 *
 * Import from @gent/core/test-utils/e2e-layer
 */

import { Effect, Layer, Ref } from "effect"
import { BunServices } from "@effect/platform-bun"
import {
  DEFAULT_MODEL_ID,
  AgentRunnerService,
  type AgentDefinition,
  type AgentName,
  type AgentRunner,
} from "../domain/agent.js"
import { AuthGuard } from "../domain/auth-guard.js"
import { AuthStorage } from "../domain/auth-storage.js"
import { AuthStore } from "../domain/auth-store.js"
import type { GentExtension, LoadedExtension } from "../domain/extension.js"
import { type ExtensionContributions, defineResource } from "../domain/contribution.js"
import { SessionId } from "../domain/ids.js"
import { Permission } from "../domain/permission.js"
import { ApprovalService } from "../runtime/approval-service.js"
import { MODEL_CONTEXT_WINDOWS } from "../runtime/context-estimation.js"
import type { Provider } from "../providers/provider.js"
import { ProviderAuth } from "../providers/provider-auth.js"
import { ToolRunner } from "../runtime/agent/tool-runner.js"
import { ConfigService } from "../runtime/config-service.js"
import { ExtensionRegistry } from "../runtime/extensions/registry.js"
import { DriverRegistry } from "../runtime/extensions/driver-registry.js"
import { MachineExecute } from "../runtime/extensions/machine-execute.js"
import { MachineEngine } from "../runtime/extensions/resource-host/machine-engine.js"
import { ExtensionTurnControl } from "../runtime/extensions/turn-control.js"
import { ModelRegistry } from "../runtime/model-registry.js"
import { RuntimePlatform } from "../runtime/runtime-platform.js"
import { ResourceManagerLive } from "../runtime/resource-manager.js"
import { SessionRuntime } from "../runtime/session-runtime.js"
import { EventStoreLive } from "../runtime/event-store-live.js"
import { EventPublisherLive } from "../server/event-publisher.js"
import { SessionCwdRegistry } from "../runtime/session-cwd-registry.js"
import { AppServicesLive } from "../server/index.js"
import { Storage, subTagLayers } from "../storage/sqlite-storage.js"
import {
  reconcileLoadedExtensions,
  setupBuiltinExtensions,
} from "../runtime/extensions/activation.js"
import { FallbackFileIndexLive } from "../runtime/file-index/index.js"

export interface E2ELayerConfig {
  /** Provider layer — typically from createSequenceProvider */
  readonly providerLayer: Layer.Layer<Provider>
  /** Agents to register in the extension registry */
  readonly agents: ReadonlyArray<AgentDefinition>
  /** Extension inputs for setup */
  readonly extensionInputs: ReadonlyArray<GentExtension>
  /** Pre-loaded extensions to wire directly (bypasses setup). Mutually exclusive with extensionInputs. */
  readonly extensions?: ReadonlyArray<LoadedExtension>
  /** AgentRunner mock. Default: returns success with empty text */
  readonly subagentRunner?: AgentRunner
  /** Extra layers to merge (e.g., additional service overrides) */
  readonly extraLayers?: ReadonlyArray<Layer.Layer<never>>
  /** Per-extension layer overrides (e.g., memory vault test layer) */
  readonly layerOverrides?: Record<string, () => Layer.Layer<never>>
}

/**
 * Build a complete E2E test layer with real extension actors and queued event publishing.
 *
 * Key differences from baseLocalLayerWithProvider:
 * - MachineEngine.Live(extensions) — spawns real actors
 * - EventPublisherLive — appends events, then delivers them through the queued extension runtime
 * - ToolRunner.Live — executes tools for real
 * - ExtensionTurnControl.Live — QueueFollowUp enqueues directly into the live loop
 */
export const createE2ELayer = (config: E2ELayerConfig) => {
  // Resolve extensions — the test-agents pseudo-extension carries the test
  // agents in its `agents` bucket.
  const builtinContributions: ExtensionContributions = { agents: config.agents }

  return Layer.unwrap(
    Effect.gen(function* () {
      const setupResult = config.extensions
        ? { active: config.extensions, failed: [] as const }
        : yield* setupBuiltinExtensions({
            extensions: config.extensionInputs,
            cwd: "/tmp",
            home: "/tmp",
            disabled: new Set(),
          })

      const loadedExtensions: ReadonlyArray<LoadedExtension> = config.extensions
        ? [
            {
              manifest: { id: "test-agents" },
              scope: "builtin" as const,
              sourcePath: "test",
              contributions: builtinContributions,
            },
            ...setupResult.active,
          ]
        : setupResult.active.map((ext) => {
            const override = config.layerOverrides?.[ext.manifest.id]
            if (override === undefined) return ext
            // E2E test override: REPLACE the entire process-Resource layer
            // set for this extension with one merged override layer.
            //
            // Today every migrated extension has exactly one process Resource,
            // so this is a 1:1 swap. If an extension grows multiple process
            // Resources, this helper silently drops the originals — fail
            // loudly so the test gets updated to provide a complete merged
            // override (or `layerOverrides` grows a per-resource API).
            const existingProcessResources = (ext.contributions.resources ?? []).filter(
              (r) => r.scope === "process",
            )
            if (existingProcessResources.length > 1) {
              throw new Error(
                `e2e-layer.layerOverrides: extension "${ext.manifest.id}" has ${existingProcessResources.length} process-scope Resources; the override path replaces all of them with one merged layer. Provide a complete merged layer in the override factory, or extend layerOverrides to address Resources individually.`,
              )
            }
            // Test override layers are heterogeneous; the harness erases R/E
            // at this boundary the same way the legacy `layerContribution`
            // did. Production paths flow through `collectProcessLayers`.
            // @effect-diagnostics-next-line anyUnknownInErrorContext:off
            // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-type-assertion
            const overrideLayer = override() as unknown as Layer.Layer<unknown, unknown, never>
            const layerOverride = defineResource({
              scope: "process",
              // @effect-diagnostics-next-line anyUnknownInErrorContext:off
              layer: overrideLayer,
            })
            const otherResources = (ext.contributions.resources ?? []).filter(
              (r) => r.scope !== "process",
            )
            return {
              ...ext,
              contributions: {
                ...ext.contributions,
                resources: [...otherResources, layerOverride],
              },
            }
          })

      const reconciled = yield* reconcileLoadedExtensions({
        extensions: loadedExtensions,
        failedExtensions: setupResult.failed,
        home: "/tmp",
        command: undefined,
      })
      const resolved = reconciled.resolved

      // Collect extension-provided layers (mirrors makeExtensionLayers in dependencies.ts).
      // Extension layers may require SqlClient, so provide it via storageLayer.
      const storageLayer = Storage.MemoryWithSql()
      const extensionLayers: Layer.Layer<never>[] = resolved.extensions.flatMap((ext) =>
        (ext.contributions.resources ?? [])
          .filter((r) => r.scope === "process")
          .map((r) => {
            // @effect-diagnostics-next-line anyUnknownInErrorContext:off — Resource layers carry their own R/E; consumers responsible for satisfying.
            // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-type-assertion
            const provided = Layer.provide(r.layer as Layer.Layer<any>, storageLayer)
            // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
            return provided as unknown as Layer.Layer<never>
          }),
      )

      // Subagent runner
      const defaultRunner: AgentRunner = {
        run: () =>
          Effect.succeed({
            _tag: "success" as const,
            text: "",
            sessionId: SessionId.of("test-subagent-session"),
            agentName: "cowork" as AgentName,
          }),
      }
      const subagentRunnerLayer = Layer.succeed(
        AgentRunnerService,
        config.subagentRunner ?? defaultRunner,
      )

      // Auth
      const authStoreLive = Layer.provide(AuthStore.Live, AuthStorage.Test())
      const extensionRegistryLive = ExtensionRegistry.fromResolved(resolved)
      const driverRegistryLive = DriverRegistry.fromResolved({
        modelDrivers: resolved.modelDrivers,
        externalDrivers: resolved.externalDrivers,
      })
      const authDeps = Layer.mergeAll(authStoreLive, extensionRegistryLive, driverRegistryLive)
      const authGuardLive = Layer.provide(AuthGuard.Live, authDeps)
      const providerAuthLive = Layer.provide(ProviderAuth.Live, authDeps)
      const extensionRuntimeLive = MachineEngine.Live(resolved.extensions).pipe(
        Layer.provideMerge(ExtensionTurnControl.Live),
      )
      // Read-only call surface for projections — must mirror profile.ts so
      // that projections like `AutoProjection`/`ExecutorProjection` (which
      // require `MachineExecute`) don't silently defect under
      // `ProjectionRegistry`'s failure isolation.
      const machineExecuteLive = MachineExecute.Live.pipe(Layer.provideMerge(extensionRuntimeLive))

      // Base services — everything that doesn't depend on reducing event store
      const baseDeps = Layer.mergeAll(
        BunServices.layer,
        storageLayer,
        subTagLayers(storageLayer),
        config.providerLayer,
        extensionRegistryLive,
        driverRegistryLive,
        extensionRuntimeLive,
        machineExecuteLive,
        Permission.Test(),
        ApprovalService.Test(),
        ConfigService.Test(),
        ModelRegistry.Test(),
        RuntimePlatform.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
        subagentRunnerLayer,
        authStoreLive,
        authGuardLive,
        providerAuthLive,
        Layer.provide(FallbackFileIndexLive, BunServices.layer),
        ResourceManagerLive,
        // SessionCwdRegistry — fast (sessionId → cwd) cache used by the
        // per-cwd EventPublisher router (B11.6c). Tests use the in-memory
        // Test variant — there is no SessionProfileCache wired here, so
        // the eventual router will fall back to its primary-cwd path.
        SessionCwdRegistry.Test(),
        ...extensionLayers,
        ...(config.extraLayers ?? []),
      )

      const baseEventStoreLive = Layer.provide(EventStoreLive, baseDeps)
      const eventPublisherLive = Layer.provide(
        EventPublisherLive,
        Layer.merge(baseDeps, baseEventStoreLive),
      )
      const toolRunnerLive = Layer.provide(ToolRunner.Live, baseDeps)
      const sessionRuntimeLive = Layer.provide(
        SessionRuntime.Live({
          baseSections: [{ id: "base", content: "e2e test system prompt", priority: 0 }],
        }),
        Layer.mergeAll(baseDeps, baseEventStoreLive, eventPublisherLive, toolRunnerLive),
      )

      return Layer.provideMerge(
        AppServicesLive,
        Layer.mergeAll(
          baseDeps,
          baseEventStoreLive,
          eventPublisherLive,
          toolRunnerLive,
          sessionRuntimeLive,
        ),
      )
    }),
  ).pipe(Layer.provide(BunServices.layer))
}

// ── Test helpers ──

/**
 * Temporarily shrink the context window for the default model so that
 * even small messages exceed the handoff threshold (85%).
 *
 * With 5000-token window and 4000-token system overhead, any message
 * content pushes context past 85%. Restores the original value via
 * Effect.ensuring, safe against test failures.
 *
 * Usage:
 * ```ts
 * yield* withTinyContextWindow(Effect.gen(function* () { ... }))
 * ```
 */
export const withTinyContextWindow = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> => {
  const originalWindow = MODEL_CONTEXT_WINDOWS[DEFAULT_MODEL_ID]
  return Effect.suspend(() => {
    MODEL_CONTEXT_WINDOWS[DEFAULT_MODEL_ID] = 5_000
    return effect
  }).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        if (originalWindow !== undefined) {
          MODEL_CONTEXT_WINDOWS[DEFAULT_MODEL_ID] = originalWindow
        } else {
          delete MODEL_CONTEXT_WINDOWS[DEFAULT_MODEL_ID]
        }
      }),
    ),
  )
}

/**
 * ApprovalService that tracks whether present() was called.
 *
 * Returns a Layer + a Ref<boolean> that flips to true if present() fires.
 * Always resolves with approved=true so tests don't hang.
 *
 * Usage:
 * ```ts
 * const { layer, presentCalled } = yield* trackingApprovalService()
 * // ... provide layer ...
 * expect(yield* Ref.get(presentCalled)).toBe(false)
 * ```
 */
export const trackingApprovalService = () =>
  Effect.gen(function* () {
    const presentCalled = yield* Ref.make(false)
    const layer = Layer.succeed(ApprovalService, {
      present: () => Ref.set(presentCalled, true).pipe(Effect.as({ approved: true })),
      storeResolution: () => {},
      respond: () => Effect.void,
      rehydrate: () => Effect.void,
    })
    return { layer, presentCalled }
  })

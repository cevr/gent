/**
 * E2E test layer with queued event publishing and tool execution.
 *
 * Unlike baseLocalLayerWithProvider (which stubs everything), this layer wires the
 * prod-shaped event publisher, real ToolRunner.Live, and direct session-loop
 * follow-ups — so QueueFollowUp actually drives multi-turn loops.
 *
 * Import from @gent/core-internal/test-utils/e2e-layer
 */

import { Effect, Layer, Ref } from "effect"
import { SingleRunner } from "effect/unstable/cluster"
import type { LanguageModel } from "effect/unstable/ai"
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { BunServices } from "@effect/platform-bun"
import { BunGentPlatformLive, BunPlatformLive } from "../runtime/gent-platform-bun.js"
import {
  AgentName,
  AgentRunnerService,
  AgentRunResult,
  DEFAULT_MODEL_ID,
  type AgentDefinition,
  type AgentRunner,
} from "../domain/agent.js"
import { Auth, AuthGuard } from "../domain/auth.js"
import type { GentExtension, LoadedExtension } from "../domain/extension.js"
import { type ExtensionContributions, defineResource } from "../domain/contribution.js"
import { EventPublisherLive, type EventPublisher } from "../domain/event-publisher.js"
import { EventStoreError } from "../domain/event.js"
import { ExtensionId, type InteractionRequestId, SessionId } from "../domain/ids.js"
import { Permission } from "../domain/permission.js"
import { ApprovalService } from "../runtime/approval-service.js"
import {
  decodeInteractionDecision,
  decodeInteractionParams,
} from "../domain/interaction-request.js"
import { MODEL_CONTEXT_WINDOWS } from "../runtime/context-estimation.js"
import { ModelResolver } from "../providers/model-resolver.js"
import { ProviderAuth } from "../providers/provider-auth.js"
import { ToolRunner } from "../runtime/agent/tool-runner.js"
import { ConfigService } from "../runtime/config-service.js"
import { ExtensionRegistry } from "../runtime/extensions/registry.js"
import { DriverRegistry } from "../runtime/extensions/driver-registry.js"
import { buildResourceLayer } from "../runtime/extensions/resource-host/resource-layer.js"
import { ModelRegistry } from "../runtime/model-registry.js"
import type { GentPlatform } from "../runtime/gent-platform.js"
import { RuntimeEnvironment } from "../runtime/runtime-environment.js"
import type { SessionProfileCache } from "../runtime/session-profile.js"
import { ResourceManagerLive } from "../runtime/resource-manager.js"
import { SessionRuntime } from "../runtime/session-runtime.js"
import { EventStoreLive } from "../runtime/event-store-live.js"
import { SessionCommands } from "../server/session-commands.js"
import { AppServicesLive } from "../server/index.js"
import { SqliteStorage } from "../storage/sqlite-storage.js"
import { InteractionStorage } from "../storage/interaction-storage.js"
import { ServerIdentity } from "../server/server-identity.js"
import {
  reconcileLoadedExtensions,
  setupBuiltinExtensions,
} from "../runtime/extensions/activation.js"
import { FallbackFileIndexLive } from "../runtime/file-index/index.js"

export interface E2ELayerConfig {
  /** Language model layer — typically from `LanguageModelLayers.sequence` */
  readonly providerLayer: Layer.Layer<LanguageModel.LanguageModel>
  /** Agents to register in the extension registry */
  readonly agents: ReadonlyArray<AgentDefinition>
  /** Extension inputs for setup */
  readonly extensionInputs: ReadonlyArray<GentExtension<ChildProcessSpawner | GentPlatform>>
  /** Pre-loaded extensions to wire directly (bypasses setup). Mutually exclusive with extensionInputs. */
  readonly extensions?: ReadonlyArray<LoadedExtension>
  /** AgentRunner mock. Default: returns success with empty text */
  readonly subagentRunner?: AgentRunner
  /** Approval service override. Default auto-approves for E2E tests. */
  readonly approvalLayer?: Layer.Layer<ApprovalService, never, EventPublisher | GentPlatform>
  /** Use the production cold-interaction service with durable pending rows. */
  readonly durableApproval?: boolean
  /** File-backed SQLite path for restart/recovery tests. Defaults to in-memory SQLite. */
  readonly storagePath?: string
  /** Optional per-cwd profile cache for shared-server routing tests. */
  readonly sessionProfileCacheLayer?: Layer.Layer<SessionProfileCache>
  /** Extra layers to merge (e.g., additional service overrides) */
  readonly extraLayers?: ReadonlyArray<Layer.Layer<never>>
  /** Auth override. Use for public RPC auth failure-path tests. */
  readonly authLayer?: Layer.Layer<Auth>
  /**
   * ConfigService override. Default is `ConfigService.Test()`.
   * Provide `ConfigService.Live` (or a custom layer) to exercise per-cwd
   * config resolution — e.g., for driver-override-from-session-cwd tests.
   */
  readonly configServiceLayer?: Layer.Layer<ConfigService>
  /** Per-extension layer overrides (e.g., memory vault test layer) */
  readonly layerOverrides?: Record<string, () => Layer.Layer<never>>
}

/**
 * Build a complete E2E test layer with queued event publishing.
 *
 * Key differences from baseLocalLayerWithProvider:
 * - EventPublisherLive — appends and broadcasts committed events
 * - ToolRunner.Live — executes tools for real
 * - session-loop follow-ups — QueueFollowUp enqueues directly into the live loop
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
              manifest: { id: ExtensionId.make("test-agents") },
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
            // This is a 1:1 process-Resource swap. If an extension grows
            // multiple process Resources, this helper silently drops the
            // originals — fail loudly so the test gets updated to provide a
            // complete merged override (or `layerOverrides` grows a
            // per-resource API).
            const existingProcessResources = (ext.contributions.resources ?? []).filter(
              (r) => r.scope === "process",
            )
            if (existingProcessResources.length > 1) {
              throw new Error(
                `e2e-layer.layerOverrides: extension "${ext.manifest.id}" has ${existingProcessResources.length} process-scope Resources; the override path replaces all of them with one merged layer. Provide a complete merged layer in the override factory, or extend layerOverrides to address Resources individually.`,
              )
            }
            // Test override layers are heterogeneous; the harness erases R/E
            // at this boundary. Production paths flow through
            // `collectProcessLayers`.
            const rawOverrideLayer = override()
            type TestOverrideLayer = Layer.Layer<unknown, unknown, never>
            // @effect-diagnostics-next-line anyUnknownInErrorContext:off
            const overrideLayer = rawOverrideLayer as unknown as TestOverrideLayer // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion -- test fixture owns intentionally partial typed values
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

      // Build the process-scope Resource layer the same way prod does
      // (`buildResourceLayer` in profile.ts) so `Resource.start` fires.
      //
      // Extension layers may require SqlClient — provide it below via
      // `provideMerge(resourceLayer, baseDeps)`.
      const storageLayer =
        config.storagePath === undefined
          ? SqliteStorage.MemoryWithSql()
          : Layer.provide(SqliteStorage.LiveWithSql(config.storagePath), BunServices.layer)
      const clusterRunnerLive = Layer.provide(
        SingleRunner.layer({ runnerStorage: "memory" }),
        storageLayer,
      )
      // `buildResourceLayer` returns `ErasedResourceLayer = Layer.Layer<any>` — the
      // membrane that `resource-layer.ts` uses to merge heterogeneous extension
      // Resource layers. No additional cast needed here.
      const extensionResourceLayer = buildResourceLayer(resolved.extensions, "process")

      // Subagent runner
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

      // Auth
      const authLive = config.authLayer ?? Auth.Test()
      const extensionRegistryLive = ExtensionRegistry.fromResolved(resolved)
      const driverRegistryLive = DriverRegistry.fromResolved({
        modelDrivers: resolved.modelDrivers,
        externalDrivers: resolved.externalDrivers,
      })
      const authDeps = Layer.mergeAll(
        authLive,
        extensionRegistryLive,
        driverRegistryLive,
        BunGentPlatformLive,
      )
      const authGuardLive = Layer.provide(AuthGuard.Live, authDeps)
      const providerAuthLive = Layer.provide(ProviderAuth.Live, authDeps)
      // Base services — everything that doesn't depend on reducing event store
      const baseDepsCore = Layer.mergeAll(
        BunServices.layer,
        storageLayer,
        clusterRunnerLive,
        config.providerLayer,
        ModelResolver.fromLanguageModel(config.providerLayer),
        extensionRegistryLive,
        driverRegistryLive,
        Permission.Test(),
        config.configServiceLayer ?? ConfigService.Test(),
        ModelRegistry.Test(),
        RuntimeEnvironment.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
        // Required for resource layers below: extension Resource layers
        // are fed via `Layer.provideMerge(extensionResourceLayer,
        // baseDepsCore)` (further down). Many of those layers yield
        // `GentPlatform`. Outer `Layer.provide(BunPlatformLive)` only
        // reaches outer requirements, not the requirements satisfied
        // INSIDE `provideMerge`.
        BunGentPlatformLive,
        subagentRunnerLayer,
        authLive,
        authGuardLive,
        providerAuthLive,
        Layer.provide(FallbackFileIndexLive, BunServices.layer),
        ResourceManagerLive,
        ...(config.sessionProfileCacheLayer !== undefined ? [config.sessionProfileCacheLayer] : []),
        ...(config.extraLayers ?? []),
      )

      // Mirror `buildExtensionLayers` in profile.ts: feed `baseDepsCore` into
      // the Resource layer via `provideMerge` so `Resource.start` hooks see the
      // full service set, while keeping `baseDepsCore`'s outputs in the merged
      // result.
      const baseDeps = Layer.provideMerge(extensionResourceLayer, baseDepsCore)

      const baseEventStoreLive = Layer.provide(EventStoreLive, baseDeps)
      const eventPublisherLive = Layer.provide(
        EventPublisherLive,
        Layer.merge(baseDeps, baseEventStoreLive),
      )
      const durableApprovalLayer = Layer.provide(
        Layer.unwrap(
          Effect.gen(function* () {
            const store = yield* InteractionStorage
            return ApprovalService.LiveWithStorage({
              persist: (record) =>
                store.persist(record).pipe(
                  Effect.asVoid,
                  Effect.mapError(
                    (cause) =>
                      new EventStoreError({
                        message: "Failed to persist interaction request",
                        cause,
                      }),
                  ),
                ),
              resolve: (requestId) =>
                store.resolve(requestId).pipe(Effect.catchEager(() => Effect.void)),
              decide: (requestId, decisionJson) =>
                store.decide(requestId, decisionJson).pipe(
                  Effect.mapError(
                    (cause) =>
                      new EventStoreError({
                        message: "Failed to persist interaction decision",
                        cause,
                      }),
                  ),
                ),
            })
          }),
        ),
        Layer.mergeAll(baseDeps, eventPublisherLive, BunGentPlatformLive),
      )
      const defaultApprovalLayer =
        config.durableApproval === true ? durableApprovalLayer : ApprovalService.Test()
      const approvalLayer =
        config.approvalLayer !== undefined
          ? Layer.provide(
              config.approvalLayer,
              Layer.merge(eventPublisherLive, BunGentPlatformLive),
            )
          : defaultApprovalLayer
      const depsWithApproval = Layer.merge(baseDeps, approvalLayer)
      const toolRunnerLive = Layer.provide(ToolRunner.Live, depsWithApproval)
      const sessionRuntimeLive = Layer.provide(
        SessionRuntime.LiveWithEntity({
          baseSections: [{ id: "base", content: "e2e test system prompt", priority: 0 }],
        }),
        Layer.mergeAll(depsWithApproval, baseEventStoreLive, eventPublisherLive, toolRunnerLive),
      )
      const sessionMutationsLive = Layer.provide(
        SessionCommands.SessionMutationsLive,
        Layer.mergeAll(baseDeps, baseEventStoreLive, eventPublisherLive, sessionRuntimeLive),
      )
      const depsWithRuntime = Layer.mergeAll(depsWithApproval, sessionRuntimeLive)
      const interactionRecoveryLive = Layer.effectDiscard(
        Effect.gen(function* () {
          const interactionStore = yield* InteractionStorage
          const approvalService = yield* ApprovalService
          const sessionRuntime = yield* SessionRuntime

          const pending = yield* interactionStore.listPending()
          for (const record of pending) {
            const params = yield* decodeInteractionParams(record.paramsJson).pipe(
              Effect.option,
              Effect.map((opt) => (opt._tag === "Some" ? opt.value : undefined)),
            )
            if (params === undefined) continue
            const decision =
              record.decisionJson === undefined
                ? undefined
                : yield* decodeInteractionDecision(record.decisionJson).pipe(
                    Effect.option,
                    Effect.map((opt) => (opt._tag === "Some" ? opt.value : undefined)),
                  )
            yield* approvalService
              .rehydrate(
                record.requestId,
                params,
                {
                  sessionId: record.sessionId,
                  branchId: record.branchId,
                },
                decision,
              )
              .pipe(Effect.catchEager(() => Effect.void))
            if (decision !== undefined) {
              yield* sessionRuntime
                .respondInteraction({
                  sessionId: record.sessionId,
                  branchId: record.branchId,
                  requestId: record.requestId,
                })
                .pipe(Effect.catchEager(() => Effect.void))
            }
          }
        }),
      ).pipe(Layer.provide(depsWithRuntime))

      return Layer.provideMerge(
        AppServicesLive,
        Layer.mergeAll(
          depsWithApproval,
          baseEventStoreLive,
          eventPublisherLive,
          toolRunnerLive,
          sessionMutationsLive,
          sessionRuntimeLive,
          interactionRecoveryLive,
          ServerIdentity.Test(),
        ),
      )
    }),
  ).pipe(Layer.provide(BunPlatformLive))
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
      pendingRequestId: () => Effect.sync((): InteractionRequestId | undefined => undefined),
      storeResolution: () => Effect.void,
      respond: () => Effect.void,
      rehydrate: () => Effect.void,
    })
    return { layer, presentCalled }
  })

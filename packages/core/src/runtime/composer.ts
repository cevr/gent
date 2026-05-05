/**
 * Explicit runtime composition roots.
 *
 * Ephemeral child runs need a narrow, auditable builder: forward the parent
 * context, omit the services owned by the child, merge extension layers, then
 * merge child-owned layers last. The override families below are the single
 * source of truth for parent service omission.
 */

import { Layer, type Config, type Context, type FileSystem, type Path } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import { brandEphemeralScope, type EphemeralProfile, type ServerProfile } from "./scope-brands.js"
import type { SessionStorage } from "../storage/session-storage.js"
import type { BranchStorage } from "../storage/branch-storage.js"
import type { MessageStorage } from "../storage/message-storage.js"
import type { EventStorage } from "../storage/event-storage.js"
import type { RelationshipStorage } from "../storage/relationship-storage.js"
import type { StorageTransaction } from "../storage/storage-transaction.js"
import type { CheckpointStorage } from "../storage/checkpoint-storage.js"
import type { InteractionStorage } from "../storage/interaction-storage.js"
import type { InteractionPendingReader } from "../storage/interaction-pending-reader.js"
import type { SearchStorage } from "../storage/search-storage.js"
import type { EventStore } from "../domain/event.js"
import type { BuiltinEventSink, EventPublisher } from "../domain/event-publisher.js"
import type { StorageError } from "../domain/storage-error.js"
import type { ApprovalService } from "./approval-service.js"
import type { PromptPresenter } from "../domain/prompt-presenter.js"
import type { ResourceManager } from "./resource-manager.js"
import type { ToolRunner } from "./agent/tool-runner.js"
import type { SessionRuntime } from "./session-runtime.js"
import type { Provider } from "../providers/provider.js"
import type { ConfigService } from "./config-service.js"
import type { ModelRegistry } from "./model-registry.js"
import type { RuntimePlatform } from "./runtime-platform.js"

export interface EphemeralRuntimeInputs<Provides> {
  readonly parent: ServerProfile
  readonly parentServices: Context.Context<never>
  readonly overrides: EphemeralRuntimeOverrides
  readonly extensionLayers?: Layer.Layer<Provides, unknown, unknown>
}

export interface EphemeralRuntimeOverrides {
  readonly storage: Layer.Layer<EphemeralStorageProvides, StorageError, never>
  readonly eventStore: Layer.Layer<EventStore, EphemeralOverrideError, never>
  readonly eventPublisher: Layer.Layer<
    EventPublisher | BuiltinEventSink,
    EphemeralOverrideError,
    never
  >
  readonly approval: Layer.Layer<ApprovalService, never, never>
  readonly promptPresenter: Layer.Layer<PromptPresenter, never, never>
  readonly resourceManager: Layer.Layer<ResourceManager, never, never>
  readonly toolRunner: Layer.Layer<ToolRunner, never, never>
  readonly sessionRuntime: Layer.Layer<SessionRuntime, EphemeralOverrideError, never>
}

type EphemeralOverrideError = StorageError | Config.ConfigError

type EphemeralStorageProvides =
  | SqlClient.SqlClient
  | SessionStorage
  | BranchStorage
  | MessageStorage
  | EventStorage
  | RelationshipStorage
  | StorageTransaction
  | CheckpointStorage
  | InteractionStorage
  | InteractionPendingReader
  | SearchStorage

type EphemeralOverrideProvides =
  | EphemeralStorageProvides
  | EventStore
  | EventPublisher
  | BuiltinEventSink
  | ApprovalService
  | PromptPresenter
  | ResourceManager
  | ToolRunner
  | SessionRuntime

type EphemeralExtensionRequires =
  | EphemeralStorageProvides
  | RuntimePlatform
  | FileSystem.FileSystem
  | Path.Path
  | Provider
  | ConfigService
  | ModelRegistry

/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- explicit extension-layer recovery membrane */
// Extension layer membrane: heterogeneous extension code is typed as
// `<Provides, unknown, unknown>` upstream. The recovered shape pins the
// requirement set to `EphemeralExtensionRequires` so the subsequent
// `Layer.provideMerge` against parent + child storage type-checks.
const recoverExtensionLayer = <Provides>(
  layer: Layer.Layer<Provides, unknown, unknown>,
): Layer.Layer<Provides, never, EphemeralExtensionRequires> =>
  // @effect-diagnostics-next-line anyUnknownInErrorContext:off — explicit extension-layer recovery membrane
  layer as Layer.Layer<Provides, never, EphemeralExtensionRequires>
/* eslint-enable @typescript-eslint/no-unsafe-type-assertion */

export const buildEphemeralRuntime = <Provides>(
  inputs: EphemeralRuntimeInputs<Provides>,
): {
  readonly profile: EphemeralProfile
  readonly layer: Layer.Layer<Provides | EphemeralOverrideProvides, EphemeralOverrideError, never>
} => {
  // Parent context becomes a `Layer.succeedContext` source. Last-writer-wins
  // occlusion in `Layer.provideMerge` means any Tag the child layer provides
  // overrides the parent automatically; no explicit omit is needed. No
  // construction happens — `Layer.succeedContext` doesn't trigger memoized
  // parent rebuilds, so the prior `Layer.fresh` + `Layer.CurrentMemoMap`
  // omit are no-ops here.
  const parentLayer = Layer.succeedContext(inputs.parentServices)

  const overridesLayer = Layer.mergeAll(
    inputs.overrides.storage,
    inputs.overrides.eventStore,
    inputs.overrides.eventPublisher,
    inputs.overrides.approval,
    inputs.overrides.promptPresenter,
    inputs.overrides.resourceManager,
    inputs.overrides.toolRunner,
    inputs.overrides.sessionRuntime,
  )

  // The extension layer is fed by parent context + child storage so its
  // requirements (`EphemeralExtensionRequires`) resolve before the final
  // merge with child overrides. Heterogeneous extension code is typed as
  // `<Provides, unknown, unknown>` upstream — `recoverExtensionLayer` is
  // the membrane that recovers the typed shape.
  const typedExtensionLayer =
    inputs.extensionLayers === undefined
      ? undefined
      : // @effect-diagnostics-next-line anyUnknownInErrorContext:off — heterogeneous upstream shape feeds the recovery membrane
        recoverExtensionLayer<Provides>(inputs.extensionLayers)
  const extensionLayer =
    typedExtensionLayer === undefined
      ? undefined
      : Layer.provideMerge(typedExtensionLayer, Layer.merge(parentLayer, inputs.overrides.storage))

  const childLayer =
    extensionLayer === undefined ? overridesLayer : Layer.merge(extensionLayer, overridesLayer)

  // Last writer wins: child overrides occlude any matching parent tag. The
  // `Layer.fresh` wrap is load-bearing: child override layers (e.g.
  // `SqliteStorage.MemoryWithSql()`) reference module-level layer constants
  // for the underlying `SqlClient`. Without a fresh memo map, the parent
  // runtime's memo would cache and reuse those instances across child
  // builds, so the "ephemeral" SQLite would alias the parent's. Fresh memo
  // gives the child its own SqliteClient.
  const merged: Layer.Layer<
    Provides | EphemeralOverrideProvides,
    EphemeralOverrideError,
    never
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Provides ⊕ EphemeralOverrideProvides is the union the call site expects; constrained by EphemeralExtensionRequires being satisfied above
  > = Layer.fresh(Layer.provideMerge(childLayer, parentLayer)) as Layer.Layer<
    Provides | EphemeralOverrideProvides,
    EphemeralOverrideError,
    never
  >

  const profile = brandEphemeralScope({
    cwd: inputs.parent.cwd,
    resolved: inputs.parent.resolved,
  })

  return { profile, layer: merged }
}

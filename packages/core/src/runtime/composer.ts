/**
 * Explicit runtime composition roots.
 *
 * Ephemeral child runs need a narrow, auditable builder: forward the parent
 * context, omit the services owned by the child, merge extension layers, then
 * merge child-owned layers last. The override families below are the single
 * source of truth for parent service omission.
 */

import { Layer } from "effect"
import type { Context } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { brandEphemeralScope, type EphemeralProfile, type ServerProfile } from "./scope-brands.js"
import { Storage } from "../storage/sqlite-storage.js"
import { SessionStorage } from "../storage/session-storage.js"
import { BranchStorage } from "../storage/branch-storage.js"
import { MessageStorage } from "../storage/message-storage.js"
import { EventStorage } from "../storage/event-storage.js"
import { RelationshipStorage } from "../storage/relationship-storage.js"
import { StorageTransaction } from "../storage/storage-transaction.js"
import { CheckpointStorage } from "../storage/checkpoint-storage.js"
import { InteractionStorage } from "../storage/interaction-storage.js"
import { InteractionPendingReader } from "../storage/interaction-pending-reader.js"
import { SearchStorage } from "../storage/search-storage.js"
import { EventStore } from "../domain/event.js"
import { BuiltinEventSink, EventPublisher } from "../domain/event-publisher.js"
import type { StorageError } from "../domain/storage-error.js"
import { ApprovalService } from "./approval-service.js"
import { PromptPresenter } from "../domain/prompt-presenter.js"
import { ResourceManager } from "./resource-manager.js"
import { ToolRunner } from "./agent/tool-runner.js"
import { SessionRuntime } from "./session-runtime.js"
import {
  eraseContextKey,
  eraseLayer,
  mergeErasedLayers,
  omitErasedContext,
  restoreErasedLayer,
} from "./extensions/effect-membrane.js"

export interface EphemeralRuntimeInputs<Provides> {
  readonly parent: ServerProfile
  readonly parentServices: Context.Context<never>
  readonly overrides: EphemeralRuntimeOverrides
  readonly extensionLayers?: Layer.Layer<Provides, unknown, unknown>
}

export interface EphemeralRuntimeOverrides {
  readonly storage: Layer.Layer<EphemeralStorageProvides, StorageError, never>
  readonly eventStore: Layer.Layer<EventStore, unknown, unknown>
  readonly eventPublisher: Layer.Layer<EventPublisher | BuiltinEventSink, unknown, unknown>
  readonly approval: Layer.Layer<ApprovalService, unknown, unknown>
  readonly promptPresenter: Layer.Layer<PromptPresenter, unknown, unknown>
  readonly resourceManager: Layer.Layer<ResourceManager, unknown, unknown>
  readonly toolRunner: Layer.Layer<ToolRunner, unknown, unknown>
  readonly sessionRuntime: Layer.Layer<SessionRuntime, unknown, unknown>
}

type EphemeralStorageProvides =
  | SqlClient.SqlClient
  | Storage
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

const storageOverrideTags = [
  SqlClient.SqlClient,
  Storage,
  SessionStorage,
  BranchStorage,
  MessageStorage,
  EventStorage,
  RelationshipStorage,
  StorageTransaction,
  CheckpointStorage,
  InteractionStorage,
  InteractionPendingReader,
  SearchStorage,
] as const

const eventPublisherOverrideTags = [EventPublisher, BuiltinEventSink] as const

const omitTagsForEphemeralOverrides = [
  ...storageOverrideTags,
  EventStore,
  ...eventPublisherOverrideTags,
  ApprovalService,
  PromptPresenter,
  ResourceManager,
  ToolRunner,
  SessionRuntime,
] as const

export const buildEphemeralRuntime = <Provides>(
  inputs: EphemeralRuntimeInputs<Provides>,
): {
  readonly profile: EphemeralProfile
  readonly layer: Layer.Layer<Provides | EphemeralOverrideProvides, never, never>
} => {
  // Strip owned services and the parent's memo map. Owned-service omission
  // prevents already-resolved parent instances from bleeding into the child;
  // memo-map omission prevents layer-object identity from replaying parent
  // builds. `Layer.fresh` below is the second half of that contract.
  const memoKey = eraseContextKey(Layer.CurrentMemoMap)
  const parentLayer = Layer.succeedContext(
    omitErasedContext(inputs.parentServices, [
      ...omitTagsForEphemeralOverrides.map(eraseContextKey),
      memoKey,
    ]),
  )

  const typedExtensionLayer =
    inputs.extensionLayers === undefined
      ? undefined
      : restoreErasedLayer<Provides, never, EphemeralStorageProvides>(
          // @effect-diagnostics-next-line anyUnknownInErrorContext:off — extension layer membrane owns heterogeneous extension requirements
          eraseLayer(inputs.extensionLayers),
        )

  const extensionLayer =
    typedExtensionLayer === undefined
      ? undefined
      : Layer.provideMerge(typedExtensionLayer, Layer.merge(parentLayer, inputs.overrides.storage))

  // Merge order is parent → extension layers fed by child storage → child overrides. Last writer wins.
  // @effect-diagnostics-next-line anyUnknownInErrorContext:off — Effect membrane owns erased runtime context boundary
  const merged = mergeErasedLayers([
    // @effect-diagnostics-next-line anyUnknownInErrorContext:off — Effect membrane owns erased runtime context boundary
    eraseLayer(parentLayer),
    ...(extensionLayer === undefined
      ? []
      : [
          // @effect-diagnostics-next-line anyUnknownInErrorContext:off — Effect membrane owns erased runtime context boundary
          eraseLayer(extensionLayer),
        ]),
    // @effect-diagnostics-next-line anyUnknownInErrorContext:off — Effect membrane owns erased runtime context boundary
    eraseLayer(inputs.overrides.storage),
    // @effect-diagnostics-next-line anyUnknownInErrorContext:off — Effect membrane owns erased runtime context boundary
    eraseLayer(inputs.overrides.eventStore),
    // @effect-diagnostics-next-line anyUnknownInErrorContext:off — Effect membrane owns erased runtime context boundary
    eraseLayer(inputs.overrides.eventPublisher),
    // @effect-diagnostics-next-line anyUnknownInErrorContext:off — Effect membrane owns erased runtime context boundary
    eraseLayer(inputs.overrides.approval),
    // @effect-diagnostics-next-line anyUnknownInErrorContext:off — Effect membrane owns erased runtime context boundary
    eraseLayer(inputs.overrides.promptPresenter),
    // @effect-diagnostics-next-line anyUnknownInErrorContext:off — Effect membrane owns erased runtime context boundary
    eraseLayer(inputs.overrides.resourceManager),
    // @effect-diagnostics-next-line anyUnknownInErrorContext:off — Effect membrane owns erased runtime context boundary
    eraseLayer(inputs.overrides.toolRunner),
    // @effect-diagnostics-next-line anyUnknownInErrorContext:off — Effect membrane owns erased runtime context boundary
    eraseLayer(inputs.overrides.sessionRuntime),
  ])

  const profile = brandEphemeralScope({
    cwd: inputs.parent.cwd,
    resolved: inputs.parent.resolved,
  })

  return {
    profile,
    // @effect-diagnostics-next-line anyUnknownInErrorContext:off — builder recovers Provides at this boundary
    layer: restoreErasedLayer<Provides | EphemeralOverrideProvides>(Layer.fresh(merged)),
  }
}

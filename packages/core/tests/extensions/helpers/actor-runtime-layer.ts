/**
 * Shared layer builder for direct-runtime extension tests.
 *
 * Consolidates the near-identical makeRuntimeLayer / makeLayer / makeSkillsRuntimeLayer
 * helpers across actor.test, plan.test, skills-actor.test, persistence.test.
 */
import { Layer } from "effect"
import { EventStore } from "@gent/core/domain/event"
import type { LoadedExtension } from "../../../src/domain/extension.js"
import { ActorEngine } from "../../../src/runtime/extensions/actor-engine"
import { ActorRouter } from "../../../src/runtime/extensions/resource-host/actor-router"
import { ExtensionTurnControl } from "../../../src/runtime/extensions/turn-control"
import { buildResourceLayer } from "../../../src/runtime/extensions/resource-host/resource-layer"
import { Storage } from "@gent/core/storage/sqlite-storage"

export const makeActorRuntimeLayer = (config: {
  readonly extensions: ReadonlyArray<LoadedExtension>
  readonly withStorage?: boolean
  readonly extensionLayers?: ReadonlyArray<Layer.Layer<never>>
}) => {
  const turnControl = ExtensionTurnControl.Test()
  const storage = Storage.Test()
  const machine = ActorRouter.Live(config.extensions).pipe(
    Layer.provideMerge(turnControl),
    Layer.provideMerge(ActorEngine.Live),
  )
  // Build the process-scope Resource layer so `Resource.start` lifecycle
  // hooks fire (e.g. spawning actors that capture services into closure
  // via `ActorEngine`). When the caller passes `extensionLayers`
  // explicitly, fall back to merging only those — used by tests that
  // intentionally bypass setup.
  const baseInfra = Layer.mergeAll(
    machine,
    EventStore.Memory,
    turnControl,
    ...(config.withStorage ? [storage] : []),
  )

  if (config.extensionLayers !== undefined) {
    return Layer.mergeAll(baseInfra, ...config.extensionLayers)
  }

  // `buildResourceLayer` walks process-scope resources, merges their
  // service layers, and threads `start`/`stop` sequentially with
  // reverse-order teardown. `provideMerge(resourceLayer, baseInfra)`
  // feeds baseInfra (ActorEngine, Receptionist, ...) into start hooks
  // while keeping baseInfra's outputs in the merged layer. The result
  // is `ErasedResourceLayer = Layer.Layer<any>` — that membrane lives
  // inside `resource-layer.ts`, no further cast needed here.
  const resourceLayer = buildResourceLayer(config.extensions, "process")
  return Layer.provideMerge(resourceLayer, baseInfra)
}

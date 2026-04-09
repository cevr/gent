/**
 * Shared layer builder for direct-runtime extension tests.
 *
 * Consolidates the near-identical makeRuntimeLayer / makeLayer / makeSkillsRuntimeLayer
 * helpers across actor.test, plan.test, skills-actor.test, persistence.test.
 */
import { Layer } from "effect"
import { EventStore } from "@gent/core/domain/event"
import type { LoadedExtension } from "@gent/core/domain/extension"
import { ExtensionStateRuntime } from "@gent/core/runtime/extensions/state-runtime"
import { ExtensionTurnControl } from "@gent/core/runtime/extensions/turn-control"
import { Storage } from "@gent/core/storage/sqlite-storage"

export const makeActorRuntimeLayer = (config: {
  readonly extensions: ReadonlyArray<LoadedExtension>
  readonly withStorage?: boolean
  readonly extensionLayers?: ReadonlyArray<Layer.Layer<never>>
}) => {
  const turnControl = ExtensionTurnControl.Test()

  // Collect layers declared by extensions (e.g. Skills.Test)
  const extLayers =
    config.extensionLayers ??
    config.extensions
      .filter((ext) => ext.setup.layer !== undefined)
      .map((ext) => ext.setup.layer as Layer.Layer<never>)

  return Layer.mergeAll(
    ExtensionStateRuntime.Live(config.extensions).pipe(Layer.provideMerge(turnControl)),
    EventStore.Memory,
    turnControl,
    ...extLayers,
    ...(config.withStorage ? [Storage.Test()] : []),
  )
}

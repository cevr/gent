/**
 * Shared layer builder for direct-runtime extension tests.
 *
 * Consolidates the near-identical makeRuntimeLayer / makeLayer / makeSkillsRuntimeLayer
 * helpers across actor.test, plan.test, skills-actor.test, persistence.test.
 */
import { Layer } from "effect"
import { EventStore } from "@gent/core/domain/event"
import { extractLayer } from "@gent/core/domain/contribution"
import type { LoadedExtension } from "@gent/core/domain/extension"
import { WorkflowRuntime } from "@gent/core/runtime/extensions/workflow-runtime"
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
    config.extensions.flatMap((ext) => {
      const layer = extractLayer(ext.contributions)
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      return layer === undefined ? [] : [layer as Layer.Layer<never>]
    })

  return Layer.mergeAll(
    WorkflowRuntime.Live(config.extensions).pipe(Layer.provideMerge(turnControl)),
    EventStore.Memory,
    turnControl,
    ...extLayers,
    ...(config.withStorage ? [Storage.Test()] : []),
  )
}

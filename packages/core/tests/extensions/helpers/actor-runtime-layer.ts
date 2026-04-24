/**
 * Shared layer builder for direct-runtime extension tests.
 *
 * Consolidates the near-identical makeRuntimeLayer / makeLayer / makeSkillsRuntimeLayer
 * helpers across actor.test, plan.test, skills-actor.test, persistence.test.
 */
import { Layer } from "effect"
import { EventStore } from "@gent/core/domain/event"
import type { LoadedExtension } from "../../../src/domain/extension.js"
import { MachineEngine } from "../../../src/runtime/extensions/resource-host/machine-engine"
import { ExtensionTurnControl } from "../../../src/runtime/extensions/turn-control"
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
    config.extensions.flatMap((ext) =>
      (ext.contributions.resources ?? [])
        .filter((r) => r.scope === "process")
        .map(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-type-assertion
          (r) => r.layer as Layer.Layer<never>,
        ),
    )

  return Layer.mergeAll(
    MachineEngine.Live(config.extensions).pipe(Layer.provideMerge(turnControl)),
    EventStore.Memory,
    turnControl,
    ...extLayers,
    ...(config.withStorage ? [Storage.Test()] : []),
  )
}

/**
 * Shared layer builder for direct-runtime extension tests.
 *
 * Consolidates the near-identical makeRuntimeLayer / makeLayer / makeSkillsRuntimeLayer
 * helpers across actor.test, plan.test, skills-actor.test, persistence.test.
 */
import { Effect, Layer } from "effect"
import { EventStore } from "@gent/core/domain/event"
import type { LoadedExtension } from "../../../src/domain/extension.js"
import { ActorEngine } from "../../../src/runtime/extensions/actor-engine"
import { MachineEngine } from "../../../src/runtime/extensions/resource-host/machine-engine"
import { ExtensionTurnControl } from "../../../src/runtime/extensions/turn-control"
import { Storage } from "@gent/core/storage/sqlite-storage"
import { ensureStorageParents } from "@gent/core/test-utils"

export const makeActorRuntimeLayer = (config: {
  readonly extensions: ReadonlyArray<LoadedExtension>
  readonly withStorage?: boolean
  readonly extensionLayers?: ReadonlyArray<Layer.Layer<never>>
}) => {
  const turnControl = ExtensionTurnControl.Test()
  const storage = Storage.Test()
  const machine = MachineEngine.Live(config.extensions).pipe(
    Layer.provideMerge(turnControl),
    Layer.provideMerge(ActorEngine.Live),
  )
  const machineWithSeededParents =
    config.withStorage === true
      ? Layer.effect(
          MachineEngine,
          Effect.gen(function* () {
            const runtime = yield* MachineEngine
            return {
              publish: (event, ctx) =>
                ensureStorageParents({ sessionId: ctx.sessionId, branchId: ctx.branchId }).pipe(
                  Effect.flatMap(() => runtime.publish(event, ctx)),
                ),
              send: (sessionId, message, branchId) =>
                ensureStorageParents({ sessionId, branchId }).pipe(
                  Effect.flatMap(() => runtime.send(sessionId, message, branchId)),
                ),
              execute: (sessionId, message, branchId) =>
                ensureStorageParents({ sessionId, branchId }).pipe(
                  Effect.flatMap(() => runtime.execute(sessionId, message, branchId)),
                ),
              getActorStatuses: (sessionId) =>
                ensureStorageParents({ sessionId }).pipe(
                  Effect.flatMap(() => runtime.getActorStatuses(sessionId)),
                ),
              terminateAll: runtime.terminateAll,
            } satisfies typeof runtime
          }),
        ).pipe(Layer.provide(Layer.merge(machine, storage)))
      : machine

  // Collect layers declared by extensions (e.g. Skills.Test)
  const extLayers =
    config.extensionLayers ??
    config.extensions.flatMap((ext) =>
      (ext.contributions.resources ?? [])
        .filter((r) => r.scope === "process")
        .map(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-type-assertion -- test fixture owns intentionally partial typed values
          (r) => r.layer as Layer.Layer<never>,
        ),
    )

  return Layer.mergeAll(
    machineWithSeededParents,
    EventStore.Memory,
    turnControl,
    ...extLayers,
    ...(config.withStorage ? [storage] : []),
  )
}

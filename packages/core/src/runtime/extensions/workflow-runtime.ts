/**
 * WorkflowRuntime — legacy Tag retained as a thin projection over
 * `MachineEngine` for the B11.3c migration window.
 *
 * Producer call sites move from `yield* WorkflowRuntime` to
 * `yield* MachineEngine` over B11.3c.{2..4}; once all migrate, this Tag
 * is deleted (B11.3c.5). `MachineEngine` is the substrate's write
 * surface; `MachineExecute` is the read-only call surface for projections.
 *
 * @module
 */

import { Context, Effect, Layer } from "effect"
import type { LoadedExtension } from "../../domain/extension.js"
import type { MachineEngineService } from "./resource-host/machine-engine.js"
import { MachineEngine } from "./resource-host/machine-engine.js"
import { ExtensionTurnControl } from "./turn-control.js"

export type WorkflowRuntimeService = MachineEngineService

export class WorkflowRuntime extends Context.Service<WorkflowRuntime, WorkflowRuntimeService>()(
  "@gent/core/src/runtime/extensions/workflow-runtime/WorkflowRuntime",
) {
  /**
   * Project `MachineEngine` onto the legacy `WorkflowRuntime` Tag. Both
   * Tags surface the same service value during the migration window.
   */
  private static project: Layer.Layer<WorkflowRuntime, never, MachineEngine> = Layer.effect(
    WorkflowRuntime,
    Effect.gen(function* () {
      const engine = yield* MachineEngine
      return engine
    }),
  )

  /**
   * Build a layer that provides BOTH `MachineEngine` (built from the given
   * extensions) and the legacy `WorkflowRuntime` Tag projecting onto it.
   *
   * Composition roots can yield either Tag and get the same engine. New
   * code should yield `MachineEngine` directly; this projection exists
   * only for the duration of the B11.3c migration window.
   */
  static fromExtensions = (
    extensions: ReadonlyArray<LoadedExtension>,
  ): Layer.Layer<WorkflowRuntime | MachineEngine, never, ExtensionTurnControl> =>
    Layer.provideMerge(WorkflowRuntime.project, MachineEngine.fromExtensions(extensions))

  static Live = (
    extensions: ReadonlyArray<LoadedExtension>,
  ): Layer.Layer<WorkflowRuntime | MachineEngine, never, ExtensionTurnControl> =>
    WorkflowRuntime.fromExtensions(extensions)

  static Test = (): Layer.Layer<WorkflowRuntime | MachineEngine> =>
    WorkflowRuntime.fromExtensions([]).pipe(Layer.provide(ExtensionTurnControl.Test()))
}

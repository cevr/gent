import { ServiceMap, Effect, Layer, Ref, Schema } from "effect"
import type { AgentEvent, ExtensionUiSnapshot } from "../../domain/event.js"
import { ExtensionUiSnapshot as ExtensionUiSnapshotClass } from "../../domain/event.js"
import type {
  ExtensionDeriveContext,
  ExtensionProjection,
  ExtensionReduceContext,
  ExtensionStateMachine,
  LoadedExtension,
} from "../../domain/extension.js"
import type { BranchId, SessionId } from "../../domain/ids.js"

// Errors

export class StaleIntentError extends Schema.TaggedErrorClass<StaleIntentError>()(
  "@gent/core/StaleIntentError",
  {
    extensionId: Schema.String,
    expectedEpoch: Schema.Number,
    actualEpoch: Schema.Number,
  },
) {}

// Internal state per extension

interface ExtensionEntry {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly machine: ExtensionStateMachine<any, any>
  state: unknown
  epoch: number
}

// Service

export interface ExtensionStateRuntimeService {
  /** Feed an event to all registered state machines */
  readonly reduce: (event: AgentEvent, ctx: ExtensionReduceContext) => Effect.Effect<void>

  /** Get current projections for all extensions with state machines */
  readonly deriveAll: (
    ctx: ExtensionDeriveContext,
  ) => Effect.Effect<ReadonlyArray<{ extensionId: string; projection: ExtensionProjection }>>

  /** Handle a typed intent from the client (epoch-validated) */
  readonly handleIntent: (
    extensionId: string,
    intent: unknown,
    epoch: number,
  ) => Effect.Effect<void, StaleIntentError>

  /** Get current UI snapshots for all extensions with uiModels */
  readonly getUiSnapshots: (
    sessionId: SessionId,
    branchId: BranchId,
  ) => Effect.Effect<ReadonlyArray<ExtensionUiSnapshot>>
}

export class ExtensionStateRuntime extends ServiceMap.Service<
  ExtensionStateRuntime,
  ExtensionStateRuntimeService
>()("@gent/core/src/runtime/extensions/state-runtime/ExtensionStateRuntime") {
  static fromExtensions = (
    extensions: ReadonlyArray<LoadedExtension>,
  ): Layer.Layer<ExtensionStateRuntime> =>
    Layer.effect(
      ExtensionStateRuntime,
      Effect.gen(function* () {
        // Collect all extensions that have state machines
        const entries: ExtensionEntry[] = []
        for (const ext of extensions) {
          const machine = ext.setup.stateMachine
          if (machine !== undefined) {
            entries.push({
              machine,
              state: machine.initial,
              epoch: 0,
            })
          }
        }

        const entriesRef = yield* Ref.make(entries)

        return {
          reduce: (event, ctx) =>
            Ref.update(entriesRef, (current) =>
              current.map((entry) => {
                const nextState = entry.machine.reduce(entry.state, event, ctx)
                if (nextState === entry.state) return entry
                return { ...entry, state: nextState, epoch: entry.epoch + 1 }
              }),
            ),

          deriveAll: (ctx) =>
            Effect.gen(function* () {
              const current = yield* Ref.get(entriesRef)
              return current.map((entry) => ({
                extensionId: entry.machine.id,
                projection: entry.machine.derive(entry.state, ctx),
              }))
            }),

          handleIntent: (extensionId, intent, epoch) =>
            Effect.gen(function* () {
              const current = yield* Ref.get(entriesRef)
              const idx = current.findIndex((e) => e.machine.id === extensionId)
              if (idx === -1) return

              const entry = current[idx]
              if (entry === undefined) return
              if (epoch < entry.epoch) {
                return yield* new StaleIntentError({
                  extensionId,
                  expectedEpoch: entry.epoch,
                  actualEpoch: epoch,
                })
              }

              const handler = entry.machine.handleIntent
              if (handler === undefined) return

              const result = handler(entry.state, intent)
              yield* Ref.update(entriesRef, (entries) =>
                entries.map((e, i) =>
                  i === idx ? { ...e, state: result.state, epoch: e.epoch + 1 } : e,
                ),
              )

              // Run side effects if any
              if (result.effects !== undefined) {
                for (const eff of result.effects) {
                  yield* eff.pipe(Effect.catchDefect(() => Effect.void))
                }
              }
            }),

          getUiSnapshots: (sessionId, branchId) =>
            Effect.gen(function* () {
              const current = yield* Ref.get(entriesRef)
              const snapshots: ExtensionUiSnapshot[] = []
              for (const entry of current) {
                // Only include entries whose derive produces a uiModel
                // We derive with a minimal context — the agent/tools don't matter for UI snapshots
                // This is a lightweight read, not a full derivation
                const uiModel = entry.machine.derive(entry.state, {
                  agent: undefined as never,
                  allTools: [],
                }).uiModel
                if (uiModel !== undefined) {
                  snapshots.push(
                    new ExtensionUiSnapshotClass({
                      sessionId,
                      branchId,
                      extensionId: entry.machine.id,
                      epoch: entry.epoch,
                      model: uiModel,
                    }),
                  )
                }
              }
              return snapshots
            }),
        }
      }),
    )

  static Live = (extensions: ReadonlyArray<LoadedExtension>): Layer.Layer<ExtensionStateRuntime> =>
    ExtensionStateRuntime.fromExtensions(extensions)

  static Test = (): Layer.Layer<ExtensionStateRuntime> => ExtensionStateRuntime.fromExtensions([])
}

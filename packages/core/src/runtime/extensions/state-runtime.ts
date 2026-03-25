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

// Internal state per extension per session

interface ExtensionEntry {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly machine: ExtensionStateMachine<any, any>
  state: unknown
  epoch: number
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MachineList = ReadonlyArray<ExtensionStateMachine<any, any>>

const initEntries = (machines: MachineList): ExtensionEntry[] =>
  machines.map((machine) => ({ machine, state: machine.initial, epoch: 0 }))

// Service

export interface ExtensionStateRuntimeService {
  /** Feed an event to all registered state machines for a session. Returns true if any machine changed state. */
  readonly reduce: (event: AgentEvent, ctx: ExtensionReduceContext) => Effect.Effect<boolean>

  /** Get current projections for all extensions with state machines */
  readonly deriveAll: (
    sessionId: SessionId,
    ctx: ExtensionDeriveContext,
  ) => Effect.Effect<ReadonlyArray<{ extensionId: string; projection: ExtensionProjection }>>

  /** Handle a typed intent from the client (epoch-validated, schema-validated) */
  readonly handleIntent: (
    sessionId: SessionId,
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
        // Collect machines from extensions
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const machines: ExtensionStateMachine<any, any>[] = []
        for (const ext of extensions) {
          if (ext.setup.stateMachine !== undefined) {
            machines.push(ext.setup.stateMachine)
          }
        }

        // Session-scoped state: Map<SessionId, ExtensionEntry[]>
        const sessionsRef = yield* Ref.make<Map<SessionId, ExtensionEntry[]>>(new Map())

        const getOrInitSession = (sessionId: SessionId) =>
          Ref.modify(sessionsRef, (sessions) => {
            const existing = sessions.get(sessionId)
            if (existing !== undefined) return [existing, sessions]
            const entries = initEntries(machines)
            const next = new Map(sessions)
            next.set(sessionId, entries)
            return [entries, next]
          })

        return {
          reduce: (event, ctx) =>
            Effect.gen(function* () {
              const entries = yield* getOrInitSession(ctx.sessionId)
              let changed = false
              const updated = entries.map((entry) => {
                const nextState = entry.machine.reduce(entry.state, event, ctx)
                if (nextState === entry.state) return entry
                changed = true
                return { ...entry, state: nextState, epoch: entry.epoch + 1 }
              })
              if (changed) {
                yield* Ref.update(sessionsRef, (sessions) => {
                  const next = new Map(sessions)
                  next.set(ctx.sessionId, updated)
                  return next
                })
              }
              return changed
            }),

          deriveAll: (sessionId, ctx) =>
            Effect.gen(function* () {
              const entries = yield* getOrInitSession(sessionId)
              return entries.map((entry) => ({
                extensionId: entry.machine.id,
                projection: entry.machine.derive(entry.state, ctx),
              }))
            }),

          handleIntent: (sessionId, extensionId, intent, epoch) =>
            Effect.gen(function* () {
              const entries = yield* getOrInitSession(sessionId)
              const idx = entries.findIndex((e) => e.machine.id === extensionId)
              if (idx === -1) return

              const entry = entries[idx]
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

              // Validate intent against schema if present — returns StaleIntentError on bad payload
              let validatedIntent: unknown = intent
              if (entry.machine.intentSchema !== undefined) {
                validatedIntent = yield* Schema.decodeUnknownEffect(
                  entry.machine.intentSchema as Schema.Any,
                )(intent).pipe(
                  Effect.catchEager(() =>
                    Effect.fail(
                      new StaleIntentError({
                        extensionId,
                        expectedEpoch: entry.epoch,
                        actualEpoch: epoch,
                      }),
                    ),
                  ),
                )
              }

              const result = handler(entry.state, validatedIntent)
              yield* Ref.update(sessionsRef, (sessions) => {
                const current = sessions.get(sessionId)
                if (current === undefined) return sessions
                const next = new Map(sessions)
                next.set(
                  sessionId,
                  current.map((e, i) =>
                    i === idx ? { ...e, state: result.state, epoch: e.epoch + 1 } : e,
                  ),
                )
                return next
              })

              // Run side effects if any
              if (result.effects !== undefined) {
                for (const eff of result.effects) {
                  yield* eff.pipe(Effect.catchDefect(() => Effect.void))
                }
              }
            }),

          getUiSnapshots: (sessionId, branchId) =>
            Effect.gen(function* () {
              const entries = yield* getOrInitSession(sessionId)
              const snapshots: ExtensionUiSnapshot[] = []
              for (const entry of entries) {
                if (entry.machine.uiModelSchema === undefined) continue
                const projection = entry.machine.derive(entry.state, {
                  // UI snapshots don't depend on agent/tools context
                  agent: undefined as never,
                  allTools: [],
                })
                if (projection.uiModel !== undefined) {
                  const validated =
                    entry.machine.uiModelSchema !== undefined
                      ? Schema.decodeUnknownSync(entry.machine.uiModelSchema as Schema.Any)(
                          projection.uiModel,
                        )
                      : projection.uiModel
                  snapshots.push(
                    new ExtensionUiSnapshotClass({
                      sessionId,
                      branchId,
                      extensionId: entry.machine.id,
                      epoch: entry.epoch,
                      model: validated,
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

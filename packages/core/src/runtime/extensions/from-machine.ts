/**
 * fromMachine — adapts an effect-machine actor to ExtensionRef.
 */

import { Effect, Ref, Schema } from "effect"
import { Machine } from "effect-machine"
import type { AgentEvent } from "../../domain/event.js"
import type {
  ExtensionDeriveContext,
  ExtensionEffect,
  ExtensionProjection,
  ExtensionProjectionConfig,
  SpawnExtensionRef,
} from "../../domain/extension.js"
import type { BranchId } from "../../domain/ids.js"
import type {
  AnyExtensionCommandMessage,
  AnyExtensionRequestMessage,
} from "../../domain/extension-protocol.js"
import { ExtensionTurnControl } from "./turn-control.js"
import { Storage } from "../../storage/sqlite-storage.js"
import {
  buildProjectionConfig,
  interpretEffects,
  makePersistCodec,
} from "./extension-actor-shared.js"

export interface FromMachineConfig<
  State extends { readonly _tag: string },
  Event extends { readonly _tag: string },
  Message = never,
  R = never,
  InitR = never,
> {
  readonly id: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly built: Machine.Machine<State, Event, R, any, any, any>
  readonly mapEvent?: (event: AgentEvent) => Event | undefined
  readonly mapMessage?: (message: Message, state: State) => Event | undefined
  readonly messageSchema?: Schema.Schema<Message>
  readonly derive?: (state: State, ctx?: ExtensionDeriveContext) => ExtensionProjection
  readonly uiModelSchema?: Schema.Schema<unknown>
  readonly stateSchema?: Schema.Schema<State>
  readonly persist?: boolean
  readonly afterTransition?: (before: State, after: State) => ReadonlyArray<ExtensionEffect>
  readonly onInit?: (ctx: {
    readonly sessionId: string
    readonly snapshot: Effect.Effect<State>
    readonly send: (event: Event) => Effect.Effect<boolean>
    readonly sessionCwd?: string
  }) => Effect.Effect<void, never, InitR>
}

export interface FromMachineResult {
  readonly spawn: SpawnExtensionRef
  readonly projection?: ExtensionProjectionConfig
}

export const fromMachine = <
  State extends { readonly _tag: string },
  Event extends { readonly _tag: string },
  Message = never,
  R = never,
  InitR = never,
>(
  config: FromMachineConfig<State, Event, Message, R, InitR>,
): FromMachineResult => {
  const spawn: SpawnExtensionRef = (ctx) =>
    Effect.withSpan("fromMachine.spawn", { attributes: { "extension.id": config.id } })(
      Effect.gen(function* () {
        const turnControl = yield* ExtensionTurnControl
        const storage = yield* Effect.serviceOption(Storage)
        const services = yield* Effect.services<InitR>()
        const versionRef = yield* Ref.make(0)
        const startedRef = yield* Ref.make(false)

        const spawnId = `${config.id}-${ctx.sessionId}`
        const codec =
          config.stateSchema !== undefined ? makePersistCodec(config.stateSchema) : undefined

        let hydratedState: State | undefined
        let initialEpoch = 0
        if (config.persist === true && storage._tag === "Some" && codec !== undefined) {
          const loaded = yield* storage.value
            .loadExtensionState({ sessionId: ctx.sessionId, extensionId: config.id })
            .pipe(Effect.catchEager(() => Effect.void.pipe(Effect.as(undefined))))
          if (loaded !== undefined) {
            const decoded = yield* codec
              .decode(loaded.stateJson)
              .pipe(Effect.catchEager(() => Effect.void.pipe(Effect.as(undefined))))
            if (decoded !== undefined) {
              hydratedState = decoded
              initialEpoch = loaded.version
            }
          }
        }

        const ref = yield* Machine.spawn(config.built, {
          id: spawnId,
          ...(hydratedState !== undefined ? { hydrate: hydratedState } : {}),
        })

        const persistState = (): Effect.Effect<void> =>
          Effect.gen(function* () {
            if (storage._tag !== "Some" || codec === undefined) return
            const state = yield* ref.snapshot
            const epoch = yield* Ref.get(versionRef)
            const encoded = codec.encode(state as State)
            yield* storage.value
              .saveExtensionState({
                sessionId: ctx.sessionId,
                extensionId: config.id,
                stateJson: encoded,
                version: epoch,
              })
              .pipe(Effect.catchEager(() => Effect.void))
          })

        const runEffects = (
          effects: ReadonlyArray<ExtensionEffect>,
          branchId: BranchId | undefined,
        ) =>
          interpretEffects(
            effects,
            ctx.sessionId,
            branchId,
            turnControl,
            config.persist === true ? persistState : undefined,
          ).pipe(
            Effect.catchDefect((defect) =>
              Effect.logWarning("extension effect interpretation defect").pipe(
                Effect.annotateLogs({ extensionId: config.id, defect: String(defect) }),
              ),
            ),
          )

        const dispatch = (machineEvent: Event, branchId: BranchId | undefined) =>
          Effect.gen(function* () {
            const result = yield* ref
              .call(machineEvent)
              .pipe(
                Effect.catchDefect((defect) =>
                  Effect.logWarning("machine transition defect").pipe(
                    Effect.annotateLogs({ extensionId: config.id, defect: String(defect) }),
                    Effect.as(undefined),
                  ),
                ),
              )
            if (result === undefined || !result.transitioned) return false
            yield* Ref.update(versionRef, (epoch) => epoch + 1)
            if (config.persist === true) {
              yield* persistState().pipe(
                Effect.catchDefect((defect) =>
                  Effect.logWarning("extension persist defect").pipe(
                    Effect.annotateLogs({ extensionId: config.id, defect: String(defect) }),
                  ),
                ),
              )
            }
            if (config.afterTransition !== undefined) {
              const effects = config.afterTransition(result.previousState, result.newState)
              if (effects.length > 0) {
                yield* runEffects(effects, branchId)
              }
            }
            return true
          })

        const start = Effect.gen(function* () {
          const started = yield* Ref.get(startedRef)
          if (started) return
          yield* ref.start
          if (initialEpoch > 0) {
            yield* Ref.set(versionRef, initialEpoch)
          }
          if (config.onInit !== undefined) {
            let sessionCwd: string | undefined
            if (storage._tag === "Some") {
              const session = yield* storage.value
                .getSession(ctx.sessionId)
                .pipe(Effect.catchEager(() => Effect.void.pipe(Effect.as(undefined))))
              sessionCwd = session?.cwd ?? undefined
            }
            yield* config
              .onInit({
                sessionId: ctx.sessionId,
                snapshot: ref.snapshot as Effect.Effect<State>,
                send: (event) =>
                  dispatch(event, ctx.branchId).pipe(
                    Effect.catchEager(() => Effect.succeed(false)),
                  ),
                sessionCwd,
              })
              .pipe(
                Effect.provideServices(services),
                Effect.catchEager(() => Effect.void),
              )
          }
          yield* Ref.set(startedRef, true)
        })

        yield* start

        return {
          id: config.id,
          start,

          publish: (event, reduceCtx) =>
            Effect.gen(function* () {
              const mapped = config.mapEvent?.(event)
              if (mapped === undefined) return false
              return yield* dispatch(mapped, reduceCtx.branchId)
            }),

          send: (message: AnyExtensionCommandMessage, branchId?: BranchId) =>
            Effect.gen(function* () {
              const mapMessage = config.mapMessage
              if (mapMessage === undefined) return
              const decoded =
                config.messageSchema !== undefined
                  ? yield* Schema.decodeUnknownEffect(config.messageSchema as Schema.Any)(
                      message,
                    ).pipe(Effect.orDie)
                  : (message as Message)
              const currentState = yield* ref.snapshot
              const mapped = mapMessage(decoded, currentState)
              if (mapped === undefined) return
              yield* dispatch(mapped, branchId)
            }),

          ask: (message: AnyExtensionRequestMessage) =>
            Effect.die(
              new Error(`extension "${config.id}" does not handle request "${message._tag}"`),
            ),

          snapshot: Effect.gen(function* () {
            const state = yield* ref.snapshot
            const epoch = yield* Ref.get(versionRef)
            return { state, epoch }
          }),

          stop: ref.stop,
        }
      }),
    )

  const projection = buildProjectionConfig<State>({
    derive: config.derive,
    uiModelSchema: config.uiModelSchema,
  })

  return { spawn, projection }
}

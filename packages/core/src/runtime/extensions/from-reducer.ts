/**
 * fromReducer — wraps a pure reducer into a mailbox-backed ExtensionRef.
 */

import { Effect, Ref, Schema, Semaphore } from "effect"
import type { AgentEvent } from "../../domain/event.js"
import type {
  ExtensionDeriveContext,
  ExtensionEffect,
  ExtensionProjection,
  ExtensionProjectionConfig,
  ExtensionReduceContext,
  ReduceResult,
  RequestResult,
  SpawnExtensionRef,
} from "../../domain/extension.js"
import type { SessionId, BranchId } from "../../domain/ids.js"
import type {
  AnyExtensionCommandMessage,
  AnyExtensionRequestMessage,
} from "../../domain/extension-protocol.js"
import { Storage } from "../../storage/sqlite-storage.js"
import { ExtensionTurnControl } from "./turn-control.js"
import {
  buildProjectionConfig,
  interpretEffects,
  makePersistCodec,
} from "./extension-actor-shared.js"

export interface FromReducerConfig<
  State,
  Message = never,
  Request = never,
  InitR = never,
  RequestR = never,
> {
  readonly id: string
  readonly initial: State
  readonly reduce: (
    state: State,
    event: AgentEvent,
    ctx: ExtensionReduceContext,
  ) => ReduceResult<State>
  readonly derive?: (state: State, ctx?: ExtensionDeriveContext) => ExtensionProjection
  readonly receive?: (state: State, message: Message) => ReduceResult<State>
  readonly messageSchema?: Schema.Schema<Message>
  readonly request?: (
    state: State,
    message: Request,
  ) => Effect.Effect<RequestResult<State, unknown>, never, RequestR>
  readonly requestSchema?: Schema.Schema<Request>
  readonly uiModelSchema?: Schema.Schema<unknown>
  readonly stateSchema?: Schema.Schema<State>
  readonly persist?: boolean
  readonly onInit?: (ctx: {
    sessionId: SessionId
    stateRef: Ref.Ref<State>
    sessionCwd?: string
  }) => Effect.Effect<void, never, InitR>
}

export interface FromReducerResult {
  readonly spawn: SpawnExtensionRef
  readonly projection?: ExtensionProjectionConfig
}

export const fromReducer = <
  State,
  Message = never,
  Request = never,
  InitR = never,
  RequestR = never,
>(
  config: FromReducerConfig<State, Message, Request, InitR, RequestR>,
): FromReducerResult => {
  const spawn: SpawnExtensionRef = (ctx) =>
    Effect.gen(function* () {
      const turnControl = yield* ExtensionTurnControl
      const storage = yield* Effect.serviceOption(Storage)
      const services = yield* Effect.services<InitR | RequestR>()
      const stateRef = yield* Ref.make<State>(config.initial)
      const versionRef = yield* Ref.make(0)
      const startedRef = yield* Ref.make(false)
      const mailbox = yield* Semaphore.make(1)

      const codec =
        config.stateSchema !== undefined ? makePersistCodec(config.stateSchema) : undefined
      const persistState = (): Effect.Effect<void> =>
        Effect.gen(function* () {
          if (storage._tag !== "Some" || codec === undefined) return
          const state = yield* Ref.get(stateRef)
          const version = yield* Ref.get(versionRef)
          const encoded = codec.encode(state)
          yield* storage.value
            .saveExtensionState({
              sessionId: ctx.sessionId,
              extensionId: config.id,
              stateJson: encoded,
              version,
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
        ).pipe(Effect.catchDefect(() => Effect.void))

      const applyResult = (
        current: State,
        result: ReduceResult<State>,
        branchId: BranchId | undefined,
      ) =>
        Effect.gen(function* () {
          const changed = result.state !== current
          if (changed) {
            yield* Ref.set(stateRef, result.state)
            yield* Ref.update(versionRef, (version) => version + 1)
            if (config.persist === true) {
              yield* persistState().pipe(Effect.catchDefect(() => Effect.void))
            }
          }
          if (result.effects !== undefined && result.effects.length > 0) {
            yield* runEffects(result.effects, branchId)
          }
          return changed
        })

      const start = mailbox.withPermits(1)(
        Effect.gen(function* () {
          const started = yield* Ref.get(startedRef)
          if (started) return
          if (config.persist === true && storage._tag === "Some" && codec !== undefined) {
            const loaded = yield* storage.value
              .loadExtensionState({ sessionId: ctx.sessionId, extensionId: config.id })
              .pipe(Effect.catchEager(() => Effect.void.pipe(Effect.as(undefined))))
            if (loaded !== undefined) {
              const decoded = yield* codec
                .decode(loaded.stateJson)
                .pipe(Effect.catchEager(() => Effect.void.pipe(Effect.as(undefined))))
              if (decoded !== undefined) {
                yield* Ref.set(stateRef, decoded)
                yield* Ref.set(versionRef, loaded.version)
              }
            }
          }
          if (config.onInit !== undefined) {
            let sessionCwd: string | undefined
            if (storage._tag === "Some") {
              const session = yield* storage.value
                .getSession(ctx.sessionId)
                .pipe(Effect.catchEager(() => Effect.void.pipe(Effect.as(undefined))))
              sessionCwd = session?.cwd ?? undefined
            }
            yield* config.onInit({ sessionId: ctx.sessionId, stateRef, sessionCwd }).pipe(
              Effect.provideServices(services),
              Effect.catchEager(() => Effect.void),
            )
          }
          yield* Ref.set(startedRef, true)
        }),
      )

      yield* start

      return {
        id: config.id,
        start,

        publish: (event, reduceCtx) =>
          mailbox.withPermits(1)(
            Effect.gen(function* () {
              const current = yield* Ref.get(stateRef)
              const result = config.reduce(current, event, reduceCtx)
              return yield* applyResult(current, result, reduceCtx.branchId)
            }),
          ),

        send: (message: AnyExtensionCommandMessage, branchId?: BranchId) => {
          const receive = config.receive
          if (receive === undefined) return Effect.void
          return mailbox.withPermits(1)(
            Effect.gen(function* () {
              const decoded =
                config.messageSchema !== undefined
                  ? yield* Schema.decodeUnknownEffect(config.messageSchema as Schema.Any)(
                      message,
                    ).pipe(Effect.orDie)
                  : (message as Message)
              const current = yield* Ref.get(stateRef)
              const result = receive(current, decoded)
              yield* applyResult(current, result, branchId)
            }),
          )
        },

        ask: (message: AnyExtensionRequestMessage, branchId?: BranchId) => {
          const request = config.request
          if (request === undefined) {
            return Effect.die(
              new Error(`extension "${config.id}" does not handle request "${message._tag}"`),
            )
          }
          return mailbox.withPermits(1)(
            Effect.gen(function* () {
              const decoded =
                config.requestSchema !== undefined
                  ? yield* Schema.decodeUnknownEffect(config.requestSchema as Schema.Any)(
                      message,
                    ).pipe(Effect.orDie)
                  : (message as Request)
              const current = yield* Ref.get(stateRef)
              const result = yield* request(current, decoded).pipe(Effect.provideServices(services))
              yield* applyResult(current, result, branchId)
              return result.reply as never
            }),
          )
        },

        snapshot: Effect.gen(function* () {
          const state = yield* Ref.get(stateRef)
          const epoch = yield* Ref.get(versionRef)
          return { state, epoch }
        }),

        stop: Effect.void,
      }
    })

  const projection = buildProjectionConfig<State>({
    derive: config.derive,
    uiModelSchema: config.uiModelSchema,
  })

  return { spawn, projection }
}

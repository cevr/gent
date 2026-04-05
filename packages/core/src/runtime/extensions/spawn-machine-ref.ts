import { Effect, Ref } from "effect"
import { Machine, type ProvideSlots, type SlotCalls, type SlotsDef } from "effect-machine"
import type {
  ExtensionActorDefinition,
  ExtensionEffect,
  ExtensionRef,
} from "../../domain/extension.js"
import type { BranchId, SessionId } from "../../domain/ids.js"
import type {
  AnyExtensionCommandMessage,
  AnyExtensionRequestMessage,
  ExtensionProtocolError,
} from "../../domain/extension-protocol.js"
import { ExtensionProtocolError as ExtensionProtocolTaggedError } from "../../domain/extension-protocol.js"
import { Storage } from "../../storage/sqlite-storage.js"
import {
  CurrentExtensionSession,
  interpretEffects,
  makePersistCodec,
} from "./extension-actor-shared.js"
import { ExtensionTurnControl } from "./turn-control.js"

export const spawnMachineExtensionRef = <
  State extends { readonly _tag: string },
  Event extends { readonly _tag: string },
  SlotsR,
  SD extends SlotsDef = Record<string, never>,
>(
  extensionId: string,
  actor: ExtensionActorDefinition<State, Event, SlotsR, SD>,
  ctx: {
    readonly sessionId: SessionId
    readonly branchId?: BranchId
  },
): Effect.Effect<ExtensionRef, never, ExtensionTurnControl | SlotsR> =>
  Effect.withSpan("spawnMachineExtensionRef", { attributes: { "extension.id": extensionId } })(
    Effect.gen(function* () {
      const normalizeSlots = <Defs extends SlotsDef>(
        provided: ProvideSlots<Defs>,
      ): SlotCalls<Defs> => {
        const normalized = Object.fromEntries(
          Object.entries(provided).map(([name, handler]) => [
            name,
            (params: unknown) =>
              Effect.suspend(() => {
                const result = handler(params as never)
                return Effect.isEffect(result) ? result : Effect.succeed(result)
              }),
          ]),
        )
        return normalized as SlotCalls<Defs>
      }

      const turnControl = yield* ExtensionTurnControl
      const storage = yield* Effect.serviceOption(Storage)
      const versionRef = yield* Ref.make(0)
      const startedRef = yield* Ref.make(false)
      const protocolError = (
        tag: string,
        phase: "command" | "request" | "lifecycle",
        message: string,
      ): ExtensionProtocolError =>
        new ExtensionProtocolTaggedError({
          extensionId,
          tag,
          phase,
          message,
        })
      const ensureStarted = Effect.gen(function* () {
        const started = yield* Ref.get(startedRef)
        if (!started) {
          return yield* protocolError(
            "lifecycle",
            "lifecycle",
            `extension "${extensionId}" actor used before start()`,
          )
        }
      })

      const codec =
        actor.stateSchema !== undefined ? makePersistCodec(actor.stateSchema) : undefined

      let hydratedState: State | undefined
      let initialEpoch = 0
      if (actor.persist === true && storage._tag === "Some" && codec !== undefined) {
        const loaded = yield* storage.value
          .loadExtensionState({ sessionId: ctx.sessionId, extensionId })
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

      const providedSlots = actor.slots !== undefined ? yield* actor.slots(ctx) : undefined
      const slots = providedSlots !== undefined ? normalizeSlots(providedSlots) : undefined

      const machineRef = yield* Machine.spawn(actor.machine, {
        id: `${extensionId}-${ctx.sessionId}`,
        ...(hydratedState !== undefined ? { hydrate: hydratedState } : {}),
        ...(providedSlots !== undefined ? { slots: providedSlots } : {}),
      })

      const persistState = (): Effect.Effect<void> =>
        Effect.gen(function* () {
          if (storage._tag !== "Some" || codec === undefined) return
          const state = yield* machineRef.snapshot
          const version = yield* Ref.get(versionRef)
          const encoded = codec.encode(state)
          yield* storage.value
            .saveExtensionState({
              sessionId: ctx.sessionId,
              extensionId,
              stateJson: encoded,
              version,
            })
            .pipe(Effect.catchEager(() => Effect.void))
        })

      const runEffects = (
        effects: ReadonlyArray<ExtensionEffect>,
        branchId: BranchId | undefined,
      ) =>
        interpretEffects(effects, ctx.sessionId, branchId, {
          turnControl,
          persistFn: actor.persist === true ? persistState : undefined,
        }).pipe(
          Effect.catchDefect((defect) =>
            Effect.logWarning("extension effect interpretation defect").pipe(
              Effect.annotateLogs({ extensionId, defect: String(defect) }),
            ),
          ),
        )

      const dispatch = (machineEvent: Event, branchId: BranchId | undefined) =>
        Effect.gen(function* () {
          const result = yield* machineRef
            .call(machineEvent)
            .pipe(Effect.provideService(CurrentExtensionSession, { sessionId: ctx.sessionId }))
          const changed = result.transitioned && result.newState !== result.previousState
          if (!changed) {
            return {
              ...result,
              transitioned: false as const,
            }
          }
          yield* Ref.update(versionRef, (epoch) => epoch + 1)
          if (actor.persist === true) {
            yield* persistState().pipe(
              Effect.catchDefect((defect) =>
                Effect.logWarning("extension persist defect").pipe(
                  Effect.annotateLogs({ extensionId, defect: String(defect) }),
                ),
              ),
            )
          }
          if (actor.afterTransition !== undefined) {
            const effects = actor.afterTransition(result.previousState, result.newState)
            if (effects.length > 0) {
              yield* runEffects(effects, branchId)
            }
          }
          return {
            ...result,
            transitioned: true as const,
          }
        })

      const start = Effect.gen(function* () {
        const started = yield* Ref.get(startedRef)
        if (started) return
        yield* machineRef.start
        if (initialEpoch > 0) {
          yield* Ref.set(versionRef, initialEpoch)
        }
        if (actor.onInit !== undefined) {
          let sessionCwd: string | undefined
          if (storage._tag === "Some") {
            const session = yield* storage.value
              .getSession(ctx.sessionId)
              .pipe(Effect.catchEager(() => Effect.void.pipe(Effect.as(undefined))))
            sessionCwd = session?.cwd ?? undefined
          }
          yield* actor.onInit({
            sessionId: ctx.sessionId,
            snapshot: machineRef.snapshot,
            send: (event) =>
              dispatch(event, ctx.branchId).pipe(
                Effect.map((result) => result.transitioned),
                Effect.catchEager(() => Effect.succeed(false)),
              ),
            sessionCwd,
            slots,
          })
        }
        yield* Ref.set(startedRef, true)
      })

      const ref: ExtensionRef = {
        id: extensionId,
        start,
        publish: (event, reduceCtx) =>
          Effect.gen(function* () {
            yield* ensureStarted
            const mapped = actor.mapEvent?.(event)
            if (mapped === undefined) return false
            return (yield* dispatch(mapped, reduceCtx.branchId)).transitioned
          }),
        send: (message: AnyExtensionCommandMessage, branchId?: BranchId) =>
          Effect.gen(function* () {
            yield* ensureStarted
            const mapped = actor.mapCommand?.(message, yield* machineRef.snapshot)
            if (mapped === undefined) return
            yield* dispatch(mapped, branchId)
          }),
        ask: (message: AnyExtensionRequestMessage, branchId?: BranchId) =>
          Effect.gen(function* () {
            yield* ensureStarted
            const mapped = actor.mapRequest?.(message, yield* machineRef.snapshot)
            if (mapped === undefined) {
              return yield* protocolError(
                message._tag,
                "request",
                `extension "${extensionId}" does not handle request "${message._tag}"`,
              )
            }
            const result = yield* dispatch(mapped, branchId)
            if (!result.hasReply) {
              return yield* protocolError(
                message._tag,
                "request",
                `extension "${extensionId}" did not reply to request "${message._tag}"`,
              )
            }
            return result.reply as never
          }),
        snapshot: Effect.gen(function* () {
          yield* ensureStarted
          return {
            state: yield* machineRef.snapshot,
            epoch: yield* Ref.get(versionRef),
          }
        }),
        stop: machineRef.stop,
      }

      return ref
    }),
  )

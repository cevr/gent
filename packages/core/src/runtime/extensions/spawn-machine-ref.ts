import { Effect, Exit, Option, Ref, Scope } from "effect"
import { ActorScope, Machine, Slot, type Lifecycle, type SlotsDef } from "effect-machine"
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
import { ExtensionEventBus } from "./event-bus.js"

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
      const turnControl = yield* ExtensionTurnControl
      const storage = yield* Effect.serviceOption(Storage)
      const bus = yield* Effect.serviceOption(ExtensionEventBus)
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

      // Build lifecycle — Recovery replaces manual hydration, Durability replaces
      // manual persist. Durability.save fires for ALL transitions including
      // .spawn() internal self.send, fixing the epoch/persist gap.
      let loadedEpoch = 0
      const lifecycle: Lifecycle<State, Event> | undefined =
        storage._tag === "Some" && codec !== undefined
          ? {
              recovery: {
                resolve: () =>
                  Effect.gen(function* () {
                    const loaded = yield* storage.value
                      .loadExtensionState({ sessionId: ctx.sessionId, extensionId })
                      .pipe(Effect.catchEager(() => Effect.void.pipe(Effect.as(undefined))))
                    if (loaded === undefined) return Option.none<State>()
                    const decoded = yield* codec
                      .decode(loaded.stateJson)
                      .pipe(Effect.catchEager(() => Effect.void.pipe(Effect.as(undefined))))
                    if (decoded === undefined) return Option.none<State>()
                    loadedEpoch = loaded.version
                    return Option.some(decoded)
                  }).pipe(Effect.catchEager(() => Effect.succeed(Option.none<State>()))),
              },
              durability: {
                save: (commit) =>
                  Effect.gen(function* () {
                    const nextVersion = (yield* Ref.get(versionRef)) + 1
                    const encoded = codec.encode(commit.nextState)
                    yield* storage.value.saveExtensionState({
                      sessionId: ctx.sessionId,
                      extensionId,
                      stateJson: encoded,
                      version: nextVersion,
                    })
                    // Increment epoch only after successful save — keeps runtime
                    // consistent with storage if save fails
                    yield* Ref.set(versionRef, nextVersion)
                  }).pipe(
                    Effect.catchEager((e) =>
                      Effect.logWarning("extension persist failed").pipe(
                        Effect.annotateLogs({ extensionId, error: String(e) }),
                      ),
                    ),
                    Effect.catchDefect((defect) =>
                      Effect.logWarning("extension persist defect").pipe(
                        Effect.annotateLogs({ extensionId, defect: String(defect) }),
                      ),
                    ),
                  ),
                shouldSave: (nextState, previousState) => nextState !== previousState,
              },
            }
          : undefined

      const providedSlots = actor.slots !== undefined ? yield* actor.slots(ctx) : undefined
      const slots =
        providedSlots !== undefined && actor.machine.slotsSchema !== undefined
          ? Slot.of(actor.machine.slotsSchema, providedSlots)
          : undefined

      // Provide a dedicated ActorScope so Machine.spawn attaches cleanup to it.
      // Extension actors are long-lived and managed explicitly by
      // WorkflowRuntime.terminateAll.
      const actorScope = yield* Scope.make()
      const machineRef = yield* Machine.spawn(actor.machine, {
        id: `${extensionId}-${ctx.sessionId}`,
        ...(providedSlots !== undefined ? { slots: providedSlots } : {}),
        ...(lifecycle !== undefined ? { lifecycle } : {}),
      }).pipe(Effect.provideService(ActorScope, actorScope))

      const runEffects = (
        effects: ReadonlyArray<ExtensionEffect>,
        branchId: BranchId | undefined,
      ) =>
        interpretEffects(effects, ctx.sessionId, branchId, {
          turnControl,
          busEmit:
            bus._tag === "Some"
              ? (channel, payload) =>
                  bus.value.emit({
                    channel,
                    payload,
                    sessionId: ctx.sessionId,
                    branchId,
                  })
              : undefined,
        }).pipe(
          Effect.catchDefect((defect) =>
            Effect.logWarning("extension effect interpretation defect").pipe(
              Effect.annotateLogs({ extensionId, defect: String(defect) }),
            ),
          ),
        )

      const dispatch = (
        machineEvent: Event,
        branchId: BranchId | undefined,
        mode: "normal" | "hydrate" = "normal",
      ) =>
        Effect.gen(function* () {
          const result = yield* machineRef
            .call(machineEvent)
            .pipe(Effect.provideService(CurrentExtensionSession, { sessionId: ctx.sessionId }))
          yield* Effect.logWarning("extension.actor.dispatch").pipe(
            Effect.annotateLogs({
              extensionId,
              eventTag: (machineEvent as { readonly _tag?: string })._tag,
              transitioned: result.transitioned,
              hasReply: result.hasReply,
              newStateEqPrev: result.newState === result.previousState,
            }),
          )
          const changed = result.transitioned && result.newState !== result.previousState
          if (!changed) {
            return {
              ...result,
              transitioned: false as const,
            }
          }
          // Epoch increment for non-durable actors. Durable actors increment
          // inside lifecycle.durability.save (which also fires for .spawn() internal transitions).
          if (lifecycle === undefined) {
            yield* Ref.update(versionRef, (epoch) => epoch + 1)
          }

          // Skip side effects during hydrate — replay is state reconstruction only
          if (mode === "normal" && actor.afterTransition !== undefined) {
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
        if (loadedEpoch > 0) {
          yield* Ref.set(versionRef, loadedEpoch)
        }
        if (actor.onInit !== undefined) {
          let sessionCwd: string | undefined
          let parentSessionId: string | undefined
          if (storage._tag === "Some") {
            const session = yield* storage.value
              .getSession(ctx.sessionId)
              .pipe(Effect.catchEager(() => Effect.void.pipe(Effect.as(undefined))))
            sessionCwd = session?.cwd ?? undefined
            parentSessionId = session?.parentSessionId ?? undefined
          }
          yield* actor.onInit({
            sessionId: ctx.sessionId,
            snapshot: machineRef.snapshot,
            send: (event) =>
              dispatch(event, ctx.branchId, "hydrate").pipe(
                Effect.map((result) => result.transitioned),
                Effect.catchEager(() => Effect.succeed(false)),
              ),
            sessionCwd,
            // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
            parentSessionId: parentSessionId as typeof ctx.sessionId | undefined,
            getSessionAncestors: () =>
              storage._tag === "Some"
                ? storage.value
                    .getSessionAncestors(ctx.sessionId)
                    .pipe(Effect.catchEager(() => Effect.succeed([])))
                : Effect.succeed([]),
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
            const snapshot = yield* machineRef.snapshot
            const mapped = actor.mapRequest?.(message, snapshot)
            if (mapped === undefined) {
              yield* Effect.logWarning("extension.actor.ask.unmapped").pipe(
                Effect.annotateLogs({
                  extensionId,
                  tag: message._tag,
                  messageExtensionId: message.extensionId,
                  hasMapRequest: actor.mapRequest !== undefined,
                  stateTag: (snapshot as { readonly _tag?: string })._tag,
                }),
              )
              return yield* protocolError(
                message._tag,
                "request",
                `extension "${extensionId}" does not handle request "${message._tag}"`,
              )
            }
            const result = yield* dispatch(mapped, branchId)
            if (!result.hasReply) {
              yield* Effect.logWarning("extension.actor.ask.no-reply").pipe(
                Effect.annotateLogs({
                  extensionId,
                  tag: message._tag,
                  transitioned: result.transitioned,
                  mappedTag: (mapped as { readonly _tag?: string })._tag,
                }),
              )
              return yield* protocolError(
                message._tag,
                "request",
                `extension "${extensionId}" did not reply to request "${message._tag}"`,
              )
            }
            // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
            return result.reply as never
          }),
        snapshot: Effect.gen(function* () {
          yield* ensureStarted
          return {
            state: yield* machineRef.snapshot,
            epoch: yield* Ref.get(versionRef),
          }
        }),
        stop: machineRef.stop.pipe(Effect.andThen(Scope.close(actorScope, Exit.void))),
      }

      return ref
    }),
  )

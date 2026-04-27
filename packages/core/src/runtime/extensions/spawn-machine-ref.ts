import { Effect, Exit, Option, Ref, Schema, Scope, type Schema as S } from "effect"
import {
  ActorScope,
  Machine,
  Slot,
  type Lifecycle,
  type ProvideSlots,
  type SlotCalls,
  type SlotsDef,
} from "effect-machine"
import type { ExtensionRef, ExtensionEffect } from "../../domain/extension.js"
import { ExtensionId, type BranchId, type SessionId } from "../../domain/ids.js"
import type { AgentEvent } from "../../domain/event.js"
import type {
  AnyExtensionCommandMessage,
  AnyExtensionRequestMessage,
  ExtensionProtocolError,
} from "../../domain/extension-protocol.js"

/** Local FSM-machine type — kept until B4 deletes MachineEngine + the FSM
 *  spawn path. Public `Resource.machine` type was removed in W10-PhaseB/B3
 *  but `spawnMachineExtensionRef` still typechecks against the same shape
 *  so the unreachable FSM dispatch path doesn't lose its type guarantees
 *  before deletion. */
interface ResourceMachineInitContext<State, Event, SD extends SlotsDef> {
  readonly sessionId: SessionId
  readonly snapshot: Effect.Effect<State>
  readonly send: (event: Event) => Effect.Effect<boolean>
  readonly sessionCwd?: string
  readonly parentSessionId?: SessionId
  readonly getSessionAncestors: () => Effect.Effect<ReadonlyArray<{ readonly id: string }>>
  readonly slots?: SlotCalls<SD>
}
interface ResourceMachine<
  State extends { readonly _tag: string },
  Event extends { readonly _tag: string },
  SlotsR,
  SD extends SlotsDef,
> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- structural compat with deleted public type
  readonly machine: Machine.Machine<State, Event, never, any, any, SD>
  readonly slots?: (ctx: {
    readonly sessionId: SessionId
    readonly branchId?: BranchId
  }) => Effect.Effect<ProvideSlots<SD>, never, SlotsR>
  readonly mapEvent?: (event: AgentEvent) => Event | undefined
  readonly mapCommand?: (message: AnyExtensionCommandMessage, state: State) => Event | undefined
  readonly mapRequest?: (message: AnyExtensionRequestMessage, state: State) => Event | undefined
  readonly afterTransition?: (before: State, after: State) => ReadonlyArray<ExtensionEffect>
  readonly stateSchema?: S.Schema<State>
  readonly protocols?: Readonly<Record<string, unknown>>
  readonly onInit?: (ctx: ResourceMachineInitContext<State, Event, SD>) => Effect.Effect<void>
}
import { ExtensionProtocolError as ExtensionProtocolTaggedError } from "../../domain/extension-protocol.js"
import { Storage } from "../../storage/sqlite-storage.js"
import {
  CurrentExtensionSession,
  interpretEffects,
  makePersistCodec,
} from "./extension-actor-shared.js"
import type { RuntimeExtensionEffect } from "./runtime-effect.js"
import { ExtensionTurnControl } from "./turn-control.js"
import { SubscriptionEngine } from "./resource-host/subscription-engine.js"

export class ExtensionPersistenceFailure extends Schema.TaggedErrorClass<ExtensionPersistenceFailure>()(
  "ExtensionPersistenceFailure",
  {
    extensionId: ExtensionId,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export const spawnMachineExtensionRef = <
  State extends { readonly _tag: string },
  Event extends { readonly _tag: string },
  SlotsR,
  SD extends SlotsDef = Record<string, never>,
>(
  extensionId: ExtensionId,
  actor: ResourceMachine<State, Event, SlotsR, SD>,
  ctx: {
    readonly sessionId: SessionId
    readonly branchId?: BranchId
  },
): Effect.Effect<ExtensionRef, never, ExtensionTurnControl | SlotsR> =>
  Effect.withSpan("spawnMachineExtensionRef", { attributes: { "extension.id": extensionId } })(
    Effect.gen(function* () {
      const turnControl = yield* ExtensionTurnControl
      const storage = yield* Effect.serviceOption(Storage)
      const bus = yield* Effect.serviceOption(SubscriptionEngine)
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
                    yield* storage.value
                      .saveExtensionState({
                        sessionId: ctx.sessionId,
                        extensionId,
                        stateJson: encoded,
                        version: nextVersion,
                      })
                      .pipe(
                        Effect.mapError(
                          (error) =>
                            new ExtensionPersistenceFailure({
                              extensionId,
                              message: `extension "${extensionId}" persistence failed`,
                              cause: error,
                            }),
                        ),
                        Effect.orDie,
                      )
                    // Increment epoch only after successful save — keeps runtime
                    // consistent with storage if save fails
                    yield* Ref.set(versionRef, nextVersion)
                  }),
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
      // MachineEngine.terminateAll.
      const actorScope = yield* Scope.make()
      const machineRef = yield* Machine.spawn(actor.machine, {
        id: `${extensionId}-${ctx.sessionId}`,
        ...(providedSlots !== undefined ? { slots: providedSlots } : {}),
        ...(lifecycle !== undefined ? { lifecycle } : {}),
      }).pipe(Effect.provideService(ActorScope, actorScope))

      const runEffects = (
        effects: ReadonlyArray<RuntimeExtensionEffect>,
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
          Effect.catchTag("TurnControlError", (error) => Effect.die(error)),
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
            // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- runtime internal owns erased generic boundary
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
        execute: (message: AnyExtensionRequestMessage, branchId?: BranchId) =>
          Effect.gen(function* () {
            yield* ensureStarted
            const snapshot = yield* machineRef.snapshot
            const mapped = actor.mapRequest?.(message, snapshot)
            if (mapped === undefined) {
              yield* Effect.logWarning("extension.actor.execute.unmapped").pipe(
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
              yield* Effect.logWarning("extension.actor.execute.no-reply").pipe(
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
            // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- runtime internal owns erased generic boundary
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

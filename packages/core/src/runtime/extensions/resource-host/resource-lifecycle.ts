/**
 * One scoped Resource lifecycle.
 *
 * The machine owns lifecycle phases. The owned Scope owns the Layer context
 * and its cleanup. A lifecycle instance is single-use: replacement creates a
 * new instance instead of reactivating a retired one.
 *
 * @module
 */

import { Cause, Context, Effect, Exit, Layer, Option, Predicate, Ref, Schema, Scope } from "effect"
import { ActorScope, Event, Machine, State } from "effect-machine"
import { ResourceId, ResourceRevision } from "../../../domain/resource-graph.js"

const LifecyclePhase = Schema.Literals(["load", "start", "stop", "release", "actor", "retired"])
type LifecyclePhase = typeof LifecyclePhase.Type

/** A failure reported by a lifecycle operation. */
export class ResourceLifecycleError extends Schema.TaggedError<ResourceLifecycleError>()(
  "ResourceLifecycleError",
  {
    id: ResourceId,
    revision: ResourceRevision,
    phase: LifecyclePhase,
    message: Schema.String,
  },
) {}

/** The serializable state exposed by a resource lifecycle actor. */
export const ResourceLifecycleState = State({
  Inactive: {},
  Loading: {},
  Active: {},
  Stopping: {},
  Retired: {},
  Failed: {
    phase: LifecyclePhase,
    message: Schema.String,
  },
})
export type ResourceLifecycleSnapshot = typeof ResourceLifecycleState.Type

const LifecycleReply = Schema.TaggedUnion({
  Activated: {},
  AlreadyActive: {},
  Retired: {},
  AlreadyRetired: {},
  Rejected: {
    phase: LifecyclePhase,
    message: Schema.String,
  },
  Failed: {
    phase: LifecyclePhase,
    message: Schema.String,
  },
})
type LifecycleReply = typeof LifecycleReply.Type

const ResourceLifecycleEvent = Event({
  Activate: Event.reply({}, LifecycleReply),
  Retire: Event.reply({}, LifecycleReply),
  Loaded: {},
  LoadFailed: {
    phase: LifecyclePhase,
    message: Schema.String,
  },
  Stopped: {},
  StopFailed: {
    phase: LifecyclePhase,
    message: Schema.String,
  },
})
type ResourceLifecycleEvent = typeof ResourceLifecycleEvent.Type

const isRetiredOrFailed = Predicate.or(Predicate.isTagged("Retired"), Predicate.isTagged("Failed"))

/** The immutable inputs captured by one lifecycle instance. */
export interface ResourceLifecycleSpec<
  A,
  LayerError,
  LayerRequirements,
  StartError = LayerError,
  StartRequirements = never,
  StopError = StartError,
  StopRequirements = never,
> {
  readonly id: ResourceId
  readonly revision: ResourceRevision
  readonly layer: Layer.Layer<A, LayerError, LayerRequirements>
  readonly start?: Effect.Effect<
    void,
    StartError,
    A | LayerRequirements | StartRequirements | Scope.Scope
  >
  readonly stop?: Effect.Effect<
    void,
    StopError,
    A | LayerRequirements | StopRequirements | Scope.Scope
  >
}

export interface ResourceLifecycle<A> {
  readonly id: ResourceId
  readonly revision: ResourceRevision
  readonly activate: Effect.Effect<void, ResourceLifecycleError>
  readonly retire: Effect.Effect<void, ResourceLifecycleError>
  readonly snapshot: Effect.Effect<ResourceLifecycleSnapshot>
  readonly current: Effect.Effect<Option.Option<Context.Context<A>>>
}

type ResourceRequirements<LayerRequirements, StartRequirements, StopRequirements> =
  | LayerRequirements
  | StartRequirements
  | StopRequirements
  | Scope.Scope

const causeMessage = (cause: Cause.Cause<unknown>): string => Cause.pretty(cause)

const exitMessage = (exit: Exit.Exit<unknown, unknown>): Option.Option<string> => {
  if (Exit.isFailure(exit)) return Option.some(causeMessage(exit.cause))
  return Option.none()
}

const optionExitMessage = (
  exit: Option.Option<Exit.Exit<unknown, unknown>>,
): Option.Option<string> => {
  if (Option.isSome(exit)) return exitMessage(exit.value)
  return Option.none()
}

const combineMessages = (messages: ReadonlyArray<Option.Option<string>>): string => {
  const values: Array<string> = []
  for (const message of messages) {
    if (Option.isSome(message)) values.push(message.value)
  }
  return values.join("\n")
}

const errorForReply = (
  id: ResourceId,
  revision: ResourceRevision,
  reply: LifecycleReply,
): Effect.Effect<void, ResourceLifecycleError> => {
  switch (reply._tag) {
    case "Activated":
    case "AlreadyActive":
    case "Retired":
    case "AlreadyRetired":
      return Effect.void
    case "Rejected":
      return Effect.fail(
        new ResourceLifecycleError({
          id,
          revision,
          phase: reply.phase,
          message: reply.message,
        }),
      )
    case "Failed":
      return Effect.fail(
        new ResourceLifecycleError({
          id,
          revision,
          phase: reply.phase,
          message: reply.message,
        }),
      )
  }
}

/**
 * Creates one single-use lifecycle actor and its owned acquisition scope.
 *
 * The returned Effect must run in a parent Scope. Closing that parent retires
 * the lifecycle when possible and then closes its acquisition scope.
 */
export const makeResourceLifecycle = <
  A,
  LayerError,
  LayerRequirements,
  StartError = LayerError,
  StartRequirements = never,
  StopError = StartError,
  StopRequirements = never,
>(
  spec: ResourceLifecycleSpec<
    A,
    LayerError,
    LayerRequirements,
    StartError,
    StartRequirements,
    StopError,
    StopRequirements
  >,
): Effect.Effect<
  ResourceLifecycle<A>,
  never,
  ResourceRequirements<LayerRequirements, StartRequirements, StopRequirements>
> =>
  Effect.gen(function* () {
    const { id, revision, layer, start, stop } = spec
    const ownedLayer = Layer.fresh(layer)
    const startEffect = Option.fromNullishOr(start)
    const stopEffect = Option.fromNullishOr(stop)
    const parentScope = yield* Scope.Scope
    const capturedContext =
      yield* Effect.context<
        ResourceRequirements<LayerRequirements, StartRequirements, StopRequirements>
      >()
    const activeContext = yield* Ref.make<Option.Option<Context.Context<A>>>(Option.none())
    const stopExit = yield* Ref.make<Option.Option<Exit.Exit<unknown, unknown>>>(Option.none())
    const resourceCleanupError = yield* Ref.make<Option.Option<string>>(Option.none())

    let resourceScope: Scope.Closeable
    let actorScope: Scope.Closeable

    const closeResourceScope = (exit: Exit.Exit<unknown, unknown>) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const closeExit = yield* Scope.close(resourceScope, exit).pipe(Effect.exit)
          const registeredStopExit = yield* Ref.get(stopExit)
          const stopMessage = optionExitMessage(registeredStopExit)
          const closeMessage = exitMessage(closeExit)
          if (Option.isSome(closeMessage)) {
            yield* Ref.set(resourceCleanupError, closeMessage)
          }
          const messages: Array<Option.Option<string>> = []
          let phase: Option.Option<"stop" | "release"> = Option.none()
          if (Option.isSome(stopMessage)) {
            messages.push(Option.some(`stop: ${stopMessage.value}`))
            phase = Option.some("stop")
          }
          if (Option.isSome(closeMessage)) {
            messages.push(Option.some(`release: ${closeMessage.value}`))
            if (Option.isNone(phase)) phase = Option.some("release")
          }
          return {
            message: combineMessages(messages),
            phase,
          }
        }),
      )

    const machine = Machine.make({
      state: ResourceLifecycleState,
      event: ResourceLifecycleEvent,
      initial: ResourceLifecycleState.Inactive,
    })
      .on(ResourceLifecycleState.Inactive, ResourceLifecycleEvent.Activate, () =>
        Machine.deferReply(ResourceLifecycleState.Loading),
      )
      .on(ResourceLifecycleState.Inactive, ResourceLifecycleEvent.Retire, () =>
        Machine.reply(ResourceLifecycleState.Retired, LifecycleReply.cases.Retired.make({})),
      )
      .on(
        ResourceLifecycleState.Loading,
        ResourceLifecycleEvent.Loaded,
        () => ResourceLifecycleState.Active,
      )
      .on(ResourceLifecycleState.Loading, ResourceLifecycleEvent.LoadFailed, ({ event }) =>
        ResourceLifecycleState.Failed({ phase: event.phase, message: event.message }),
      )
      .on(ResourceLifecycleState.Active, ResourceLifecycleEvent.Activate, () =>
        Machine.reply(ResourceLifecycleState.Active, LifecycleReply.cases.AlreadyActive.make({})),
      )
      .on(ResourceLifecycleState.Active, ResourceLifecycleEvent.Retire, () =>
        Machine.deferReply(ResourceLifecycleState.Stopping),
      )
      .on(
        ResourceLifecycleState.Stopping,
        ResourceLifecycleEvent.Stopped,
        () => ResourceLifecycleState.Retired,
      )
      .on(ResourceLifecycleState.Stopping, ResourceLifecycleEvent.StopFailed, ({ event }) =>
        ResourceLifecycleState.Failed({ phase: event.phase, message: event.message }),
      )
      .on(ResourceLifecycleState.Retired, ResourceLifecycleEvent.Activate, () =>
        Machine.reply(
          ResourceLifecycleState.Retired,
          LifecycleReply.cases.Rejected.make({
            phase: "retired",
            message: "Resource lifecycle is retired",
          }),
        ),
      )
      .on(ResourceLifecycleState.Retired, ResourceLifecycleEvent.Retire, () =>
        Machine.reply(ResourceLifecycleState.Retired, LifecycleReply.cases.AlreadyRetired.make({})),
      )
      .on(ResourceLifecycleState.Failed, ResourceLifecycleEvent.Activate, ({ state }) =>
        Machine.reply(
          ResourceLifecycleState.Failed.with(state),
          LifecycleReply.cases.Rejected.make({ phase: state.phase, message: state.message }),
        ),
      )
      .on(ResourceLifecycleState.Failed, ResourceLifecycleEvent.Retire, ({ state }) =>
        Machine.reply(
          ResourceLifecycleState.Failed.with(state),
          LifecycleReply.cases.Failed.make({ phase: state.phase, message: state.message }),
        ),
      )
      .postpone(ResourceLifecycleState.Loading, [
        ResourceLifecycleEvent.Activate,
        ResourceLifecycleEvent.Retire,
      ])
      .postpone(ResourceLifecycleState.Stopping, [
        ResourceLifecycleEvent.Activate,
        ResourceLifecycleEvent.Retire,
      ])
      .spawn(ResourceLifecycleState.Active, ({ self }) =>
        self.reply(LifecycleReply.cases.Activated.make({})).pipe(Effect.asVoid),
      )
      .spawn(ResourceLifecycleState.Retired, ({ self }) =>
        self.reply(LifecycleReply.cases.Retired.make({})).pipe(Effect.asVoid),
      )
      .spawn(ResourceLifecycleState.Failed, ({ self, state }) =>
        self
          .reply(LifecycleReply.cases.Failed.make({ phase: state.phase, message: state.message }))
          .pipe(Effect.asVoid),
      )
      .spawn(ResourceLifecycleState.Loading, ({ self }) =>
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const built = yield* restore(
              Layer.buildWithScope(ownedLayer, resourceScope).pipe(
                Effect.provideContext(capturedContext),
              ),
            ).pipe(Effect.exit)

            if (Exit.isFailure(built)) {
              const cleanup = yield* closeResourceScope(built)
              yield* Ref.set(activeContext, Option.none())
              yield* self.send(
                ResourceLifecycleEvent.LoadFailed({
                  phase: "load",
                  message: combineMessages([exitMessage(built), Option.some(cleanup.message)]),
                }),
              )
              return
            }

            const context = built.value
            const serviceContext = Context.merge(capturedContext, context)
            const startContext = Context.add(serviceContext, Scope.Scope, resourceScope)
            let started: Exit.Exit<void, StartError> = Exit.succeed(void 0)
            if (Option.isSome(startEffect)) {
              started = yield* restore(Effect.provideContext(startEffect.value, startContext)).pipe(
                Effect.exit,
              )
            }

            if (Exit.isFailure(started)) {
              const cleanup = yield* closeResourceScope(started)
              yield* Ref.set(activeContext, Option.none())
              yield* self.send(
                ResourceLifecycleEvent.LoadFailed({
                  phase: "start",
                  message: combineMessages([exitMessage(started), Option.some(cleanup.message)]),
                }),
              )
              return
            }

            yield* Ref.set(activeContext, Option.some(context))
            if (Option.isSome(stopEffect)) {
              yield* Scope.addFinalizer(
                resourceScope,
                Effect.provideContext(Effect.scoped(stopEffect.value), serviceContext)
                  .pipe(Effect.exit)
                  .pipe(Effect.flatMap((exit) => Ref.set(stopExit, Option.some(exit)))),
              )
            }
            yield* self.send(ResourceLifecycleEvent.Loaded)
          }),
        ),
      )
      .spawn(ResourceLifecycleState.Stopping, ({ self }) =>
        Effect.uninterruptible(
          Effect.gen(function* () {
            const cleanup = yield* closeResourceScope(Exit.void)
            yield* Ref.set(activeContext, Option.none())
            if (cleanup.message.length > 0) {
              let phase: LifecyclePhase = "stop"
              if (Option.isSome(cleanup.phase)) phase = cleanup.phase.value
              yield* self.send(
                ResourceLifecycleEvent.StopFailed({
                  phase,
                  message: cleanup.message,
                }),
              )
            } else {
              yield* self.send(ResourceLifecycleEvent.Stopped)
            }
          }),
        ),
      )

    const actor = yield* Effect.uninterruptibleMask(() =>
      Effect.gen(function* () {
        resourceScope = yield* Scope.make("sequential")
        actorScope = yield* Scope.make("sequential")
        const closeSetupScopes = (cause: Cause.Cause<unknown>) =>
          Effect.uninterruptible(
            Effect.gen(function* () {
              const actorClosed = yield* Scope.close(actorScope, Exit.failCause(cause)).pipe(
                Effect.exit,
              )
              const resourceClosed = yield* Scope.close(resourceScope, Exit.failCause(cause)).pipe(
                Effect.exit,
              )
              let combined = cause
              if (Exit.isFailure(actorClosed)) combined = Cause.combine(combined, actorClosed.cause)
              if (Exit.isFailure(resourceClosed)) {
                combined = Cause.combine(combined, resourceClosed.cause)
              }
              return yield* Effect.die(new Error(Cause.pretty(combined)))
            }),
          )
        const spawned = yield* Machine.spawn(machine, { id: String(id) }).pipe(
          Effect.provideService(ActorScope, actorScope),
          Effect.exit,
        )
        if (Exit.isFailure(spawned)) return yield* closeSetupScopes(spawned.cause)
        const actor = spawned.value
        const started = yield* actor.start.pipe(Effect.exit)
        if (Exit.isFailure(started)) return yield* closeSetupScopes(started.cause)
        const cleanup = (exit: Exit.Exit<unknown, unknown>) =>
          Effect.uninterruptible(
            Effect.gen(function* () {
              const failures: Array<string> = []
              const recordMessage = (message: string): void => {
                if (!failures.includes(message)) failures.push(message)
              }
              const recordExit = (exit: Exit.Exit<unknown, unknown>): void => {
                const message = exitMessage(exit)
                if (Option.isSome(message)) recordMessage(message.value)
              }
              const state = yield* actor.snapshot
              switch (state._tag) {
                case "Active": {
                  const retired = yield* actor.ask(ResourceLifecycleEvent.Retire).pipe(Effect.exit)
                  recordExit(retired)
                  if (Exit.isSuccess(retired) && retired.value._tag === "Failed") {
                    recordMessage(retired.value.message)
                  }
                  break
                }
                case "Stopping": {
                  const stopped = yield* actor.waitFor(isRetiredOrFailed).pipe(Effect.exit)
                  recordExit(stopped)
                  if (Exit.isSuccess(stopped) && stopped.value._tag === "Failed") {
                    recordMessage(stopped.value.message)
                  }
                  break
                }
              }
              const actorClosed = yield* Scope.close(actorScope, exit).pipe(Effect.exit)
              recordExit(actorClosed)
              const resourceClosed = yield* Scope.close(resourceScope, exit).pipe(Effect.exit)
              recordExit(resourceClosed)
              const registeredStopExit = yield* Ref.get(stopExit)
              if (Option.isSome(registeredStopExit)) recordExit(registeredStopExit.value)
              const cleanupError = yield* Ref.get(resourceCleanupError)
              if (Option.isSome(cleanupError)) recordMessage(cleanupError.value)
              if (failures.length > 0) {
                return yield* Effect.die(
                  new ResourceLifecycleError({
                    id,
                    revision,
                    phase: "actor",
                    message: failures.join("\n"),
                  }),
                )
              }
            }),
          )
        yield* Scope.addFinalizerExit(parentScope, cleanup)
        return actor
      }),
    )

    const ask = (
      event: typeof ResourceLifecycleEvent.Activate | typeof ResourceLifecycleEvent.Retire,
    ) =>
      actor.ask(event).pipe(
        Effect.mapError(
          (error) =>
            new ResourceLifecycleError({
              id,
              revision,
              phase: "actor",
              message: String(error),
            }),
        ),
      )

    return {
      id,
      revision,
      activate: ask(ResourceLifecycleEvent.Activate).pipe(
        Effect.flatMap((reply) => errorForReply(id, revision, reply)),
      ),
      retire: ask(ResourceLifecycleEvent.Retire).pipe(
        Effect.flatMap((reply) => errorForReply(id, revision, reply)),
      ),
      snapshot: actor.snapshot,
      current: Effect.gen(function* () {
        const state = yield* actor.snapshot
        if (state._tag !== "Active") return Option.none()
        return yield* Ref.get(activeContext)
      }),
    } satisfies ResourceLifecycle<A>
  })

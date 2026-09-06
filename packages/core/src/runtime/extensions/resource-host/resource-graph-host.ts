/**
 * Local live resource graph reconciliation.
 *
 * The host owns graph admission and publication. ResourceLifecycle owns one
 * resource's scopes and local state. A publication owns one generation lease
 * set and one stage scope.
 *
 * @module
 */

import {
  Cause,
  Context,
  Deferred,
  Effect,
  Exit,
  Match,
  Option,
  Predicate,
  Result,
  Schema,
  Scope,
  Semaphore,
} from "effect"
import type { AnyResourceContribution } from "../../../domain/resource.js"
import {
  ResourceId,
  diffResourceGraph,
  planResourceGraph,
  type ResourceGraphError,
  type ResourceDescriptor,
  type ResourceGraphDiff,
  type ResourcePlan,
  type ResourceRevision,
} from "../../../domain/resource-graph.js"
import { ResourceGenerationId } from "../../../domain/resource-generation.js"
import { eraseResourceLayer, sealErasedEffect } from "../extension-effect-membrane.js"
import {
  makeResourceLeaseSet,
  type ResourceLeaseAdmissionError,
  type ResourceLeaseSet,
} from "./resource-leases.js"
import {
  makeResourceLifecycle,
  type ResourceLifecycle,
  type ResourceLifecycleSpec,
} from "./resource-lifecycle.js"
import { GentPlatform } from "../../gent-platform.js"

/** Failure phases reported by one graph reconciliation attempt. */
const ResourceGraphFailurePhase = Schema.Literals([
  "validate",
  "stop",
  "start",
  "stage",
  "release",
  "closed",
])
type ResourceGraphFailurePhase = typeof ResourceGraphFailurePhase.Type

/** One failure receipt from graph validation, staging, or cleanup. */
export const ResourceGraphFailure = Schema.Struct({
  id: Schema.NullOr(ResourceId),
  phase: ResourceGraphFailurePhase,
  message: Schema.String,
})
export type ResourceGraphFailure = typeof ResourceGraphFailure.Type

/** A graph change did not produce a new callable publication. */
export class ResourceGraphHostError extends Schema.TaggedError<ResourceGraphHostError>()(
  "ResourceGraphHostError",
  {
    failures: Schema.Array(ResourceGraphFailure),
    retained: Schema.Array(ResourceId),
    unavailable: Schema.Array(ResourceId),
  },
) {}

class ResourceGraphLifecycleError extends Schema.TaggedError<ResourceGraphLifecycleError>()(
  "ResourceGraphLifecycleError",
  { message: Schema.String },
) {}

/** Inputs supplied to one generic catalog staging callback. */
export interface ResourceGraphStageInput<Payload> {
  readonly generationId: ResourceGenerationId
  readonly publicationRevision: ResourceRevision
  readonly plan: ResourcePlan
  readonly payload: Payload
  /** The immutable context assembled for this staged publication. */
  readonly context: Context.Context<unknown>
}

/** One immutable, generation-bound publication. */
export interface ResourceGraphPublication<Catalog> {
  readonly generationId: ResourceGenerationId
  readonly publicationRevision: ResourceRevision
  readonly plan: ResourcePlan
  readonly value: Catalog
  /**
   * Admit work against this exact generation and provide its resource context.
   * The lease owns a fresh scope, so the count includes all use finalizers.
   */
  readonly run: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | ResourceLeaseAdmissionError, never>
}

/** Options for one host's catalog stage callback. */
export interface ResourceGraphHostOptions {
  readonly baseContext?: Context.Context<unknown>
}

/** The local reconciliation owner. */
export interface ResourceGraphHost<Catalog> {
  readonly apply: <Payload>(
    input: ResourceGraphApplyInput<Catalog, Payload>,
  ) => Effect.Effect<ResourceGraphPublication<Catalog>, ResourceGraphHostError>
  readonly current: Effect.Effect<Option.Option<ResourceGraphPublication<Catalog>>>
  readonly shutdown: Effect.Effect<void, ResourceGraphHostError>
}

/** Desired declarations and the semantic catalog revision they expose. */
export interface ResourceGraphApplyInput<Catalog, Payload> {
  readonly publicationRevision: ResourceRevision
  readonly payload: Payload
  readonly retireMode: ResourceGraphRetireMode
  readonly resources: ReadonlyArray<AnyResourceContribution>
  /**
   * Final desired-state admission check. The host invokes this after it owns
   * the reconciliation semaphore and before it retires or starts resources.
   */
  readonly admit?: Effect.Effect<void, ResourceGraphHostError>
  readonly stage: (
    input: ResourceGraphStageInput<Payload>,
  ) => Effect.Effect<Catalog, ResourceGraphHostError, Scope.Scope>
}

interface ResourceHandle {
  readonly id: ResourceId
  readonly revision: ResourceDescriptor["revision"]
  readonly resource: AnyResourceContribution
  readonly lifecycle: ResourceLifecycle<unknown>
  readonly scope: Scope.Closeable
  context: Context.Context<unknown>
  active: boolean
  closeExit: Exit.Exit<unknown, unknown>
}

interface ResourceGeneration<Catalog> {
  readonly leases: ResourceLeaseSet
  readonly publicationScope: Scope.Closeable
  readonly publication: ResourceGraphPublication<Catalog>
}

interface ResourceReconciliation {
  readonly nextPlan: ResourcePlan
  readonly nextDeclarationOrder: ReadonlyArray<ResourceId>
  // oxlint-disable-next-line effect/noNullish -- The first apply has no previous plan.
  readonly previousPlan: ResourcePlan | undefined
  readonly resourcesInDeclarationOrder: ReadonlyArray<AnyResourceContribution>
  readonly resourcesById: ReadonlyMap<ResourceId, AnyResourceContribution>
  readonly descriptorsById: ReadonlyMap<ResourceId, ResourceDescriptor>
  readonly stopIds: ReadonlyArray<ResourceId>
  readonly startIds: ReadonlyArray<ResourceId>
}

interface ResourceStartResult {
  readonly failures: ReadonlyArray<ResourceGraphFailure>
  readonly newHandles: ReadonlyArray<ResourceHandle>
}

interface ResourceRetirementResult {
  readonly failures: ReadonlyArray<ResourceGraphFailure>
  readonly shutdownRequested: boolean
}

interface StagedPublication<Catalog> {
  readonly publicationScope: Scope.Closeable
  readonly leases: ResourceLeaseSet
  readonly result: Exit.Exit<Catalog, unknown>
}

export type ResourceGraphRetireMode = "drain" | "cancel"

const mergeContexts = (
  contexts: ReadonlyArray<Context.Context<unknown>>,
): Context.Context<unknown> => {
  let result: Context.Context<unknown> = Context.makeUnsafe<unknown>(new Map())
  for (const context of contexts) result = Context.merge(result, context)
  return result
}

const sameIds = (left: ReadonlyArray<ResourceId>, right: ReadonlyArray<ResourceId>): boolean => {
  if (left.length !== right.length) return false
  for (const [index, id] of left.entries()) {
    if (id !== right[index]) return false
  }
  return true
}

const sameDescriptors = (
  left: ReadonlyArray<ResourceDescriptor>,
  right: ReadonlyArray<ResourceDescriptor>,
): boolean => {
  if (left.length !== right.length) return false
  for (const [index, descriptor] of left.entries()) {
    const other = Option.fromUndefinedOr(right[index])
    if (Option.isNone(other)) return false
    if (
      descriptor.id !== other.value.id ||
      descriptor.revision !== other.value.revision ||
      descriptor.required !== other.value.required ||
      !sameIds(descriptor.requires, other.value.requires)
    ) {
      return false
    }
  }
  return true
}

const samePlan = (left: ResourcePlan, right: ResourcePlan): boolean => {
  if (!sameDescriptors(left.descriptors, right.descriptors)) return false
  if (!sameIds(left.startOrder, right.startOrder)) return false
  if (!sameIds(left.stopOrder, right.stopOrder)) return false
  if (left.inactive.length !== right.inactive.length) return false
  for (const [index, inactive] of left.inactive.entries()) {
    const other = Option.fromUndefinedOr(right.inactive[index])
    if (Option.isNone(other)) return false
    if (inactive.id !== other.value.id || !sameIds(inactive.missing, other.value.missing)) {
      return false
    }
  }
  return true
}

const sameDeclarationOrder = (
  left: ReadonlyArray<ResourceId>,
  right: ReadonlyArray<ResourceId>,
): boolean => sameIds(left, right)

const describeGraphError = (error: ResourceGraphError): string =>
  Match.type<ResourceGraphError>().pipe(
    Match.tagsExhaustive({
      DuplicateResourceId: (value) => `duplicate resource id: ${String(value.id)}`,
      MissingRequiredResource: (value) =>
        `required resource ${String(value.id)} is missing: ${value.missing.map(String).join(", ")}`,
      ResourceDependencyCycle: (value) =>
        `resource dependency cycle: ${value.ids.map(String).join(" -> ")}`,
    }),
  )(error)

const causeMessage = (cause: Cause.Cause<unknown>): string => Cause.pretty(cause)

// oxlint-disable-next-line effect/noUnknownParameters -- Resource failures cross the authored resource membrane.
const failureMessage = (error: unknown): string => {
  if (Schema.is(ResourceGraphHostError)(error)) {
    return error.failures.map((failure) => failure.message).join("\n")
  }
  return String(error)
}

const sealedLifecycleEffect = (
  id: ResourceId,
  phase: "start" | "stop",
  effect: () => Effect.Effect<void, unknown, unknown>,
): Effect.Effect<void, ResourceGraphLifecycleError> =>
  sealErasedEffect(effect, {
    // oxlint-disable-next-line effect/noUnknownParameters -- The resource membrane receives arbitrary authored failure values.
    onFailure: (error) =>
      Effect.fail(
        new ResourceGraphLifecycleError({
          message: `${String(phase)} ${String(id)}: ${failureMessage(error)}`,
        }),
      ),
    onDefect: (defect) =>
      Effect.fail(
        new ResourceGraphLifecycleError({
          message: `${String(phase)} ${String(id)}: ${failureMessage(defect)}`,
        }),
      ),
  })

const failureFromExit = (
  id: Option.Option<ResourceId>,
  phase: ResourceGraphFailurePhase,
  exit: Exit.Exit<unknown, unknown>,
): ResourceGraphFailure =>
  ResourceGraphFailure.make({
    // oxlint-disable-next-line effect/noNullish -- A release or stage failure has no resource owner.
    id: Option.getOrElse(id, () => null),
    phase,
    message: Exit.match(exit, {
      onFailure: (cause) => causeMessage(cause),
      onSuccess: () => "Unexpected successful exit",
    }),
  })

const resourceMap = (
  resources: ReadonlyArray<AnyResourceContribution>,
): ReadonlyMap<ResourceId, AnyResourceContribution> => {
  const result = new Map<ResourceId, AnyResourceContribution>()
  for (const resource of resources) result.set(resource.id, resource)
  return result
}

const descriptorMap = (plan: ResourcePlan): ReadonlyMap<ResourceId, ResourceDescriptor> => {
  const result = new Map<ResourceId, ResourceDescriptor>()
  for (const descriptor of plan.descriptors) result.set(descriptor.id, descriptor)
  return result
}

const affectedStopIds = (
  failedId: ResourceId,
  stopIds: ReadonlyArray<ResourceId>,
  plan: ResourcePlan,
): ReadonlyArray<ResourceId> => {
  const affected = new Set<ResourceId>([failedId])
  let changed = true
  while (changed) {
    changed = false
    for (const descriptor of plan.descriptors) {
      if (affected.has(descriptor.id)) continue
      if (!descriptor.requires.some((required) => affected.has(required))) continue
      affected.add(descriptor.id)
      changed = true
    }
  }
  return stopIds.filter((id) => affected.has(id))
}

const allActiveIds = (
  plan: ResourcePlan,
  handles: ReadonlyMap<ResourceId, ResourceHandle>,
): ReadonlyArray<ResourceId> => plan.startOrder.filter((id) => handles.has(id))

const retainedIds = (
  plan: ResourcePlan,
  handles: ReadonlyMap<ResourceId, ResourceHandle>,
): ReadonlyArray<ResourceId> => allActiveIds(plan, handles)

const unavailableIds = (
  plan: ResourcePlan,
  handles: ReadonlyMap<ResourceId, ResourceHandle>,
): ReadonlyArray<ResourceId> => plan.startOrder.filter((id) => !handles.has(id))

/**
 * Create one local graph host. The host must run in a parent Scope. Every
 * lifecycle and publication scopes are owned by the host until shutdown.
 */
export const makeResourceGraphHost = <Catalog>(
  options: ResourceGraphHostOptions,
): Effect.Effect<ResourceGraphHost<Catalog>, never, Scope.Scope | GentPlatform> =>
  Effect.gen(function* () {
    const parentScope = yield* Scope.Scope
    const platform = yield* GentPlatform
    const semaphore = yield* Semaphore.make(1)
    const shutdownRequested = yield* Deferred.make<true>()
    const baseContext: Context.Context<unknown> = Option.getOrElse(
      Option.fromUndefinedOr(options.baseContext),
      () => Context.makeUnsafe<unknown>(new Map()),
    )
    const hostNonce = yield* platform.randomId
    const ownedScopes = new Set<Scope.Closeable>()

    let closed = false
    let shutdownComplete = false
    let generationCounter = 0
    // oxlint-disable-next-line effect/noNullish -- Mutable host state uses an absent value before the first apply.
    let desiredPlan: ResourcePlan | undefined
    // oxlint-disable-next-line effect/noNullish -- Mutable host state uses an absent value before the first apply.
    let desiredPublicationRevision: ResourceRevision | undefined
    let declarationOrder: ReadonlyArray<ResourceId> = []
    // oxlint-disable-next-line effect/noNullish -- Mutable host state uses an absent value before the first apply.
    let generation: ResourceGeneration<Catalog> | undefined
    // oxlint-disable-next-line effect/noNullish -- A publication cleanup failure blocks unsafe restaging.
    let publicationCleanupFailure: ResourceGraphFailure | undefined
    const handles = new Map<ResourceId, ResourceHandle>()
    const quarantined = new Map<ResourceId, ResourceGraphFailure>()

    const hostError = (
      failures: ReadonlyArray<ResourceGraphFailure>,
      // oxlint-disable-next-line effect/noNullish -- A failure can leave no desired graph.
      plan: ResourcePlan | undefined,
    ): ResourceGraphHostError => {
      if (Predicate.isUndefined(plan)) {
        return new ResourceGraphHostError({
          failures: [...failures],
          retained: [],
          unavailable: [],
        })
      }
      return new ResourceGraphHostError({
        failures: [...failures],
        retained: retainedIds(plan, handles),
        unavailable: unavailableIds(plan, handles),
      })
    }

    const shutdownFailure = (): ResourceGraphFailure =>
      ResourceGraphFailure.make({
        // oxlint-disable-next-line effect/noNullish -- A shutdown request has no resource owner.
        id: null,
        phase: "closed",
        message: "resource graph host shutdown requested",
      })

    const isShutdownRequested = Deferred.poll(shutdownRequested).pipe(Effect.map(Option.isSome))

    const admitTransition = (
      // oxlint-disable-next-line effect/noNullish -- An omitted admission check means the caller does not use durable admission.
      admission: Effect.Effect<void, ResourceGraphHostError> | undefined,
      restore: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>,
    ): Effect.Effect<void, ResourceGraphHostError> => {
      if (Predicate.isUndefined(admission)) return Effect.void
      return Effect.gen(function* () {
        const admitted = yield* Effect.raceFirst(
          restore(admission),
          Deferred.await(shutdownRequested).pipe(Effect.andThen(Effect.interrupt)),
        ).pipe(Effect.exit)
        if (Exit.isFailure(admitted)) {
          const failures = [failureFromExit(Option.none(), "validate", admitted)]
          if (yield* isShutdownRequested) failures.push(shutdownFailure())
          return yield* hostError(failures, desiredPlan)
        }
        if (yield* isShutdownRequested) {
          return yield* hostError([shutdownFailure()], desiredPlan)
        }
      })
    }

    const closeHandle = (
      handle: ResourceHandle,
      shouldRetire: boolean,
    ): Effect.Effect<ReadonlyArray<ResourceGraphFailure>> =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const failures: Array<ResourceGraphFailure> = []
          if (shouldRetire) {
            const retired = yield* handle.lifecycle.retire.pipe(Effect.exit)
            if (Exit.isFailure(retired)) {
              failures.push(failureFromExit(Option.some(handle.id), "stop", retired))
            }
          }
          const closedScope = yield* Scope.close(handle.scope, handle.closeExit).pipe(Effect.exit)
          ownedScopes.delete(handle.scope)
          if (Exit.isFailure(closedScope)) {
            failures.push(failureFromExit(Option.some(handle.id), "release", closedScope))
          }
          return failures
        }),
      )

    const rememberQuarantine = (
      handle: ResourceHandle,
      failures: ReadonlyArray<ResourceGraphFailure>,
      candidateIds: ReadonlyArray<ResourceId>,
      dependencyPlan: ResourcePlan,
    ): void => {
      for (const failure of failures) {
        for (const affectedId of affectedStopIds(handle.id, candidateIds, dependencyPlan)) {
          let receipt = failure
          if (affectedId !== handle.id) {
            receipt = ResourceGraphFailure.make({
              id: affectedId,
              phase: failure.phase,
              message: `blocked by ${String(handle.id)}: ${failure.message}`,
            })
          }
          quarantined.set(affectedId, receipt)
        }
      }
    }

    const closeGeneration = (
      previous: ResourceGeneration<Catalog>,
      drain: Effect.Effect<void>,
      retireMode: ResourceGraphRetireMode,
      failures: Array<ResourceGraphFailure>,
    ): Effect.Effect<boolean> =>
      Effect.gen(function* () {
        yield* previous.leases.closeAdmission
        let cancelledByShutdown = false
        if (retireMode === "cancel") {
          yield* previous.leases.cancel
        } else {
          const drained = yield* Effect.raceFirst(
            drain.pipe(Effect.as("drained" satisfies "drained")),
            Deferred.await(shutdownRequested).pipe(
              Effect.andThen(previous.leases.cancel),
              Effect.as("shutdown" satisfies "shutdown"),
            ),
          ).pipe(Effect.exit)
          if (Exit.isFailure(drained)) {
            failures.push(failureFromExit(Option.none(), "release", drained))
            yield* previous.leases.cancel
          } else if (drained.value === "shutdown") {
            cancelledByShutdown = true
          }
        }
        const closedScope = yield* Scope.close(previous.publicationScope, Exit.void).pipe(
          Effect.exit,
        )
        if (Exit.isFailure(closedScope)) {
          const failure = failureFromExit(Option.none(), "release", closedScope)
          failures.push(failure)
          // oxlint-disable-next-line effect/noNullish -- Keep the first unknown publication cleanup failure as a repair barrier.
          if (Predicate.isUndefined(publicationCleanupFailure)) {
            publicationCleanupFailure = failure
          }
        }
        ownedScopes.delete(previous.publicationScope)
        return cancelledByShutdown
      })

    const resourceContext = (
      descriptor: ResourceDescriptor,
      resourcesInDeclarationOrder: ReadonlyArray<AnyResourceContribution>,
    ): Context.Context<unknown> => {
      const required = new Set(descriptor.requires)
      const contexts: Array<Context.Context<unknown>> = [baseContext]
      for (const resource of resourcesInDeclarationOrder) {
        if (!required.has(resource.id)) continue
        const handle = handles.get(resource.id)
        if (!Predicate.isUndefined(handle) && handle.active) contexts.push(handle.context)
      }
      return mergeContexts(contexts)
    }

    const publicationContext = (
      plan: ResourcePlan,
      resourcesInDeclarationOrder: ReadonlyArray<AnyResourceContribution>,
    ): Context.Context<unknown> => {
      const active = new Set(plan.startOrder)
      const contexts: Array<Context.Context<unknown>> = [baseContext]
      for (const resource of resourcesInDeclarationOrder) {
        if (!active.has(resource.id)) continue
        const handle = handles.get(resource.id)
        if (!Predicate.isUndefined(handle) && handle.active) contexts.push(handle.context)
      }
      return mergeContexts(contexts)
    }

    const makeHandle = (
      resource: AnyResourceContribution,
      context: Context.Context<unknown>,
    ): Effect.Effect<ResourceHandle, ResourceGraphHostError> =>
      Effect.gen(function* () {
        const scope = yield* Scope.make("sequential")
        ownedScopes.add(scope)
        const start = resource.start
        const stop = resource.stop
        let lifecycleSpec: ResourceLifecycleSpec<
          unknown,
          never,
          never,
          ResourceGraphLifecycleError,
          never,
          ResourceGraphLifecycleError,
          never
        > = {
          id: resource.id,
          revision: resource.revision,
          // The heterogeneous resource boundary is sealed once here. The
          // lifecycle then owns the resulting Layer and its Scope.
          // @effect-diagnostics-next-line anyUnknownInErrorContext:off — The resource membrane owns heterogeneous layer channels.
          layer: eraseResourceLayer(resource.layer),
          // Optional lifecycle actions are added below after the heterogeneous
          // resource has crossed the host membrane.
        }
        if (!Predicate.isUndefined(start)) {
          lifecycleSpec = {
            ...lifecycleSpec,
            // @effect-diagnostics-next-line anyUnknownInErrorContext:off — Resource lifecycle effects cross the explicit host membrane.
            start: sealedLifecycleEffect(resource.id, "start", () => start),
          }
        }
        if (!Predicate.isUndefined(stop)) {
          lifecycleSpec = {
            ...lifecycleSpec,
            // @effect-diagnostics-next-line anyUnknownInErrorContext:off — Resource lifecycle effects cross the explicit host membrane.
            stop: sealedLifecycleEffect(resource.id, "stop", () => stop),
          }
        }
        const captured = Context.add(context, Scope.Scope, scope)
        const lifecycle = yield* makeResourceLifecycle(lifecycleSpec).pipe(
          Effect.provideContext(captured),
          Effect.exit,
        )
        if (Exit.isFailure(lifecycle)) {
          const closedScope = yield* Scope.close(scope, lifecycle).pipe(Effect.exit)
          ownedScopes.delete(scope)
          const failures = [failureFromExit(Option.some(resource.id), "start", lifecycle)]
          if (Exit.isFailure(closedScope)) {
            failures.push(failureFromExit(Option.some(resource.id), "release", closedScope))
          }
          return yield* hostError(failures, desiredPlan)
        }
        return {
          id: resource.id,
          revision: resource.revision,
          resource,
          lifecycle: lifecycle.value,
          scope,
          context: Context.makeUnsafe<unknown>(new Map()),
          active: false,
          closeExit: Exit.void,
        } satisfies ResourceHandle
      })

    const activateHandle = (
      handle: ResourceHandle,
      restore: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>,
    ): Effect.Effect<ReadonlyArray<ResourceGraphFailure>> =>
      Effect.gen(function* () {
        const activated = yield* Effect.raceFirst(
          restore(handle.lifecycle.activate),
          Deferred.await(shutdownRequested).pipe(Effect.andThen(Effect.interrupt)),
        ).pipe(Effect.exit)
        if (Exit.isFailure(activated)) {
          handle.closeExit = activated
          return [failureFromExit(Option.some(handle.id), "start", activated)]
        }
        const current = yield* handle.lifecycle.current
        if (Option.isNone(current)) {
          const failure = ResourceGraphFailure.make({
            id: handle.id,
            phase: "start",
            message: "resource reported active without a service context",
          })
          handle.closeExit = Exit.fail(failure.message)
          return [failure]
        }
        handle.context = current.value
        handle.active = true
        return []
      })

    const closeHandles = (
      closing: ReadonlyArray<ResourceHandle>,
      failures: Array<ResourceGraphFailure>,
      candidateIds: ReadonlyArray<ResourceId>,
      dependencyPlan: ResourcePlan,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        for (const handle of [...closing].reverse()) {
          const handleFailures = yield* closeHandle(handle, handle.active)
          failures.push(...handleFailures)
          if (handleFailures.length > 0) {
            rememberQuarantine(handle, handleFailures, candidateIds, dependencyPlan)
          }
          handles.delete(handle.id)
        }
      })

    const nextGenerationId = (): ResourceGenerationId => {
      generationCounter += 1
      return ResourceGenerationId.make(`resource-generation-${hostNonce}-${generationCounter}`)
    }

    const prepareReconciliation = <Payload>(
      input: ResourceGraphApplyInput<Catalog, Payload>,
      nextPlan: ResourcePlan,
    ): ResourceReconciliation => {
      const resourcesById = resourceMap(input.resources)
      const descriptorsById = descriptorMap(nextPlan)
      const previousPlan = desiredPlan
      let diff: ResourceGraphDiff
      if (Predicate.isUndefined(previousPlan)) {
        diff = {
          retained: [],
          stop: [],
          start: [...nextPlan.startOrder],
        }
      } else {
        diff = diffResourceGraph(previousPlan, nextPlan)
      }
      const stopSet = new Set(diff.stop)
      return {
        nextPlan,
        nextDeclarationOrder: input.resources.map((resource) => resource.id),
        previousPlan,
        resourcesInDeclarationOrder: input.resources,
        resourcesById,
        descriptorsById,
        stopIds: diff.stop.filter((id) => handles.has(id)),
        startIds: nextPlan.startOrder.filter((id) => !handles.has(id) || stopSet.has(id)),
      }
    }

    const rememberDesired = (
      prepared: ResourceReconciliation,
      publicationRevision: ResourceRevision,
    ): void => {
      desiredPlan = prepared.nextPlan
      desiredPublicationRevision = publicationRevision
      declarationOrder = prepared.nextDeclarationOrder
    }

    const rejectApply = (
      prepared: ResourceReconciliation,
      publicationRevision: ResourceRevision,
      failures: ReadonlyArray<ResourceGraphFailure>,
    ): Effect.Effect<never, ResourceGraphHostError> => {
      rememberDesired(prepared, publicationRevision)
      return Effect.fail(hostError(failures, prepared.nextPlan))
    }

    const rejectStarted = <Payload>(
      prepared: ResourceReconciliation,
      input: ResourceGraphApplyInput<Catalog, Payload>,
      started: ResourceStartResult,
    ): Effect.Effect<never, ResourceGraphHostError> =>
      Effect.gen(function* () {
        const failures = [...started.failures]
        yield* closeHandles(started.newHandles, failures, prepared.startIds, prepared.nextPlan)
        if (yield* isShutdownRequested) {
          failures.push(shutdownFailure())
          return yield* hostError(failures, desiredPlan)
        }
        return yield* rejectApply(prepared, input.publicationRevision, failures)
      })

    const retireResources = <Payload>(
      prepared: ResourceReconciliation,
      input: ResourceGraphApplyInput<Catalog, Payload>,
      restore: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>,
    ): Effect.Effect<ResourceRetirementResult> =>
      Effect.gen(function* () {
        const failures: Array<ResourceGraphFailure> = []
        let shutdownRequestedDuringRetirement = false
        if (!Predicate.isUndefined(generation)) {
          shutdownRequestedDuringRetirement = yield* closeGeneration(
            generation,
            restore(generation.leases.awaitDrained),
            input.retireMode,
            failures,
          )
          // oxlint-disable-next-line effect/noNullish -- Retired generations are removed from mutable host state.
          generation = undefined
        }
        for (const id of prepared.stopIds) {
          const handle = handles.get(id)
          if (Predicate.isUndefined(handle)) continue
          const handleFailures = yield* closeHandle(handle, true)
          failures.push(...handleFailures)
          handles.delete(id)
          if (handleFailures.length === 0) continue
          let dependencyPlan = prepared.previousPlan
          if (Predicate.isUndefined(dependencyPlan)) dependencyPlan = prepared.nextPlan
          rememberQuarantine(handle, handleFailures, prepared.stopIds, dependencyPlan)
        }
        return { failures, shutdownRequested: shutdownRequestedDuringRetirement }
      })

    const startResources = (
      prepared: ResourceReconciliation,
      restore: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>,
    ): Effect.Effect<ResourceStartResult> =>
      Effect.gen(function* () {
        const failures: Array<ResourceGraphFailure> = []
        const newHandles: Array<ResourceHandle> = []
        for (const id of prepared.startIds) {
          const resource = Option.fromUndefinedOr(prepared.resourcesById.get(id))
          const descriptor = Option.fromUndefinedOr(prepared.descriptorsById.get(id))
          if (Option.isNone(resource) || Option.isNone(descriptor)) {
            failures.push(
              ResourceGraphFailure.make({
                id,
                phase: "start",
                message: "planned resource declaration was not found",
              }),
            )
            break
          }
          const handle = yield* makeHandle(
            resource.value,
            resourceContext(descriptor.value, prepared.resourcesInDeclarationOrder),
          ).pipe(Effect.exit)
          if (Exit.isFailure(handle)) {
            failures.push(failureFromExit(Option.some(id), "start", handle))
            break
          }
          handles.set(id, handle.value)
          newHandles.push(handle.value)
          const activated = yield* activateHandle(handle.value, restore)
          failures.push(...activated)
          if (activated.length > 0) break
        }
        return { failures, newHandles }
      })

    const stagePublication = <Payload>(
      input: ResourceGraphApplyInput<Catalog, Payload>,
      nextPlan: ResourcePlan,
      nextContext: Context.Context<unknown>,
      generationId: ResourceGenerationId,
      restore: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>,
    ): Effect.Effect<StagedPublication<Catalog>> =>
      Effect.gen(function* () {
        const publicationScope = yield* Scope.make("sequential")
        ownedScopes.add(publicationScope)
        const leases = yield* makeResourceLeaseSet(generationId).pipe(
          Effect.provideService(Scope.Scope, publicationScope),
        )
        const result = yield* Effect.raceFirst(
          restore(
            Effect.suspend(() =>
              input.stage({
                generationId,
                publicationRevision: input.publicationRevision,
                plan: nextPlan,
                payload: input.payload,
                context: nextContext,
              }),
            ).pipe(Effect.provideContext(Context.add(nextContext, Scope.Scope, publicationScope))),
          ),
          Deferred.await(shutdownRequested).pipe(Effect.andThen(Effect.interrupt)),
        ).pipe(Effect.exit)
        return { publicationScope, leases, result }
      })

    const closeStagedPublication = (
      staged: StagedPublication<Catalog>,
      exit: Exit.Exit<unknown, unknown>,
      failures: Array<ResourceGraphFailure>,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const closedPublication = yield* Scope.close(staged.publicationScope, exit).pipe(
          Effect.exit,
        )
        ownedScopes.delete(staged.publicationScope)
        if (Exit.isFailure(closedPublication)) {
          const failure = failureFromExit(Option.none(), "release", closedPublication)
          failures.push(failure)
          // oxlint-disable-next-line effect/noNullish -- Keep the first unknown publication cleanup failure as a repair barrier.
          if (Predicate.isUndefined(publicationCleanupFailure)) {
            publicationCleanupFailure = failure
          }
        }
      })

    const apply = <Payload>(input: ResourceGraphApplyInput<Catalog, Payload>) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          if (closed) {
            return yield* hostError(
              [
                ResourceGraphFailure.make({
                  // oxlint-disable-next-line effect/noNullish -- A host failure has no resource owner.
                  id: null,
                  phase: "closed",
                  message: "resource graph host is shut down",
                }),
              ],
              desiredPlan,
            )
          }
          if (!Predicate.isUndefined(publicationCleanupFailure)) {
            return yield* hostError([publicationCleanupFailure], desiredPlan)
          }

          const planned = planResourceGraph(input.resources)
          if (Result.isFailure(planned)) {
            return yield* hostError(
              [
                ResourceGraphFailure.make({
                  // oxlint-disable-next-line effect/noNullish -- A graph validation failure has no resource owner.
                  id: null,
                  phase: "validate",
                  message: describeGraphError(planned.failure),
                }),
              ],
              desiredPlan,
            )
          }
          const nextPlan = planned.success
          const nextDeclarationOrder = input.resources.map((resource) => resource.id)

          // Admission is part of the serialized transition contract, even for
          // a semantic no-op. A durable caller uses it to recheck its desired
          // receipt after waiting for this host's semaphore.
          yield* admitTransition(input.admit, restore)

          if (
            !Predicate.isUndefined(generation) &&
            !Predicate.isUndefined(desiredPlan) &&
            desiredPublicationRevision === input.publicationRevision &&
            samePlan(desiredPlan, nextPlan) &&
            sameDeclarationOrder(declarationOrder, nextDeclarationOrder)
          ) {
            return generation.publication
          }

          const prepared = prepareReconciliation(input, nextPlan)
          const retirement = yield* retireResources(prepared, input, restore)
          if (retirement.shutdownRequested || (yield* isShutdownRequested)) {
            return yield* hostError([...retirement.failures, shutdownFailure()], desiredPlan)
          }
          if (retirement.failures.length > 0) {
            return yield* rejectApply(prepared, input.publicationRevision, retirement.failures)
          }

          const quarantinedFailures: Array<ResourceGraphFailure> = []
          for (const id of prepared.startIds) {
            const receipt = Option.fromUndefinedOr(quarantined.get(id))
            if (Option.isSome(receipt)) quarantinedFailures.push(receipt.value)
          }
          if (quarantinedFailures.length > 0) {
            return yield* rejectApply(prepared, input.publicationRevision, quarantinedFailures)
          }

          const started = yield* startResources(prepared, restore)
          if (started.failures.length > 0) {
            return yield* rejectStarted(prepared, input, started)
          }
          if (yield* isShutdownRequested) {
            const failures = [shutdownFailure()]
            yield* closeHandles(started.newHandles, failures, prepared.startIds, prepared.nextPlan)
            return yield* hostError(failures, desiredPlan)
          }

          const generationId = nextGenerationId()
          const nextContext = publicationContext(nextPlan, input.resources)
          const staged = yield* stagePublication(
            input,
            nextPlan,
            nextContext,
            generationId,
            restore,
          )
          if (Exit.isFailure(staged.result)) {
            const failures: Array<ResourceGraphFailure> = [
              failureFromExit(Option.none(), "stage", staged.result),
            ]
            yield* closeStagedPublication(staged, staged.result, failures)
            yield* closeHandles(started.newHandles, failures, prepared.startIds, prepared.nextPlan)
            if (yield* isShutdownRequested) {
              failures.push(shutdownFailure())
              return yield* hostError(failures, desiredPlan)
            }
            return yield* rejectApply(prepared, input.publicationRevision, failures)
          }

          if (yield* isShutdownRequested) {
            const failures = [shutdownFailure()]
            yield* closeStagedPublication(staged, Exit.void, failures)
            yield* closeHandles(started.newHandles, failures, prepared.startIds, prepared.nextPlan)
            return yield* hostError(failures, desiredPlan)
          }

          const publicationContextValue = nextContext
          const publication: ResourceGraphPublication<Catalog> = {
            generationId,
            publicationRevision: input.publicationRevision,
            plan: nextPlan,
            value: staged.result.value,
            run: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
              Effect.provideContext(staged.leases.run(effect), publicationContextValue),
          }
          generation = {
            leases: staged.leases,
            publicationScope: staged.publicationScope,
            publication,
          }
          rememberDesired(prepared, input.publicationRevision)
          return publication
        }),
      ).pipe(semaphore.withPermit.bind(semaphore))

    const current = Effect.sync(() => {
      if (closed || Predicate.isUndefined(generation)) return Option.none()
      return Option.some(generation.publication)
    }).pipe(semaphore.withPermit.bind(semaphore))

    const shutdownCritical = Effect.uninterruptible(
      Effect.gen(function* () {
        if (shutdownComplete) return
        const failures: Array<ResourceGraphFailure> = []
        if (!Predicate.isUndefined(generation)) {
          yield* closeGeneration(generation, generation.leases.awaitDrained, "cancel", failures)
          // oxlint-disable-next-line effect/noNullish -- Shutdown removes the active generation from mutable host state.
          generation = undefined
        }
        let stopOrder: ReadonlyArray<ResourceId>
        if (Predicate.isUndefined(desiredPlan)) {
          stopOrder = [...handles.keys()].reverse()
        } else {
          stopOrder = desiredPlan.stopOrder
        }
        const closedIds = new Set<ResourceId>()
        for (const id of stopOrder) {
          const handle = handles.get(id)
          if (Predicate.isUndefined(handle)) continue
          closedIds.add(id)
          failures.push(...(yield* closeHandle(handle, handle.active)))
          handles.delete(id)
        }
        for (const [id, handle] of [...handles.entries()].reverse()) {
          if (closedIds.has(id)) continue
          failures.push(...(yield* closeHandle(handle, handle.active)))
          handles.delete(id)
        }
        for (const scope of [...ownedScopes].reverse()) {
          const closedScope = yield* Scope.close(scope, Exit.void).pipe(Effect.exit)
          ownedScopes.delete(scope)
          if (Exit.isFailure(closedScope)) {
            failures.push(failureFromExit(Option.none(), "release", closedScope))
          }
        }
        // oxlint-disable-next-line effect/noNullish -- Shutdown clears the desired graph state.
        desiredPlan = undefined
        // oxlint-disable-next-line effect/noNullish -- Shutdown clears the desired revision state.
        desiredPublicationRevision = undefined
        declarationOrder = []
        shutdownComplete = true
        if (failures.length > 0) {
          // oxlint-disable-next-line effect/noNullish -- Shutdown has no desired graph after cleanup.
          return yield* hostError(failures, undefined)
        }
      }),
    ).pipe(semaphore.withPermit.bind(semaphore))

    const shutdown = Effect.uninterruptible(
      Effect.gen(function* () {
        closed = true
        yield* Deferred.succeed(shutdownRequested, true)
        yield* shutdownCritical
      }),
    )

    yield* Scope.addFinalizer(parentScope, shutdown.pipe(Effect.orDie))

    return {
      apply,
      current,
      shutdown,
    } satisfies ResourceGraphHost<Catalog>
  })

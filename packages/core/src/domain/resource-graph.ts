import { Option, Result, Schema } from "effect"

/** Stable identity for a declared resource. */
export const ResourceId = Schema.NonEmptyString.pipe(Schema.brand("ResourceId"))
export type ResourceId = typeof ResourceId.Type

/** Desired semantic revision for a declared resource. */
export const ResourceRevision = Schema.NonEmptyString.pipe(Schema.brand("ResourceRevision"))
export type ResourceRevision = typeof ResourceRevision.Type

/** The runtime requirements and activation policy for one resource. */
export const ResourceDescriptor = Schema.Struct({
  id: ResourceId,
  revision: ResourceRevision,
  requires: Schema.Array(ResourceId),
  required: Schema.Boolean,
})
export type ResourceDescriptor = typeof ResourceDescriptor.Type

/** A resource that cannot activate because one or more requirements are absent. */
export const ResourceInactive = Schema.Struct({
  id: ResourceId,
  missing: Schema.Array(ResourceId),
})
export type ResourceInactive = typeof ResourceInactive.Type

/** Schema-backed validation failures for a desired resource graph. */
export const ResourceGraphError = Schema.TaggedUnion({
  DuplicateResourceId: {
    id: ResourceId,
  },
  MissingRequiredResource: {
    id: ResourceId,
    missing: Schema.Array(ResourceId),
  },
  ResourceDependencyCycle: {
    ids: Schema.Array(ResourceId),
  },
})
export type ResourceGraphError = typeof ResourceGraphError.Type

/** The validated graph snapshot and its deterministic lifecycle order. */
export const ResourcePlan = Schema.Struct({
  descriptors: Schema.Array(ResourceDescriptor),
  startOrder: Schema.Array(ResourceId),
  stopOrder: Schema.Array(ResourceId),
  inactive: Schema.Array(ResourceInactive),
})
export type ResourcePlan = typeof ResourcePlan.Type

/** IDs that remain active, stop, or start when moving between two plans. */
export const ResourceGraphDiff = Schema.Struct({
  retained: Schema.Array(ResourceId),
  stop: Schema.Array(ResourceId),
  start: Schema.Array(ResourceId),
})
export type ResourceGraphDiff = typeof ResourceGraphDiff.Type

const compareResourceIds = (left: ResourceId, right: ResourceId): number => {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

const sortedUniqueResourceIds = (ids: ReadonlyArray<ResourceId>): ReadonlyArray<ResourceId> => {
  const unique = new Map<ResourceId, ResourceId>()
  for (const id of ids) {
    unique.set(id, id)
  }
  return [...unique.values()].sort(compareResourceIds)
}

const canonicalDescriptor = (descriptor: ResourceDescriptor): ResourceDescriptor =>
  ResourceDescriptor.make({
    id: descriptor.id,
    revision: descriptor.revision,
    requires: sortedUniqueResourceIds(descriptor.requires),
    required: descriptor.required,
  })

const canonicalDescriptors = (
  descriptors: ReadonlyArray<ResourceDescriptor>,
): ReadonlyArray<ResourceDescriptor> =>
  [...descriptors]
    .map(canonicalDescriptor)
    .sort((left, right) => compareResourceIds(left.id, right.id))

const descriptorIndex = (
  descriptors: ReadonlyArray<ResourceDescriptor>,
): Result.Result<ReadonlyMap<ResourceId, ResourceDescriptor>, ResourceGraphError> => {
  const index = new Map<ResourceId, ResourceDescriptor>()
  for (const descriptor of descriptors) {
    if (index.has(descriptor.id)) {
      return Result.fail(
        ResourceGraphError.cases.DuplicateResourceId.make({
          id: descriptor.id,
        }),
      )
    }
    index.set(descriptor.id, descriptor)
  }
  return Result.succeed(index)
}

const findDependencyCycle = (
  descriptors: ReadonlyArray<ResourceDescriptor>,
  index: ReadonlyMap<ResourceId, ResourceDescriptor>,
): Option.Option<ResourceGraphError> => {
  const states = new Map<ResourceId, "visiting" | "visited">()
  const stack: Array<ResourceId> = []

  const visit = (descriptor: ResourceDescriptor): Option.Option<ResourceGraphError> => {
    const id = descriptor.id
    const state = Option.fromNullishOr(states.get(id))
    if (Option.isSome(state) && state.value === "visited") return Option.none()
    if (Option.isSome(state) && state.value === "visiting") {
      const cycleStart = stack.findIndex((stackId) => stackId === descriptor.id)
      const ids = stack.slice(cycleStart)
      ids.push(descriptor.id)
      return Option.some(ResourceGraphError.cases.ResourceDependencyCycle.make({ ids }))
    }

    states.set(id, "visiting")
    stack.push(descriptor.id)
    for (const requirement of descriptor.requires) {
      const dependency = Option.fromNullishOr(index.get(requirement))
      if (Option.isNone(dependency)) continue
      const cycle = visit(dependency.value)
      if (Option.isSome(cycle)) return cycle
    }
    stack.pop()
    states.set(id, "visited")
    return Option.none()
  }

  for (const descriptor of descriptors) {
    const cycle = visit(descriptor)
    if (Option.isSome(cycle)) return cycle
  }
  return Option.none()
}

const dependencyLinks = (
  descriptors: ReadonlyArray<ResourceDescriptor>,
  index: ReadonlyMap<ResourceId, ResourceDescriptor>,
) => {
  const indegree = new Map<ResourceId, number>()
  const dependents = new Map<ResourceId, Array<ResourceId>>()
  for (const descriptor of descriptors) {
    indegree.set(descriptor.id, 0)
    dependents.set(descriptor.id, [])
  }

  for (const descriptor of descriptors) {
    const id = descriptor.id
    for (const requirement of descriptor.requires) {
      if (index.has(requirement)) {
        const current = Option.fromNullishOr(indegree.get(id))
        if (Option.isSome(current)) indegree.set(id, current.value + 1)
        const children = Option.fromNullishOr(dependents.get(requirement))
        if (Option.isSome(children)) children.value.push(descriptor.id)
      }
    }
  }

  return { indegree, dependents }
}

const initialReadyIds = (
  descriptors: ReadonlyArray<ResourceDescriptor>,
  indegree: ReadonlyMap<ResourceId, number>,
): Array<ResourceId> => {
  const ready: Array<ResourceId> = []
  for (const descriptor of descriptors) {
    const value = Option.fromNullishOr(indegree.get(descriptor.id))
    if (Option.isSome(value) && value.value === 0) ready.push(descriptor.id)
  }
  ready.sort(compareResourceIds)
  return ready
}

const releaseDependents = (
  id: ResourceId,
  indegree: Map<ResourceId, number>,
  dependents: ReadonlyMap<ResourceId, ReadonlyArray<ResourceId>>,
  ready: Array<ResourceId>,
): void => {
  const children = Option.fromNullishOr(dependents.get(id))
  if (Option.isNone(children)) return
  for (const child of children.value) {
    const value = Option.fromNullishOr(indegree.get(child))
    if (Option.isNone(value)) continue
    const next = value.value - 1
    indegree.set(child, next)
    if (next === 0) ready.push(child)
  }
  ready.sort(compareResourceIds)
}

const topologicalOrder = (
  descriptors: ReadonlyArray<ResourceDescriptor>,
  index: ReadonlyMap<ResourceId, ResourceDescriptor>,
): ReadonlyArray<ResourceId> => {
  const links = dependencyLinks(descriptors, index)
  const ready = initialReadyIds(descriptors, links.indegree)

  const order: Array<ResourceId> = []
  while (ready.length > 0) {
    const id = Option.fromNullishOr(ready.shift())
    if (Option.isNone(id)) continue
    order.push(id.value)
    releaseDependents(id.value, links.indegree, links.dependents, ready)
  }
  return order
}

const activeAndInactive = (
  order: ReadonlyArray<ResourceId>,
  index: ReadonlyMap<ResourceId, ResourceDescriptor>,
): Result.Result<
  {
    readonly active: ReadonlyArray<ResourceId>
    readonly inactive: ReadonlyArray<ResourceInactive>
  },
  ResourceGraphError
> => {
  const missingById = new Map<ResourceId, ReadonlyArray<ResourceId>>()
  const active: Array<ResourceId> = []
  const inactive: Array<ResourceInactive> = []

  for (const id of order) {
    const descriptor = Option.fromNullishOr(index.get(id))
    if (Option.isNone(descriptor)) continue
    const missing: Array<ResourceId> = []
    for (const requirement of descriptor.value.requires) {
      if (!index.has(requirement)) {
        missing.push(requirement)
        continue
      }
      const dependencyMissing = Option.fromNullishOr(missingById.get(requirement))
      if (Option.isSome(dependencyMissing)) missing.push(...dependencyMissing.value)
    }

    const normalizedMissing = sortedUniqueResourceIds(missing)
    if (normalizedMissing.length === 0) {
      active.push(id)
      continue
    }

    missingById.set(id, normalizedMissing)
    if (descriptor.value.required) {
      return Result.fail(
        ResourceGraphError.cases.MissingRequiredResource.make({
          id,
          missing: normalizedMissing,
        }),
      )
    }
    inactive.push(
      ResourceInactive.make({
        id,
        missing: normalizedMissing,
      }),
    )
  }

  inactive.sort((left, right) => compareResourceIds(left.id, right.id))
  return Result.succeed({ active, inactive })
}

/** Validate a desired graph without performing I/O or starting resources. */
export const planResourceGraph = (
  descriptors: ReadonlyArray<ResourceDescriptor>,
): Result.Result<ResourcePlan, ResourceGraphError> => {
  const canonical = canonicalDescriptors(descriptors)
  const indexed = descriptorIndex(canonical)
  if (Result.isFailure(indexed)) return Result.fail(indexed.failure)

  const cycle = findDependencyCycle(canonical, indexed.success)
  if (Option.isSome(cycle)) return Result.fail(cycle.value)

  const order = topologicalOrder(canonical, indexed.success)
  const availability = activeAndInactive(order, indexed.success)
  if (Result.isFailure(availability)) return Result.fail(availability.failure)

  const stopOrder = [...availability.success.active].reverse()
  return Result.succeed(
    ResourcePlan.make({
      descriptors: canonical,
      startOrder: availability.success.active,
      stopOrder,
      inactive: availability.success.inactive,
    }),
  )
}

const descriptorMap = (plan: ResourcePlan): ReadonlyMap<ResourceId, ResourceDescriptor> => {
  const result = new Map<ResourceId, ResourceDescriptor>()
  for (const descriptor of plan.descriptors) {
    result.set(descriptor.id, descriptor)
  }
  return result
}

const idSet = (ids: ReadonlyArray<ResourceId>): ReadonlySet<ResourceId> => {
  const result = new Set<ResourceId>()
  for (const id of ids) result.add(id)
  return result
}

const sameRequirements = (
  left: ReadonlyArray<ResourceId>,
  right: ReadonlyArray<ResourceId>,
): boolean => {
  const leftCanonical = sortedUniqueResourceIds(left)
  const rightCanonical = sortedUniqueResourceIds(right)
  if (leftCanonical.length !== rightCanonical.length) return false
  for (const [index, id] of leftCanonical.entries()) {
    const other = Option.fromNullishOr(rightCanonical[index])
    if (Option.isNone(other) || id !== other.value) return false
  }
  return true
}

const sameDescriptor = (left: ResourceDescriptor, right: ResourceDescriptor): boolean =>
  left.revision === right.revision && sameRequirements(left.requires, right.requires)

const dependentMap = (
  descriptors: ReadonlyArray<ResourceDescriptor>,
): ReadonlyMap<ResourceId, ReadonlyArray<ResourceId>> => {
  const result = new Map<ResourceId, Array<ResourceId>>()
  for (const descriptor of descriptors) result.set(descriptor.id, [])
  for (const descriptor of descriptors) {
    for (const requirement of descriptor.requires) {
      const dependents = Option.fromNullishOr(result.get(requirement))
      if (Option.isSome(dependents)) dependents.value.push(descriptor.id)
    }
  }
  return result
}

const transitiveDependents = (
  seeds: ReadonlySet<ResourceId>,
  active: ReadonlySet<ResourceId>,
  dependents: ReadonlyMap<ResourceId, ReadonlyArray<ResourceId>>,
): ReadonlySet<ResourceId> => {
  const affected = new Set<ResourceId>()
  const pending = [...seeds]
  while (pending.length > 0) {
    const id = Option.fromNullishOr(pending.shift())
    if (Option.isNone(id) || affected.has(id.value)) continue
    if (!seeds.has(id.value) && !active.has(id.value)) continue
    affected.add(id.value)
    const children = Option.fromNullishOr(dependents.get(id.value))
    if (Option.isNone(children)) continue
    for (const child of children.value) {
      if (!affected.has(child)) pending.push(child)
    }
  }
  return affected
}

/**
 * Derive lifecycle work between two already validated graph snapshots.
 * Descriptor and requirement changes restart transitive active dependents.
 */
export const diffResourceGraph = (current: ResourcePlan, next: ResourcePlan): ResourceGraphDiff => {
  const currentDescriptors = descriptorMap(current)
  const nextDescriptors = descriptorMap(next)
  const currentActive = idSet(current.startOrder)
  const nextActive = idSet(next.startOrder)
  const changed = new Set<ResourceId>()

  for (const descriptor of current.descriptors) {
    const id = descriptor.id
    const replacement = Option.fromNullishOr(nextDescriptors.get(id))
    if (Option.isNone(replacement) || !sameDescriptor(descriptor, replacement.value)) {
      changed.add(id)
    }
  }
  for (const descriptor of next.descriptors) {
    const id = descriptor.id
    if (currentDescriptors.has(id)) continue
    changed.add(id)
  }
  for (const id of new Set([...currentActive, ...nextActive])) {
    if (currentActive.has(id) !== nextActive.has(id)) changed.add(id)
  }

  const currentStopAffected = transitiveDependents(
    changed,
    currentActive,
    dependentMap(current.descriptors),
  )
  const nextStartAffected = transitiveDependents(
    changed,
    nextActive,
    dependentMap(next.descriptors),
  )

  const stop = current.stopOrder.filter((id) => currentStopAffected.has(id))
  const start = next.startOrder.filter((id) => nextStartAffected.has(id))
  const retained = next.startOrder.filter(
    (id) => currentActive.has(id) && !currentStopAffected.has(id) && !nextStartAffected.has(id),
  )

  return ResourceGraphDiff.make({ retained, stop, start })
}

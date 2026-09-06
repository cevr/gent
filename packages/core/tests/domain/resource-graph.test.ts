import { describe, expect, test } from "bun:test"
import { Result, Schema } from "effect"
import {
  diffResourceGraph,
  planResourceGraph,
  ResourceDescriptor,
  ResourceGraphError,
  ResourceId,
  ResourceRevision,
} from "@gent/core-internal/domain/resource-graph"
import type { ResourcePlan } from "@gent/core-internal/domain/resource-graph"

const descriptor = (
  id: string,
  requires: ReadonlyArray<string> = [],
  required = false,
  revision = "1",
) =>
  ResourceDescriptor.make({
    id: ResourceId.make(id),
    revision: ResourceRevision.make(revision),
    requires: requires.map((value) => ResourceId.make(value)),
    required,
  })

const plan = (descriptors: ReadonlyArray<ResourceDescriptor>): ResourcePlan =>
  Result.getOrThrow(planResourceGraph(descriptors))

const failure = (descriptors: ReadonlyArray<ResourceDescriptor>): ResourceGraphError =>
  Result.getOrThrow(Result.flip(planResourceGraph(descriptors)))

const ids = (values: ReadonlyArray<ResourceId>): ReadonlyArray<string> => values.map(String)

describe("resource graph schemas", () => {
  test("IDs and revisions reject empty values and keep distinct brands", () => {
    expect(() => ResourceId.make("")).toThrow()
    expect(() => ResourceRevision.make("")).toThrow()
    const id = ResourceId.make("resource")
    const revision = ResourceRevision.make("1")
    // @ts-expect-error — Resource IDs and revisions are distinct brands.
    const invalidId: ResourceId = revision
    expect(String(id)).toBe("resource")
    expect(String(invalidId)).toBe("1")
  })

  test("a descriptor is schema-backed and uses trusted construction", () => {
    const value = descriptor("worker", ["provider"], true, "v2")
    const decoded = Schema.decodeSync(ResourceDescriptor)(value)
    expect(decoded).toEqual(value)
  })
})

describe("planResourceGraph", () => {
  test("plans an empty graph", () => {
    const result = planResourceGraph([])
    expect(Result.isSuccess(result)).toBe(true)
    if (Result.isFailure(result)) return
    expect(result.success.startOrder).toEqual([])
    expect(result.success.stopOrder).toEqual([])
    expect(result.success.inactive).toEqual([])
  })

  test("sorts disconnected resources independently of input order", () => {
    const left = plan([descriptor("zeta"), descriptor("alpha")])
    const right = plan([descriptor("alpha"), descriptor("zeta")])
    expect(ids(left.startOrder)).toEqual(["alpha", "zeta"])
    expect(ids(left.stopOrder)).toEqual(["zeta", "alpha"])
    expect(right).toEqual(left)
  })

  test("uses dependency-first order for chains and diamonds", () => {
    const result = plan([
      descriptor("leaf", ["left", "right"]),
      descriptor("right", ["root"]),
      descriptor("root"),
      descriptor("left", ["root"]),
    ])
    expect(ids(result.startOrder)).toEqual(["root", "left", "right", "leaf"])
    expect(ids(result.stopOrder)).toEqual(["leaf", "right", "left", "root"])
  })

  test("marks direct and transitive optional gaps with root missing IDs", () => {
    const result = plan([
      descriptor("leaf", ["middle"]),
      descriptor("middle", ["root"]),
      descriptor("root", ["missing"]),
      descriptor("healthy"),
    ])
    expect(ids(result.startOrder)).toEqual(["healthy"])
    expect(result.inactive).toEqual([
      { id: ResourceId.make("leaf"), missing: [ResourceId.make("missing")] },
      { id: ResourceId.make("middle"), missing: [ResourceId.make("missing")] },
      { id: ResourceId.make("root"), missing: [ResourceId.make("missing")] },
    ])
  })

  test("rejects an unavailable required root", () => {
    const error = failure([descriptor("app", ["missing"], true)])
    expect(error._tag).toBe("MissingRequiredResource")
    if (ResourceGraphError.guards.MissingRequiredResource(error)) {
      expect(String(error.id)).toBe("app")
      expect(ids(error.missing)).toEqual(["missing"])
    }
  })

  test("reports transitive gaps when the required root depends on an inactive provider", () => {
    const error = failure([
      descriptor("app", ["provider"], true),
      descriptor("provider", ["missing"]),
    ])
    expect(error._tag).toBe("MissingRequiredResource")
    if (ResourceGraphError.guards.MissingRequiredResource(error)) {
      expect(String(error.id)).toBe("app")
      expect(ids(error.missing)).toEqual(["missing"])
    }
  })

  test("rejects duplicate IDs before activation", () => {
    const error = failure([descriptor("same"), descriptor("same", [], false, "2")])
    expect(error._tag).toBe("DuplicateResourceId")
    if (ResourceGraphError.guards.DuplicateResourceId(error)) {
      expect(String(error.id)).toBe("same")
    }
  })

  test("rejects ordinary and self cycles, including optional cycles", () => {
    const ordinary = failure([descriptor("a", ["b"]), descriptor("b", ["a"])])
    const self = failure([descriptor("self", ["self"])])
    expect(ordinary._tag).toBe("ResourceDependencyCycle")
    expect(self._tag).toBe("ResourceDependencyCycle")
    if (ResourceGraphError.guards.ResourceDependencyCycle(ordinary)) {
      expect(ids(ordinary.ids)).toEqual(["a", "b", "a"])
    }
    if (ResourceGraphError.guards.ResourceDependencyCycle(self)) {
      expect(ids(self.ids)).toEqual(["self", "self"])
    }
  })

  test("reports a cycle instead of treating it as only a missing graph", () => {
    const error = failure([descriptor("a", ["b", "missing"]), descriptor("b", ["a"])])
    expect(error._tag).toBe("ResourceDependencyCycle")
  })

  test("cycle diagnostics contain cycle members, not a downstream dependent", () => {
    const error = failure([
      descriptor("downstream", ["a"]),
      descriptor("a", ["b"]),
      descriptor("b", ["a"]),
    ])
    expect(error._tag).toBe("ResourceDependencyCycle")
    if (ResourceGraphError.guards.ResourceDependencyCycle(error)) {
      expect(ids(error.ids)).toEqual(["a", "b", "a"])
    }
  })

  test("snapshots descriptors and canonicalizes duplicate or reordered requirements", () => {
    const requirements = [ResourceId.make("b"), ResourceId.make("a"), ResourceId.make("a")]
    const result = planResourceGraph([
      ResourceDescriptor.make({
        id: ResourceId.make("consumer"),
        revision: ResourceRevision.make("1"),
        requires: requirements,
        required: false,
      }),
      descriptor("a"),
      descriptor("b"),
    ])
    requirements.push(ResourceId.make("later"))
    expect(Result.isSuccess(result)).toBe(true)
    if (Result.isFailure(result)) return
    expect(result.success.descriptors[2]).toMatchObject({
      requires: [ResourceId.make("a"), ResourceId.make("b")],
    })
  })
})

describe("diffResourceGraph", () => {
  test("restarts a provider revision and every active dependent transitively", () => {
    const current = plan([
      descriptor("leaf", ["middle"]),
      descriptor("middle", ["provider"]),
      descriptor("provider", [], false, "1"),
      descriptor("unrelated"),
    ])
    const next = plan([
      descriptor("leaf", ["middle"]),
      descriptor("middle", ["provider"]),
      descriptor("provider", [], false, "2"),
      descriptor("unrelated"),
    ])
    expect(diffResourceGraph(current, next)).toEqual({
      retained: [ResourceId.make("unrelated")],
      stop: [ResourceId.make("leaf"), ResourceId.make("middle"), ResourceId.make("provider")],
      start: [ResourceId.make("provider"), ResourceId.make("middle"), ResourceId.make("leaf")],
    })
  })

  test("restarts a resource and dependents when its requirements change", () => {
    const current = plan([descriptor("a"), descriptor("b"), descriptor("consumer", ["a"])])
    const next = plan([descriptor("a"), descriptor("b"), descriptor("consumer", ["b"])])
    expect(diffResourceGraph(current, next)).toEqual({
      retained: [ResourceId.make("a"), ResourceId.make("b")],
      stop: [ResourceId.make("consumer")],
      start: [ResourceId.make("consumer")],
    })
  })

  test("keeps active resources when only required-root policy changes", () => {
    const current = plan([descriptor("app", [], false)])
    const next = plan([descriptor("app", [], true)])
    expect(diffResourceGraph(current, next)).toEqual({
      retained: [ResourceId.make("app")],
      stop: [],
      start: [],
    })
  })

  test("treats reordered and requirement-order-only changes as no-op", () => {
    const current = plan([descriptor("consumer", ["a", "b"]), descriptor("b"), descriptor("a")])
    const next = plan([
      descriptor("a"),
      ResourceDescriptor.make({
        id: ResourceId.make("consumer"),
        revision: ResourceRevision.make("1"),
        requires: [ResourceId.make("b"), ResourceId.make("a"), ResourceId.make("a")],
        required: false,
      }),
      descriptor("b"),
    ])
    expect(diffResourceGraph(current, next)).toEqual({
      retained: [ResourceId.make("a"), ResourceId.make("b"), ResourceId.make("consumer")],
      stop: [],
      start: [],
    })
  })

  test("starts an optional resource when its provider appears", () => {
    const current = plan([descriptor("consumer", ["provider"])])
    const next = plan([descriptor("consumer", ["provider"]), descriptor("provider")])
    expect(diffResourceGraph(current, next)).toEqual({
      retained: [],
      stop: [],
      start: [ResourceId.make("provider"), ResourceId.make("consumer")],
    })
  })

  test("stops an optional dependent when its provider disappears", () => {
    const current = plan([descriptor("consumer", ["provider"]), descriptor("provider")])
    const next = plan([descriptor("consumer", ["provider"])])
    expect(diffResourceGraph(current, next)).toEqual({
      retained: [],
      stop: [ResourceId.make("consumer"), ResourceId.make("provider")],
      start: [],
    })
  })
})

import { describe, expect, it } from "effect-bun-test"
import {
  Cause,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Result,
  Schema,
  Scope,
} from "effect"
import { defineResource } from "../../src/domain/resource.js"
import type { AnyResourceContribution } from "../../src/domain/resource.js"
import { ResourceId, ResourceRevision } from "../../src/domain/resource-graph.js"
import { GentPlatform } from "../../src/runtime/gent-platform.js"
import { ResourceLeaseClosedError } from "../../src/runtime/extensions/resource-host/resource-leases.js"
import {
  makeResourceGraphHost,
  type ResourceGraphApplyInput,
  type ResourceGraphHost,
  ResourceGraphFailure,
  ResourceGraphHostError,
  type ResourceGraphStageInput,
} from "../../src/runtime/extensions/resource-host/resource-graph-host.js"

class TestService extends Context.Service<TestService, { readonly value: string }>()(
  "@gent/core/tests/extensions/resource-graph-host.test/TestService",
) {}

class DependencyService extends Context.Service<
  DependencyService,
  { readonly value: string; readonly instance: number }
>()("@gent/core/tests/extensions/resource-graph-host.test/DependencyService") {}

class DependentService extends Context.Service<DependentService, { readonly value: string }>()(
  "@gent/core/tests/extensions/resource-graph-host.test/DependentService",
) {}

const id = (name: string): ResourceId => ResourceId.make(`test/resource-graph-host/${name}`)
const revision = (value: string): ResourceRevision => ResourceRevision.make(value)

const stage =
  <Payload>(
    output: string,
  ): ((input: ResourceGraphStageInput<Payload>) => Effect.Effect<string, never, never>) =>
  (input) =>
    Effect.succeed(`${output}:${String(input.payload)}:${String(input.generationId)}`)

const applyInput = <Payload>(
  resources: ReadonlyArray<AnyResourceContribution>,
  output: string,
  payload: Payload,
  publicationRevision = "catalog-1",
): ResourceGraphApplyInput<string, Payload> => ({
  publicationRevision: revision(publicationRevision),
  payload,
  retireMode: "drain",
  resources,
  stage: stage<Payload>(output),
})

const makeHost = <Catalog = string>(): Effect.Effect<
  ResourceGraphHost<Catalog>,
  never,
  Scope.Scope
> =>
  makeResourceGraphHost<Catalog>({}).pipe(Effect.provide(GentPlatform.Test("resource-graph-host")))

const makeHostInScope = <Catalog = string>(
  parentScope: Scope.Closeable,
): Effect.Effect<ResourceGraphHost<Catalog>> =>
  makeResourceGraphHost<Catalog>({}).pipe(
    Effect.provideService(Scope.Scope, parentScope),
    Effect.provide(GentPlatform.Test("resource-graph-host-parent-shutdown")),
  )

describe("resource graph host", () => {
  it.live("starts dependencies first and stops dependents first", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const events: Array<string> = []
        let nextInstance = 0
        const dependency = defineResource({
          id: id("order/dependency"),
          scope: "process",
          layer: Layer.effect(
            DependencyService,
            Effect.acquireRelease(
              Effect.sync(() => {
                const instance = ++nextInstance
                events.push(`acquire:dependency:${instance}`)
                return DependencyService.of({ value: "dependency", instance })
              }),
              (service) => Effect.sync(() => events.push(`release:dependency:${service.instance}`)),
            ),
          ),
          start: Effect.gen(function* () {
            const service = yield* DependencyService
            events.push(`start:dependency:${service.instance}`)
          }),
          stop: Effect.gen(function* () {
            const service = yield* DependencyService
            events.push(`stop:dependency:${service.instance}`)
          }),
        })
        const dependent = defineResource({
          id: id("order/dependent"),
          requires: [dependency.id],
          scope: "process",
          layer: Layer.effect(
            DependentService,
            Effect.gen(function* () {
              const service = yield* DependencyService
              return yield* Effect.acquireRelease(
                Effect.succeed(DependentService.of({ value: `dependent:${service.instance}` })),
                () => Effect.sync(() => events.push(`release:dependent:${service.instance}`)),
              )
            }),
          ),
          start: Effect.gen(function* () {
            const service = yield* DependencyService
            events.push(`start:dependent:${service.instance}`)
          }),
          stop: Effect.sync(() => events.push("stop:dependent:1")),
        })
        const host = yield* makeHost()
        const publication = yield* host.apply(
          applyInput([dependent, dependency], "order", "initial"),
        )

        expect(publication.plan.startOrder.map(String)).toEqual([
          String(dependency.id),
          String(dependent.id),
        ])
        expect(
          yield* publication.run(
            Effect.map(Effect.service(DependentService), (service) => service.value),
          ),
        ).toBe("dependent:1")

        yield* host.shutdown
        expect(events).toEqual([
          "acquire:dependency:1",
          "start:dependency:1",
          "start:dependent:1",
          "stop:dependent:1",
          "release:dependent:1",
          "stop:dependency:1",
          "release:dependency:1",
        ])
      }),
    ).pipe(Effect.timeout("3 seconds")),
  )

  it.live(
    "retains resources for a true no-op and restages only for a new publication revision",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          let acquisitions = 0
          let starts = 0
          let stops = 0
          let releases = 0
          let stages = 0
          const resource = defineResource({
            id: id("noop/resource"),
            scope: "process",
            layer: Layer.effect(
              TestService,
              Effect.acquireRelease(
                Effect.sync(() => {
                  acquisitions += 1
                  return TestService.of({ value: "live" })
                }),
                () =>
                  Effect.sync(() => {
                    releases += 1
                  }),
              ),
            ),
            start: Effect.sync(() => {
              starts += 1
            }),
            stop: Effect.sync(() => {
              stops += 1
            }),
          })
          const host = yield* makeHost()
          const first = yield* host.apply(applyInput([resource], "noop", "same", "catalog-1"))
          const second = yield* host.apply({
            ...applyInput([resource], "different", "ignored", "catalog-1"),
            stage: (input) =>
              Effect.sync(() => {
                stages += 1
                return `ignored:${String(input.payload)}`
              }),
          })
          expect(second).toBe(first)
          expect(acquisitions).toBe(1)
          expect(starts).toBe(1)
          expect(stops).toBe(0)
          expect(releases).toBe(0)
          expect(stages).toBe(0)

          const third = yield* host.apply(
            applyInput([resource], "restaged", "revision", "catalog-2"),
          )
          expect(third.generationId).not.toBe(first.generationId)
          expect(acquisitions).toBe(1)
          expect(starts).toBe(1)
          expect(stops).toBe(0)
          expect(releases).toBe(0)

          yield* host.shutdown
          expect(stops).toBe(1)
          expect(releases).toBe(1)
        }),
      ).pipe(Effect.timeout("3 seconds")),
  )

  it.live("rechecks queued transitions at host admission", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const releaseStage = yield* Deferred.make<true>()
        return yield* Effect.gen(function* () {
          const stageEntered = yield* Deferred.make<true>()
          const firstAdmission = yield* Deferred.make<true>()
          const secondAdmission = yield* Deferred.make<true>()
          const stages: Array<string> = []
          let desired = "first"
          const host = yield* makeHost()

          const initial = yield* host
            .apply({
              ...applyInput([], "initial", "initial"),
              stage: () =>
                Deferred.succeed(stageEntered, true).pipe(
                  Effect.andThen(Deferred.await(releaseStage)),
                  Effect.andThen(
                    Effect.sync(() => {
                      stages.push("initial")
                      return "initial"
                    }),
                  ),
                ),
            })
            .pipe(Effect.forkChild)
          yield* Deferred.await(stageEntered)

          const first = yield* host
            .apply({
              ...applyInput([], "first", "first", "catalog-first"),
              admit: Deferred.succeed(firstAdmission, true).pipe(
                Effect.andThen(
                  Effect.suspend(() => {
                    if (desired !== "first") {
                      return Effect.fail(
                        new ResourceGraphHostError({
                          failures: [
                            ResourceGraphFailure.make({
                              // oxlint-disable-next-line effect/noNullish -- Admission test failures have no resource owner.
                              id: null,
                              phase: "validate",
                              message: "first transition was superseded",
                            }),
                          ],
                          retained: [],
                          unavailable: [],
                        }),
                      )
                    }
                    return Effect.void
                  }),
                ),
              ),
            })
            .pipe(Effect.forkChild)

          desired = "second"
          const second = yield* host
            .apply({
              ...applyInput([], "second", "second", "catalog-second"),
              admit: Deferred.succeed(secondAdmission, true).pipe(
                Effect.andThen(
                  Effect.suspend(() => {
                    if (desired !== "second") {
                      return Effect.fail(
                        new ResourceGraphHostError({
                          failures: [
                            ResourceGraphFailure.make({
                              // oxlint-disable-next-line effect/noNullish -- Admission test failures have no resource owner.
                              id: null,
                              phase: "validate",
                              message: "second transition was superseded",
                            }),
                          ],
                          retained: [],
                          unavailable: [],
                        }),
                      )
                    }
                    return Effect.void
                  }),
                ),
              ),
              stage: () =>
                Effect.sync(() => {
                  stages.push("second")
                  return "second"
                }),
            })
            .pipe(Effect.forkChild)

          yield* Deferred.succeed(releaseStage, true)
          expect(Exit.isSuccess(yield* Fiber.await(initial))).toBe(true)
          yield* Deferred.await(firstAdmission)
          expect(Exit.isFailure(yield* Fiber.await(first))).toBe(true)
          yield* Deferred.await(secondAdmission)
          const secondExit = yield* Fiber.await(second)
          expect(Exit.isSuccess(secondExit)).toBe(true)
          expect(stages).toEqual(["initial", "second"])
          yield* host.shutdown
        }).pipe(Effect.ensuring(Deferred.succeed(releaseStage, true).pipe(Effect.asVoid)))
      }),
    ).pipe(Effect.timeout("3 seconds")),
  )

  it.live("rebuilds publication precedence without restarting unchanged resources", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let acquisitions = 0
        let releases = 0
        const first = defineResource({
          id: id("precedence/first"),
          scope: "process",
          layer: Layer.effect(
            TestService,
            Effect.acquireRelease(
              Effect.sync(() => {
                acquisitions += 1
                return TestService.of({ value: "first" })
              }),
              () =>
                Effect.sync(() => {
                  releases += 1
                }),
            ),
          ),
        })
        const second = defineResource({
          id: id("precedence/second"),
          scope: "process",
          layer: Layer.succeed(TestService, TestService.of({ value: "second" })),
        })
        const host = yield* makeHost()
        const firstPublication = yield* host.apply(
          applyInput([first, second], "precedence", "forward"),
        )
        expect(
          yield* firstPublication.run(
            Effect.map(Effect.service(TestService), (service) => service.value),
          ),
        ).toBe("second")

        const secondPublication = yield* host.apply(
          applyInput([second, first], "precedence", "reverse"),
        )
        expect(secondPublication.generationId).not.toBe(firstPublication.generationId)
        expect(
          yield* secondPublication.run(
            Effect.map(Effect.service(TestService), (service) => service.value),
          ),
        ).toBe("first")
        expect(acquisitions).toBe(1)
        expect(releases).toBe(0)

        yield* host.shutdown
        expect(releases).toBe(1)
      }),
    ).pipe(Effect.timeout("3 seconds")),
  )

  it.live("rejects invalid graphs before any resource effect", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let acquisitions = 0
        const make = (name: string, requires: ReadonlyArray<ResourceId>, required = false) =>
          defineResource({
            id: id(name),
            requires,
            required,
            scope: "process",
            layer: Layer.effect(
              TestService,
              Effect.sync(() => {
                acquisitions += 1
                return TestService.of({ value: name })
              }),
            ),
          })
        const host = yield* makeHost()
        const duplicate = make("invalid/duplicate", [])
        const duplicateResult = yield* host
          .apply(applyInput([duplicate, duplicate], "invalid", "duplicate"))
          .pipe(Effect.exit)
        expect(Exit.isFailure(duplicateResult)).toBe(true)

        const cycleA = make("invalid/cycle-a", [id("invalid/cycle-b")])
        const cycleB = make("invalid/cycle-b", [cycleA.id])
        const cycleResult = yield* host
          .apply(applyInput([cycleA, cycleB], "invalid", "cycle"))
          .pipe(Effect.exit)
        expect(Exit.isFailure(cycleResult)).toBe(true)

        const missing = make("invalid/missing", [id("invalid/provider")], true)
        const missingResult = yield* host
          .apply(applyInput([missing], "invalid", "missing"))
          .pipe(Effect.exit)
        expect(Exit.isFailure(missingResult)).toBe(true)
        expect(acquisitions).toBe(0)
        expect(yield* host.current).toEqual(Option.none())
      }),
    ).pipe(Effect.timeout("3 seconds")),
  )

  it.live("waits for admitted use finalizers before replacing a resource", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<true>()
        const release = yield* Deferred.make<true>()
        const replacementStarted = yield* Deferred.make<true>()
        const events: Array<string> = []
        return yield* Effect.gen(function* () {
          const oldResource = defineResource({
            id: id("drain/resource"),
            revision: "1",
            scope: "process",
            layer: Layer.succeed(TestService, TestService.of({ value: "old" })),
            stop: Effect.sync(() => events.push("old-stop")),
          })
          const newResource = defineResource({
            id: oldResource.id,
            revision: "2",
            scope: "process",
            layer: Layer.succeed(TestService, TestService.of({ value: "new" })),
            start: Deferred.succeed(replacementStarted, true).pipe(
              Effect.tap(() => Effect.sync(() => events.push("new-start"))),
            ),
          })
          const host = yield* makeHost()
          const oldPublication = yield* host.apply(applyInput([oldResource], "drain", "old"))
          const use = yield* oldPublication
            .run(
              Effect.acquireRelease(Deferred.succeed(entered, true).pipe(Effect.as("using")), () =>
                Deferred.await(release),
              ),
            )
            .pipe(Effect.forkChild)
          yield* Deferred.await(entered)
          const replacement = yield* host
            .apply(applyInput([newResource], "drain", "new", "catalog-2"))
            .pipe(Effect.forkChild)
          expect(
            Option.isNone(
              yield* Deferred.await(replacementStarted).pipe(Effect.timeoutOption("20 millis")),
            ),
          ).toBe(true)
          yield* Deferred.succeed(release, true)
          expect(Exit.isSuccess(yield* Fiber.await(use))).toBe(true)
          expect(Exit.isSuccess(yield* Fiber.await(replacement))).toBe(true)
          expect(events).toEqual(["old-stop", "new-start"])
          yield* host.shutdown
        }).pipe(Effect.ensuring(Deferred.succeed(release, true)))
      }),
    ).pipe(Effect.timeout("3 seconds")),
  )

  it.live("cancels admitted use before replacement when requested", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<true>()
        const events: Array<string> = []
        const resource = defineResource({
          id: id("cancel/resource"),
          revision: "1",
          scope: "process",
          layer: Layer.succeed(TestService, TestService.of({ value: "old" })),
        })
        const replacement = defineResource({
          id: resource.id,
          revision: "2",
          scope: "process",
          layer: Layer.succeed(TestService, TestService.of({ value: "new" })),
          start: Effect.sync(() => {
            events.push("replacement-start")
          }),
        })
        const host = yield* makeHost()
        const publication = yield* host.apply(applyInput([resource], "cancel", "old"))
        const use = yield* publication
          .run(
            Effect.gen(function* () {
              yield* Deferred.succeed(entered, true)
              return yield* Effect.never
            }).pipe(Effect.ensuring(Effect.sync(() => events.push("use-finalizer")))),
          )
          .pipe(Effect.forkChild)
        yield* Deferred.await(entered)
        const next = yield* host.apply({
          ...applyInput([replacement], "cancel", "new", "catalog-2"),
          retireMode: "cancel",
        })
        expect(events).toEqual(["use-finalizer", "replacement-start"])
        expect(Exit.isFailure(yield* Fiber.await(use))).toBe(true)
        expect(next.value).toContain("cancel:new:resource-generation-")
        yield* host.shutdown
      }),
    ).pipe(Effect.timeout("3 seconds")),
  )

  it.live("cleans partial starts in reverse order", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const events: Array<string> = []
        const good = defineResource({
          id: id("partial/good"),
          scope: "process",
          layer: Layer.succeed(TestService, TestService.of({ value: "good" })),
          start: Effect.sync(() => events.push("good-start")),
          stop: Effect.sync(() => events.push("good-stop")),
        })
        const bad = defineResource({
          id: id("partial/bad"),
          requires: [good.id],
          scope: "process",
          layer: Layer.succeed(DependentService, DependentService.of({ value: "bad" })),
          start: Effect.fail("bad-start"),
          stop: Effect.sync(() => events.push("bad-stop")),
        })
        const host = yield* makeHost()
        const result = yield* host
          .apply(applyInput([good, bad], "partial", "failure"))
          .pipe(Effect.exit)
        expect(Exit.isFailure(result)).toBe(true)
        expect(events).toEqual(["good-start", "good-stop"])
        expect(yield* host.current).toEqual(Option.none())
      }),
    ).pipe(Effect.timeout("3 seconds")),
  )

  it.live("closes staged acquisitions when catalog staging fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const events: Array<string> = []
        const resource = defineResource({
          id: id("stage/failure"),
          scope: "process",
          layer: Layer.succeed(TestService, TestService.of({ value: "stage" })),
          start: Effect.sync(() => events.push("start")),
          stop: Effect.sync(() => events.push("stop")),
        })
        const host = yield* makeHost()
        const result = yield* host
          .apply({
            ...applyInput([resource], "stage", "failure"),
            stage: () =>
              Effect.acquireRelease(
                Effect.sync(() => {
                  events.push("stage-acquire")
                }),
                () => Effect.sync(() => events.push("stage-release")),
              ).pipe(
                Effect.andThen(
                  Effect.fail(
                    new ResourceGraphHostError({
                      failures: [
                        ResourceGraphFailure.make({
                          // oxlint-disable-next-line effect/noNullish -- A stage failure has no resource owner.
                          id: null,
                          phase: "stage",
                          message: "catalog stage failed",
                        }),
                      ],
                      retained: [],
                      unavailable: [],
                    }),
                  ),
                ),
              ),
          })
          .pipe(Effect.exit)
        expect(Exit.isFailure(result)).toBe(true)
        expect(events).toEqual(["start", "stage-acquire", "stage-release", "stop"])
        expect(yield* host.current).toEqual(Option.none())
      }),
    ).pipe(Effect.timeout("3 seconds")),
  )

  it.live("quarantines failed compensation before a later restage", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const events: Array<string> = []
        let acquisitions = 0
        const resource = defineResource({
          id: id("stage/stop-failure"),
          scope: "process",
          layer: Layer.effect(
            TestService,
            Effect.acquireRelease(
              Effect.sync(() => {
                acquisitions += 1
                events.push("acquire")
                return TestService.of({ value: "stage" })
              }),
              () => Effect.sync(() => events.push("release")),
            ),
          ),
          start: Effect.sync(() => events.push("start")),
          stop: Effect.gen(function* () {
            events.push("stop")
            return yield* Effect.die(new Error("compensation stop failed"))
          }),
        })
        const host = yield* makeHost()
        const failed = yield* host
          .apply({
            ...applyInput([resource], "stage-stop", "first"),
            stage: () =>
              Effect.fail(
                new ResourceGraphHostError({
                  failures: [
                    ResourceGraphFailure.make({
                      // oxlint-disable-next-line effect/noNullish -- A stage failure has no resource owner.
                      id: null,
                      phase: "stage",
                      message: "catalog stage failed",
                    }),
                  ],
                  retained: [],
                  unavailable: [],
                }),
              ),
          })
          .pipe(Effect.exit)
        expect(Exit.isFailure(failed)).toBe(true)
        expect(acquisitions).toBe(1)
        expect(events).toEqual(["acquire", "start", "stop", "release"])

        const retried = yield* host
          .apply(applyInput([resource], "stage-stop", "retry", "catalog-2"))
          .pipe(Effect.exit)
        expect(Exit.isFailure(retried)).toBe(true)
        expect(acquisitions).toBe(1)
        expect(events).toEqual(["acquire", "start", "stop", "release"])
        if (Exit.isFailure(retried)) {
          const error = Cause.findError(retried.cause)
          expect(Result.isSuccess(error)).toBe(true)
          if (Result.isSuccess(error) && Schema.is(ResourceGraphHostError)(error.success)) {
            expect(
              error.success.failures.some((failure) =>
                failure.message.includes("compensation stop failed"),
              ),
            ).toBe(true)
          }
        }
        yield* host.shutdown
      }),
    ).pipe(Effect.timeout("3 seconds")),
  )

  it.live("blocks restage after publication cleanup fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let acquisitions = 0
        const resource = defineResource({
          id: id("stage/publication-cleanup-failure"),
          scope: "process",
          layer: Layer.effect(
            TestService,
            Effect.sync(() => {
              acquisitions += 1
              return TestService.of({ value: "stage" })
            }),
          ),
        })
        const stageFailure = new ResourceGraphHostError({
          failures: [
            ResourceGraphFailure.make({
              // oxlint-disable-next-line effect/noNullish -- A stage failure has no resource owner.
              id: null,
              phase: "stage",
              message: "catalog stage failed",
            }),
          ],
          retained: [],
          unavailable: [],
        })
        const host = yield* makeHost()
        const failed = yield* host
          .apply({
            ...applyInput([resource], "publication-cleanup", "first"),
            stage: () =>
              Effect.acquireRelease(Effect.succeed("catalog"), () =>
                Effect.die(new Error("catalog cleanup failed")),
              ).pipe(Effect.andThen(Effect.fail(stageFailure))),
          })
          .pipe(Effect.exit)
        expect(Exit.isFailure(failed)).toBe(true)
        expect(acquisitions).toBe(1)

        const retried = yield* host
          .apply(applyInput([resource], "publication-cleanup", "retry", "catalog-2"))
          .pipe(Effect.exit)
        expect(Exit.isFailure(retried)).toBe(true)
        expect(acquisitions).toBe(1)
        if (Exit.isFailure(retried)) {
          const error = Cause.findError(retried.cause)
          expect(Result.isSuccess(error)).toBe(true)
          if (Result.isSuccess(error) && Schema.is(ResourceGraphHostError)(error.success)) {
            expect(
              error.success.failures.some((failure) =>
                failure.message.includes("catalog cleanup failed"),
              ),
            ).toBe(true)
          }
        }
        yield* host.shutdown
      }),
    ).pipe(Effect.timeout("3 seconds")),
  )

  it.live("quarantines failed stops and does not start replacements", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const events: Array<string> = []
        const provider = defineResource({
          id: id("stop-failure/provider"),
          revision: "1",
          scope: "process",
          layer: Layer.succeed(
            DependencyService,
            DependencyService.of({ value: "old", instance: 1 }),
          ),
          stop: Effect.die(new Error("provider stop failed")),
        })
        const dependent = defineResource({
          id: id("stop-failure/dependent"),
          requires: [provider.id],
          revision: "1",
          scope: "process",
          layer: Layer.succeed(DependentService, DependentService.of({ value: "old" })),
          stop: Effect.sync(() => events.push("dependent-stop")),
        })
        const unrelated = defineResource({
          id: id("stop-failure/unrelated"),
          revision: "1",
          scope: "process",
          layer: Layer.succeed(TestService, TestService.of({ value: "unrelated" })),
          stop: Effect.sync(() => events.push("unrelated-stop")),
        })
        const replacementProvider = defineResource({
          ...provider,
          revision: "2",
          start: Effect.sync(() => events.push("provider-replacement-start")),
        })
        const replacementDependent = defineResource({
          ...dependent,
          start: Effect.sync(() => events.push("dependent-replacement-start")),
        })
        const replacementUnrelated = defineResource({
          ...unrelated,
          revision: "2",
          start: Effect.sync(() => events.push("unrelated-replacement-start")),
        })
        const host = yield* makeHost()
        yield* host.apply(applyInput([provider, dependent, unrelated], "stop", "old"))
        const failed = yield* host
          .apply(
            applyInput(
              [replacementProvider, replacementDependent, replacementUnrelated],
              "stop",
              "new",
              "catalog-2",
            ),
          )
          .pipe(Effect.exit)
        expect(Exit.isFailure(failed)).toBe(true)
        expect(events).toEqual(["unrelated-stop", "dependent-stop"])
        const unrelatedPublication = yield* host.apply(
          applyInput([replacementUnrelated], "stop", "unrelated", "catalog-3"),
        )
        expect(unrelatedPublication.value).toContain("stop:unrelated:resource-generation-")
        expect(events).toEqual(["unrelated-stop", "dependent-stop", "unrelated-replacement-start"])
        const retried = yield* host
          .apply(
            applyInput(
              [replacementProvider, replacementDependent, replacementUnrelated],
              "stop",
              "retry",
              "catalog-4",
            ),
          )
          .pipe(Effect.exit)
        expect(Exit.isFailure(retried)).toBe(true)
        expect(events).toEqual(["unrelated-stop", "dependent-stop", "unrelated-replacement-start"])
        if (Exit.isFailure(retried)) {
          const error = Cause.findError(retried.cause)
          expect(Result.isSuccess(error)).toBe(true)
          if (Result.isSuccess(error) && Schema.is(ResourceGraphHostError)(error.success)) {
            expect(
              error.success.failures.some(
                (failure) =>
                  failure.id === provider.id && failure.message.includes("provider stop failed"),
              ),
            ).toBe(true)
            expect(
              error.success.failures.some(
                (failure) =>
                  failure.id === dependent.id && failure.message.includes(String(provider.id)),
              ),
            ).toBe(true)
          }
        }
        yield* host.shutdown
      }),
    ).pipe(Effect.timeout("3 seconds")),
  )

  it.live("owns surviving resource scopes during parent shutdown", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const events: Array<string> = []
        const first = defineResource({
          id: id("shutdown/first"),
          scope: "process",
          layer: Layer.effect(
            TestService,
            Effect.acquireRelease(
              Effect.sync(() => TestService.of({ value: "first" })),
              () => Effect.sync(() => events.push("release:first")),
            ),
          ),
          stop: Effect.sync(() => events.push("stop:first")),
        })
        const second = defineResource({
          id: id("shutdown/second"),
          scope: "process",
          layer: Layer.effect(
            DependentService,
            Effect.acquireRelease(
              Effect.sync(() => DependentService.of({ value: "second" })),
              () => Effect.sync(() => events.push("release:second")),
            ),
          ),
          stop: Effect.sync(() => events.push("stop:second")),
        })
        const host = yield* makeHost()
        yield* host.apply(applyInput([first, second], "shutdown", "live"))
        yield* host.shutdown
        yield* host.shutdown
        expect(events).toEqual(["stop:second", "release:second", "stop:first", "release:first"])
        expect(yield* host.current).toEqual(Option.none())
        const after = yield* host.apply(applyInput([], "shutdown", "closed")).pipe(Effect.exit)
        expect(Exit.isFailure(after)).toBe(true)
      }),
    ).pipe(Effect.timeout("3 seconds")),
  )

  it.live("parent shutdown cancels a drain blocked apply before the reconcile lock", () =>
    Effect.gen(function* () {
      const parentScope = yield* Scope.make("sequential")
      const entered = yield* Deferred.make<true>()
      const useCancelled = yield* Deferred.make<true>()
      let replacementStarts = 0
      yield* Effect.ensuring(
        Effect.gen(function* () {
          const host = yield* makeHostInScope<string>(parentScope)
          const oldResource = defineResource({
            id: id("parent-shutdown/resource"),
            revision: "1",
            scope: "process",
            layer: Layer.succeed(TestService, TestService.of({ value: "old" })),
          })
          const replacement = defineResource({
            ...oldResource,
            revision: "2",
            start: Effect.sync(() => {
              replacementStarts += 1
            }),
          })
          const oldPublication = yield* host.apply(
            applyInput([oldResource], "parent-shutdown", "old"),
          )
          const use = yield* oldPublication
            .run(
              Effect.gen(function* () {
                yield* Deferred.succeed(entered, true)
                return yield* Effect.never
              }).pipe(Effect.ensuring(Deferred.succeed(useCancelled, true).pipe(Effect.asVoid))),
            )
            .pipe(Effect.forkChild)
          yield* Deferred.await(entered)

          const applying = yield* host
            .apply({
              ...applyInput([replacement], "parent-shutdown", "replacement"),
              retireMode: "drain",
            })
            .pipe(Effect.forkChild)
          // The late admission attempt is the handshake that the replacement
          // has closed the old generation before parent shutdown starts.
          yield* Effect.yieldNow
          const late = yield* oldPublication.run(Effect.fail("late admission")).pipe(Effect.exit)
          expect(Exit.isFailure(late)).toBe(true)
          if (Exit.isFailure(late)) {
            const error = Cause.findErrorOption(late.cause)
            expect(Option.isSome(error)).toBe(true)
            if (Option.isSome(error)) {
              expect(error.value).toBeInstanceOf(ResourceLeaseClosedError)
            }
          }

          const closing = yield* Scope.close(parentScope, Exit.void).pipe(Effect.forkChild)
          expect(Exit.isSuccess(yield* Fiber.await(closing))).toBe(true)
          expect(Exit.isFailure(yield* Fiber.await(applying))).toBe(true)
          expect(Exit.isFailure(yield* Fiber.await(use))).toBe(true)
          yield* Deferred.await(useCancelled)
          expect(replacementStarts).toBe(0)
        }),
        Scope.close(parentScope, Exit.void).pipe(Effect.ignore),
      )
    }).pipe(Effect.timeout("3 seconds")),
  )

  it.live("parent shutdown interrupts blocked resource activation", () =>
    Effect.gen(function* () {
      const parentScope = yield* Scope.make("sequential")
      const activationEntered = yield* Deferred.make<true>()
      let releases = 0
      yield* Effect.ensuring(
        Effect.gen(function* () {
          const host = yield* makeHostInScope<string>(parentScope)
          const resource = defineResource({
            id: id("parent-shutdown/activation"),
            scope: "process",
            layer: Layer.effect(
              TestService,
              Effect.acquireRelease(Effect.succeed(TestService.of({ value: "activation" })), () =>
                Effect.sync(() => {
                  releases += 1
                }),
              ),
            ),
            start: Effect.gen(function* () {
              yield* Deferred.succeed(activationEntered, true)
              return yield* Effect.never
            }),
          })
          const applying = yield* host
            .apply(applyInput([resource], "activation", "blocked"))
            .pipe(Effect.forkChild)
          yield* Deferred.await(activationEntered)

          const closing = yield* Scope.close(parentScope, Exit.void).pipe(Effect.forkChild)
          expect(Exit.isSuccess(yield* Fiber.await(closing))).toBe(true)
          expect(Exit.isFailure(yield* Fiber.await(applying))).toBe(true)
          expect(releases).toBe(1)
        }),
        Scope.close(parentScope, Exit.void).pipe(Effect.ignore),
      )
    }).pipe(Effect.timeout("3 seconds")),
  )

  it.live("parent shutdown interrupts blocked catalog staging", () =>
    Effect.gen(function* () {
      const parentScope = yield* Scope.make("sequential")
      const stageEntered = yield* Deferred.make<true>()
      const stageReleased = yield* Deferred.make<true>()
      yield* Effect.ensuring(
        Effect.gen(function* () {
          const host = yield* makeHostInScope<string>(parentScope)
          const resource = defineResource({
            id: id("parent-shutdown/stage"),
            scope: "process",
            layer: Layer.succeed(TestService, TestService.of({ value: "stage" })),
          })
          const applying = yield* host
            .apply({
              ...applyInput([resource], "stage", "blocked"),
              stage: () =>
                Effect.acquireRelease(
                  Deferred.succeed(stageEntered, true).pipe(Effect.as("catalog")),
                  () => Deferred.succeed(stageReleased, true).pipe(Effect.asVoid),
                ).pipe(Effect.andThen(Effect.never)),
            })
            .pipe(Effect.forkChild)
          yield* Deferred.await(stageEntered)

          const closing = yield* Scope.close(parentScope, Exit.void).pipe(Effect.forkChild)
          expect(Exit.isSuccess(yield* Fiber.await(closing))).toBe(true)
          expect(Exit.isFailure(yield* Fiber.await(applying))).toBe(true)
          yield* Deferred.await(stageReleased)
        }),
        Scope.close(parentScope, Exit.void).pipe(Effect.ignore),
      )
    }).pipe(Effect.timeout("3 seconds")),
  )

  it.live("parent shutdown interrupts blocked transition admission", () =>
    Effect.gen(function* () {
      const parentScope = yield* Scope.make("sequential")
      const admissionEntered = yield* Deferred.make<true>()
      yield* Effect.ensuring(
        Effect.gen(function* () {
          const host = yield* makeHostInScope<string>(parentScope)
          const applying = yield* host
            .apply({
              ...applyInput([], "admission", "blocked"),
              admit: Deferred.succeed(admissionEntered, true).pipe(Effect.andThen(Effect.never)),
            })
            .pipe(Effect.forkChild)
          yield* Deferred.await(admissionEntered)

          const closing = yield* Scope.close(parentScope, Exit.void).pipe(Effect.forkChild)
          expect(Exit.isSuccess(yield* Fiber.await(closing))).toBe(true)
          expect(Exit.isFailure(yield* Fiber.await(applying))).toBe(true)
        }),
        Scope.close(parentScope, Exit.void).pipe(Effect.ignore),
      )
    }).pipe(Effect.timeout("3 seconds")),
  )
})

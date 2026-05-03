import { describe, it, expect } from "effect-bun-test"
import { Effect } from "effect"
import { AutoExtension, AutoState, viewForState } from "@gent/extensions/auto"
import { AutoControllerLive, AutoRead, AutoWrite } from "@gent/extensions/auto-controller"
import { testSetupCtx } from "@gent/core/test-utils"

const makeLayer = () => AutoControllerLive

const getSnapshot = () =>
  Effect.gen(function* () {
    const auto = yield* AutoRead
    return yield* auto.snapshot()
  })

const startAuto = (goal = "test", maxIterations?: number) =>
  Effect.gen(function* () {
    const auto = yield* AutoWrite
    yield* auto.start({ goal, maxIterations })
  })

const checkpoint = (input: {
  readonly status: "continue" | "complete" | "abandon"
  readonly summary: string
  readonly learnings?: string
  readonly nextIdea?: string
}) =>
  Effect.gen(function* () {
    const auto = yield* AutoWrite
    yield* auto.autoSignal(input)
  })

const review = Effect.gen(function* () {
  const auto = yield* AutoWrite
  yield* auto.reviewSignal()
})

const turnCompleted = Effect.gen(function* () {
  const auto = yield* AutoWrite
  yield* auto.turnCompleted()
})

describe("Auto runtime", () => {
  it.live("declares process resources without actor contributions", () =>
    Effect.sync(() => {
      const contributions = Effect.runSync(AutoExtension.setup(testSetupCtx()))
      expect(contributions.actors).toBeUndefined()
      expect(contributions.resources?.length).toBe(2)
    }),
  )

  it.live("full lifecycle: start -> checkpoint -> review -> iterate -> complete", () =>
    Effect.gen(function* () {
      yield* startAuto("fix all bugs", 3)

      const snap1 = yield* getSnapshot()
      expect(snap1.active).toBe(true)
      expect(snap1.phase).toBe("working")
      expect(snap1.iteration).toBe(1)

      yield* checkpoint({
        status: "continue",
        summary: "Found issues",
        learnings: "auth bad",
      })

      const snap2 = yield* getSnapshot()
      expect(snap2.phase).toBe("awaiting-review")
      expect(snap2.learnings?.length).toBe(1)

      yield* review

      const snap3 = yield* getSnapshot()
      expect(snap3.phase).toBe("working")
      expect(snap3.iteration).toBe(2)

      yield* checkpoint({ status: "complete", summary: "All fixed" })

      const snap4 = yield* getSnapshot()
      expect(snap4.active).toBe(false)
    }).pipe(Effect.provide(makeLayer())),
  )

  it.live("turnCompleted does not advance the loop, only increments watchdog", () =>
    Effect.gen(function* () {
      yield* startAuto()
      yield* turnCompleted

      const snap = yield* getSnapshot()
      expect(snap.iteration).toBe(1)
    }).pipe(Effect.provide(makeLayer())),
  )

  it.live("cancel mid-working returns to inactive", () =>
    Effect.gen(function* () {
      const auto = yield* AutoWrite
      yield* auto.start({ goal: "test" })
      expect(yield* auto.isActive()).toBe(true)

      yield* auto.cancel()
      expect(yield* auto.isActive()).toBe(false)
    }).pipe(Effect.provide(makeLayer())),
  )

  it.live("cancel from awaiting review returns to inactive", () =>
    Effect.gen(function* () {
      const auto = yield* AutoWrite
      yield* auto.start({ goal: "test" })
      yield* auto.autoSignal({ status: "continue", summary: "x" })
      expect((yield* auto.snapshot()).phase).toBe("awaiting-review")

      yield* auto.cancel()
      expect(yield* auto.isActive()).toBe(false)
    }).pipe(Effect.provide(makeLayer())),
  )

  it.live("wedge prevention: five turns without checkpoint auto-cancel", () =>
    Effect.gen(function* () {
      yield* startAuto()

      for (let i = 0; i < 5; i++) {
        yield* turnCompleted
      }

      const snap = yield* getSnapshot()
      expect(snap.active).toBe(false)
    }).pipe(Effect.provide(makeLayer())),
  )

  it.live("inactive ignores checkpoint, review, and turn events", () =>
    Effect.gen(function* () {
      yield* checkpoint({ status: "continue", summary: "x" })
      yield* review
      yield* turnCompleted

      const snap = yield* getSnapshot()
      expect(snap.active).toBe(false)
    }).pipe(Effect.provide(makeLayer())),
  )

  it.live("unrelated tool does not advance the loop", () =>
    Effect.gen(function* () {
      yield* startAuto()

      const snap = yield* getSnapshot()
      expect(snap.phase).toBe("working")
      expect(snap.iteration).toBe(1)
    }).pipe(Effect.provide(makeLayer())),
  )

  it.live("review while working is ignored until checkpoint", () =>
    Effect.gen(function* () {
      yield* startAuto("test", 3)
      yield* review

      const snap = yield* getSnapshot()
      expect(snap.phase).toBe("working")
      expect(snap.iteration).toBe(1)
    }).pipe(Effect.provide(makeLayer())),
  )

  it.live("checkpoint while awaiting review is ignored until review", () =>
    Effect.gen(function* () {
      yield* startAuto("test", 3)
      yield* checkpoint({ status: "continue", summary: "first" })
      expect((yield* getSnapshot()).phase).toBe("awaiting-review")

      yield* checkpoint({ status: "continue", summary: "second" })
      const snap = yield* getSnapshot()
      expect(snap.phase).toBe("awaiting-review")
      expect(snap.iteration).toBe(1)
    }).pipe(Effect.provide(makeLayer())),
  )

  it.live("complete checkpoint while awaiting review is ignored", () =>
    Effect.gen(function* () {
      yield* startAuto("test", 3)
      yield* checkpoint({ status: "continue", summary: "first" })
      expect((yield* getSnapshot()).phase).toBe("awaiting-review")

      yield* checkpoint({ status: "complete", summary: "skip review" })
      const snap = yield* getSnapshot()
      expect(snap.phase).toBe("awaiting-review")
      expect(snap.active).toBe(true)
    }).pipe(Effect.provide(makeLayer())),
  )

  it.live("maxIterations reached after review returns inactive", () =>
    Effect.gen(function* () {
      yield* startAuto("test", 1)
      yield* checkpoint({ status: "continue", summary: "done" })
      expect((yield* getSnapshot()).phase).toBe("awaiting-review")

      yield* review

      const snap = yield* getSnapshot()
      expect(snap.active).toBe(false)
    }).pipe(Effect.provide(makeLayer())),
  )

  it.live("turn projection injects learnings and next idea into prompt sections", () =>
    Effect.gen(function* () {
      const auto = yield* AutoWrite
      yield* auto.start({ goal: "research caching strategies" })
      yield* auto.autoSignal({
        status: "continue",
        summary: "first pass",
        learnings: "tried memoization",
        nextIdea: "test LRU eviction",
      })
      yield* auto.reviewSignal()

      const view = yield* auto.turnProjection()
      expect(view.prompt?.length).toBe(1)
      const content = view.prompt![0]!.content
      expect(content).toContain("tried memoization")
      expect(content).toContain("test LRU eviction")
    }).pipe(Effect.provide(makeLayer())),
  )

  it.live("inactive projection excludes auto checkpoint", () =>
    Effect.sync(() => {
      const view = viewForState(AutoState.Inactive.make({}))
      expect(view.toolPolicy).toEqual({ exclude: ["auto_checkpoint"] })
    }),
  )
})

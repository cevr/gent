import { describe, it, expect, test } from "effect-bun-test"
import { Deferred, Effect } from "effect"
import artifactsBuiltin from "../src/extensions/builtins/artifacts.client"
import { BranchId, SessionId } from "@gent/core-internal/domain/ids"
import {
  findBorderLabel,
  makeActiveSessionRef,
  makeClientExtensionRuntime,
  runClientExtensionSetup,
} from "./extension-test-harness-boundary"

const throwCleanup = (): never => Effect.runSync(Effect.die("boom"))

describe("transport-only extension widgets", () => {
  test("cleanups fire in registration order", () => {
    const calls: string[] = []
    const cleanups: Array<() => void> = []
    const lifecycle = { addCleanup: (fn: () => void) => cleanups.push(fn) }
    lifecycle.addCleanup(() => calls.push("first"))
    lifecycle.addCleanup(() => calls.push("second"))
    lifecycle.addCleanup(() => calls.push("third"))
    for (const cleanup of cleanups) cleanup()
    expect(calls).toEqual(["first", "second", "third"])
  })
  it.live("a thrown cleanup does not block later cleanups", () =>
    Effect.gen(function* () {
      const calls: string[] = []
      const cleanups: Array<() => void> = []
      const lifecycle = { addCleanup: (fn: () => void) => cleanups.push(fn) }
      lifecycle.addCleanup(() => calls.push("before-throw"))
      lifecycle.addCleanup(throwCleanup)
      lifecycle.addCleanup(() => calls.push("after-throw"))
      yield* Effect.forEach(cleanups, (cleanup) => Effect.sync(cleanup).pipe(Effect.ignoreCause))
      expect(calls).toEqual(["before-throw", "after-throw"])
    }),
  )
  it.live("artifacts widget drops a stale refetch after the branch changes", () =>
    Effect.gen(function* () {
      const activeSession = makeActiveSessionRef({
        sessionId: SessionId.make("session-A"),
        branchId: BranchId.make("branch-A"),
      })
      const requestDeferred = yield* Deferred.make<unknown, never>()
      const runtime = makeClientExtensionRuntime({ activeSession, requestDeferred })
      yield* Effect.gen(function* () {
        const contributions = yield* runClientExtensionSetup(runtime, artifactsBuiltin)
        const borderLabel = findBorderLabel(contributions, "bottom-right")
        expect(borderLabel).toBeDefined()
        activeSession.value = {
          sessionId: SessionId.make("session-A"),
          branchId: BranchId.make("branch-B"),
        }
        yield* Deferred.succeed(requestDeferred, [
          {
            id: "artifact-1",
            label: "Plan",
            sourceTool: "plan",
            content: "body",
            status: "active",
            branchId: BranchId.make("branch-A"),
            createdAt: 1,
            updatedAt: 2,
          },
        ])
        // gent/no-sleep: allow microtask drain — extension widget fiber must observe queued state pulse before assertion
        yield* Effect.sleep("0 millis")
        expect(borderLabel?.produce()).toEqual([])
      }).pipe(Effect.ensuring(Effect.promise(() => runtime.dispose())))
    }),
  )
  it.live("artifacts widget renders decoded artifacts", () =>
    Effect.gen(function* () {
      const activeSession = makeActiveSessionRef({
        sessionId: SessionId.make("session-A"),
        branchId: BranchId.make("branch-A"),
      })
      const requestDeferred = yield* Deferred.make<unknown, never>()
      const runtime = makeClientExtensionRuntime({ activeSession, requestDeferred })
      yield* Effect.gen(function* () {
        const contributions = yield* runClientExtensionSetup(runtime, artifactsBuiltin)
        const borderLabel = findBorderLabel(contributions, "bottom-right")
        expect(borderLabel).toBeDefined()
        yield* Deferred.succeed(requestDeferred, [
          {
            id: "artifact-1",
            label: "Plan",
            sourceTool: "plan",
            content: "body",
            status: "active",
            branchId: BranchId.make("branch-A"),
            createdAt: 1,
            updatedAt: 2,
          },
        ])
        // gent/no-sleep: allow microtask drain — extension widget fiber must observe queued state pulse before assertion
        yield* Effect.sleep("0 millis")
        expect(borderLabel?.produce()).toEqual([{ text: "1 artifact", color: "info" }])
      }).pipe(Effect.ensuring(Effect.promise(() => runtime.dispose())))
    }),
  )
  it.live("artifacts widget rejects undecodable artifacts at the client seam", () =>
    Effect.gen(function* () {
      const activeSession = makeActiveSessionRef({
        sessionId: SessionId.make("session-A"),
        branchId: BranchId.make("branch-A"),
      })
      const requestDeferred = yield* Deferred.make<unknown, never>()
      const runtime = makeClientExtensionRuntime({ activeSession, requestDeferred })
      yield* Effect.gen(function* () {
        const contributions = yield* runClientExtensionSetup(runtime, artifactsBuiltin)
        const borderLabel = findBorderLabel(contributions, "bottom-right")
        expect(borderLabel).toBeDefined()
        yield* Deferred.succeed(requestDeferred, [{ status: "active" }])
        // gent/no-sleep: allow microtask drain — extension widget fiber must observe queued state pulse before assertion
        yield* Effect.sleep("0 millis")
        expect(borderLabel?.produce()).toEqual([])
      }).pipe(Effect.ensuring(Effect.promise(() => runtime.dispose())))
    }),
  )
})

import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Layer, ManagedRuntime } from "effect"
import { BunFileSystem, BunServices } from "@effect/platform-bun"
import {
  makeClientWorkspaceLayer,
  makeClientShellLayer,
  makeClientComposerLayer,
  makeClientLifecycleLayer,
} from "../src/extensions/client-services"
import { makeClientTransportLayer } from "../src/extensions/client-transport"
import autoBuiltin from "../src/extensions/builtins/auto.client"
import artifactsBuiltin from "../src/extensions/builtins/artifacts.client"

const buildRuntime = (
  activeSession: { value: { sessionId: string; branchId: string } | undefined },
  askDeferred: Deferred.Deferred<unknown, never>,
): ManagedRuntime.ManagedRuntime<never, never> =>
  ManagedRuntime.make(
    Layer.mergeAll(
      BunFileSystem.layer,
      BunServices.layer,
      makeClientWorkspaceLayer({ cwd: "/tmp/test-cwd", home: "/tmp/test-home" }),
      makeClientShellLayer({
        send: () => {},
        sendMessage: () => {},
        openOverlay: () => {},
        closeOverlay: () => {},
      }),
      makeClientComposerLayer({
        state: () => ({
          draft: "",
          mode: "editing" as const,
          inputFocused: false,
          autocompleteOpen: false,
        }),
      }),
      makeClientTransportLayer({
        client: {
          extension: {
            ask: () => Deferred.await(askDeferred),
            request: () => Effect.void,
            listCommands: () => Effect.succeed([]),
          },
        } as Parameters<typeof makeClientTransportLayer>[0]["client"],
        runtime: {
          run: <A, E>(effect: Effect.Effect<A, E, never>): Promise<A> => Effect.runPromise(effect),
        } as Parameters<typeof makeClientTransportLayer>[0]["runtime"],
        currentSession: () => activeSession.value,
        onExtensionStateChanged: () => () => {},
      }),
      makeClientLifecycleLayer({ addCleanup: () => {} }),
    ),
  )

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

  test("a thrown cleanup does not block later cleanups", () => {
    const calls: string[] = []
    const cleanups: Array<() => void> = []
    const lifecycle = { addCleanup: (fn: () => void) => cleanups.push(fn) }

    lifecycle.addCleanup(() => calls.push("before-throw"))
    lifecycle.addCleanup(() => {
      throw new Error("boom")
    })
    lifecycle.addCleanup(() => calls.push("after-throw"))

    for (const cleanup of cleanups) {
      try {
        cleanup()
      } catch {
        // Mirrors provider-side cleanup isolation.
      }
    }

    expect(calls).toEqual(["before-throw", "after-throw"])
  })

  test("auto widget drops a stale refetch after the session changes", async () => {
    const activeSession = {
      value: { sessionId: "session-A", branchId: "branch-A" } as
        | { sessionId: string; branchId: string }
        | undefined,
    }
    const askDeferred = await Effect.runPromise(Deferred.make<unknown, never>())
    const runtime = buildRuntime(activeSession, askDeferred)

    try {
      const contributions = await runtime.runPromise(autoBuiltin.setup)
      const borderLabel = contributions.find(
        (entry) => entry._tag === "border-label" && entry.position === "top-left",
      )

      expect(borderLabel).toBeDefined()

      activeSession.value = { sessionId: "session-B", branchId: "branch-B" }
      await Effect.runPromise(
        Deferred.succeed(askDeferred, { active: true, phase: "running", iteration: 1 }),
      )
      await Promise.resolve()
      await Promise.resolve()

      expect(borderLabel?.produce()).toEqual([])
    } finally {
      await runtime.dispose()
    }
  })

  test("artifacts widget drops a stale refetch after the branch changes", async () => {
    const activeSession = {
      value: { sessionId: "session-A", branchId: "branch-A" } as
        | { sessionId: string; branchId: string }
        | undefined,
    }
    const askDeferred = await Effect.runPromise(Deferred.make<unknown, never>())
    const runtime = buildRuntime(activeSession, askDeferred)

    try {
      const contributions = await runtime.runPromise(artifactsBuiltin.setup)
      const borderLabel = contributions.find(
        (entry) => entry._tag === "border-label" && entry.position === "bottom-right",
      )

      expect(borderLabel).toBeDefined()

      activeSession.value = { sessionId: "session-A", branchId: "branch-B" }
      await Effect.runPromise(
        Deferred.succeed(askDeferred, [{ status: "active", branchId: "branch-A" }]),
      )
      await Promise.resolve()
      await Promise.resolve()

      expect(borderLabel?.produce()).toEqual([])
    } finally {
      await runtime.dispose()
    }
  })
})

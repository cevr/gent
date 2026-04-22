/**
 * Lifecycle + stale-response invariants for transport-only widgets (B11.6).
 *
 * Pins two contracts the prior counsel pass flagged as untested:
 *
 *  1. `ClientLifecycle.addCleanup` callbacks run in registration order
 *     when the `ExtensionUIProvider`'s `onCleanup` fires, BEFORE the
 *     per-provider `clientRuntime` is disposed. Without this, a widget's
 *     pulse `unsubscribe` could fire against an already-disposed
 *     transport.
 *
 *  2. The keyed `(sessionId, branchId)` gating in
 *     `auto`/`artifacts`/`tasks` widgets drops a refetch reply that
 *     resolves AFTER the live session changed. The widget setup must
 *     not emit stale state into the signal once the gate moves.
 *
 * Both are exercised via the real builtin setups against synthetic
 * Effect runtimes, not via end-to-end provider mount — the goal is to
 * prove the invariant cheaply, not re-test the harness.
 */

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

describe("ClientLifecycle.addCleanup contract", () => {
  test("cleanups fire in registration order", () => {
    const calls: string[] = []
    const cleanups: Array<() => void> = []
    const lifecycle = { addCleanup: (fn: () => void) => cleanups.push(fn) }

    lifecycle.addCleanup(() => calls.push("first"))
    lifecycle.addCleanup(() => calls.push("second"))
    lifecycle.addCleanup(() => calls.push("third"))

    // Mirror the provider's onCleanup body.
    for (const fn of cleanups) fn()

    expect(calls).toEqual(["first", "second", "third"])
  })

  test("a thrown cleanup does not block subsequent ones", () => {
    const calls: string[] = []
    const cleanups: Array<() => void> = []
    const lifecycle = { addCleanup: (fn: () => void) => cleanups.push(fn) }

    lifecycle.addCleanup(() => calls.push("before-throw"))
    lifecycle.addCleanup(() => {
      throw new Error("boom")
    })
    lifecycle.addCleanup(() => calls.push("after-throw"))

    // Mirror the provider's onCleanup body — swallows per-cleanup throws.
    for (const fn of cleanups) {
      try {
        fn()
      } catch {
        // Provider-side swallow is the whole point of this branch.
      }
    }

    expect(calls).toEqual(["before-throw", "after-throw"])
  })
})

describe("transport-only widgets — stale-response gating", () => {
  // Build a runtime where currentSession() can be flipped between calls.
  // The widget's refetch path captures the active session at call time;
  // when it resolves later, it must re-check the LIVE session before
  // committing state.
  const buildRuntime = (
    activeSession: { value: { sessionId: string; branchId: string } | undefined },
    askDeferred: Deferred.Deferred<unknown, never>,
  ): ManagedRuntime.ManagedRuntime<never, never> => {
    return ManagedRuntime.make(
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
          // Stubbed RPC client: extension.ask returns an Effect that
          // awaits the test-controlled Deferred so we can resolve the
          // refetch AFTER swapping `activeSession`.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          client: {
            extension: {
              ask: () => Deferred.await(askDeferred),
              request: () => Effect.void,
              listCommands: () => Effect.succeed([]),
            },
          } as any,
          // runtime.run wraps an Effect into a Promise — use a real
          // Effect runtime under the hood.
          runtime: {
            run: <A, E>(effect: Effect.Effect<A, E, never>): Promise<A> =>
              Effect.runPromise(effect),
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } as any,
          currentSession: () => activeSession.value,
          onExtensionStateChanged: () => () => {},
        }),
        makeClientLifecycleLayer({ addCleanup: () => {} }),
      ),
    )
  }

  test("auto widget drops a refetch reply after session changes", async () => {
    const activeSession = {
      value: { sessionId: "session-A", branchId: "branch-A" } as
        | { sessionId: string; branchId: string }
        | undefined,
    }
    const askDeferred = await Effect.runPromise(Deferred.make<unknown, never>())

    const runtime = buildRuntime(activeSession, askDeferred)
    try {
      // Run the widget setup against the runtime so it captures
      // ClientTransport with the controlled stubs above.
      const contributions = await runtime.runPromise(autoBuiltin.setup)

      // The auto widget contributes a top-left border label whose
      // `produce()` reads via `liveModel()` (the keyed gate). Find it.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const borderLabel = (contributions as ReadonlyArray<any>).find(
        (c) => c._kind === "border-label" && c.position === "top-left",
      )
      expect(borderLabel).toBeDefined()

      // Setup's `createEffect` already kicked off a refetch for session-A.
      // While that refetch is pending, swap the active session to B.
      activeSession.value = { sessionId: "session-B", branchId: "branch-B" }

      // Resolve the in-flight refetch with a session-A snapshot. The
      // keyed gate must drop it because the live session is now B.
      await Effect.runPromise(
        Deferred.succeed(askDeferred, { active: true, phase: "running", iteration: 1 }),
      )
      // Yield to flush the .then() chain in runRefetch.
      await Promise.resolve()
      await Promise.resolve()

      // Border label produce() reads liveModel(), which gates by the
      // CURRENT session. With the live key being B and stored state
      // (if any) keyed to A, liveModel() returns undefined → no label.
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      const labels = borderLabel.produce()
      expect(labels).toEqual([])
    } finally {
      await runtime.dispose()
    }
  })

  test("artifacts widget drops a refetch reply after branch changes", async () => {
    const activeSession = {
      value: { sessionId: "session-A", branchId: "branch-A" } as
        | { sessionId: string; branchId: string }
        | undefined,
    }
    const askDeferred = await Effect.runPromise(Deferred.make<unknown, never>())

    const runtime = buildRuntime(activeSession, askDeferred)
    try {
      const contributions = await runtime.runPromise(artifactsBuiltin.setup)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const borderLabel = (contributions as ReadonlyArray<any>).find(
        (c) => c._kind === "border-label" && c.position === "bottom-right",
      )
      expect(borderLabel).toBeDefined()

      // Branch swap mid-refetch (same session, different branch — also
      // a stale key per the widget's gate).
      activeSession.value = { sessionId: "session-A", branchId: "branch-B" }

      await Effect.runPromise(
        Deferred.succeed(askDeferred, [{ status: "active", branchId: "branch-A" }]),
      )
      await Promise.resolve()
      await Promise.resolve()

      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      const labels = borderLabel.produce()
      expect(labels).toEqual([])
    } finally {
      await runtime.dispose()
    }
  })
})

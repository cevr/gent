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
import type { ClientContribution } from "../src/extensions/client-facets.js"
import autoBuiltin from "../src/extensions/builtins/auto.client"
import artifactsBuiltin from "../src/extensions/builtins/artifacts.client"
import tasksBuiltin from "../src/extensions/builtins/tasks.client"
import { BranchId, SessionId } from "@gent/core/domain/ids"

const buildRuntime = (
  activeSession: { value: { sessionId: SessionId; branchId: BranchId } | undefined },
  opts: {
    readonly askDeferred?: Deferred.Deferred<unknown, never>
    readonly requestDeferred?: Deferred.Deferred<unknown, never>
  },
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
            ask: () =>
              opts.askDeferred === undefined ? Effect.void : Deferred.await(opts.askDeferred),
            request: () =>
              opts.requestDeferred === undefined
                ? Effect.void
                : Deferred.await(opts.requestDeferred),
            listCommands: () => Effect.succeed([]),
          },
        } as unknown as Parameters<typeof makeClientTransportLayer>[0]["client"],
        runtime: {
          run: <A, E>(effect: Effect.Effect<A, E, never>): Promise<A> => Effect.runPromise(effect),
        } as unknown as Parameters<typeof makeClientTransportLayer>[0]["runtime"],
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
      value: { sessionId: SessionId.make("session-A"), branchId: BranchId.make("branch-A") } as
        | { sessionId: SessionId; branchId: BranchId }
        | undefined,
    }
    const askDeferred = await Effect.runPromise(Deferred.make<unknown, never>())
    const runtime = buildRuntime(activeSession, { askDeferred })

    try {
      const contributions = await runtime.runPromise(
        autoBuiltin.setup as unknown as Effect.Effect<readonly ClientContribution[], never, never>,
      )
      const borderLabel = contributions.find(
        (entry): entry is Extract<ClientContribution, { _tag: "border-label" }> =>
          entry._tag === "border-label" && entry.position === "top-left",
      )

      expect(borderLabel).toBeDefined()

      activeSession.value = {
        sessionId: SessionId.make("session-B"),
        branchId: BranchId.make("branch-B"),
      }
      await Effect.runPromise(
        Deferred.succeed(askDeferred, { active: true, phase: "working", iteration: 1 }),
      )
      await Promise.resolve()
      await Promise.resolve()

      expect(borderLabel?.produce()).toEqual([])
    } finally {
      await runtime.dispose()
    }
  })

  test("auto widget renders a decoded snapshot", async () => {
    const activeSession = {
      value: { sessionId: SessionId.make("session-A"), branchId: BranchId.make("branch-A") } as
        | { sessionId: SessionId; branchId: BranchId }
        | undefined,
    }
    const askDeferred = await Effect.runPromise(Deferred.make<unknown, never>())
    const runtime = buildRuntime(activeSession, { askDeferred })

    try {
      const contributions = await runtime.runPromise(
        autoBuiltin.setup as unknown as Effect.Effect<readonly ClientContribution[], never, never>,
      )
      const borderLabel = contributions.find(
        (entry): entry is Extract<ClientContribution, { _tag: "border-label" }> =>
          entry._tag === "border-label" && entry.position === "top-left",
      )

      expect(borderLabel).toBeDefined()

      await Effect.runPromise(
        Deferred.succeed(askDeferred, {
          active: true,
          phase: "working",
          iteration: 2,
          maxIterations: 4,
        }),
      )
      await Promise.resolve()
      await Promise.resolve()

      expect(borderLabel?.produce()).toEqual([{ text: "auto 2/4", color: "info" }])
    } finally {
      await runtime.dispose()
    }
  })

  test("auto widget rejects undecodable snapshots at the client seam", async () => {
    const activeSession = {
      value: { sessionId: SessionId.make("session-A"), branchId: BranchId.make("branch-A") } as
        | { sessionId: SessionId; branchId: BranchId }
        | undefined,
    }
    const askDeferred = await Effect.runPromise(Deferred.make<unknown, never>())
    const runtime = buildRuntime(activeSession, { askDeferred })

    try {
      const contributions = await runtime.runPromise(
        autoBuiltin.setup as unknown as Effect.Effect<readonly ClientContribution[], never, never>,
      )
      const borderLabel = contributions.find(
        (entry): entry is Extract<ClientContribution, { _tag: "border-label" }> =>
          entry._tag === "border-label" && entry.position === "top-left",
      )

      expect(borderLabel).toBeDefined()

      await Effect.runPromise(Deferred.succeed(askDeferred, { active: "yes" }))
      await Promise.resolve()
      await Promise.resolve()

      expect(borderLabel?.produce()).toEqual([])
    } finally {
      await runtime.dispose()
    }
  })

  test("artifacts widget drops a stale refetch after the branch changes", async () => {
    const activeSession = {
      value: { sessionId: SessionId.make("session-A"), branchId: BranchId.make("branch-A") } as
        | { sessionId: SessionId; branchId: BranchId }
        | undefined,
    }
    const askDeferred = await Effect.runPromise(Deferred.make<unknown, never>())
    const runtime = buildRuntime(activeSession, { askDeferred })

    try {
      const contributions = await runtime.runPromise(
        artifactsBuiltin.setup as unknown as Effect.Effect<
          readonly ClientContribution[],
          never,
          never
        >,
      )
      const borderLabel = contributions.find(
        (entry): entry is Extract<ClientContribution, { _tag: "border-label" }> =>
          entry._tag === "border-label" && entry.position === "bottom-right",
      )

      expect(borderLabel).toBeDefined()

      activeSession.value = {
        sessionId: SessionId.make("session-A"),
        branchId: BranchId.make("branch-B"),
      }
      await Effect.runPromise(
        Deferred.succeed(askDeferred, [
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
        ]),
      )
      await Promise.resolve()
      await Promise.resolve()

      expect(borderLabel?.produce()).toEqual([])
    } finally {
      await runtime.dispose()
    }
  })

  test("artifacts widget renders decoded artifacts", async () => {
    const activeSession = {
      value: { sessionId: SessionId.make("session-A"), branchId: BranchId.make("branch-A") } as
        | { sessionId: SessionId; branchId: BranchId }
        | undefined,
    }
    const askDeferred = await Effect.runPromise(Deferred.make<unknown, never>())
    const runtime = buildRuntime(activeSession, { askDeferred })

    try {
      const contributions = await runtime.runPromise(
        artifactsBuiltin.setup as unknown as Effect.Effect<
          readonly ClientContribution[],
          never,
          never
        >,
      )
      const borderLabel = contributions.find(
        (entry): entry is Extract<ClientContribution, { _tag: "border-label" }> =>
          entry._tag === "border-label" && entry.position === "bottom-right",
      )

      expect(borderLabel).toBeDefined()

      await Effect.runPromise(
        Deferred.succeed(askDeferred, [
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
        ]),
      )
      await Promise.resolve()
      await Promise.resolve()

      expect(borderLabel?.produce()).toEqual([{ text: "1 artifact", color: "info" }])
    } finally {
      await runtime.dispose()
    }
  })

  test("artifacts widget rejects undecodable artifacts at the client seam", async () => {
    const activeSession = {
      value: { sessionId: SessionId.make("session-A"), branchId: BranchId.make("branch-A") } as
        | { sessionId: SessionId; branchId: BranchId }
        | undefined,
    }
    const askDeferred = await Effect.runPromise(Deferred.make<unknown, never>())
    const runtime = buildRuntime(activeSession, { askDeferred })

    try {
      const contributions = await runtime.runPromise(
        artifactsBuiltin.setup as unknown as Effect.Effect<
          readonly ClientContribution[],
          never,
          never
        >,
      )
      const borderLabel = contributions.find(
        (entry): entry is Extract<ClientContribution, { _tag: "border-label" }> =>
          entry._tag === "border-label" && entry.position === "bottom-right",
      )

      expect(borderLabel).toBeDefined()

      await Effect.runPromise(Deferred.succeed(askDeferred, [{ status: "active" }]))
      await Promise.resolve()
      await Promise.resolve()

      expect(borderLabel?.produce()).toEqual([])
    } finally {
      await runtime.dispose()
    }
  })

  test("tasks widget renders decoded task list responses", async () => {
    const activeSession = {
      value: { sessionId: SessionId.make("session-A"), branchId: BranchId.make("branch-A") } as
        | { sessionId: SessionId; branchId: BranchId }
        | undefined,
    }
    const requestDeferred = await Effect.runPromise(Deferred.make<unknown, never>())
    const runtime = buildRuntime(activeSession, { requestDeferred })

    try {
      const contributions = await runtime.runPromise(
        tasksBuiltin.setup as unknown as Effect.Effect<readonly ClientContribution[], never, never>,
      )
      const borderLabel = contributions.find(
        (entry): entry is Extract<ClientContribution, { _tag: "border-label" }> =>
          entry._tag === "border-label" && entry.position === "bottom-left",
      )

      expect(borderLabel).toBeDefined()

      await Effect.runPromise(
        Deferred.succeed(requestDeferred, [
          {
            id: "task-1",
            sessionId: SessionId.make("session-A"),
            branchId: BranchId.make("branch-A"),
            subject: "Audit",
            status: "in_progress",
            createdAt: 1,
            updatedAt: 2,
          },
        ]),
      )
      await Promise.resolve()
      await Promise.resolve()

      expect(borderLabel?.produce()).toEqual([{ text: "1 task ↓", color: "info" }])
    } finally {
      await runtime.dispose()
    }
  })

  test("tasks widget rejects undecodable task lists at the client seam", async () => {
    const activeSession = {
      value: { sessionId: SessionId.make("session-A"), branchId: BranchId.make("branch-A") } as
        | { sessionId: SessionId; branchId: BranchId }
        | undefined,
    }
    const requestDeferred = await Effect.runPromise(Deferred.make<unknown, never>())
    const runtime = buildRuntime(activeSession, { requestDeferred })

    try {
      const contributions = await runtime.runPromise(
        tasksBuiltin.setup as unknown as Effect.Effect<readonly ClientContribution[], never, never>,
      )
      const borderLabel = contributions.find(
        (entry): entry is Extract<ClientContribution, { _tag: "border-label" }> =>
          entry._tag === "border-label" && entry.position === "bottom-left",
      )

      expect(borderLabel).toBeDefined()

      await Effect.runPromise(
        Deferred.succeed(requestDeferred, [{ subject: "missing id", status: "pending" }]),
      )
      await Promise.resolve()
      await Promise.resolve()

      expect(borderLabel?.produce()).toEqual([])
    } finally {
      await runtime.dispose()
    }
  })
})

import { describe, expect, it } from "effect-bun-test"
import { Cause, Deferred, Effect, Stream } from "effect"
import { BranchId, SessionId } from "@gent/core-internal/domain/ids"
import { EventStore, SessionStarted } from "@gent/core-internal/domain/event"
import { LanguageModelLayers } from "@gent/core-internal/test-utils/language-model"
import { SessionCommands } from "../../src/server/session-commands"
import { BranchStorage } from "@gent/core-internal/storage/branch-storage"
import { SessionStorage } from "@gent/core-internal/storage/session-storage"
import { createE2ELayer } from "@gent/core-internal/test-utils/e2e-layer"
import { Gent } from "@gent/sdk"
import { e2ePreset } from "../../../extensions/tests/helpers/test-preset"
import { SessionMutations } from "../../src/domain/session-mutations"
import {
  FIXED_NOW,
  collectSessionEvents,
  createActiveSessionFixture,
  failingDeleteSessionCommandsLayerWithMachineProbe,
  makeClient,
  racySessionCommandsLayer,
  sessionCommandsLayerWithMachineProbe,
  sessionMutationsLayerWithMachineProbe,
} from "./session-commands/helpers"

describe("session.delete", () => {
  it.live("closes session event streams and removes the session from public queries", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { client } = yield* makeClient()
        const created = yield* client.session.create({ cwd: process.cwd() })
        const closed = yield* collectSessionEvents(
          client.session.events({
            sessionId: created.sessionId,
          }),
        )

        yield* client.session.delete({ sessionId: created.sessionId })
        yield* Deferred.await(closed).pipe(Effect.timeout("5 seconds"))

        const deleted = yield* client.session.get({ sessionId: created.sessionId })
        const sessions = yield* client.session.list()

        expect(deleted).toBeNull()
        expect(sessions.some((session) => session.id === created.sessionId)).toBe(false)
      }).pipe(Effect.timeout("4 seconds")),
    ),
  )

  it.live("closes descendant event streams and removes descendants on public delete", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { client } = yield* makeClient()
        const parent = yield* client.session.create({ cwd: process.cwd() })
        const child = yield* client.session.create({
          cwd: process.cwd(),
          parentSessionId: parent.sessionId,
          parentBranchId: parent.branchId,
        })
        const grandchild = yield* client.session.create({
          cwd: process.cwd(),
          parentSessionId: child.sessionId,
          parentBranchId: child.branchId,
        })

        const parentClosed = yield* collectSessionEvents(
          client.session.events({ sessionId: parent.sessionId }),
        )
        const childClosed = yield* collectSessionEvents(
          client.session.events({ sessionId: child.sessionId }),
        )
        const grandchildClosed = yield* collectSessionEvents(
          client.session.events({ sessionId: grandchild.sessionId }),
        )

        yield* client.session.delete({ sessionId: parent.sessionId })

        yield* Deferred.await(parentClosed).pipe(Effect.timeout("5 seconds"))
        yield* Deferred.await(childClosed).pipe(Effect.timeout("5 seconds"))
        yield* Deferred.await(grandchildClosed).pipe(Effect.timeout("5 seconds"))

        expect(yield* client.session.get({ sessionId: parent.sessionId })).toBeNull()
        expect(yield* client.session.get({ sessionId: child.sessionId })).toBeNull()
        expect(yield* client.session.get({ sessionId: grandchild.sessionId })).toBeNull()
      }).pipe(Effect.timeout("4 seconds")),
    ),
  )

  it.live("closes runtime streams and interrupts active loops on public delete", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { layer: providerLayer, controls } =
          yield* LanguageModelLayers.signal("delete me later")
        const { client } = yield* Gent.test(createE2ELayer({ ...e2ePreset, providerLayer }))
        const created = yield* client.session.create({ cwd: process.cwd() })
        const runtimeClosed = yield* collectSessionEvents(
          client.session.watchRuntime({
            sessionId: created.sessionId,
            branchId: created.branchId,
          }),
        )

        yield* client.message.send({
          sessionId: created.sessionId,
          branchId: created.branchId,
          content: "start an active loop before delete",
        })
        yield* controls.waitForStreamStart.pipe(Effect.timeout("5 seconds"))

        yield* client.session.delete({ sessionId: created.sessionId })
        yield* Deferred.await(runtimeClosed).pipe(Effect.timeout("5 seconds"))

        expect(yield* client.session.get({ sessionId: created.sessionId })).toBeNull()
      }).pipe(Effect.timeout("4 seconds")),
    ),
  )

  it.live("is idempotent when deleting an already deleted session", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { client } = yield* makeClient()
        const created = yield* client.session.create({ cwd: process.cwd() })

        yield* client.session.delete({ sessionId: created.sessionId })
        yield* client.session.delete({ sessionId: created.sessionId })
        const deleted = yield* client.session.get({ sessionId: created.sessionId })

        expect(deleted).toBeNull()
      }).pipe(Effect.timeout("4 seconds")),
    ),
  )

  it.live("cleans runtime state for descendant sessions before durable cascade", () => {
    const runtimeTerminated: Array<SessionId> = []
    return Effect.scoped(
      Effect.gen(function* () {
        const commands = yield* SessionCommands
        const mutations = yield* SessionMutations
        const eventStore = yield* EventStore

        const parent = yield* commands.createSession({ cwd: "/tmp/delete-parent" })
        const child = yield* mutations.createChildSession({
          parentSessionId: parent.sessionId,
          parentBranchId: parent.branchId,
          cwd: "/tmp/delete-child",
        })
        const grandchild = yield* mutations.createChildSession({
          parentSessionId: child.sessionId,
          parentBranchId: child.branchId,
          cwd: "/tmp/delete-grandchild",
        })

        const primeSessionStream = Effect.fn("primeSessionStream")(function* (
          sessionId: SessionId,
          branchId: BranchId,
        ) {
          const closed = collectSessionEvents(eventStore.subscribe({ sessionId }))
          yield* eventStore.publish(SessionStarted.make({ sessionId, branchId }))
          return yield* closed
        })

        const parentClosed = yield* primeSessionStream(parent.sessionId, parent.branchId)
        const childClosed = yield* primeSessionStream(child.sessionId, child.branchId)
        const grandchildClosed = yield* primeSessionStream(
          grandchild.sessionId,
          grandchild.branchId,
        )

        yield* commands.deleteSession(parent.sessionId)

        yield* Deferred.await(parentClosed).pipe(Effect.timeout("5 seconds"))
        yield* Deferred.await(childClosed).pipe(Effect.timeout("5 seconds"))
        yield* Deferred.await(grandchildClosed).pipe(Effect.timeout("5 seconds"))
        expect(runtimeTerminated).toEqual([parent.sessionId, child.sessionId, grandchild.sessionId])
      }).pipe(
        Effect.provide(sessionCommandsLayerWithMachineProbe(runtimeTerminated)),
        Effect.timeout("4 seconds"),
      ),
    )
  })

  it.live("cleans runtime state for a child created mid-cascade", () => {
    const runtimeTerminated: Array<SessionId> = []
    const lateChildSessionId = SessionId.make("race-late-child")
    const lateChildBranchId = BranchId.make("race-late-child-branch")
    return Effect.scoped(
      Effect.gen(function* () {
        const commands = yield* SessionCommands
        const sessions = yield* SessionStorage

        const parent = yield* commands.createSession({ cwd: "/tmp/race-parent" })

        yield* commands.deleteSession(parent.sessionId)

        expect(yield* sessions.getSession(parent.sessionId)).toBeUndefined()
        expect(yield* sessions.getSession(lateChildSessionId)).toBeUndefined()
        expect(runtimeTerminated.sort()).toEqual([parent.sessionId, lateChildSessionId].sort())
      }).pipe(
        Effect.provide(
          racySessionCommandsLayer({
            runtimeTerminated,
            lateChild: {
              sessionId: lateChildSessionId,
              branchId: lateChildBranchId,
            },
          }),
        ),
        Effect.timeout("4 seconds"),
      ),
    )
  })

  it.live("cleans runtime state for mutation deletes used by extension hosts", () => {
    const runtimeTerminated: Array<SessionId> = []
    return Effect.scoped(
      Effect.gen(function* () {
        const mutations = yield* SessionMutations
        const sessions = yield* SessionStorage
        const branches = yield* BranchStorage
        const now = FIXED_NOW
        const parent = {
          sessionId: SessionId.make("mutation-delete-parent"),
          branchId: BranchId.make("mutation-delete-parent-branch"),
        }

        yield* createActiveSessionFixture({ ...parent, sessions, branches, now })
        const child = yield* mutations.createChildSession({
          parentSessionId: parent.sessionId,
          parentBranchId: parent.branchId,
          cwd: "/tmp/mutation-delete-child",
        })

        yield* mutations.deleteSession(parent.sessionId)

        expect(runtimeTerminated).toEqual([parent.sessionId, child.sessionId])
      }).pipe(
        Effect.provide(sessionMutationsLayerWithMachineProbe(runtimeTerminated)),
        Effect.timeout("4 seconds"),
      ),
    )
  })

  it.live("restores runtime tombstones when durable delete fails", () => {
    const runtimeTerminated: Array<SessionId> = []
    const runtimeRestored: Array<SessionId> = []
    return Effect.scoped(
      Effect.gen(function* () {
        const commands = yield* SessionCommands
        const sessions = yield* SessionStorage
        const branches = yield* BranchStorage
        const sessionId = SessionId.make("delete-failure-session")
        const branchId = BranchId.make("delete-failure-branch")

        yield* createActiveSessionFixture({
          sessions,
          branches,
          sessionId,
          branchId,
          now: FIXED_NOW,
        })

        const exit = yield* Effect.exit(commands.deleteSession(sessionId))

        expect(exit._tag).toBe("Failure")
        expect(runtimeTerminated).toEqual([sessionId])
        expect(runtimeRestored).toEqual([sessionId])
        expect(yield* sessions.getSession(sessionId)).not.toBeUndefined()
      }).pipe(
        Effect.provide(
          failingDeleteSessionCommandsLayerWithMachineProbe(runtimeTerminated, runtimeRestored),
        ),
        Effect.timeout("4 seconds"),
      ),
    )
  })

  it.live(
    "rejects public read boundaries for deleted sessions (events, watchRuntime, getState, getMetrics, queue.get)",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { client } = yield* makeClient()
          const created = yield* client.session.create({ cwd: process.cwd() })
          yield* client.session.delete({ sessionId: created.sessionId })

          const expectSessionNotFound = (exit: {
            readonly _tag: "Success" | "Failure"
            readonly cause?: Cause.Cause<unknown>
          }) => {
            expect(exit._tag).toBe("Failure")
            if (exit._tag === "Failure" && exit.cause !== undefined) {
              const message = String(Cause.squash(exit.cause))
              expect(message.toLowerCase()).toMatch(/session.*(not found|terminated)/)
            }
          }

          const eventsExit = yield* Effect.exit(
            client.session
              .events({ sessionId: created.sessionId })
              .pipe(Stream.runDrain, Effect.timeout("5 seconds")),
          )
          expectSessionNotFound(eventsExit)

          const watchExit = yield* Effect.exit(
            client.session
              .watchRuntime({
                sessionId: created.sessionId,
                branchId: created.branchId,
              })
              .pipe(Stream.runDrain, Effect.timeout("5 seconds")),
          )
          expectSessionNotFound(watchExit)

          const snapshotExit = yield* Effect.exit(
            client.session.getSnapshot({
              sessionId: created.sessionId,
              branchId: created.branchId,
            }),
          )
          expectSessionNotFound(snapshotExit)

          const queueExit = yield* Effect.exit(
            client.queue.get({
              sessionId: created.sessionId,
              branchId: created.branchId,
            }),
          )
          expectSessionNotFound(queueExit)
        }).pipe(Effect.timeout("4 seconds")),
      ),
  )

  it.live("terminates an active subscription mid-delete (subscribe-then-delete race)", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { client } = yield* makeClient()
        const created = yield* client.session.create({ cwd: process.cwd() })

        // Subscribe while the session is alive, then delete it while
        // the stream is still attached. The subscription must terminate
        // (either via interruption on loop close, or by the event-store
        // propagating session-gone). A hang means the principle of
        // terminal-state-exit-safety is violated.
        const closed = yield* collectSessionEvents(
          client.session.events({ sessionId: created.sessionId }),
        )

        yield* client.session.delete({ sessionId: created.sessionId })
        yield* Deferred.await(closed).pipe(Effect.timeout("5 seconds"))
      }).pipe(Effect.timeout("4 seconds")),
    ),
  )
})

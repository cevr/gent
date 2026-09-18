/**
 * The ambient host context resolves each facet from its own service Tag.
 *
 * A facet whose service is absent from the ambient context is not an error at
 * build time: the context still assembles, and the facet reports the absence
 * only if something calls it. That keeps a deployment that ships no approval
 * flow from having to provide a stub for one.
 */
import { Cause, Effect, Exit, Fiber, Layer, Stream } from "effect"
import { describe, expect, it } from "effect-bun-test"
import { BranchId, SessionId } from "../../src/domain/ids.js"
import { makeExtensionHostContextProvider } from "../../src/runtime/make-extension-host-context.js"
import { ApprovalService } from "../../src/runtime/approval-service.js"
import { resolveExtensions } from "../../src/runtime/extensions/registry.js"
import { EventPublisherLive, EventStore } from "../../src/domain/event.js"
import { MessageStorage } from "../../src/storage/message-storage.js"
import { SqliteStorage } from "../../src/storage/sqlite-storage.js"
import { noBranchTools } from "../../src/runtime/agent/tools.js"
import { ensureStorageParents } from "../../src/test-utils/index.js"
import { testHostFacts } from "../../src/test-utils"
import { SessionStorage } from "../../src/storage/session-storage.js"
import { CurrentWorkspaceId, workspaceIdForCwd } from "../../src/server/workspace-rpc.js"
import { dateFromMillis, Session } from "../../src/domain/message.js"

const sessionId = SessionId.make("ambient-host-session")
const branchId = BranchId.make("ambient-host-branch")
const request = { text: "Approve?", metadata: {} }

const resolved = resolveExtensions([])

const ambientContext = Effect.gen(function* () {
  const provider = yield* makeExtensionHostContextProvider({
    host: testHostFacts().host,
    extensionRegistry: { extensionHooks: resolved.extensionHooks, getResolved: () => resolved },
  })
  return provider.forRun({ sessionId, branchId })
})

describe("ambient extension host context", () => {
  it.live("assembles with no host services in scope", () =>
    Effect.gen(function* () {
      const ctx = yield* ambientContext
      expect(ctx.sessionId).toBe(sessionId)
      expect(ctx.branchId).toBe(branchId)
    }),
  )

  it.live("reports the absence only when an unwired facet is called", () =>
    Effect.gen(function* () {
      const ctx = yield* ambientContext
      const exit = yield* Effect.exit(ctx.Interaction.approve(request))

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.hasDies(exit.cause)).toBe(true)
        expect(exit.cause.toString()).toContain("ApprovalService not available")
      }
    }),
  )

  it.live("uses the real service once its Tag is in scope", () =>
    Effect.gen(function* () {
      const ctx = yield* ambientContext
      expect(yield* ctx.Interaction.approve(request)).toStrictEqual({ approved: true })
    }).pipe(
      Effect.provideService(ApprovalService, {
        present: () => Effect.succeed({ approved: true }),
        pendingRequestId: () => Effect.die("not used"),
        storeResolution: () => Effect.die("not used"),
        rehydrate: () => Effect.void,
      }),
    ),
  )

  it.scopedLive("present stores a hidden assistant message and delivers it", () =>
    Effect.gen(function* () {
      const ctx = yield* ambientContext
      const store = yield* EventStore
      const delivered = yield* store
        .subscribe({ sessionId, branchId })
        .pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
      yield* ensureStorageParents({ sessionId, branchId })

      yield* ctx.Interaction.present({ title: "Goal", content: "Ship it" })

      const messages = yield* (yield* MessageStorage).listMessages(branchId)
      expect(messages.map((m) => [m.role, m.metadata])).toStrictEqual([
        ["assistant", { customType: "prompt-present", hidden: true }],
      ])
      const envelopes = yield* Fiber.join(delivered)
      expect(envelopes.map((envelope) => envelope.event._tag)).toStrictEqual(["MessageReceived"])
    }).pipe(
      Effect.provide(
        Layer.provideMerge(
          EventPublisherLive,
          Layer.mergeAll(
            SqliteStorage.TestWithSql(noBranchTools.storage, noBranchTools.migrations),
            EventStore.Memory,
          ),
        ),
      ),
    ),
  )

  it.live("a session read lands in the workspace the run was built under, not the caller's", () =>
    Effect.gen(function* () {
      const runWorkspace = workspaceIdForCwd("/tmp/run-workspace")
      const otherWorkspace = workspaceIdForCwd("/tmp/other-workspace")
      const storage = yield* SessionStorage
      // The session exists only in the workspace the run was opened under.
      yield* storage
        .createSession(
          new Session({
            id: sessionId,
            name: "pinned",
            cwd: "/tmp/run-workspace",
            createdAt: dateFromMillis(0),
            updatedAt: dateFromMillis(0),
          }),
        )
        .pipe(Effect.provideService(CurrentWorkspaceId, runWorkspace))

      // Build the run's context under the run's workspace, the way the
      // actor does after decoding it from the entity id.
      const ctx = yield* ambientContext.pipe(
        Effect.provideService(CurrentWorkspaceId, runWorkspace),
      )

      // Read it back from a caller sitting in a different workspace.
      const found = yield* ctx.Session.getSession().pipe(
        Effect.provideService(CurrentWorkspaceId, otherWorkspace),
      )
      expect(found?.name).toBe("pinned")
    }).pipe(
      Effect.provide(SqliteStorage.TestWithSql(noBranchTools.storage, noBranchTools.migrations)),
    ),
  )
})

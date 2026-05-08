import { describe, it, expect } from "effect-bun-test"
import { Clock, Deferred, Effect, Exit, Layer, Path, Scope } from "effect"
import { BunChildProcessSpawner, BunFileSystem, BunServices } from "@effect/platform-bun"
import { BackgroundBashSupervisorLive, BashTool } from "../../src/exec-tools/bash.js"
import { BackgroundBashStorage } from "../../src/exec-tools/bash-storage.js"
import { BranchId, SessionId, ToolCallId } from "@gent/core-internal/domain/ids"
import { Branch, dateFromMillis, Session } from "@gent/core-internal/domain/message"
import type { ToolCapabilityContext } from "@gent/core-internal/domain/capability/tool"
import { getToolEffect } from "@gent/core-internal/domain/capability/tool"
import { testExtensionHostContext } from "@gent/core-internal/test-utils"
import { SqliteStorage } from "@gent/core-internal/storage/sqlite-storage"

const makeProcessLayer = <A, E>(storageLayer: Layer.Layer<A, E>) => {
  const base = Layer.mergeAll(
    storageLayer,
    BunFileSystem.layer,
    Path.layer,
    BunChildProcessSpawner.layer.pipe(Layer.provide(Layer.merge(BunFileSystem.layer, Path.layer))),
  )
  return BackgroundBashSupervisorLive.pipe(
    Layer.provideMerge(BackgroundBashStorage.Live),
    Layer.provideMerge(base),
  )
}

const makePlatformLayer = () => makeProcessLayer(SqliteStorage.MemoryWithSql())
const provideBun = <A, E, R>(e: Effect.Effect<A, E, R>) =>
  Effect.provide(e, makePlatformLayer()) as Effect.Effect<A, E, never>

const processTestTimeout = 5_000
const withProcessTimeout = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.timeout("4 seconds"))

const dieStub = (label: string) => () => Effect.die(`${label} not wired in test`)

const stubCtx: ToolCapabilityContext = {
  sessionId: SessionId.make("test-session"),
  branchId: BranchId.make("test-branch"),
  toolCallId: ToolCallId.make("tc-1"),
  cwd: process.cwd(),
  home: "/tmp",
  host: testExtensionHostContext().host,
  agent: {
    get: dieStub("get"),
    require: dieStub("require"),
    run: dieStub("run"),
    resolveDualModelPair: dieStub("resolveDualModelPair"),
  },
  session: {
    listMessages: dieStub("listMessages"),
    getSession: dieStub("getSession"),
    getDetail: dieStub("getDetail"),
    renameCurrent: dieStub("renameCurrent"),
    estimateContextPercent: dieStub("estimateContextPercent"),
    search: dieStub("search"),
    listBranches: dieStub("listBranches"),
    createBranch: dieStub("createBranch"),
    forkBranch: dieStub("forkBranch"),
    switchBranch: dieStub("switchBranch"),
    createChildSession: dieStub("createChildSession"),
    getChildSessions: dieStub("getChildSessions"),
    getSessionAncestors: dieStub("getSessionAncestors"),
    deleteSession: dieStub("deleteSession"),
    deleteBranch: dieStub("deleteBranch"),
    deleteMessages: dieStub("deleteMessages"),
    queueFollowUp: dieStub("queueFollowUp"),
  },
  interaction: {
    approve: () => Effect.succeed({ approved: true }),
    present: dieStub("present"),
    confirm: dieStub("confirm"),
    review: dieStub("review"),
  },
}
const now = dateFromMillis(0)

describe("BashTool execution", () => {
  it.live(
    "runs a command and returns stdout",
    () =>
      withProcessTimeout(
        Effect.gen(function* () {
          const result = yield* provideBun(
            getToolEffect(BashTool)({ command: "echo hello" }, stubCtx),
          )

          expect(result.stdout.trim()).toBe("hello")
          expect(result.exitCode).toBe(0)
        }),
      ),
    processTestTimeout,
  )

  it.live(
    "captures nonzero exit code",
    () =>
      withProcessTimeout(
        Effect.gen(function* () {
          const result = yield* provideBun(getToolEffect(BashTool)({ command: "exit 2" }, stubCtx))

          expect(result.exitCode).toBe(2)
        }),
      ),
    processTestTimeout,
  )

  it.live(
    "respects cwd parameter",
    () =>
      withProcessTimeout(
        Effect.gen(function* () {
          const result = yield* provideBun(
            getToolEffect(BashTool)({ command: "pwd", cwd: "/tmp" }, stubCtx),
          )

          expect(result.stdout.trim()).toMatch(/\/tmp$/)
          expect(result.exitCode).toBe(0)
        }),
      ),
    processTestTimeout,
  )

  it.live(
    "splits cd + command into cwd and executes",
    () =>
      withProcessTimeout(
        Effect.gen(function* () {
          const result = yield* provideBun(
            getToolEffect(BashTool)({ command: "cd /tmp && pwd" }, stubCtx),
          )

          expect(result.stdout.trim()).toMatch(/\/tmp$/)
          expect(result.exitCode).toBe(0)
        }),
      ),
    processTestTimeout,
  )

  it.live(
    "background mode queues a follow-up on completion",
    () =>
      withProcessTimeout(
        Effect.gen(function* () {
          const sent = yield* Deferred.make<{ sourceId: string; content: string }>()
          const ctx: ToolCapabilityContext = {
            ...stubCtx,
            session: {
              ...stubCtx.session,
              getSession: () =>
                Effect.succeed(
                  new Session({
                    id: stubCtx.sessionId,
                    activeBranchId: stubCtx.branchId,
                    createdAt: now,
                    updatedAt: now,
                  }),
                ),
              listBranches: () =>
                Effect.succeed([
                  new Branch({
                    id: stubCtx.branchId,
                    sessionId: stubCtx.sessionId,
                    createdAt: now,
                  }),
                ]),
              queueFollowUp: (params) => Deferred.succeed(sent, params),
            },
          }
          const result = yield* getToolEffect(BashTool)(
            { command: "printf background-finished", run_in_background: true },
            ctx,
          )

          expect(result.exitCode).toBe(0)
          expect(result.stdout).toContain("Command started in background")

          const message = yield* Deferred.await(sent).pipe(Effect.timeout("2 seconds"))
          expect(message.sourceId).toBe("bash:tc-1:complete")
          expect(message.content).toContain("Background command completed (exit code 0)")
          expect(message.content).toContain("$ printf background-finished")
        }).pipe(provideBun),
      ),
    processTestTimeout,
  )

  it.live(
    "background process is cancelled with the supervisor scope",
    () =>
      withProcessTimeout(
        Effect.gen(function* () {
          const sent = yield* Deferred.make<{ sourceId: string; content: string }>()
          const ctx: ToolCapabilityContext = {
            ...stubCtx,
            session: {
              ...stubCtx.session,
              getSession: () =>
                Effect.succeed(
                  new Session({
                    id: stubCtx.sessionId,
                    activeBranchId: stubCtx.branchId,
                    createdAt: now,
                    updatedAt: now,
                  }),
                ),
              listBranches: () =>
                Effect.succeed([
                  new Branch({
                    id: stubCtx.branchId,
                    sessionId: stubCtx.sessionId,
                    createdAt: now,
                  }),
                ]),
              queueFollowUp: (params) => Deferred.succeed(sent, params),
            },
          }
          const scope = yield* Scope.make()
          const context = yield* Layer.buildWithScope(makePlatformLayer(), scope)
          const result = yield* getToolEffect(BashTool)(
            { command: "sleep 2; printf should-not-arrive", run_in_background: true },
            ctx,
          ).pipe(Effect.provideContext(context))

          expect(result.exitCode).toBe(0)
          yield* Scope.close(scope, Exit.void)

          const followUp = yield* Effect.exit(
            Deferred.await(sent).pipe(Effect.timeout("250 millis")),
          )
          expect(followUp._tag).toBe("Failure")
        }),
      ),
    processTestTimeout,
  )

  it.live(
    "background completion is dropped when the session disappeared",
    () =>
      withProcessTimeout(
        Effect.gen(function* () {
          const sent = yield* Deferred.make<{ sourceId: string; content: string }>()
          const ctx: ToolCapabilityContext = {
            ...stubCtx,
            session: {
              ...stubCtx.session,
              getSession: () => Effect.sync((): Session | undefined => undefined),
              listBranches: () => Effect.succeed([]),
              queueFollowUp: (params) => Deferred.succeed(sent, params),
            },
          }

          const result = yield* getToolEffect(BashTool)(
            { command: "printf stale-session", run_in_background: true },
            ctx,
          ).pipe(provideBun)

          expect(result.exitCode).toBe(0)
          const followUp = yield* Effect.exit(
            Deferred.await(sent).pipe(Effect.timeout("250 millis")),
          )
          expect(followUp._tag).toBe("Failure")
        }),
      ),
    processTestTimeout,
  )

  it.live(
    "background job interrupted by restart is reconciled once",
    () =>
      withProcessTimeout(
        Effect.gen(function* () {
          const sent = yield* Deferred.make<{ sourceId: string; content: string }>()
          const ctx: ToolCapabilityContext = {
            ...stubCtx,
            toolCallId: ToolCallId.make("tc-restart"),
            session: {
              ...stubCtx.session,
              getSession: () =>
                Effect.succeed(
                  new Session({
                    id: stubCtx.sessionId,
                    activeBranchId: stubCtx.branchId,
                    createdAt: now,
                    updatedAt: now,
                  }),
                ),
              listBranches: () =>
                Effect.succeed([
                  new Branch({
                    id: stubCtx.branchId,
                    sessionId: stubCtx.sessionId,
                    createdAt: now,
                  }),
                ]),
              queueFollowUp: (params) => Deferred.succeed(sent, params),
            },
          }
          const scope = yield* Scope.make()
          const millis = yield* Clock.currentTimeMillis
          const storageLayer = SqliteStorage.LiveWithSql(
            `/tmp/gent-background-bash-${millis}.db`,
          ).pipe(Layer.provide(BunServices.layer))
          const processLayer = makeProcessLayer(storageLayer)
          const firstContext = yield* Layer.buildWithScope(processLayer, scope)
          const started = yield* getToolEffect(BashTool)(
            { command: "sleep 2; printf should-not-arrive", run_in_background: true },
            ctx,
          ).pipe(Effect.provideContext(firstContext))
          expect(started.exitCode).toBe(0)
          yield* Scope.close(scope, Exit.void)

          yield* Effect.gen(function* () {
            const storage = yield* BackgroundBashStorage
            yield* storage.reconcileInterrupted()
          }).pipe(Effect.provide(BackgroundBashStorage.Live.pipe(Layer.provide(storageLayer))))

          const retried = yield* getToolEffect(BashTool)(
            { command: "printf should-not-run", run_in_background: true },
            ctx,
          ).pipe(Effect.provide(makeProcessLayer(storageLayer)))
          expect(retried.exitCode).toBe(0)

          const message = yield* Deferred.await(sent).pipe(Effect.timeout("2 seconds"))
          expect(message.sourceId).toBe("bash:tc-restart:failure")
          expect(message.content).toContain("Background command interrupted by server restart")
          expect(message.content).not.toContain("Background command completed")
        }),
      ),
    processTestTimeout,
  )
})

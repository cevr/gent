import { describe, it, expect } from "effect-bun-test"
import {
  Clock,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Path,
  Scope,
  Schema,
  Stream,
} from "effect"
import { textStep, toolCallStep } from "@gent/core-internal/test-utils/sequence-steps"
import { LanguageModelLayers } from "@gent/core-internal/test-utils/language-model"
import { createRpcHarness } from "@gent/core-internal/test-utils/rpc-harness"
import { shippedPreset } from "../helpers/test-preset.js"
import { BunChildProcessSpawner, BunFileSystem, BunServices } from "@effect/platform-bun"
import { BackgroundBashSupervisorLive, BashParams, BashTool } from "../../src/exec-tools/bash.js"
import {
  BackgroundBashStorage,
  BackgroundBashStorageError,
} from "../../src/exec-tools/bash-storage.js"
import { BranchId, SessionId, ToolCallId } from "@gent/core-internal/domain/ids"
import { Branch, dateFromMillis, Session } from "@gent/core-internal/domain/message"
import { runToolWithCtx } from "@gent/core-internal/test-utils"
import {
  testToolContext,
  type TestToolContext,
} from "@gent/core-internal/test-utils/extension-harness"
import { BunPlatformLive } from "@gent/core-internal/runtime/gent-platform-bun"
import { SqliteStorage } from "@gent/core-internal/storage/sqlite-storage"
import {
  boundToolResultForModel,
  maximumModelToolResultChars,
} from "@gent/core-internal/providers/ai-transcript"
import * as Prompt from "effect/unstable/ai/Prompt"

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

const makeProcessLayerWithFailingMarkFailed = <A, E>(storageLayer: Layer.Layer<A, E>) => {
  const base = Layer.mergeAll(
    storageLayer,
    BunFileSystem.layer,
    Path.layer,
    BunChildProcessSpawner.layer.pipe(Layer.provide(Layer.merge(BunFileSystem.layer, Path.layer))),
  )
  const failingStorage = Layer.effect(
    BackgroundBashStorage,
    Effect.gen(function* () {
      const storage = yield* BackgroundBashStorage
      return BackgroundBashStorage.of({
        ...storage,
        markFailed: () =>
          Effect.fail(new BackgroundBashStorageError({ message: "failure state did not commit" })),
      })
    }),
  ).pipe(Layer.provideMerge(BackgroundBashStorage.Live))
  return BackgroundBashSupervisorLive.pipe(
    Layer.provideMerge(failingStorage),
    Layer.provideMerge(base),
  )
}

const makePlatformLayer = () =>
  makeProcessLayer(
    SqliteStorage.MemoryWithSql(() => Layer.empty, {}).pipe(Layer.provide(BunPlatformLive)),
  )
const provideBun = <A, E, R>(e: Effect.Effect<A, E, R>) => Effect.provide(e, makePlatformLayer())

const processTestTimeout = 5_000
const withProcessTimeout = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.timeout("4 seconds"))

const dieStub = (label: string) => () => Effect.die(`${label} not wired in test`)

describe("background shell through a cell", () => {
  it.scopedLive.layer(BunFileSystem.layer)(
    "delivers the completion notice to the parent session",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "gent-background-notice-" })
        for (const afterTurn of [false, true]) {
          const release = `${directory}/release`
          let command = "printf CELL-BACKGROUND-COMPLETE"
          if (afterTurn) command = `while ! test -f ${release}; do sleep 0.02; done; ${command}`
          const input = yield* Schema.encodeEffect(Schema.fromJsonString(BashParams))({
            command,
            run_in_background: true,
          })
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
            toolCallStep("cell", {
              code: `await tools.call("bash", ${input})`,
            }),
            textStep("started"),
            textStep("received completion"),
          ])
          const { client, sessionId, branchId } = yield* createRpcHarness({
            ...shippedPreset,
            providerLayer,
            durableApproval: true,
          })
          const notice = yield* client.session.events({ sessionId, branchId }).pipe(
            Stream.filter(
              ({ event }) =>
                event._tag === "MessageReceived" &&
                event.message.parts.some(
                  (part) =>
                    part.type === "text" &&
                    part.text.includes("Background command completed (exit code 0)"),
                ),
            ),
            Stream.take(1),
            Stream.runCollect,
            Effect.forkScoped,
          )
          const completed = yield* client.session.events({ sessionId, branchId }).pipe(
            Stream.filter(({ event }) => event._tag === "TurnCompleted"),
            Stream.take(1),
            Stream.runDrain,
            Effect.forkScoped,
          )
          yield* client.message.send({
            sessionId,
            branchId,
            content: "Run the background shell test",
          })
          yield* Fiber.join(completed)
          yield* fs.writeFileString(release, "go")
          expect(Array.from(yield* Fiber.join(notice))).toHaveLength(1)
          yield* fs.remove(release)
        }
      }).pipe(Effect.timeout("8 seconds")),
    10_000,
  )

  it.scopedLive.layer(BunFileSystem.layer)(
    "bounds a huge completion notice and points at the stored tool result",
    () =>
      Effect.gen(function* () {
        // Far past the model-facing bound, so the notice must be cut.
        const lineCount = 4000
        const input = yield* Schema.encodeEffect(Schema.fromJsonString(BashParams))({
          command: `seq 1 ${lineCount} | sed 's/^/line /'`,
          run_in_background: true,
        })
        const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
          toolCallStep("cell", { code: `await tools.call("bash", ${input})` }),
          textStep("started"),
          textStep("received completion"),
        ])
        const { client, sessionId, branchId } = yield* createRpcHarness({
          ...shippedPreset,
          providerLayer,
          durableApproval: true,
        })
        const notice = yield* client.session.events({ sessionId, branchId }).pipe(
          Stream.filter(
            ({ event }) =>
              event._tag === "MessageReceived" &&
              event.message.parts.some(
                (part) =>
                  part.type === "text" &&
                  part.text.includes("Background command completed (exit code 0)"),
              ),
          ),
          Stream.map(({ event }) => {
            if (event._tag !== "MessageReceived") return ""
            return event.message.parts
              .map((part) => {
                if (part.type === "text") return part.text
                return ""
              })
              .join("")
          }),
          Stream.take(1),
          Stream.runCollect,
          Effect.forkScoped,
        )
        const completed = yield* client.session.events({ sessionId, branchId }).pipe(
          Stream.filter(({ event }) => event._tag === "TurnCompleted"),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkScoped,
        )
        yield* client.message.send({
          sessionId,
          branchId,
          content: "Run the big background shell test",
        })
        yield* Fiber.join(completed)
        const text = Array.from(yield* Fiber.join(notice)).join("")

        // The user-role notice carries a bounded copy, not the whole output.
        expect(text.length).toBeLessThan(maximumModelToolResultChars * 2)
        expect(text).toContain("characters truncated")
        expect(text).toContain("characters omitted")
        // Head and tail both survive, so the model can page either way.
        expect(text).toContain("line 1\n")
        expect(text).toContain(`line ${lineCount}`)
        // The locator points back at the stored tool result.
        expect(text).toContain("context.read(")
        expect(text).toContain("{ offset, limit }")
      }).pipe(Effect.timeout("20 seconds")),
    30_000,
  )
})

const stubCtx = testToolContext({
  sessionId: SessionId.make("test-session"),
  branchId: BranchId.make("test-branch"),
  toolCallId: ToolCallId.make("tc-1"),
  cwd: process.cwd(),
  home: "/tmp",
  Agent: {
    run: dieStub("run"),
    listAgents: Effect.die("listAgents not wired in test"),
  },
  Session: {
    getSession: dieStub("getSession"),
    getDetail: dieStub("getDetail"),
    renameCurrent: dieStub("renameCurrent"),
    listBranches: Effect.die("listBranches not wired in test"),
    queueFollowUp: dieStub("queueFollowUp"),
    dequeueFollowUp: dieStub("dequeueFollowUp"),
    listSessions: Effect.die("listSessions not wired in test"),
    listActiveLoops: Effect.die("listActiveLoops not wired in test"),
  },
  Interaction: {
    approve: () => Effect.succeed({ approved: true }),
    present: dieStub("present"),
  },
})
const withSession = (
  ctx: TestToolContext,
  session: TestToolContext["Session"],
): TestToolContext => ({
  ...ctx,
  Session: session,
})
const now = dateFromMillis(0)

const BoundedBashResult = Schema.Struct({
  truncated: Schema.Boolean,
  totalChars: Schema.Finite,
  omittedChars: Schema.Finite,
  read: Schema.String,
  text: Schema.String,
})

describe("BashTool execution", () => {
  it.live(
    "runs a command and returns stdout",
    () =>
      Effect.gen(function* () {
        const result = yield* provideBun(
          runToolWithCtx(BashTool, { command: "echo hello" }, stubCtx),
        )

        expect(result.stdout.trim()).toBe("hello")
        expect(result.exitCode).toBe(0)
      }).pipe(withProcessTimeout),
    processTestTimeout,
  )

  it.live(
    "keeps a huge command result whole while the model sees a bounded copy with the read locator",
    () =>
      Effect.gen(function* () {
        // One line per iteration, far past the model-facing bound.
        const lineCount = 4000
        const result = yield* provideBun(
          runToolWithCtx(BashTool, { command: `seq 1 ${lineCount} | sed 's/^/line /'` }, stubCtx),
        )

        // The tool returns the complete output: no head/tail marker, no
        // spill path, first and last line both present.
        expect(result.exitCode).toBe(0)
        expect(result.stdout.length).toBeGreaterThan(maximumModelToolResultChars)
        expect(result.stdout).toContain("line 1\n")
        expect(result.stdout).toContain(`line ${lineCount}`)
        expect(result.stdout).not.toContain("lines truncated")
        expect(result.stdout).not.toContain("Full output saved to")
        const storedLines = result.stdout.trimEnd().split("\n")
        expect(storedLines).toHaveLength(lineCount)

        // Core bounds the model-facing copy and hands over the paging locator.
        const part = Prompt.toolResultPart({
          id: stubCtx.toolCallId,
          name: "bash",
          isFailure: false,
          providerExecuted: false,
          result: { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode },
        })
        const bounded = boundToolResultForModel(part)
        const boundedResult = yield* Schema.decodeUnknownEffect(BoundedBashResult)(bounded.result)
        expect(boundedResult.truncated).toBe(true)
        expect(boundedResult.omittedChars).toBeGreaterThan(0)
        expect(boundedResult.read).toBe(`context.read("${stubCtx.toolCallId}", { offset, limit })`)
        expect(boundedResult.text.length).toBeLessThan(result.stdout.length)
        // Head and tail both survive the bound, so the model can page either way.
        expect(boundedResult.text).toContain("line 1")
        expect(boundedResult.text).toContain(`line ${lineCount}`)
      }).pipe(withProcessTimeout),
    processTestTimeout,
  )

  it.live(
    "captures nonzero exit code",
    () =>
      Effect.gen(function* () {
        const result = yield* provideBun(runToolWithCtx(BashTool, { command: "exit 2" }, stubCtx))

        expect(result.exitCode).toBe(2)
      }).pipe(withProcessTimeout),
    processTestTimeout,
  )

  it.live(
    "respects cwd parameter",
    () =>
      Effect.gen(function* () {
        const result = yield* provideBun(
          runToolWithCtx(BashTool, { command: "pwd", cwd: "/tmp" }, stubCtx),
        )

        expect(result.stdout.trim()).toMatch(/\/tmp$/)
        expect(result.exitCode).toBe(0)
      }).pipe(withProcessTimeout),
    processTestTimeout,
  )

  it.live(
    "splits cd + command into cwd and executes",
    () =>
      Effect.gen(function* () {
        const result = yield* provideBun(
          runToolWithCtx(BashTool, { command: "cd /tmp && pwd" }, stubCtx),
        )

        expect(result.stdout.trim()).toMatch(/\/tmp$/)
        expect(result.exitCode).toBe(0)
      }).pipe(withProcessTimeout),
    processTestTimeout,
  )

  it.live(
    "background mode queues a follow-up on completion",
    () =>
      Effect.gen(function* () {
        const sent = yield* Deferred.make<{ sourceId: string; content: string }>()
        const ctx = withSession(stubCtx, {
          ...stubCtx.Session,
          getSession: () =>
            Effect.succeed(
              new Session({
                id: stubCtx.sessionId,
                activeBranchId: stubCtx.branchId,
                createdAt: now,
                updatedAt: now,
              }),
            ),
          listBranches: Effect.succeed([
            new Branch({
              id: stubCtx.branchId,
              sessionId: stubCtx.sessionId,
              createdAt: now,
            }),
          ]),
          queueFollowUp: (params) => Deferred.succeed(sent, params),
        })
        const result = yield* runToolWithCtx(
          BashTool,
          { command: "printf background-finished", run_in_background: true },
          ctx,
        )

        expect(result.exitCode).toBe(0)
        expect(result.stdout).toContain("Command started in background")

        const message = yield* Deferred.await(sent).pipe(Effect.timeout("2 seconds"))
        expect(message.sourceId).toBe("bash:tc-1:complete")
        expect(message.content).toContain("Background command completed (exit code 0)")
        expect(message.content).toContain("$ printf background-finished")
      }).pipe(provideBun, withProcessTimeout),
    processTestTimeout,
  )

  it.live(
    "background bash without a host-owned tool call fails closed",
    () =>
      Effect.gen(function* () {
        const { toolCallId: _dropped, ...withoutToolCall } = stubCtx
        const outcome = yield* Effect.exit(
          runToolWithCtx(
            BashTool,
            { command: "printf never-runs", run_in_background: true },
            withoutToolCall,
          ).pipe(provideBun),
        )

        expect(Exit.isFailure(outcome)).toBe(true)
      }).pipe(withProcessTimeout),
    processTestTimeout,
  )

  it.live(
    "background process is cancelled with the supervisor scope",
    () =>
      Effect.gen(function* () {
        const sent = yield* Deferred.make<{ sourceId: string; content: string }>()
        const ctx = withSession(stubCtx, {
          ...stubCtx.Session,
          getSession: () =>
            Effect.succeed(
              new Session({
                id: stubCtx.sessionId,
                activeBranchId: stubCtx.branchId,
                createdAt: now,
                updatedAt: now,
              }),
            ),
          listBranches: Effect.succeed([
            new Branch({
              id: stubCtx.branchId,
              sessionId: stubCtx.sessionId,
              createdAt: now,
            }),
          ]),
          queueFollowUp: (params) => Deferred.succeed(sent, params),
        })
        const scope = yield* Scope.make()
        const context = yield* Layer.buildWithScope(makePlatformLayer(), scope)
        const result = yield* runToolWithCtx(
          BashTool,
          { command: "sleep 2; printf should-not-arrive", run_in_background: true },
          ctx,
        ).pipe(Effect.provideContext(context))

        expect(result.exitCode).toBe(0)
        yield* Scope.close(scope, Exit.void)

        const followUp = yield* Effect.exit(Deferred.await(sent).pipe(Effect.timeout("250 millis")))
        expect(followUp._tag).toBe("Failure")
      }).pipe(withProcessTimeout),
    processTestTimeout,
  )

  it.live(
    "background completion is dropped when the session disappeared",
    () =>
      Effect.gen(function* () {
        const sent = yield* Deferred.make<{ sourceId: string; content: string }>()
        const ctx = withSession(stubCtx, {
          ...stubCtx.Session,
          getSession: () => Effect.sync(() => Option.getOrUndefined(Option.none<Session>())),
          listBranches: Effect.succeed([]),
          queueFollowUp: (params) => Deferred.succeed(sent, params),
        })

        const result = yield* runToolWithCtx(
          BashTool,
          { command: "printf stale-session", run_in_background: true },
          ctx,
        ).pipe(provideBun)

        expect(result.exitCode).toBe(0)
        const followUp = yield* Effect.exit(Deferred.await(sent).pipe(Effect.timeout("250 millis")))
        expect(followUp._tag).toBe("Failure")
      }).pipe(withProcessTimeout),
    processTestTimeout,
  )

  it.live(
    "terminal background job retries replay durable completion instead of spawning work",
    () =>
      Effect.gen(function* () {
        const sent = yield* Deferred.make<{ sourceId: string; content: string }>()
        const toolCallId = ToolCallId.make("tc-terminal-retry")
        const ctx = withSession(
          { ...stubCtx, toolCallId },
          {
            ...stubCtx.Session,
            getSession: () =>
              Effect.succeed(
                new Session({
                  id: stubCtx.sessionId,
                  activeBranchId: stubCtx.branchId,
                  createdAt: now,
                  updatedAt: now,
                }),
              ),
            listBranches: Effect.succeed([
              new Branch({
                id: stubCtx.branchId,
                sessionId: stubCtx.sessionId,
                createdAt: now,
              }),
            ]),
            queueFollowUp: (params) => Deferred.succeed(sent, params),
          },
        )
        const millis = yield* Clock.currentTimeMillis
        const storageLayer = SqliteStorage.LiveWithSql(
          `/tmp/gent-background-bash-terminal-${millis}.db`,
          () => Layer.empty,
          {},
        ).pipe(Layer.provide(Layer.merge(BunServices.layer, BunPlatformLive)))

        yield* Effect.gen(function* () {
          const storage = yield* BackgroundBashStorage
          const claim = yield* storage.claimStart({
            sessionId: ctx.sessionId,
            branchId: ctx.branchId,
            toolCallId,
            command: "printf stored-terminal",
            cwd: Option.some(ctx.cwd),
          })
          expect(claim._tag).toBe("Started")
          yield* storage.markCompleted(
            { sessionId: ctx.sessionId, branchId: ctx.branchId, toolCallId },
            { exitCode: 0, message: "stored output" },
          )
        }).pipe(
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
          Effect.provide(
            Layer.mergeAll(
              storageLayer,
              BackgroundBashStorage.Live.pipe(Layer.provide(storageLayer)),
            ),
          ),
        )

        const retried = yield* runToolWithCtx(
          BashTool,
          { command: "printf should-not-run", run_in_background: true },
          ctx,
        )
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
          .pipe(Effect.provide(makeProcessLayer(storageLayer)))
        expect(retried.exitCode).toBe(0)

        const message = yield* Deferred.await(sent).pipe(Effect.timeout("2 seconds"))
        expect(message.sourceId).toBe("bash:tc-terminal-retry:complete")
        expect(message.content).toContain("Background command completed (exit code 0)")
        expect(message.content).toContain("$ printf stored-terminal")
        expect(message.content).toContain("stored output")
        expect(message.content).not.toContain("should-not-run")
      }).pipe(withProcessTimeout),
    processTestTimeout,
  )

  it.live(
    "failed background job does not notify before failure state is durable",
    () =>
      Effect.gen(function* () {
        const sent = yield* Deferred.make<{ sourceId: string; content: string }>()
        const toolCallId = ToolCallId.make("tc-failed-terminal-durability")
        const ctx = withSession(
          { ...stubCtx, toolCallId },
          {
            ...stubCtx.Session,
            getSession: () =>
              Effect.succeed(
                new Session({
                  id: stubCtx.sessionId,
                  activeBranchId: stubCtx.branchId,
                  createdAt: now,
                  updatedAt: now,
                }),
              ),
            listBranches: Effect.succeed([
              new Branch({
                id: stubCtx.branchId,
                sessionId: stubCtx.sessionId,
                createdAt: now,
              }),
            ]),
            queueFollowUp: (params) => Deferred.succeed(sent, params),
          },
        )
        const millis = yield* Clock.currentTimeMillis
        const storageLayer = SqliteStorage.LiveWithSql(
          `/tmp/gent-background-bash-failure-${millis}.db`,
          () => Layer.empty,
          {},
        ).pipe(Layer.provide(Layer.merge(BunServices.layer, BunPlatformLive)))

        const result = yield* runToolWithCtx(
          BashTool,
          {
            command: "printf should-not-run",
            cwd: "/tmp/gent-missing-cwd",
            run_in_background: true,
          },
          ctx,
        )
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
          .pipe(Effect.provide(makeProcessLayerWithFailingMarkFailed(storageLayer)))
        expect(result.exitCode).toBe(0)

        const followUp = yield* Effect.exit(Deferred.await(sent).pipe(Effect.timeout("250 millis")))
        expect(followUp._tag).toBe("Failure")
      }).pipe(withProcessTimeout),
    processTestTimeout,
  )

  it.live(
    "background job interrupted by restart is reconciled once",
    () =>
      Effect.gen(function* () {
        const sent = yield* Deferred.make<{ sourceId: string; content: string }>()
        const ctx = withSession(
          { ...stubCtx, toolCallId: ToolCallId.make("tc-restart") },
          {
            ...stubCtx.Session,
            getSession: () =>
              Effect.succeed(
                new Session({
                  id: stubCtx.sessionId,
                  activeBranchId: stubCtx.branchId,
                  createdAt: now,
                  updatedAt: now,
                }),
              ),
            listBranches: Effect.succeed([
              new Branch({
                id: stubCtx.branchId,
                sessionId: stubCtx.sessionId,
                createdAt: now,
              }),
            ]),
            queueFollowUp: (params) => Deferred.succeed(sent, params),
          },
        )
        const scope = yield* Scope.make()
        const millis = yield* Clock.currentTimeMillis
        const storageLayer = SqliteStorage.LiveWithSql(
          `/tmp/gent-background-bash-${millis}.db`,
          () => Layer.empty,
          {},
        ).pipe(Layer.provide(Layer.merge(BunServices.layer, BunPlatformLive)))
        const processLayer = makeProcessLayer(storageLayer)
        const firstContext = yield* Layer.buildWithScope(processLayer, scope)
        const started = yield* runToolWithCtx(
          BashTool,
          { command: "sleep 2; printf should-not-arrive", run_in_background: true },
          ctx,
        ).pipe(Effect.provideContext(firstContext))
        expect(started.exitCode).toBe(0)
        yield* Scope.close(scope, Exit.void)

        yield* Effect.gen(function* () {
          const storage = yield* BackgroundBashStorage
          yield* storage.reconcileInterrupted
        })
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
          .pipe(Effect.provide(BackgroundBashStorage.Live.pipe(Layer.provide(storageLayer))))

        const retried = yield* runToolWithCtx(
          BashTool,
          { command: "printf should-not-run", run_in_background: true },
          ctx,
        )
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
          .pipe(Effect.provide(makeProcessLayer(storageLayer)))
        expect(retried.exitCode).toBe(0)

        const message = yield* Deferred.await(sent).pipe(Effect.timeout("2 seconds"))
        expect(message.sourceId).toBe("bash:tc-restart:failure")
        expect(message.content).toContain("Background command interrupted by server restart")
        expect(message.content).not.toContain("Background command completed")
      }).pipe(withProcessTimeout),
    processTestTimeout,
  )
})

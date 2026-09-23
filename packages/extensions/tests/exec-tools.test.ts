import { describe, expect, it, test } from "effect-bun-test"
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
  Ref,
  Schema,
  Scope,
  Stream,
} from "effect"
import {
  BackgroundBashLayer,
  BackgroundBashStorage,
  BackgroundBashStorageError,
  BackgroundBashSupervisorLive,
  BashParams,
  BashTool,
  classifyBashCommand,
  injectGitTrailers,
  splitCdCommand,
  stripBackground,
} from "../src/exec-tools.js"
import {
  BranchId,
  SessionId,
  ToolCallId,
  Branch,
  dateFromMillis,
  Session,
} from "@gent/core/protocol"
import {
  LanguageModelLayers,
  textStep,
  toolCallStep,
  waitFor,
  createRpcHarness,
  runToolWithCtx,
  testToolContext,
  type TestToolContext,
} from "@gent/core/test-utils"
import { shippedPreset } from "./helpers/test-preset.js"
import { BunChildProcessSpawner, BunFileSystem, BunServices } from "@effect/platform-bun"
import { BunPlatformLive, SqliteStorage } from "@gent/core/host"
import { maximumModelToolResultChars } from "@gent/core/extensions/api"
import { e2ePreset } from "./helpers/test-preset"
import { isToolResultFor } from "./helpers/tool-event.js"

// ── exec-tools/bash.test ────────────────────────────────────────────────────

describe("splitCdCommand", () => {
  test("cd /foo && ls → { cwd: '/foo', command: 'ls' }", () => {
    const result = splitCdCommand("cd /foo && ls")
    expect(result).toEqual(Option.some({ cwd: "/foo", command: "ls" }))
  })

  test("cd with quoted path && cmd → quoted path", () => {
    const result = splitCdCommand('cd "/path with spaces" && ls -la')
    expect(result).toEqual(Option.some({ cwd: "/path with spaces", command: "ls -la" }))
  })

  test("cd /foo; ls → semicolon separator", () => {
    const result = splitCdCommand("cd /foo; ls")
    expect(result).toEqual(Option.some({ cwd: "/foo", command: "ls" }))
  })

  test("plain command → None", () => {
    expect(Option.isNone(splitCdCommand("ls -la"))).toBe(true)
  })
})

describe("injectGitTrailers", () => {
  test('git commit -m "msg" → injects --trailer', () => {
    const result = injectGitTrailers('git commit -m "fix bug"', SessionId.make("sess-123"))
    expect(result).toContain('--trailer "Session-Id: sess-123"')
    expect(result).toContain("git commit")
  })

  test("git push → unchanged", () => {
    const cmd = "git push origin main"
    expect(injectGitTrailers(cmd, SessionId.make("sess-123"))).toBe(cmd)
  })

  test("already has --trailer → unchanged", () => {
    const cmd = 'git commit --trailer "Foo: bar" -m "msg"'
    expect(injectGitTrailers(cmd, SessionId.make("sess-123"))).toBe(cmd)
  })
})

describe("stripBackground", () => {
  test('"cmd &" → "cmd"', () => {
    expect(stripBackground("cmd &")).toBe("cmd")
  })

  test('"cmd  &  " → "cmd"', () => {
    expect(stripBackground("cmd  &  ")).toBe("cmd")
  })

  test('"cmd" → "cmd"', () => {
    expect(stripBackground("cmd")).toBe("cmd")
  })
})

describe("classifyBashCommand", () => {
  test("a read-only command that names a secret file stays safe", () => {
    expect(classifyBashCommand("cat ~/.aws/credentials").level).toBe("safe")
    expect(classifyBashCommand("grep -n KEY .env").level).toBe("safe")
  })

  test("a write to a secret file is sensitive", () => {
    expect(classifyBashCommand("cp ~/.aws/credentials /tmp/x").level).toBe("sensitive")
  })

  test("a read-only prefix does not exempt a later segment that writes a secret", () => {
    for (const command of [
      "cat README.md; cp ~/.aws/credentials /tmp/x",
      "ls && cp ~/.aws/credentials /tmp/x",
      "ls || mv .env /tmp/x",
      "ls | xargs -I{} cp {} ~/.ssh/id_rsa",
      "cat README.md\ncp ~/.aws/credentials /tmp/x",
      "cat $(cp ~/.aws/credentials /tmp/x)",
      "cat `cp ~/.aws/credentials /tmp/x`",
      "cat <<EOF | sh\ncp ~/.aws/credentials /tmp/x\nEOF",
    ]) {
      expect(classifyBashCommand(command).level, command).toBe("sensitive")
    }
  })

  test("a compound command of read-only segments stays safe", () => {
    expect(classifyBashCommand("cat .env | grep KEY && ls -la secrets").level).toBe("safe")
  })

  test("destructive and external patterns win over the read-only exemption", () => {
    expect(classifyBashCommand("cat x; rm -rf /").level).toBe("destructive")
    expect(classifyBashCommand("ls && git push").level).toBe("external")
  })
})

// ── exec-tools/bash-execution.test ──────────────────────────────────────────

const makeProcessLayer = <A, E>(storageLayer: Layer.Layer<A, E>) => {
  const base = Layer.mergeAll(
    storageLayer,
    BunFileSystem.layer,
    Path.layer,
    BunChildProcessSpawner.layer.pipe(Layer.provide(Layer.merge(BunFileSystem.layer, Path.layer))),
  )
  return BackgroundBashLayer.pipe(Layer.provideMerge(base))
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
              code: `await tools.bash(${input})`,
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
          toolCallStep("cell", { code: `await tools.bash(${input})` }),
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
  Session: {
    getSession: dieStub("getSession"),
    getDetail: dieStub("getDetail"),
    renameCurrent: dieStub("renameCurrent"),
    listBranches: Effect.die("listBranches not wired in test"),
    dequeueFollowUp: dieStub("dequeueFollowUp"),
    create: dieStub("create"),
    delete: dieStub("delete"),
    send: dieStub("send"),
    stop: dieStub("stop"),
    events: () => Stream.die("events not wired in test"),
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
/** A fake `Session.send` that records the background notice, a `queue` delivery. */
const onQueue =
  (record: (notice: { sourceId: string; content: string }) => Effect.Effect<unknown>) =>
  (params: Parameters<TestToolContext["Session"]["send"]>[0]) => {
    if (params.delivery !== "queue") return Effect.die(`unexpected ${params.delivery} delivery`)
    return record({ sourceId: params.sourceId, content: params.content }).pipe(Effect.asVoid)
  }
const now = dateFromMillis(0)

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
    "keeps a huge command result whole",
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
          send: onQueue((notice) => Deferred.succeed(sent, notice)),
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
          send: onQueue((notice) => Deferred.succeed(sent, notice)),
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
          send: onQueue((notice) => Deferred.succeed(sent, notice)),
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
            send: onQueue((notice) => Deferred.succeed(sent, notice)),
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
            send: onQueue((notice) => Deferred.succeed(sent, notice)),
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
            send: onQueue((notice) => Deferred.succeed(sent, notice)),
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

        // The second process layer marks the job interrupted as it builds.
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

  it.live(
    "starting a finished background job again notifies the parent only once",
    () =>
      Effect.gen(function* () {
        // The durable row survives the job, so a repeated start would find a
        // Terminal claim and replay its notice. The supervisor remembers which
        // keys it already notified about and stays silent for the second call.
        const notices = yield* Ref.make<Array<{ sourceId: string; content: string }>>([])
        const ctx = withSession(
          { ...stubCtx, toolCallId: ToolCallId.make("tc-replay") },
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
              new Branch({ id: stubCtx.branchId, sessionId: stubCtx.sessionId, createdAt: now }),
            ]),
            send: onQueue((notice) => Ref.update(notices, (all) => [...all, notice])),
          },
        )

        yield* Effect.gen(function* () {
          const first = yield* runToolWithCtx(
            BashTool,
            { command: "printf replayed-output", run_in_background: true },
            ctx,
          )
          expect(first.exitCode).toBe(0)
          yield* waitFor(Ref.get(notices), (all) => all.length === 1, 2_000, "first notice")

          const second = yield* runToolWithCtx(
            BashTool,
            { command: "printf replayed-output", run_in_background: true },
            ctx,
          )
          expect(second.exitCode).toBe(0)
          // The replay path is synchronous: a Terminal claim queues its notice
          // before `start` returns, so a second entry would already be here.
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        }).pipe(Effect.provide(makePlatformLayer()))

        const all = yield* Ref.get(notices)
        expect(all.map((notice) => notice.sourceId)).toEqual(["bash:tc-replay:complete"])
        expect(all[0]?.content).toContain("Background command completed (exit code 0)")
        expect(all[0]?.content).toContain("replayed-output")
      }).pipe(withProcessTimeout),
    processTestTimeout,
  )
})

// ── exec-tools/exec-tools-rpc.test ──────────────────────────────────────────

/**
 * Exec-tools RPC acceptance test — exercises the `bash` tool through a real
 * agent turn (LLM emits the tool call, runtime dispatches it inside the
 * per-request scope, BunChildProcessSpawner from BunServices spawns a real
 * process). The existing `bash.test.ts` calls the executor directly via
 * `runToolWithCtx`, which bypasses the scope boundary production uses.
 *
 * Uses `echo` (SAFE risk class) so no Interaction.approve gate fires.
 *
 * Maps W37 S6 C14 (audit L5-P1-2).
 */

describe("ExecToolsExtension (bash) via model turn", () => {
  it.live(
    "bash tool call routes through per-request scope and returns stdout",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
            toolCallStep("bash", { command: "echo rpc-harness-bash-marker" }),
            textStep("ran"),
          ])
          const { client, sessionId, branchId } = yield* createRpcHarness({
            ...e2ePreset,
            providerLayer,
          })

          const toolEventFiber = yield* client.session
            .events({ sessionId, branchId })
            .pipe(
              Stream.filter(isToolResultFor("bash")),
              Stream.take(1),
              Stream.runCollect,
              Effect.forkScoped,
            )

          yield* client.message.send({
            sessionId,
            branchId,
            content: "run an echo",
          })

          const events = Array.from(yield* Fiber.join(toolEventFiber))
          const succeeded = events.find((event) => event.event._tag === "ToolCallSucceeded")
          expect(succeeded).toBeDefined()
          if (succeeded?.event._tag === "ToolCallSucceeded") {
            expect(succeeded.event.output).toContain("rpc-harness-bash-marker")
          }
        }).pipe(Effect.timeout("12 seconds")),
      ),
    15_000,
  )
})

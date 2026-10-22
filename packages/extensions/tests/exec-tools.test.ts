import { describe, expect, it, test } from "effect-bun-test"
import {
  ConfigProvider,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Logger,
  Option,
  Path,
  Predicate,
  Ref,
  Result,
  References,
  Schema,
  Scope,
  Sink,
  Stream,
} from "effect"
import {
  BackgroundBashLayer,
  BackgroundBashStorage,
  BackgroundBashStorageError,
  BackgroundBashSupervisorLive,
  BashParams,
  BashTool,
  commandLaunch,
  type CommandProcess,
  readCommandReceipt,
  runBashCommand,
  stopLostCommand,
  stopStaleProcess,
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
  finishPart,
  interruptAtEachStep,
  LanguageModelLayers,
  textDeltaPart,
  textStep,
  toolCallPart,
  multiToolCallStep,
  toolCallStep,
  waitFor,
  createE2ELayer,
  createRpcClient,
  createRpcHarness,
  makeTempDirectoryScoped,
  runToolWithCtx,
  testToolContext,
  type TestToolContext,
  turnRequestText,
  SqliteStorage,
  ApprovalService,
} from "@gent/core/test-utils"
import { e2ePreset, shippedPreset } from "./helpers/test-preset.js"
import { toolResultSummary } from "@gent/core/extensions/branch-tools"
import { BunChildProcessSpawner, BunCrypto, BunFileSystem, BunServices } from "@effect/platform-bun"
import { GentPlatform } from "@gent/core/host"
import { BunSqlite, BunPlatformLive } from "@gent/core/host-bun"
import {
  defineExtension,
  defineResource,
  ExtensionContext,
  type ExtensionContextService,
  ExtensionHost,
  ExtensionId,
  request,
  ExtensionServiceError,
  maximumModelToolResultChars,
  runProcess,
} from "@gent/core/extensions/api"
import { SqlClient } from "effect/sql"
import { TestClock } from "effect/testing"
import type * as Prompt from "effect/ai/Prompt"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import * as AiError from "effect/ai/AiError"

/** SQLite storage in the file at `path`, so a later layer reads what an earlier one wrote. */
const fileStorage = (path: string) =>
  SqliteStorage.WithSql(BunSqlite.file(path)).pipe(
    Layer.provide(Layer.merge(BunServices.layer, BunPlatformLive)),
  )

/** The storage and the platform services a background supervisor needs. */
const processBase = <A, E>(storageLayer: Layer.Layer<A, E>) =>
  Layer.mergeAll(
    storageLayer,
    BunCrypto.layer,
    BunFileSystem.layer,
    Path.layer,
    BunChildProcessSpawner.layer.pipe(Layer.provide(Layer.merge(BunFileSystem.layer, Path.layer))),
  )

const makeProcessLayer = <A, E>(storageLayer: Layer.Layer<A, E>) =>
  BackgroundBashLayer.pipe(Layer.provideMerge(processBase(storageLayer)))

/** A supervisor whose `markFailed` fails; `attempted` completes when a job calls it. */
const makeProcessLayerWithFailingMarkFailed = <A, E>(
  storageLayer: Layer.Layer<A, E>,
  attempted: Deferred.Deferred<void>,
) => {
  const failingStorage = Layer.effect(
    BackgroundBashStorage,
    Effect.gen(function* () {
      const storage = yield* BackgroundBashStorage
      return BackgroundBashStorage.of({
        ...storage,
        markFailed: () =>
          Effect.fail(
            new BackgroundBashStorageError({ message: "failure state did not commit" }),
          ).pipe(Effect.ensuring(Deferred.succeed(attempted, void 0))),
      })
    }),
  ).pipe(Layer.provideMerge(BackgroundBashStorage.Live))
  return BackgroundBashSupervisorLive.pipe(
    Layer.provideMerge(failingStorage),
    Layer.provideMerge(processBase(storageLayer)),
  )
}

/** Live heap bytes after a full collection; Bun counts array buffers in it. */
const liveBytes = Effect.sync(() => {
  Bun.gc(true)
  return process.memoryUsage().heapUsed
})

const makePlatformLayer = () =>
  makeProcessLayer(SqliteStorage.WithSql(BunSqlite.memory).pipe(Layer.provide(BunPlatformLive)))
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
            approvalLayer: ApprovalService.Live,
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
          // The notice names its kind, so a reader tells it from what the user wrote.
          const delivered = Array.from(yield* Fiber.join(notice)).flatMap(({ event }) => {
            if (event._tag !== "MessageReceived") return []
            return [event.message.metadata?.customType]
          })
          expect(delivered).toEqual(["background-bash"])
          yield* fs.remove(release)
        }
        // A deadlock bound only: each wait above is an event. Two harnesses
        // and their shells outgrow a tight bound on a loaded machine.
      }).pipe(Effect.timeout("25 seconds")),
    30_000,
  )

  it.scopedLive.layer(BunFileSystem.layer)(
    "a huge completion notice is bounded and names a file that holds the whole output",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "gent-bg-output-" })
        const text = yield* hugeBackgroundNotice(home)

        // The whole user-role notice, the file line included, fits the bound.
        expect(text.length).toBeLessThanOrEqual(maximumModelToolResultChars)
        // The frame, the head, one cut marker, the tail, then the file line.
        const wholeChars = Array.from(
          { length: hugeLineCount },
          (_, index) => `line ${index + 1}\n`.length,
        ).reduce((sum, chars) => sum + chars, 0)
        expect(text).toMatch(
          new RegExp(
            [
              "^Background command completed \\(exit code 0\\):\\n```\\n\\$ seq 1 4000 \\| sed 's/\\^/line /'\\n",
              "line 1\\n[^]*\\n\\n\\.\\.\\. \\[\\d+ characters truncated\\] \\.\\.\\.\\n\\n[^]*line 4000\\n",
              `\\n\\n\\[The whole output is in \\S+ \\(${wholeChars} characters\\); page it with the read tool's offset and limit\\.\\]\\n\`\`\`$`,
            ].join(""),
          ),
        )
        // Head and tail both survive; the middle is cut.
        expect(text).toContain("line 1\n")
        expect(text).toContain(`line ${hugeLineCount}`)
        expect(text).not.toContain(`line ${hugeLineCount / 2}\n`)
        // One omitted count: the cut marker's.
        expect(text.match(/\d+ (of \d+ )?characters (truncated|omitted)/g)).toHaveLength(1)
        // The notice names a file under the data directory that a read
        // reaches, and the file holds the whole output, the cut middle too.
        const file = savedOutputFile(text)
        expect(file.startsWith(`${home}/.gent/background-bash/`)).toBe(true)
        const saved = yield* fs.readFileString(file)
        expect(saved).toContain(`line ${hugeLineCount / 2}\n`)
        expect(saved.trimEnd().split("\n")).toHaveLength(hugeLineCount)
      }).pipe(Effect.timeout("20 seconds")),
    30_000,
  )

  // The read tool resolves a relative path against the session cwd, not the
  // server's, so the notice names the file by its absolute path.
  it.scopedLive.layer(BunServices.layer)(
    "a relative data directory still gives the notice an absolute file path",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "gent-bg-output-" })
        const dataDir = yield* fs.makeTempDirectoryScoped({ prefix: "gent-bg-data-" })
        const text = yield* hugeBackgroundNotice(home, [
          Layer.succeed(
            ConfigProvider.ConfigProvider,
            ConfigProvider.fromEnv({
              env: { GENT_DATA_DIR: path.relative(process.cwd(), dataDir) },
            }),
          ),
        ])
        const file = savedOutputFile(text)
        expect(path.isAbsolute(file)).toBe(true)
        expect(file.startsWith(`${dataDir}/background-bash/`)).toBe(true)
        const saved = yield* fs.readFileString(file)
        expect(saved.trimEnd().split("\n")).toHaveLength(hugeLineCount)
      }).pipe(Effect.timeout("20 seconds")),
    30_000,
  )

  it.scopedLive.layer(BunServices.layer)(
    "a job whose file cannot be written still reports its ends",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "gent-bg-output-" })
        // The output directory is a file: no job file can go under it. The
        // receipt still can, so the job runs.
        const dataDir = path.join(home, "data")
        yield* fs.makeDirectory(dataDir)
        yield* fs.writeFileString(path.join(dataDir, "background-bash"), "")
        const text = yield* hugeBackgroundNotice(home, [
          Layer.succeed(
            ConfigProvider.ConfigProvider,
            ConfigProvider.fromEnv({ env: { GENT_DATA_DIR: dataDir } }),
          ),
        ])
        expect(text.length).toBeLessThanOrEqual(maximumModelToolResultChars)
        expect(text).toContain("line 1\n")
        expect(text).toContain(`line ${hugeLineCount}`)
        expect(text).toContain("[The whole output could not be saved.]")
      }).pipe(Effect.timeout("20 seconds")),
    30_000,
  )
})

/** Far past the model-facing bound, so the notice must be cut. */
const hugeLineCount = 4000

/** The file a cut notice names; empty when it names none. */
const savedOutputFile = (text: string) => /The whole output is in (\S+) /.exec(text)?.[1] ?? ""
const startedOutputFile = (text: string) =>
  /Its output streams to (\S+); read/.exec(text)?.[1] ?? ""

/** The completion notice of a background job, run under `home`, whose output is far past the bound. */
const hugeBackgroundNotice = Effect.fn("test.hugeBackgroundNotice")(function* (
  home: string,
  extraLayers: ReadonlyArray<Layer.Layer<never>> = [],
) {
  const input = yield* Schema.encodeEffect(Schema.fromJsonString(BashParams))({
    command: `seq 1 ${hugeLineCount} | sed 's/^/line /'`,
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
    approvalLayer: ApprovalService.Live,
    home,
    extraLayers,
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
  return Array.from(yield* Fiber.join(notice)).join("")
})

const stubCtx = testToolContext({
  sessionId: SessionId.make("test-session"),
  branchId: BranchId.make("test-branch"),
  toolCallId: ToolCallId.make("tc-1"),
  cwd: "/nonexistent/gent-exec-tools-cwd",
  home: "/nonexistent/gent-test-home",
  Session: {
    getSession: dieStub("getSession"),
    getDetail: dieStub("getDetail"),
    getAgent: dieStub("getAgent"),
    getModel: dieStub("getModel"),
    renameCurrent: dieStub("renameCurrent"),
    forkBranch: dieStub("forkBranch"),
    listBranches: Effect.die("listBranches not wired in test"),
    dequeueFollowUp: dieStub("dequeueFollowUp"),
    holdResident: Effect.die("holdResident not wired in test"),
    create: dieStub("create"),
    delete: dieStub("delete"),
    send: dieStub("send"),
    stop: dieStub("stop"),
    stopMessage: dieStub("stopMessage"),
    events: () => Stream.die("events not wired in test"),
    listSessions: dieStub("listSessions"),
    listActiveLoops: Effect.die("listActiveLoops not wired in test"),
    branchMetrics: () => Effect.die("branchMetrics not wired in test"),
  },
  Interaction: {
    approve: dieStub("approve"),
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
  (
    record: (notice: {
      sourceId: string
      content: string
    }) => Effect.Effect<unknown, ExtensionServiceError>,
  ) =>
  (params: Parameters<TestToolContext["Session"]["send"]>[0]) => {
    if (params.delivery !== "queue") return Effect.die(`unexpected ${params.delivery} delivery`)
    return record({ sourceId: params.sourceId, content: params.content }).pipe(Effect.asVoid)
  }
const now = dateFromMillis(0)
/**
 * The stub context with a live session and branch whose `send` records each
 * background notice through `record`. `fields` names the tool call and home.
 */
const liveSession = (
  record: Parameters<typeof onQueue>[0],
  fields: { readonly toolCallId?: string; readonly home?: string } = {},
): TestToolContext =>
  withSession(
    {
      ...stubCtx,
      toolCallId: ToolCallId.make(fields.toolCallId ?? "tc-1"),
      home: fields.home ?? stubCtx.home,
    },
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
      send: onQueue(record),
    },
  )
type Notice = { sourceId: string; content: string }
/** `ctx` in a fresh working directory that the test's scope removes. */
/**
 * The context in a temp cwd. A context on the stub's home gets a temp home
 * too: a background job writes its receipt under the data directory before
 * it runs.
 */
const inTempCwd = (ctx: TestToolContext) =>
  Effect.gen(function* () {
    const cwd = yield* makeTempDirectoryScoped("gent-exec-cwd-")
    let home = ctx.home
    if (home === stubCtx.home) home = yield* makeTempDirectoryScoped("gent-exec-home-")
    return { ...ctx, cwd, home }
  })

describe("Bash command semantics", () => {
  const cases = [
    { name: "escaped final ampersand", command: "printf %s foo\\&", output: "foo&", exitCode: 0 },
    { name: "quoted ampersand", command: "printf %s 'foo&'", output: "foo&", exitCode: 0 },
    { name: "plain command", command: "printf plain", output: "plain", exitCode: 0 },
    {
      name: "successful conjunction cd",
      command: "cd sub && pwd",
      output: "<cwd>/sub\n",
      exitCode: 0,
    },
    { name: "successful semicolon cd", command: "cd sub; pwd", output: "<cwd>/sub\n", exitCode: 0 },
    {
      name: "quoted directory",
      command: 'cd "path with spaces" && pwd',
      output: "<cwd>/path with spaces\n",
      exitCode: 0,
    },
    { name: "literal directory", command: "cd '$x' && pwd", output: "<cwd>/$x\n", exitCode: 0 },
    {
      name: "failed semicolon cd",
      command: "cd missing-directory; printf ok",
      output: "ok",
      stderr: "missing-directory",
      exitCode: 0,
    },
    {
      name: "failed conjunction cd",
      command: "cd missing-directory && printf forbidden",
      output: "",
      stderr: "missing-directory",
      exitCode: 1,
    },
    {
      name: "previous directory",
      command: "cd sub && cd - >/dev/null; pwd",
      output: "<cwd>\n",
      exitCode: 0,
    },
    { name: "directory options", command: "cd -P link && pwd", output: "<cwd>/sub\n", exitCode: 0 },
    { name: "shell background operator", command: "false &", output: "", exitCode: 0 },
    // A status other than 0 and 1 comes back as given, not folded into a failure.
    { name: "exact exit status", command: "exit 2", output: "", exitCode: 2 },
    {
      name: "shell directory expansion",
      command:
        'HOME="$PWD"; DIR=sub; cd ~/sub && pwd; cd "$HOME/sub" && pwd; cd "$HOME"; cd $DIR; pwd; cd `printf %s "$HOME/sub"` && pwd; cd "$HOME"; cd su? && pwd',
      output: "<cwd>/sub\n<cwd>/sub\n<cwd>/sub\n<cwd>/sub\n<cwd>/sub\n",
      exitCode: 0,
    },
  ]
  for (const runInBackground of [false, true]) {
    let mode = "foreground"
    let reply = "shell finished"
    if (runInBackground) {
      mode = "background"
      reply = "completion received"
    }
    for (const entry of cases) {
      it.scopedLive.layer(BunFileSystem.layer)(
        `${mode} preserves ${entry.name}`,
        () =>
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem
            const directory = yield* fs.realPath(
              yield* makeTempDirectoryScoped("gent-shell-semantics-"),
            )
            for (const name of ["sub", "path with spaces", "$x"])
              yield* fs.makeDirectory(`${directory}/${name}`)
            yield* fs.symlink(`${directory}/sub`, `${directory}/link`)
            const toolCallId = ToolCallId.make("shell-semantics")
            const steps = [
              toolCallStep(
                "bash",
                { command: entry.command, run_in_background: runInBackground },
                { toolCallId },
              ),
              textStep("shell finished"),
            ]
            if (runInBackground) steps.push(textStep("completion received"))
            const { layer: providerLayer } = yield* LanguageModelLayers.sequence(steps)
            const { client, sessionId, branchId } = yield* createRpcHarness({
              ...e2ePreset,
              providerLayer,
              cwd: directory,
              home: directory,
            })
            yield* client.message.send({
              sessionId,
              branchId,
              content: "Run the shell program unchanged",
            })
            const settled = yield* waitFor(
              client.session.getSnapshot({ sessionId, branchId }),
              (snapshot) =>
                snapshot.runtime._tag === "Idle" &&
                snapshot.messages.some((message) =>
                  message.parts.some((part) => part.type === "text" && part.text === reply),
                ),
              10_000,
              "the shell completion",
            )
            const result = settled.messages
              .flatMap((message) => message.parts)
              .find((part) => part.type === "tool-result" && part.id === toolCallId)
            expect(result?.type).toBe("tool-result")
            if (result?.type !== "tool-result") return
            expect(result.isFailure).toBe(false)
            const output = yield* Schema.decodeUnknownEffect(
              Schema.Struct({
                stdout: Schema.String,
                stderr: Schema.String,
                exitCode: Schema.Finite,
              }),
            )(result.result)
            const expected = entry.output.replaceAll("<cwd>", directory)
            if (runInBackground) {
              const notices = settled.messages
                .filter((message) => message.metadata?.customType === "background-bash")
                .flatMap((message) =>
                  message.parts.filter((part) => part.type === "text").map((part) => part.text),
                )
              expect(notices).toHaveLength(1)
              expect(notices[0]).toContain(
                `Background command completed (exit code ${entry.exitCode})`,
              )
              const saved = yield* fs.readFileString(startedOutputFile(output.stdout))
              if (Predicate.isString(entry.stderr)) {
                expect(saved).toContain(entry.stderr)
                // The two pipes can arrive in either order.
                expect(saved.replace(/bash: line \d+: cd: missing-directory: [^\n]*\n/, "")).toBe(
                  expected,
                )
              } else expect(saved).toBe(expected)
              expect(output.stdout).toContain(entry.command)
            } else {
              expect(output.stdout).toBe(expected)
              expect(output.exitCode).toBe(entry.exitCode)
              if (Predicate.isString(entry.stderr)) expect(output.stderr).toContain(entry.stderr)
              else expect(output.stderr).toBe("")
            }
          }).pipe(Effect.timeout("20 seconds")),
        25_000,
      )
    }
  }
})

describe("BashTool summary", () => {
  test("names the exit code and the printed line count", () => {
    const summary = (stdout: string, stderr: string, exitCode: number) =>
      toolResultSummary(
        Option.some(BashTool),
        { command: "make" },
        { isFailure: false, result: { stdout, stderr, exitCode } },
      )
    expect(summary("a\nb\n", "warn\n", 0)).toBe("exit 0 · 3 lines")
    expect(summary("", "", 2)).toBe("exit 2 · 0 lines")
    expect(summary("one", "", 0)).toBe("exit 0 · 1 line")
  })

  for (const status of ["queued", "running", "completed", "failed", "interrupted"]) {
    test(`a background phase names ${status} instead of an exit code`, () => {
      expect(
        toolResultSummary(
          Option.some(BashTool),
          { command: "make" },
          {
            isFailure: false,
            result: { stdout: "Command started", stderr: "", exitCode: 0, status },
          },
        ),
      ).toBe(`${status} in background`)
    })
  }

  test("a background command says so instead of an exit code", () => {
    expect(
      toolResultSummary(
        Option.some(BashTool),
        { command: "make" },
        {
          isFailure: false,
          result: { stdout: "Command started", stderr: "", exitCode: 0, status: "background" },
        },
      ),
    ).toBe("started in background")
  })
})

describe("BashTool execution", () => {
  // `trap '' TERM` leaves SIGTERM ignored for the whole group, so only the
  // SIGKILL three seconds later ends it. The call must not wait for that.
  it.scopedLive.layer(BunPlatformLive)(
    "a command that ignores SIGTERM returns at its timeout, not after the kill",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const platform = yield* GentPlatform
        const directory = yield* makeTempDirectoryScoped("gent-bash-term-")
        const pidFile = `${directory}/job.pid`
        const exit = yield* Effect.exit(
          provideBun(
            runToolWithCtx(
              BashTool,
              { command: `trap '' TERM; echo $$ > ${pidFile}; sleep 30`, timeout: 500 },
              { ...stubCtx, cwd: directory },
            ),
          ),
        )
        expect(Exit.isFailure(exit)).toBe(true)
        const pid = Number(yield* fs.readFileString(pidFile))
        expect(Number.isSafeInteger(pid) && pid > 0).toBe(true)
        // A red run must not leave the group behind.
        yield* Effect.addFinalizer(() => Effect.ignore(platform.signal(-pid, "SIGKILL")))
        // The group still runs: the call returned before the SIGKILL that ends it.
        expect(Exit.isSuccess(yield* Effect.exit(platform.signal(-pid, 0)))).toBe(true)
      }).pipe(withProcessTimeout),
    processTestTimeout,
  )

  it.scopedLive(
    "a multibyte character split across output chunks decodes whole",
    () =>
      Effect.gen(function* () {
        const ctx = yield* inTempCwd(stubCtx)
        const result = yield* provideBun(
          runToolWithCtx(BashTool, { command: "printf '\\xc3'; sleep 0.2; printf '\\xa9'" }, ctx),
        )

        expect(result.stdout).toBe("é")
      }).pipe(withProcessTimeout),
    processTestTimeout,
  )

  // The stub context's `approve` dies, so an ask would fail the test. The
  // command runs and fails at once: its directory does not exist.
  it.scopedLive(
    "a command runs as given, with no ask",
    () =>
      Effect.gen(function* () {
        const ctx = yield* inTempCwd(stubCtx)
        const result = yield* provideBun(
          runToolWithCtx(
            BashTool,
            { command: "git -C /nonexistent/gent-probe-x push --force" },
            ctx,
          ),
        )
        expect(result.status).toBeUndefined()
        expect(result.exitCode).not.toBe(0)
        expect(result.stderr).toContain("/nonexistent/gent-probe-x")
      }).pipe(withProcessTimeout),
    processTestTimeout,
  )

  it.scopedLive(
    "keeps a result past the model bound but within the kept ends whole, with no file",
    () =>
      Effect.gen(function* () {
        const ctx = yield* inTempCwd(stubCtx)
        // One line per iteration, far past the model-facing bound.
        const lineCount = 4000
        const result = yield* provideBun(
          runToolWithCtx(BashTool, { command: `seq 1 ${lineCount} | sed 's/^/line /'` }, ctx),
        )

        // The tool returns the complete output: no head/tail marker, no
        // file, first and last line both present.
        expect(result.exitCode).toBe(0)
        expect(result.stdout.length).toBeGreaterThan(maximumModelToolResultChars)
        expect(result.stdout).toContain("line 1\n")
        expect(result.stdout).toContain(`line ${lineCount}`)
        expect(result.stdout).not.toContain("characters truncated")
        expect(result.outputFile).toBeUndefined()
        const storedLines = result.stdout.trimEnd().split("\n")
        expect(storedLines).toHaveLength(lineCount)
      }).pipe(withProcessTimeout),
    processTestTimeout,
  )

  it.live(
    "runs in the session directory, not the server directory, or in the cwd given",
    () =>
      Effect.gen(function* () {
        const result = yield* provideBun(
          Effect.scoped(
            Effect.gen(function* () {
              const fs = yield* FileSystem.FileSystem
              const sessionDir = yield* fs.realPath(
                yield* fs.makeTempDirectoryScoped({ prefix: "gent-bash-session-" }),
              )
              yield* fs.makeDirectory(`${sessionDir}/sub`)
              const ctx = { ...stubCtx, cwd: sessionDir }
              const plain = yield* runToolWithCtx(BashTool, { command: "pwd" }, ctx)
              const relative = yield* runToolWithCtx(BashTool, { command: "pwd", cwd: "sub" }, ctx)
              const split = yield* runToolWithCtx(BashTool, { command: "cd sub && pwd" }, ctx)
              // the temp root may resolve through a symlink (/private/tmp on macOS)
              const absoluteDir = yield* fs.realPath(
                yield* fs.makeTempDirectoryScoped({ prefix: "gent-test-cwd-" }),
              )
              const absolute = yield* runToolWithCtx(
                BashTool,
                { command: "pwd", cwd: absoluteDir },
                ctx,
              )
              return { sessionDir, plain, relative, split, absoluteDir, absolute }
            }),
          ),
        )

        expect(result.sessionDir).not.toBe(process.cwd())
        expect(result.plain.stdout.trim()).toBe(result.sessionDir)
        expect(result.relative.stdout.trim()).toBe(`${result.sessionDir}/sub`)
        expect(result.split.stdout.trim()).toBe(`${result.sessionDir}/sub`)
        expect(result.absolute.stdout.trim()).toBe(result.absoluteDir)
        expect(result.absolute.exitCode).toBe(0)
      }).pipe(withProcessTimeout),
    processTestTimeout,
  )

  it.scopedLive(
    "background mode queues a follow-up on completion",
    () =>
      Effect.gen(function* () {
        const sent = yield* Deferred.make<Notice>()
        const ctx = yield* inTempCwd(liveSession((notice) => Deferred.succeed(sent, notice)))
        const result = yield* runToolWithCtx(
          BashTool,
          { command: "printf background-finished", run_in_background: true },
          ctx,
        )

        expect(result.exitCode).toBe(0)
        expect(result.stdout).toContain("Command running in background")

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
        // A typed failure, not a defect: without the guard the output path dies on the missing id.
        const error = yield* Effect.flip(
          runToolWithCtx(
            BashTool,
            { command: "printf never-runs", run_in_background: true },
            withoutToolCall,
          ).pipe(provideBun),
        )

        expect(error._tag).toBe("BackgroundBashError")
        expect(error).toMatchObject({
          message: "Background bash requires a host-owned tool call",
        })
      }).pipe(withProcessTimeout),
    processTestTimeout,
  )

  it.scopedLive.layer(BunPlatformLive)(
    "closing the supervisor scope stops the job's process group, and no notice is sent",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const platform = yield* GentPlatform
        const directory = yield* makeTempDirectoryScoped("gent-bg-scope-close-")
        const pidFile = `${directory}/job.pid`
        const sent = yield* Deferred.make<Notice>()
        const ctx = {
          ...liveSession((notice) => Deferred.succeed(sent, notice), { home: directory }),
          cwd: directory,
        }
        const scope = yield* Scope.make()
        yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
        const context = yield* Layer.buildWithScope(makePlatformLayer(), scope)
        const result = yield* runToolWithCtx(
          BashTool,
          {
            command: `echo $$ > ${pidFile}; sleep 30; touch ${directory}/late`,
            run_in_background: true,
          },
          ctx,
        ).pipe(Effect.provideContext(context))
        expect(result.exitCode).toBe(0)
        const pid = Number(
          yield* waitFor(
            fs.readFileString(pidFile).pipe(Effect.orElseSucceed(() => "")),
            (text) => text.trim() !== "",
            2_000,
            "the job's pid",
          ),
        )
        expect(Number.isSafeInteger(pid) && pid > 0).toBe(true)
        // A red run must not leave the job's group behind.
        yield* Effect.addFinalizer(() => Effect.ignore(platform.signal(-pid, "SIGKILL")))

        yield* Scope.close(scope, Exit.void)

        // Every process of the job's group is gone before its sleep ends.
        yield* waitFor(
          platform.signal(-pid, 0).pipe(Effect.exit),
          Exit.isFailure,
          5_000,
          "the job's process group stopped",
        )
        expect(yield* fs.exists(`${directory}/late`)).toBe(false)
        expect(yield* Deferred.isDone(sent)).toBe(false)
      }).pipe(Effect.timeout("8 seconds")),
    10_000,
  )

  it.scopedLive(
    "background completion is dropped when the session disappeared",
    () =>
      Effect.gen(function* () {
        const sent = yield* Deferred.make<Notice>()
        // ExtensionSessionService.getSession answers undefined for an absent session.
        // oxlint-disable-next-line effect/noNullish -- the facade's absent-session answer.
        const absentSession: Session | undefined = undefined
        const ctx = yield* inTempCwd(
          withSession(stubCtx, {
            ...stubCtx.Session,
            getSession: () => Effect.succeed(absentSession),
            listBranches: Effect.succeed([]),
            send: onQueue((notice) => Deferred.succeed(sent, notice)),
          }),
        )

        yield* Effect.gen(function* () {
          const result = yield* runToolWithCtx(
            BashTool,
            { command: "printf stale-session", run_in_background: true },
            ctx,
          )
          expect(result.exitCode).toBe(0)
          // The delivery step clears the pending mark only after it decided
          // the job's message: here, that the absent session is owed none.
          yield* waitFor(
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient
              return yield* sql<{ readonly settled: number }>`
                SELECT COUNT(*) AS settled FROM background_bash_jobs
                WHERE tool_call_id = 'tc-1' AND status = 'completed' AND undelivered_at IS NULL
              `
            }),
            (rows) => rows.some((row) => row.settled > 0),
            2_000,
            "the job's delivery settled",
          )
        }).pipe(provideBun)

        expect(yield* Deferred.isDone(sent)).toBe(false)
      }).pipe(withProcessTimeout),
    processTestTimeout,
  )

  it.scopedLive(
    "terminal background job retries replay durable completion instead of spawning work",
    () =>
      Effect.gen(function* () {
        const sent = yield* Deferred.make<Notice>()
        const toolCallId = ToolCallId.make("tc-terminal-retry")
        const ctx = liveSession((notice) => Deferred.succeed(sent, notice), { toolCallId })
        const directory = yield* makeTempDirectoryScoped("gent-background-bash-")
        const storageLayer = fileStorage(`${directory}/storage.db`)

        yield* Effect.gen(function* () {
          const storage = yield* BackgroundBashStorage
          const claim = yield* storage.claimStart({
            sessionId: ctx.sessionId,
            branchId: ctx.branchId,
            toolCallId,
            command: "printf stored-terminal",
            cwd: Option.some(ctx.cwd),
            outputFile: `${directory}/tc-terminal-retry.txt`,
          })
          expect(claim._tag).toBe("Started")
          yield* storage.markCompleted(
            { sessionId: ctx.sessionId, branchId: ctx.branchId, toolCallId },
            { exitCode: 0, message: "stored output" },
          )
        }).pipe(
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
        ).pipe(Effect.provide(makeProcessLayer(storageLayer)))
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

  // A row can hold a whole long output while its job file is gone. A replay
  // cuts that message to its head and tail and writes no file for it.
  it.scopedLive(
    "a replayed row that holds a whole long output is cut, with no file written",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "gent-bg-old-row-" })
        const sent = yield* Deferred.make<Notice>()
        const toolCallId = ToolCallId.make("tc-old-row-replay")
        const ctx = liveSession((notice) => Deferred.succeed(sent, notice), { toolCallId, home })
        const storageLayer = fileStorage(`${home}/gent.db`)
        const output = Array.from({ length: 3000 }, (_, index) => `old line ${index + 1}\n`).join(
          "",
        )
        yield* Effect.gen(function* () {
          const storage = yield* BackgroundBashStorage
          yield* storage.claimStart({
            sessionId: ctx.sessionId,
            branchId: ctx.branchId,
            toolCallId,
            command: "seq-old",
            cwd: Option.some(ctx.cwd),
            outputFile: `${home}/gone.txt`,
          })
          yield* storage.markCompleted(
            { sessionId: ctx.sessionId, branchId: ctx.branchId, toolCallId },
            { exitCode: 0, message: output },
          )
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              storageLayer,
              BackgroundBashStorage.Live.pipe(Layer.provide(storageLayer)),
            ),
          ),
        )

        yield* runToolWithCtx(
          BashTool,
          { command: "printf should-not-run", run_in_background: true },
          ctx,
        ).pipe(Effect.provide(makeProcessLayer(storageLayer)))
        const message = yield* Deferred.await(sent).pipe(Effect.timeout("2 seconds"))
        expect(message.content.length).toBeLessThanOrEqual(maximumModelToolResultChars)
        expect(message.content).toContain("old line 1\n")
        expect(message.content).toContain("old line 3000\n")
        expect(message.content).toContain("characters truncated")
        expect(message.content).not.toContain("The whole output is in")
        expect(yield* fs.exists(`${home}/gone.txt`)).toBe(false)
      }).pipe(Effect.provide(BunFileSystem.layer), withProcessTimeout),
    processTestTimeout,
  )

  // A row can keep a follow-up's worth of output while the job's file holds
  // all of it. A replay names that file, unchanged.
  it.scopedLive(
    "a replayed row longer than its bound names the job's file when it exists",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "gent-bg-row-file-" })
        const sent = yield* Deferred.make<Notice>()
        const toolCallId = ToolCallId.make("tc/row-file-replay")
        const ctx = liveSession((notice) => Deferred.succeed(sent, notice), { toolCallId, home })
        const storageLayer = fileStorage(`${home}/gent.db`)
        const output = Array.from({ length: 3000 }, (_, index) => `row line ${index + 1}\n`).join(
          "",
        )
        const folder = `${home}/.gent/background-bash/${ctx.sessionId}/${ctx.branchId}`
        const file = `${folder}/tc_row-file-replay.txt`
        yield* fs.makeDirectory(folder, { recursive: true })
        yield* fs.writeFileString(file, output)
        yield* Effect.gen(function* () {
          const storage = yield* BackgroundBashStorage
          yield* storage.claimStart({
            sessionId: ctx.sessionId,
            branchId: ctx.branchId,
            toolCallId,
            command: "seq-row",
            cwd: Option.some(ctx.cwd),
            outputFile: file,
          })
          yield* storage.markCompleted(
            { sessionId: ctx.sessionId, branchId: ctx.branchId, toolCallId },
            { exitCode: 0, message: output },
          )
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              storageLayer,
              BackgroundBashStorage.Live.pipe(Layer.provide(storageLayer)),
            ),
          ),
        )

        yield* runToolWithCtx(
          BashTool,
          { command: "printf should-not-run", run_in_background: true },
          ctx,
        ).pipe(Effect.provide(makeProcessLayer(storageLayer)))
        const message = yield* Deferred.await(sent).pipe(Effect.timeout("2 seconds"))
        expect(message.content.length).toBeLessThanOrEqual(maximumModelToolResultChars)
        expect(message.content).toContain("row line 1\n")
        expect(message.content).toContain(
          `The whole output is in ${file} (${output.length} characters)`,
        )
        expect(yield* fs.readFileString(file)).toBe(output)
      }).pipe(Effect.provide(BunFileSystem.layer), withProcessTimeout),
    processTestTimeout,
  )

  it.scopedLive(
    "failed background job does not notify before failure state is durable",
    () =>
      Effect.gen(function* () {
        const sent = yield* Deferred.make<Notice>()
        const attempted = yield* Deferred.make<void>()
        const ctx = liveSession((notice) => Deferred.succeed(sent, notice), {
          toolCallId: "tc-failed-terminal-durability",
        })
        const directory = yield* makeTempDirectoryScoped("gent-background-bash-")
        const storageLayer = fileStorage(`${directory}/storage.db`)
        const scope = yield* Scope.make()
        yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
        const profile = yield* Layer.buildWithScope(
          makeProcessLayerWithFailingMarkFailed(storageLayer, attempted),
          scope,
        )

        const result = yield* runToolWithCtx(
          BashTool,
          {
            command: "printf should-not-run",
            cwd: "/nonexistent/gent-missing-cwd",
            run_in_background: true,
          },
          ctx,
        ).pipe(Effect.provideContext(profile))
        expect(result.exitCode).toBe(0)

        // The job failed and its failure state did not commit. The scope
        // close waits for the job's fiber, so any message it sends is in.
        yield* Deferred.await(attempted)
        yield* Scope.close(scope, Exit.void)
        expect(yield* Deferred.isDone(sent)).toBe(false)
      }).pipe(withProcessTimeout),
    processTestTimeout,
  )

  it.scopedLive(
    "a repeated start of a job a restart interrupted sends no message and leaves the job unread",
    () =>
      Effect.gen(function* () {
        const sent = yield* Deferred.make<Notice>()
        const ctx = yield* inTempCwd(
          liveSession((notice) => Deferred.succeed(sent, notice), { toolCallId: "tc-restart" }),
        )
        const scope = yield* Scope.make()
        const directory = yield* makeTempDirectoryScoped("gent-background-bash-")
        const storageLayer = fileStorage(`${directory}/storage.db`)
        const processLayer = makeProcessLayer(storageLayer)
        const firstContext = yield* Layer.buildWithScope(processLayer, scope)
        const started = yield* runToolWithCtx(
          BashTool,
          { command: "sleep 2; printf should-not-arrive", run_in_background: true },
          ctx,
        ).pipe(Effect.provideContext(firstContext))
        expect(started.exitCode).toBe(0)
        // The row names the job's process before the server stops.
        yield* waitFor(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient
            return yield* sql<{
              readonly recorded: number
            }>`SELECT COUNT(*) AS recorded FROM background_bash_jobs WHERE tool_call_id = 'tc-restart' AND pid IS NOT NULL`
          }).pipe(Effect.provide(storageLayer)),
          (rows) => rows.some((row) => row.recorded > 0),
          5_000,
          "the job's recorded process",
        )
        yield* Scope.close(scope, Exit.void)
        // The server restarts: the job belongs to the process that is gone.
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          yield* sql`UPDATE background_bash_jobs SET owner_generation = 'earlier-process'`
        }).pipe(Effect.provide(storageLayer))

        // The restarted server's process layer marks the job interrupted as it builds.
        const retried = yield* runToolWithCtx(
          BashTool,
          { command: "printf should-not-run", run_in_background: true },
          ctx,
        ).pipe(Effect.provide(makeProcessLayer(storageLayer)))
        expect(retried.exitCode).toBe(0)
        expect(startedOutputFile(retried.stdout)).toBe(startedOutputFile(started.stdout))

        // The replay path is synchronous: a Terminal claim would queue its
        // message before `start` returns.
        expect(yield* Deferred.isDone(sent)).toBe(false)
        // The job waits, unread, for the branch's next turn to show it.
        const unread = yield* Effect.gen(function* () {
          const storage = yield* BackgroundBashStorage
          return yield* storage.interruptedJobs({
            sessionId: stubCtx.sessionId,
            branchId: stubCtx.branchId,
          })
        }).pipe(Effect.provide(BackgroundBashStorage.Live.pipe(Layer.provide(storageLayer))))
        expect(unread).toEqual([
          {
            toolCallId: ToolCallId.make("tc-restart"),
            command: "sleep 2; printf should-not-arrive",
            outputFile: startedOutputFile(started.stdout),
            mayStillRun: false,
          },
        ])
      }).pipe(withProcessTimeout),
    processTestTimeout,
  )

  it.scopedLive(
    "another profile building in the same server leaves a running job running",
    () =>
      Effect.gen(function* () {
        const ctx = { ...stubCtx, toolCallId: ToolCallId.make("tc-two-profiles") }
        const directory = yield* makeTempDirectoryScoped("gent-background-bash-")
        const storageLayer = fileStorage(`${directory}/storage.db`)
        const firstProfile = yield* Layer.build(makeProcessLayer(storageLayer))
        const started = yield* runToolWithCtx(
          BashTool,
          { command: "sleep 2", run_in_background: true },
          ctx,
        ).pipe(Effect.provideContext(firstProfile))
        expect(started.exitCode).toBe(0)

        const secondProfile = yield* Layer.build(makeProcessLayer(storageLayer))
        const claim = yield* Effect.gen(function* () {
          const storage = yield* BackgroundBashStorage
          return yield* storage.claimStart({
            sessionId: ctx.sessionId,
            branchId: ctx.branchId,
            toolCallId: ctx.toolCallId,
            command: "sleep 2",
            cwd: Option.none(),
            outputFile: `${directory}/second-claim.txt`,
          })
        }).pipe(Effect.provideContext(secondProfile))
        expect(claim._tag).toBe("AlreadyRunning")
      }).pipe(Effect.scoped, withProcessTimeout),
    processTestTimeout,
  )

  it.live("an unread interrupted job and a running job of a gone server are each shown once", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const branch = { sessionId: SessionId.make("s"), branchId: BranchId.make("b") }
      const unread = yield* Effect.gen(function* () {
        const storage = yield* BackgroundBashStorage
        // `running` belongs to a server that is gone and recorded no process.
        yield* sql`
            INSERT INTO background_bash_jobs (session_id, branch_id, tool_call_id, command, status, started_at, completed_at, output_file)
            VALUES ('s', 'b', 'earlier', 'sleep 8', 'interrupted', 0, 5, '/out/earlier.txt'),
                   ('s', 'b', 'running', 'sleep 9', 'running', 1, NULL, '/out/running.txt')
          `
        yield* storage.reconcileInterrupted([])
        const before = yield* storage.interruptedJobs(branch)
        yield* storage.markNoticesRead(branch, [
          ToolCallId.make("earlier"),
          ToolCallId.make("running"),
        ])
        return { before, after: yield* storage.interruptedJobs(branch) }
      }).pipe(Effect.provide(BackgroundBashStorage.Live))
      // `running` recorded no process, so nothing tells whether it still runs.
      expect(unread.before).toEqual([
        {
          toolCallId: ToolCallId.make("earlier"),
          command: "sleep 8",
          outputFile: "/out/earlier.txt",
          mayStillRun: false,
        },
        {
          toolCallId: ToolCallId.make("running"),
          command: "sleep 9",
          outputFile: "/out/running.txt",
          mayStillRun: true,
        },
      ])
      expect(unread.after).toEqual([])
    }).pipe(
      Effect.provide(SqliteStorage.WithSql(BunSqlite.memory).pipe(Layer.provide(BunPlatformLive))),
    ),
  )

  it.scopedLive(
    "starting a finished background job again notifies the parent only once",
    () =>
      Effect.gen(function* () {
        // The durable row survives the job, so a repeated start would find a
        // Terminal claim and replay its notice. The supervisor remembers which
        // keys it already notified about and stays silent for the second call.
        const notices = yield* Ref.make<Array<Notice>>([])
        const ctx = yield* inTempCwd(
          liveSession((notice) => Ref.update(notices, (all) => [...all, notice]), {
            toolCallId: "tc-replay",
          }),
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
        }).pipe(Effect.provide(makePlatformLayer()))

        const all = yield* Ref.get(notices)
        expect(all.map((notice) => notice.sourceId)).toEqual(["bash:tc-replay:complete"])
        expect(all[0]?.content).toContain("Background command completed (exit code 0)")
        expect(all[0]?.content).toContain("replayed-output")
      }).pipe(withProcessTimeout),
    processTestTimeout,
  )

  it.scopedLive(
    "a refused completion a later replay delivers is not also kept as a notice",
    () =>
      Effect.gen(function* () {
        const toolCallId = ToolCallId.make("tc-refused-replay")
        const branch = { sessionId: stubCtx.sessionId, branchId: stubCtx.branchId }
        const delivered = yield* Ref.make<ReadonlyArray<string>>([])
        const refusing = yield* Ref.make(true)
        const refused = yield* Deferred.make<void>()
        const ctx = yield* inTempCwd(
          liveSession(
            (notice) =>
              Effect.gen(function* () {
                if (yield* Ref.get(refusing)) {
                  return yield* Effect.fail(
                    new ExtensionServiceError({
                      service: "Session",
                      operation: "send",
                      message: "Follow-up queue full (max 10)",
                    }),
                  ).pipe(Effect.ensuring(Deferred.succeed(refused, void 0)))
                }
                yield* Ref.update(delivered, (all) => [...all, notice.sourceId])
              }),
            { toolCallId },
          ),
        )
        const directory = yield* makeTempDirectoryScoped("gent-background-bash-")
        const storageLayer = fileStorage(`${directory}/storage.db`)
        const undelivered = BackgroundBashStorage.pipe(
          Effect.flatMap((storage) => storage.undeliveredJobs(branch)),
        )
        const params = { command: "printf refused-output", run_in_background: true }

        // The first server's send is refused: the row keeps the completion.
        const scope = yield* Scope.make()
        const firstProfile = yield* Layer.buildWithScope(makeProcessLayer(storageLayer), scope)
        yield* Effect.gen(function* () {
          yield* runToolWithCtx(BashTool, params, ctx)
          yield* Deferred.await(refused)
          yield* waitFor(undelivered, (jobs) => jobs.length === 1, 2_000, "the refused completion")
        }).pipe(Effect.provideContext(firstProfile))
        yield* Scope.close(scope, Exit.void)

        // A later server replays the Terminal claim, and its send is accepted.
        yield* Ref.set(refusing, false)
        const after = yield* Effect.gen(function* () {
          yield* runToolWithCtx(BashTool, params, ctx)
          return yield* undelivered
        }).pipe(Effect.provide(makeProcessLayer(storageLayer)))

        expect(yield* Ref.get(delivered)).toEqual(["bash:tc-refused-replay:complete"])
        expect(after).toEqual([])
      }).pipe(withProcessTimeout),
    processTestTimeout,
  )
})

// ── exec tools rpc ──────────────────────────────────────────────────────────

describe("background job output", () => {
  for (const recover of [false, true]) {
    let behavior = "a retry"
    if (recover) behavior = "an interruption notice"
    it.scopedLive.layer(BunServices.layer)(
      `${behavior} never assigns an older colliding file to a job whose output has not opened`,
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const directory = yield* makeTempDirectoryScoped("gent-output-ownership-")
          const storagePath = `${directory}/gent.db`
          const noticed = yield* Deferred.make<string>()
          const providerLayer = LanguageModelLayers.testStream((options) =>
            Deferred.succeed(noticed, turnRequestText(options.prompt).notices).pipe(
              Effect.as(
                Stream.fromIterable([
                  textDeltaPart("Reported."),
                  finishPart({ finishReason: "stop" }),
                ]),
              ),
            ),
          )
          const { client, sessionId, branchId } = yield* createRpcHarness({
            ...e2ePreset,
            providerLayer,
            storagePath,
            home: directory,
            cwd: directory,
          })
          const ctx = testToolContext({
            sessionId,
            branchId,
            toolCallId: ToolCallId.make("call/a"),
            home: directory,
            cwd: directory,
          })
          const folder = `${directory}/.gent/background-bash/${sessionId}/${branchId}`
          const legacy = `${folder}/call_a.txt`
          // An older call `call?a` emitted this file, before the new call was claimed.
          yield* fs.makeDirectory(folder, { recursive: true })
          yield* fs.writeFileString(legacy, "older-call-output")
          const opening = yield* Deferred.make<string>()
          const release = yield* Deferred.make<void>()
          const heldFs: FileSystem.FileSystem = {
            ...fs,
            open: (file, options) => {
              if (file.startsWith(`${folder}/calls/`))
                return Deferred.succeed(opening, file).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.andThen(fs.open(file, options)),
                )
              return fs.open(file, options)
            },
          }
          const storageLayer = fileStorage(storagePath)
          const scope = yield* Scope.make()
          yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
          const profile = Context.add(
            yield* Layer.buildWithScope(makeProcessLayer(storageLayer), scope),
            FileSystem.FileSystem,
            heldFs,
          )
          const start = () =>
            runToolWithCtx(
              BashTool,
              { command: "printf new-call-output", run_in_background: true },
              ctx,
            ).pipe(Effect.provideContext(profile))
          const first = yield* start()
          const canonical = yield* Deferred.await(opening)
          expect(startedOutputFile(first.stdout)).toBe(canonical)
          expect(yield* fs.exists(canonical)).toBe(false)
          if (recover) {
            yield* Scope.close(scope, Exit.void)
            // Both the process memo and a fresh terminal-row replay retain ownership.
            expect(startedOutputFile((yield* start()).stdout)).toBe(canonical)
            const replay = yield* runToolWithCtx(
              BashTool,
              { command: "printf should-not-run", run_in_background: true },
              ctx,
            ).pipe(Effect.provide(makeProcessLayer(storageLayer)))
            expect(startedOutputFile(replay.stdout)).toBe(canonical)
            yield* client.message.send({ sessionId, branchId, content: "Report the interruption" })
            const notice = yield* Deferred.await(noticed)
            expect(notice).toContain("# Interrupted background commands")
            expect(notice).toContain("call call/a · no output was saved")
            expect(notice).not.toContain(legacy)
          } else {
            const retry = yield* start()
            expect(startedOutputFile(retry.stdout)).toBe(canonical)
          }
          expect(yield* fs.readFileString(legacy)).toBe("older-call-output")
        }).pipe(Effect.timeout("15 seconds")),
      20_000,
    )
  }

  for (const runInBackground of [false, true]) {
    let mode = "foreground"
    if (runInBackground) mode = "background"
    for (const entry of [
      { name: "slash and underscore", ids: ["call/a", "call_a"] },
      { name: "unicode and underscore", ids: ["call-🚀", "call-__"] },
      { name: "long identities", ids: ["x".repeat(300), `${"x".repeat(299)}y`] },
      {
        name: "a literal hash and its encoded identity",
        ids: ["call/a", "a883c4294550dd476c83701ebac2824f923f1e7cf1cad0bbc009e66b6dbf4d18"],
      },
    ]) {
      it.scopedLive.layer(BunServices.layer)(
        `${mode} keeps independent output files for ${entry.name}`,
        () =>
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem
            const directory = yield* makeTempDirectoryScoped("gent-output-identity-")
            const calls = yield* Ref.make(0)
            const providerLayer = LanguageModelLayers.testStream(() =>
              Ref.updateAndGet(calls, (n) => n + 1).pipe(
                Effect.map((call) => {
                  if (call <= entry.ids.length) {
                    let mark = "a"
                    if (call === 2) mark = "b"
                    return Stream.fromIterable([
                      toolCallPart(
                        "bash",
                        {
                          command: `head -c 600000 /dev/zero | tr '\\0' ${mark}`,
                          run_in_background: runInBackground,
                        },
                        { toolCallId: ToolCallId.make(entry.ids[call - 1] ?? "") },
                      ),
                      finishPart({ finishReason: "tool-calls" }),
                    ])
                  }
                  return Stream.fromIterable([
                    textDeltaPart(`reply ${call}`),
                    finishPart({ finishReason: "stop" }),
                  ])
                }),
              ),
            )
            const { client, sessionId, branchId } = yield* createRpcHarness({
              ...e2ePreset,
              providerLayer,
              home: directory,
              cwd: directory,
            })
            const legacy = `${directory}/.gent/background-bash/${sessionId}/${branchId}/call_a.txt`
            if (entry.name === "slash and underscore") {
              // An older call `call?a` emitted this path; neither new call may overwrite it.
              yield* fs.makeDirectory(
                `${directory}/.gent/background-bash/${sessionId}/${branchId}`,
                {
                  recursive: true,
                },
              )
              yield* fs.writeFileString(legacy, "retained-before-upgrade")
            }
            yield* client.message.send({
              sessionId,
              branchId,
              content: "Keep both command outputs",
            })
            const settled = yield* waitFor(
              client.session.getSnapshot({ sessionId, branchId }),
              (snapshot) => {
                const results = snapshot.messages
                  .flatMap((message) => message.parts)
                  .filter((part) => part.type === "tool-result" && entry.ids.includes(part.id))
                const completions = snapshot.messages.filter(
                  (message) => message.metadata?.customType === "background-bash",
                )
                return (
                  snapshot.runtime._tag === "Idle" &&
                  results.length === 2 &&
                  (!runInBackground || completions.length === 2)
                )
              },
              10_000,
              "both shell outputs settled",
            )
            const files: string[] = []
            for (const [index, id] of entry.ids.entries()) {
              const stored = settled.messages
                .flatMap((message) => message.parts)
                .find((part) => part.type === "tool-result" && part.id === id)
              if (Predicate.isUndefined(stored) || stored.type !== "tool-result")
                return yield* Effect.die("Missing command result")
              expect(stored.isFailure).toBe(false)
              const result = yield* Schema.decodeUnknownEffect(
                Schema.Struct({
                  stdout: Schema.String,
                  outputFile: Schema.optionalKey(Schema.String),
                }),
              )(stored.result)
              let file = result.outputFile ?? ""
              if (runInBackground) file = startedOutputFile(result.stdout)
              expect(file.startsWith(`${directory}/.gent/background-bash/`)).toBe(true)
              files.push(file)
              let mark = "a"
              if (index === 1) mark = "b"
              expect(yield* fs.readFileString(file)).toBe(mark.repeat(600_000))
            }
            expect(new Set(files).size).toBe(2)
            if (entry.name === "slash and underscore")
              expect(yield* fs.readFileString(legacy)).toBe("retained-before-upgrade")
          }).pipe(Effect.timeout("20 seconds")),
        25_000,
      )
    }
  }

  it.scopedLive.layer(BunFileSystem.layer)(
    "a running job's output is in its file, not in server memory",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "gent-bg-stream-" })
        const produced = `${directory}/produced`
        const release = `${directory}/release`
        const bytes = 96 * 1024 * 1024
        const mark = "\nMID-RUN-MARK\n"
        const command = `head -c ${bytes} /dev/zero | tr '\\0' x; printf '\\nMID-RUN-MARK\\n'; touch ${produced}; while ! test -f ${release}; do sleep 0.02; done; printf 'after release\\n'`
        const toolCallId = ToolCallId.make("bg-stream-call")
        const calls = yield* Ref.make(0)
        const providerLayer = LanguageModelLayers.testStream(() =>
          Ref.updateAndGet(calls, (n) => n + 1).pipe(
            Effect.map((call) => {
              if (call === 1) {
                return Stream.fromIterable([
                  toolCallPart("bash", { command, run_in_background: true }, { toolCallId }),
                  finishPart({ finishReason: "tool-calls" }),
                ])
              }
              return Stream.fromIterable([
                textDeltaPart(`reply ${call}`),
                finishPart({ finishReason: "stop" }),
              ])
            }),
          ),
        )
        const { client, sessionId, branchId } = yield* createRpcHarness({
          ...e2ePreset,
          providerLayer,
          cwd: directory,
          home: directory,
        })
        const baseline = yield* liveBytes
        yield* client.message.send({ sessionId, branchId, content: "start the job" })
        yield* waitFor(fs.exists(produced), (exists) => exists, 20_000, "the job printed")

        // The job printed 96 MiB and still runs; the server holds only its ends.
        const held = (yield* liveBytes) - baseline
        expect(held).toBeLessThan(bytes / 8)

        const started = yield* client.session.getSnapshot({ sessionId, branchId })
        const stored = started.messages
          .flatMap((message) => message.parts)
          .find((part) => part.type === "tool-result" && part.id === toolCallId)
        if (Predicate.isUndefined(stored) || stored.type !== "tool-result")
          return yield* Effect.die("Missing background start result")
        const result = yield* Schema.decodeUnknownEffect(Schema.Struct({ stdout: Schema.String }))(
          stored.result,
        )
        const file = startedOutputFile(result.stdout)
        // The file is readable before the job exits and holds all of it so far.
        const size = yield* waitFor(
          fs.stat(file).pipe(
            Effect.map((info) => Number(info.size)),
            Effect.orElseSucceed(() => 0),
          ),
          (current) => current >= bytes + mark.length,
          5_000,
          "the running job's file",
        )
        expect(size).toBe(bytes + mark.length)
        // The start result names the file, so the model can read it mid-run.
        const results = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
          started.messages.filter((message) => message.role === "tool"),
        )
        expect(results).toContain(file)

        yield* fs.writeFileString(release, "go")
        yield* waitFor(
          client.session.getSnapshot({ sessionId, branchId }),
          (snapshot) =>
            snapshot.runtime._tag === "Idle" &&
            snapshot.messages.some((message) =>
              message.parts.some(
                (part) => part.type === "text" && part.text.includes("after release"),
              ),
            ),
          10_000,
          "the completion notice",
        )
        const notice = (yield* client.session.getSnapshot({ sessionId, branchId })).messages
          .flatMap((message) => message.parts)
          .flatMap((part) => {
            if (part.type === "text" && part.text.includes("after release")) return [part.text]
            return []
          })
        expect(notice).toHaveLength(1)
        expect(notice[0]?.length ?? 0).toBeLessThanOrEqual(maximumModelToolResultChars)
        expect(notice[0]).toContain(`The whole output is in ${file} (`)
        expect(notice[0]).toContain("MID-RUN-MARK")
      }).pipe(Effect.timeout("40 seconds")),
    45_000,
  )
})

describe("a command's recorded process", () => {
  /** One `ps` column of a process, in the locale and zone the record reads it in. */
  const psColumn = (column: "pgid" | "lstart", pid: number) =>
    Effect.map(
      runProcess("ps", ["-o", `${column}=`, "-p", String(pid)], {
        env: { LC_ALL: "C", TZ: "UTC0" },
        extendEnv: true,
      }),
      (result) => result.stdout.trim(),
    )
  /** The pids in process group `pid`, none once the group is gone. */
  const groupMembers = (pid: number) =>
    Effect.map(runProcess("pgrep", ["-g", String(pid)]), (result) =>
      result.stdout.split("\n").filter((line) => line.trim() !== ""),
    )
  /** A recording whose receipt goes under a fresh data dir and whose process lands in `recorded`. */
  const recordingInto = (recorded: Deferred.Deferred<CommandProcess>) =>
    Effect.gen(function* () {
      const launch = yield* commandLaunch(yield* makeTempDirectoryScoped("gent-command-receipt-"))
      return {
        launch,
        recording: Option.some({
          launch,
          recorded: (process: CommandProcess) => Effect.asVoid(Deferred.succeed(recorded, process)),
        }),
      }
    })

  it.scopedLive.layer(BunServices.layer)(
    "a run reports the process group it leads with that process's start time, and a later server's stop ends the group and its children",
    () =>
      Effect.gen(function* () {
        const recorded = yield* Deferred.make<CommandProcess>()
        const { recording } = yield* recordingInto(recorded)
        // `bash` leads its group; the background sleep is a child in it.
        const run = yield* runBashCommand(
          "sleep 60 & wait",
          Option.none(),
          Option.none(),
          recording,
        ).pipe(Effect.exit, Effect.forkScoped)
        const process = yield* Deferred.await(recorded)
        expect(yield* psColumn("pgid", process.pid)).toBe(String(process.pid))
        expect(process.startIdentity).toBe(yield* psColumn("lstart", process.pid))
        const members = yield* waitFor(
          groupMembers(process.pid),
          (pids) => pids.length >= 2,
          5_000,
          "the sleep joined the command's group",
        )
        expect(members).toContain(String(process.pid))
        // The run that owned the group is lost; a later server stops what it recorded.
        expect(yield* stopStaleProcess(process)).toBe(true)
        expect(yield* groupMembers(process.pid)).toEqual([])
        // The killed command's run ends: nothing of it waits on the group.
        yield* Fiber.join(run)
      }).pipe(Effect.timeout("20 seconds")),
    30_000,
  )

  it.scopedLive.layer(BunServices.layer)(
    "a command's processes inherit the token its record names",
    () =>
      Effect.gen(function* () {
        const recorded = yield* Deferred.make<CommandProcess>()
        const { launch, recording } = yield* recordingInto(recorded)
        const output = yield* runBashCommand(
          'echo "$GENT_COMMAND_TOKEN"',
          Option.none(),
          Option.none(),
          recording,
        )
        const process = yield* Deferred.await(recorded)
        expect(process.token).toEqual(Option.some(launch.token))
        expect(output.stdout.trim()).toBe(launch.token)
      }).pipe(Effect.timeout("10 seconds")),
    15_000,
  )

  /** The command line of each process in group `pid`. */
  const groupCommands = (pid: number) =>
    Effect.map(
      runProcess("ps", ["-A", "-o", "pgid=,command="], { env: { LC_ALL: "C" }, extendEnv: true }),
      (result) =>
        result.stdout
          .split("\n")
          .values()
          .map((line) => line.trim())
          .filter((line) => line.startsWith(`${pid} `))
          .map((line) => line.slice(String(pid).length + 1))
          .toArray(),
    )
  /**
   * A command whose leader exits at once and leaves one child in its group:
   * the test runtime, which macOS does not hide the environment of.
   */
  const leaderlessCommand = (execPath: string) =>
    `${execPath} -e "setTimeout(() => {}, 60000)" > /dev/null 2>&1 &`
  /** Waits until the leader `pid` is gone and its group holds the runtime child. */
  const leftChild = (platform: GentPlatform["Service"], pid: number) =>
    Effect.gen(function* () {
      yield* waitFor(
        platform.signal(pid, 0).pipe(Effect.exit),
        Exit.isFailure,
        5_000,
        "the leader exited",
      )
      yield* waitFor(
        groupCommands(pid),
        (commands) => commands.some((command) => command.includes("setTimeout")),
        5_000,
        "the child runs the runtime",
      )
    })

  it.scopedLive.layer(BunPlatformLive)(
    "a later server's stop ends a group whose leader exited, by the token its child inherited",
    () =>
      Effect.gen(function* () {
        const platform = yield* GentPlatform
        const recorded = yield* Deferred.make<CommandProcess>()
        const { recording } = yield* recordingInto(recorded)
        // The leader exits at once: the spawn still records it, from the receipt.
        yield* runBashCommand(
          leaderlessCommand(yield* platform.execPath),
          Option.none(),
          Option.none(),
          recording,
        ).pipe(Effect.exit, Effect.forkScoped)
        const process = yield* Deferred.await(recorded)
        yield* Effect.addFinalizer(() => Effect.ignore(platform.signal(-process.pid, "SIGKILL")))
        yield* leftChild(platform, process.pid)
        expect(yield* stopStaleProcess(process)).toBe(true)
        expect(yield* groupMembers(process.pid)).toEqual([])
      }).pipe(Effect.timeout("20 seconds")),
    30_000,
  )

  it.scopedLive.layer(BunPlatformLive)(
    "a later server stops a group whose leader exited at once from its receipt alone, when the server died before it kept the process",
    () =>
      Effect.gen(function* () {
        const platform = yield* GentPlatform
        const fs = yield* FileSystem.FileSystem
        const seen = yield* Deferred.make<CommandProcess>()
        const { launch, recording } = yield* recordingInto(seen)
        yield* runBashCommand(
          leaderlessCommand(yield* platform.execPath),
          Option.none(),
          Option.none(),
          recording,
        ).pipe(Effect.exit, Effect.forkScoped)
        // The test learns the pid only to clean up; the lost server kept nothing.
        const process = yield* Deferred.await(seen)
        yield* Effect.addFinalizer(() => Effect.ignore(platform.signal(-process.pid, "SIGKILL")))
        yield* leftChild(platform, process.pid)
        expect(yield* readCommandReceipt(launch)).toEqual(Option.some(process))
        expect(yield* stopLostCommand(Option.none(), Option.some(launch))).toBe(true)
        expect(yield* groupMembers(process.pid)).toEqual([])
        // The group is shown gone: its receipt goes with it.
        expect(yield* fs.exists(launch.receipt)).toBe(false)
      }).pipe(Effect.timeout("20 seconds")),
    30_000,
  )

  it.scopedLive.layer(BunPlatformLive)(
    "a restart stops a stale job's group from its receipt when the server died before it kept the process",
    () =>
      Effect.gen(function* () {
        const platform = yield* GentPlatform
        const directory = yield* makeTempDirectoryScoped("gent-bg-receipt-only-")
        const seen = yield* Deferred.make<CommandProcess>()
        const { launch, recording } = yield* recordingInto(seen)
        yield* runBashCommand(
          leaderlessCommand(yield* platform.execPath),
          Option.none(),
          Option.none(),
          recording,
        ).pipe(Effect.exit, Effect.forkScoped)
        // The test learns the pid to check the group and clean up; the row keeps none.
        const process = yield* Deferred.await(seen)
        yield* Effect.addFinalizer(() => Effect.ignore(platform.signal(-process.pid, "SIGKILL")))
        yield* leftChild(platform, process.pid)
        const storageLayer = fileStorage(`${directory}/gent.db`)
        // The lost server stored the launch with its claim, and died before
        // it copied the receipt's process into the row.
        yield* Effect.gen(function* () {
          yield* BackgroundBashStorage
          const sql = yield* SqlClient.SqlClient
          yield* sql`
            INSERT INTO background_bash_jobs
              (session_id, branch_id, tool_call_id, command, status, started_at, owner_generation, process_token, process_receipt, output_file)
            VALUES ('s', 'b', 'receipt-only', 'node &', 'running', 0, 'earlier-process', ${launch.token}, ${launch.receipt}, '/out/receipt-only.txt')
          `
        }).pipe(Effect.provide(BackgroundBashStorage.Live.pipe(Layer.provideMerge(storageLayer))))

        const unread = yield* Effect.gen(function* () {
          const storage = yield* BackgroundBashStorage
          return yield* storage.interruptedJobs({
            sessionId: SessionId.make("s"),
            branchId: BranchId.make("b"),
          })
        }).pipe(Effect.provide(makeProcessLayer(storageLayer)))

        expect(unread).toMatchObject([
          { toolCallId: ToolCallId.make("receipt-only"), mayStillRun: false },
        ])
        expect(yield* groupMembers(process.pid)).toEqual([])
      }).pipe(Effect.timeout("20 seconds")),
    30_000,
  )

  it.scopedLive.layer(BunPlatformLive)(
    "a launch whose launcher never wrote its receipt ran nothing, and a later server finds nothing to stop",
    () =>
      Effect.gen(function* () {
        const launch = yield* commandLaunch(yield* makeTempDirectoryScoped("gent-command-receipt-"))
        expect(yield* stopLostCommand(Option.none(), Option.some(launch))).toBe(true)
        // A record from before receipts proves nothing.
        expect(yield* stopLostCommand(Option.none(), Option.none())).toBe(false)
      }).pipe(Effect.timeout("10 seconds")),
    15_000,
  )

  it.scopedLive.layer(BunPlatformLive)(
    "a later server's stop that cannot list the processes leaves the group as it may still run",
    () =>
      Effect.gen(function* () {
        const real = yield* ChildProcessSpawner.ChildProcessSpawner
        // Every process listing fails, as a `ps` that exits non-zero with no output.
        const failingListing = ChildProcessSpawner.make((command) => {
          if (command._tag === "StandardCommand" && command.command === "ps") {
            return real.spawn(ChildProcess.make("false", [], command.options))
          }
          return real.spawn(command)
        })
        const exited = yield* ChildProcess.make("true", [], {
          forceKillAfter: "2 seconds",
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        })
        yield* exited.exitCode
        const job: CommandProcess = {
          pid: Number(exited.pid),
          startIdentity: "Thu Jan  1 00:00:00 1970",
          token: Option.some("the-job-s-own-token"),
        }
        const stopped = yield* stopStaleProcess(job).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, failingListing),
        )
        expect(stopped).toBe(false)
      }).pipe(Effect.timeout("10 seconds")),
    15_000,
  )

  it.scopedLive.layer(BunPlatformLive)(
    "a later server's stop leaves alone the children an unrelated leader left in the job's reused pid",
    () =>
      Effect.gen(function* () {
        const platform = yield* GentPlatform
        // The job's group ended; an unrelated leader took its pid, started a
        // child, and exited. The child carries no token of the job.
        const other = yield* ChildProcess.make(
          "bash",
          ["-c", leaderlessCommand(yield* platform.execPath)],
          {
            forceKillAfter: "2 seconds",
            stdin: "ignore",
            stdout: "ignore",
            stderr: "ignore",
          },
        )
        const otherPid = Number(other.pid)
        yield* Effect.addFinalizer(() => Effect.ignore(platform.signal(-otherPid, "SIGKILL")))
        yield* other.exitCode
        yield* leftChild(platform, other.pid)
        const job: CommandProcess = {
          pid: other.pid,
          startIdentity: "Thu Jan  1 00:00:00 1970",
          token: Option.some("the-job-s-own-token"),
        }
        expect(yield* stopStaleProcess(job)).toBe(false)
        // A record from before the token proves nothing either.
        expect(yield* stopStaleProcess({ ...job, token: Option.none() })).toBe(false)
        expect((yield* groupMembers(other.pid)).length).toBeGreaterThan(0)
      }).pipe(Effect.timeout("20 seconds")),
    30_000,
  )
})

describe("foreground command output", () => {
  it.scopedLive.layer(BunServices.layer)(
    "a cut that lands inside an emoji leaves the whole emoji out",
    () =>
      Effect.gen(function* () {
        // 131,050 + 2 + 200,000 characters: the marker for that total leaves
        // a head of 131,051, which ends between the emoji's two halves.
        const command =
          "head -c 131050 /dev/zero | tr '\\0' x; printf '\\360\\237\\230\\200'; head -c 200000 /dev/zero | tr '\\0' y"
        const result = yield* runBashCommand(command, Option.none(), Option.none())
        expect(result.stdout.isWellFormed()).toBe(true)
        expect(result.stdout.startsWith(`${"x".repeat(131_050)}\n\n... [`)).toBe(true)
        expect(result.stdout.endsWith("y")).toBe(true)
      }).pipe(Effect.timeout("20 seconds")),
    30_000,
  )

  it.scopedLive.layer(BunFileSystem.layer)(
    "a foreground command's output past the kept ends goes to its file, not to server memory or the row",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "gent-fg-stream-" })
        const produced = `${directory}/produced`
        const release = `${directory}/release`
        const bytes = 96 * 1024 * 1024
        const command = `head -c ${bytes} /dev/zero | tr '\\0' x; printf '\\nMID-RUN-MARK\\n'; printf 'on stderr\\n' >&2; touch ${produced}; while ! test -f ${release}; do sleep 0.02; done; printf 'after release\\n'`
        const toolCallId = ToolCallId.make("fg-stream-call")
        const calls = yield* Ref.make(0)
        const providerLayer = LanguageModelLayers.testStream(() =>
          Ref.updateAndGet(calls, (n) => n + 1).pipe(
            Effect.map((call) => {
              if (call === 1) {
                return Stream.fromIterable([
                  toolCallPart("bash", { command }, { toolCallId }),
                  finishPart({ finishReason: "tool-calls" }),
                ])
              }
              return Stream.fromIterable([
                textDeltaPart(`reply ${call}`),
                finishPart({ finishReason: "stop" }),
              ])
            }),
          ),
        )
        const { client, sessionId, branchId } = yield* createRpcHarness({
          ...e2ePreset,
          providerLayer,
          cwd: directory,
          home: directory,
        })
        const baseline = yield* liveBytes
        yield* client.message.send({ sessionId, branchId, content: "run the command" })
        yield* waitFor(fs.exists(produced), (exists) => exists, 20_000, "the command printed")

        // The command printed 96 MiB and still runs; the server holds only its ends.
        const held = (yield* liveBytes) - baseline
        expect(held).toBeLessThan(bytes / 8)

        yield* fs.writeFileString(release, "go")
        const settled = yield* waitFor(
          client.session.getSnapshot({ sessionId, branchId }),
          (snapshot) =>
            snapshot.runtime._tag === "Idle" &&
            snapshot.messages.some((message) =>
              message.parts.some((part) => part.type === "text" && part.text === "reply 2"),
            ),
          10_000,
          "the command's result",
        )
        const stored = settled.messages
          .flatMap((message) => message.parts)
          .find((part) => part.type === "tool-result" && part.id === toolCallId)
        if (Predicate.isUndefined(stored) || stored.type !== "tool-result")
          return yield* Effect.die("Missing bash result")
        const total =
          bytes + "\nMID-RUN-MARK\n".length + "on stderr\n".length + "after release\n".length
        const result = yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            stdout: Schema.String,
            stderr: Schema.String,
            exitCode: Schema.Finite,
            outputFile: Schema.String,
            outputChars: Schema.Finite,
          }),
        )(stored.result)
        const file = result.outputFile
        // The row keeps each stream's ends and names the file with all of it.
        expect(result.exitCode).toBe(0)
        expect(result.stdout.length).toBeLessThanOrEqual(256 * 1024)
        expect(result.stdout.startsWith("xxxx")).toBe(true)
        expect(result.stdout).toContain("characters truncated")
        expect(result.stdout.endsWith("MID-RUN-MARK\nafter release\n")).toBe(true)
        expect(result.stderr).toBe("on stderr\n")
        expect(
          file.startsWith(`${directory}/.gent/background-bash/${sessionId}/${branchId}/calls/`),
        ).toBe(true)
        expect(result.outputChars).toBe(total)
        expect(Number((yield* fs.stat(file)).size)).toBe(total)
      }).pipe(Effect.timeout("40 seconds")),
    45_000,
  )

  it.scopedLive.layer(BunFileSystem.layer)(
    "a foreground command that spilled and then timed out leaves no file",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "gent-fg-timeout-" })
        const command = "head -c 600000 /dev/zero | tr '\\0' x; sleep 30"
        const toolCallId = ToolCallId.make("fg-timeout-call")
        const calls = yield* Ref.make(0)
        const providerLayer = LanguageModelLayers.testStream(() =>
          Ref.updateAndGet(calls, (n) => n + 1).pipe(
            Effect.map((call) => {
              if (call === 1) {
                return Stream.fromIterable([
                  toolCallPart("bash", { command, timeout: 3000 }, { toolCallId }),
                  finishPart({ finishReason: "tool-calls" }),
                ])
              }
              return Stream.fromIterable([
                textDeltaPart(`reply ${call}`),
                finishPart({ finishReason: "stop" }),
              ])
            }),
          ),
        )
        const { client, sessionId, branchId } = yield* createRpcHarness({
          ...e2ePreset,
          providerLayer,
          cwd: directory,
          home: directory,
        })
        const folder = `${directory}/.gent/background-bash/${sessionId}/${branchId}/calls`
        yield* client.message.send({ sessionId, branchId, content: "run the command" })
        // The output passes what memory keeps whole, so the file holds it while the command runs.
        const files = yield* waitFor(
          fs.readDirectory(folder).pipe(Effect.orElseSucceed(() => [])),
          (files) => files.length === 1,
          10_000,
          "the output file",
        )
        const file = `${folder}/${files[0]}`
        const settled = yield* waitFor(
          client.session.getSnapshot({ sessionId, branchId }),
          (snapshot) =>
            snapshot.runtime._tag === "Idle" &&
            snapshot.messages.some((message) =>
              message.parts.some((part) => part.type === "text" && part.text === "reply 2"),
            ),
          10_000,
          "the timed-out result",
        )
        const stored = settled.messages
          .flatMap((message) => message.parts)
          .find((part) => part.type === "tool-result" && part.id === toolCallId)
        expect(stored).toMatchObject({ isFailure: true })
        // A timed-out call returns no pointer, so no file stays behind for it.
        expect(yield* fs.exists(file)).toBe(false)
      }).pipe(Effect.timeout("25 seconds")),
    30_000,
  )
})

describe("background bash after session deletion", () => {
  it.scopedLive.layer(BunFileSystem.layer)(
    "a deleted session's output files go with it; another session's stay",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "gent-fg-deleted-" })
        const toolCallId = ToolCallId.make("fg-deleted-call")
        const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
          // Past what a result keeps whole, so the output spills to its file.
          toolCallStep(
            "bash",
            { command: "head -c 600000 /dev/zero | tr '\\0' x" },
            { toolCallId },
          ),
          textStep("spilled"),
        ])
        const { client, sessionId, branchId } = yield* createRpcHarness({
          ...e2ePreset,
          providerLayer,
          cwd: directory,
          home: directory,
        })
        const sessionFiles = `${directory}/.gent/background-bash/${sessionId}`
        const other = `${directory}/.gent/background-bash/other-session/branch/call.txt`
        yield* fs.makeDirectory(`${directory}/.gent/background-bash/other-session/branch`, {
          recursive: true,
        })
        yield* fs.writeFileString(other, "kept")
        yield* client.message.send({ sessionId, branchId, content: "run the command" })
        const settled = yield* waitFor(
          client.session.getSnapshot({ sessionId, branchId }),
          (snapshot) =>
            snapshot.runtime._tag === "Idle" &&
            snapshot.messages.some((message) =>
              message.parts.some((part) => part.type === "text" && part.text === "spilled"),
            ),
          10_000,
          "the spilled result",
        )
        const stored = settled.messages
          .flatMap((message) => message.parts)
          .find((part) => part.type === "tool-result" && part.id === toolCallId)
        if (Predicate.isUndefined(stored) || stored.type !== "tool-result")
          return yield* Effect.die("Missing spilled result")
        const { outputFile: file } = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ outputFile: Schema.String }),
        )(stored.result)
        expect(yield* fs.exists(file)).toBe(true)

        yield* client.session.delete({ sessionId })

        expect(yield* fs.exists(sessionFiles)).toBe(false)
        expect(yield* fs.readFileString(other)).toBe("kept")
      }).pipe(Effect.timeout("15 seconds")),
    20_000,
  )

  it.scopedLive.layer(BunFileSystem.layer)(
    "a completion that lands after the session is deleted starts no turn",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "gent-bg-deleted-" })
        const markerPath = `${directory}/done`
        const release = `${directory}/release`
        const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
          toolCallStep("bash", {
            command: `while ! test -f ${release}; do sleep 0.02; done; touch ${markerPath}; printf stale-background-completion`,
            run_in_background: true,
          }),
          textStep("background command started"),
          // A live session answers the completion notice with this step.
          textStep("received completion"),
        ])
        const { client } = yield* createRpcClient(createE2ELayer({ ...e2ePreset, providerLayer }))
        const { sessionId, branchId } = yield* client.session.create({ cwd: directory })
        const completed = yield* client.session.events({ sessionId, branchId }).pipe(
          Stream.filter(({ event }) => event._tag === "TurnCompleted"),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkScoped,
        )
        yield* client.message.send({ sessionId, branchId, content: "start background command" })
        yield* Fiber.join(completed)
        yield* client.session.delete({ sessionId })
        // The job outlives its session: it finishes only after the delete.
        yield* fs.writeFileString(release, "go")
        yield* waitFor(fs.exists(markerPath), (exists) => exists, 2_000, "background marker")
        // Absence has no event to wait for: a live session starts the third
        // model call within this window; a deleted one must not.
        const answered = yield* Effect.exit(
          controls.waitForCall(2).pipe(Effect.timeout("1 second")),
        )
        expect(answered._tag).toBe("Failure")
      }).pipe(Effect.timeout("8 seconds")),
    10_000,
  )
})

describe("a background completion the full follow-up queue refused", () => {
  it.scopedLive.layer(BunFileSystem.layer)(
    "the next turn reads it as a notice until a turn answers",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "gent-bg-queue-full-" })
        const storagePath = `${directory}/gent.db`
        const release = `${directory}/release`
        // Past the notice's output bound, so the notice names the saved file.
        const command = `while ! test -f ${release}; do sleep 0.02; done; printf 'queue-full-output\\n'; seq 1 1000`
        const holding = yield* Deferred.make<void>()
        const releaseHold = yield* Deferred.make<void>()
        const refused = yield* Deferred.make<void>()
        const refusalLogger = Layer.merge(
          Layer.succeed(References.MinimumLogLevel, "Warn"),
          Logger.layer([
            Logger.make(({ message }) => {
              if (String(message) === "exec-tools.background.follow-up.refused")
                Deferred.doneUnsafe(refused, Effect.void)
            }),
          ]),
        )
        const notices = yield* Ref.make<ReadonlyArray<string>>([])
        const providerLayer = LanguageModelLayers.testStream((options) =>
          Effect.gen(function* () {
            const call = (yield* Ref.updateAndGet(notices, (all) => [
              ...all,
              turnRequestText(options.prompt).notices,
            ])).length
            if (call === 1) {
              return Stream.fromIterable([
                toolCallPart("bash", { command, run_in_background: true }),
                finishPart({ finishReason: "tool-calls" }),
              ])
            }
            // The third call holds its turn, so every later send waits in the queue.
            if (call === 3) {
              yield* Deferred.succeed(holding, void 0)
              yield* Deferred.await(releaseHold)
            }
            return Stream.fromIterable([
              textDeltaPart(`reply ${call}`),
              finishPart({ finishReason: "stop" }),
            ])
          }),
        )
        const { client, sessionId, branchId } = yield* createRpcHarness({
          ...e2ePreset,
          providerLayer,
          storagePath,
          cwd: directory,
          home: directory,
          extraLayers: [refusalLogger],
        })
        const idle = (label: string) =>
          waitFor(
            client.session.getSnapshot({ sessionId, branchId }),
            (snapshot) => snapshot.runtime._tag === "Idle",
            10_000,
            label,
          )
        yield* client.message.send({ sessionId, branchId, content: "start the job" })
        yield* waitFor(
          client.session.getSnapshot({ sessionId, branchId }),
          (snapshot) =>
            snapshot.runtime._tag === "Idle" &&
            snapshot.messages.some((message) => message.role === "tool"),
          10_000,
          "the job started and the turn ended",
        )
        yield* client.message.send({ sessionId, branchId, content: "hold" })
        yield* Deferred.await(holding)
        for (let i = 1; i <= 10; i++) {
          yield* client.message.send({ sessionId, branchId, content: `queued ${i}` })
        }
        yield* fs.writeFileString(release, "go")
        yield* Deferred.await(refused)
        // The job ends while the queue is full: the refused completion is kept on its row.
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          yield* waitFor(
            sql<{ readonly n: number }>`
              SELECT COUNT(*) AS n FROM background_bash_jobs WHERE undelivered_at IS NOT NULL
            `.pipe(
              Effect.map((rows) => rows[0]?.n ?? 0),
              // A table without the column reads as nothing recorded.
              Effect.orElseSucceed(() => 0),
            ),
            (count) => count === 1,
            5_000,
            "the refused completion is recorded",
          )
        }).pipe(Effect.provide(fileStorage(storagePath)))
        yield* Deferred.succeed(releaseHold, void 0)
        yield* idle("the queued turns ran")
        const heading = "# Background commands finished"
        const shown = (yield* Ref.get(notices)).filter((text) => text.includes(heading))
        expect(shown.length).toBeGreaterThan(0)
        expect(shown[0]).toContain(command)
        expect(shown[0]).toContain("queue-full-output")
        expect(shown[0]).not.toContain("\n500\n")
        const file = /The whole output is in (\S+) /.exec(shown[0] ?? "")?.[1] ?? ""
        expect(file.startsWith(`${directory}/.gent/background-bash/`)).toBe(true)
        expect(yield* fs.readFileString(file)).toContain("\n500\n")
        // No message carries the completion: it lived in the notices only.
        const snapshot = yield* client.session.getSnapshot({ sessionId, branchId })
        const texts = snapshot.messages.flatMap((message) =>
          message.parts.flatMap((part) => {
            if (part.type === "text") return [part.text]
            return []
          }),
        )
        expect(texts.some((text) => text.includes("queue-full-output"))).toBe(false)
        // A turn answered with it shown: the next turn reads nothing.
        const before = (yield* Ref.get(notices)).length
        yield* client.message.send({ sessionId, branchId, content: "anything else?" })
        yield* waitFor(Ref.get(notices), (all) => all.length > before, 5_000, "the next model call")
        yield* idle("the last turn ended")
        expect((yield* Ref.get(notices)).slice(before).join("")).not.toContain(heading)
      }).pipe(Effect.timeout("25 seconds")),
    30_000,
  )

  // A row can hold more output than the notice bound while the job's file
  // holds all of it. The notice names that file, not only the row's cut ends.
  it.scopedLive.layer(BunFileSystem.layer)(
    "a stored row longer than the notice bound names the job's file; a missing file is named as not saved",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "gent-bg-long-row-" })
        const storagePath = `${directory}/gent.db`
        const notices = yield* Ref.make<ReadonlyArray<string>>([])
        const providerLayer = LanguageModelLayers.testStream((options) =>
          Ref.updateAndGet(notices, (all) => [
            ...all,
            turnRequestText(options.prompt).notices,
          ]).pipe(
            Effect.map((all) =>
              Stream.fromIterable([
                textDeltaPart(`reply ${all.length}`),
                finishPart({ finishReason: "stop" }),
              ]),
            ),
          ),
        )
        const { client, sessionId, branchId } = yield* createRpcHarness({
          ...e2ePreset,
          providerLayer,
          storagePath,
          cwd: directory,
          home: directory,
        })
        const printed = Array.from({ length: 1000 }, (_, index) => `${index + 1}\n`).join("")
        const finished = ToolCallId.make("tc/long-row")
        const stopped = ToolCallId.make("tc-stopped-no-file")
        const file = `${directory}/.gent/background-bash/${sessionId}/${branchId}/tc_long-row.txt`
        yield* fs.makeDirectory(`${directory}/.gent/background-bash/${sessionId}/${branchId}`, {
          recursive: true,
        })
        yield* fs.writeFileString(file, printed)
        const storageLayer = fileStorage(storagePath)
        yield* Effect.gen(function* () {
          const storage = yield* BackgroundBashStorage
          const job = (toolCallId: ToolCallId) => ({ sessionId, branchId, toolCallId })
          yield* storage.claimStart({
            ...job(finished),
            command: "seq 1 1000",
            cwd: Option.some(directory),
            outputFile: file,
          })
          yield* storage.markCompleted(job(finished), { exitCode: 0, message: printed })
          yield* storage.claimStart({
            ...job(stopped),
            command: "sleep 100",
            cwd: Option.some(directory),
            outputFile: `${directory}/tc-stopped-no-file.txt`,
          })
          yield* storage.markInterrupted(job(stopped))
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              storageLayer,
              BackgroundBashStorage.Live.pipe(Layer.provide(storageLayer)),
            ),
          ),
        )
        yield* client.message.send({ sessionId, branchId, content: "what happened?" })
        const shown = (yield* waitFor(
          Ref.get(notices),
          (all) => all.length > 0,
          5_000,
          "the first model call",
        ))[0]
        expect(shown).toContain("# Background commands finished")
        expect(shown).toContain("1\n2\n3\n")
        expect(shown).toContain("\n1000\n")
        expect(shown).toContain(`The whole output is in ${file} (${printed.length} characters)`)
        expect(yield* fs.readFileString(file)).toBe(printed)
        expect(shown).toContain("# Interrupted background commands")
        expect(shown).toContain(`\`sleep 100\` · call ${stopped} · no output was saved`)
      }).pipe(Effect.timeout("20 seconds")),
    25_000,
  )
})

// ── background bash across a restart ───────────────────────────────────────

describe("a background job the server stopped", () => {
  for (const entry of [
    { name: "completion", failed: false },
    { name: "failure", failed: true },
  ]) {
    it.scopedLive.layer(BunServices.layer)(
      `interruption after durable ${entry.name} keeps the undelivered outcome`,
      () =>
        Effect.gen(function* () {
          const directory = yield* makeTempDirectoryScoped("gent-background-delivery-")
          const terminal = yield* Deferred.make<void>()
          const notices = yield* Ref.make<ReadonlyArray<string>>([])
          const ctx = liveSession(
            (notice) => Ref.update(notices, (all) => [...all, notice.sourceId]),
            { toolCallId: `delivery-${entry.name}`, home: directory },
          )
          const storageLayer = fileStorage(`${directory}/storage.db`)
          const interruptAfterCommit = (commit: Effect.Effect<void, BackgroundBashStorageError>) =>
            Effect.withFiber((fiber) =>
              commit.pipe(
                Effect.tap(() => Effect.sync(() => fiber.interruptUnsafe())),
                Effect.ensuring(Deferred.succeed(terminal, void 0)),
              ),
            )
          const interruptedStorage = Layer.effect(
            BackgroundBashStorage,
            Effect.gen(function* () {
              const storage = yield* BackgroundBashStorage
              return BackgroundBashStorage.of({
                ...storage,
                markCompleted: (key, result) =>
                  interruptAfterCommit(storage.markCompleted(key, result)),
                markFailed: (key, message) =>
                  interruptAfterCommit(storage.markFailed(key, message)),
              })
            }),
          ).pipe(Layer.provideMerge(BackgroundBashStorage.Live))
          const processLayer = BackgroundBashSupervisorLive.pipe(
            Layer.provideMerge(interruptedStorage),
            Layer.provideMerge(Layer.merge(storageLayer, BunServices.layer)),
          )
          const scope = yield* Scope.make()
          yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
          const profile = yield* Layer.buildWithScope(processLayer, scope)
          let cwd = directory
          let status = "completed"
          let message = "saved-output"
          if (entry.failed) {
            cwd = `${directory}/missing-directory`
            status = "failed"
            message = "missing-directory"
          }
          yield* runToolWithCtx(
            BashTool,
            { command: "printf saved-output", cwd, run_in_background: true },
            ctx,
          ).pipe(Effect.provideContext(profile))
          yield* Deferred.await(terminal)
          yield* Scope.close(scope, Exit.void)
          expect(yield* Ref.get(notices)).toEqual([])
          const pending = yield* BackgroundBashStorage.pipe(
            Effect.flatMap((storage) =>
              storage.undeliveredJobs({ sessionId: ctx.sessionId, branchId: ctx.branchId }),
            ),
            Effect.provide(BackgroundBashStorage.Live.pipe(Layer.provide(storageLayer))),
          )
          expect(pending).toHaveLength(1)
          expect(pending[0]).toMatchObject({
            toolCallId: ctx.toolCallId,
            state: { status, command: "printf saved-output" },
          })
          expect(pending[0]?.state.message).toContain(message)
        }).pipe(withProcessTimeout),
      processTestTimeout,
    )
  }

  it.scopedLive.layer(BunServices.layer)(
    "an interruption at any step after a durable start claim leaves a scope-owned job",
    () =>
      interruptAtEachStep(
        Effect.gen(function* () {
          const directory = yield* makeTempDirectoryScoped("gent-background-claim-")
          const ctx = {
            ...stubCtx,
            home: directory,
            toolCallId: ToolCallId.make("claim-interrupted"),
          }
          const key = {
            sessionId: ctx.sessionId,
            branchId: ctx.branchId,
            toolCallId: ctx.toolCallId,
          }
          const storageLayer = fileStorage(`${directory}/storage.db`)
          // The steps that count start once the real start transaction commits.
          let claimed = false
          const claimingStorage = Layer.effect(
            BackgroundBashStorage,
            Effect.gen(function* () {
              const storage = yield* BackgroundBashStorage
              return BackgroundBashStorage.of({
                ...storage,
                claimStart: (input) =>
                  storage.claimStart(input).pipe(
                    Effect.tap((claim) =>
                      Effect.sync(() => {
                        claimed ||= claim._tag === "Started"
                      }),
                    ),
                  ),
              })
            }),
          ).pipe(Layer.provideMerge(BackgroundBashStorage.Live))
          const processLayer = BackgroundBashSupervisorLive.pipe(
            Layer.provideMerge(claimingStorage),
            Layer.provideMerge(Layer.merge(storageLayer, BunServices.layer)),
          )
          const scope = yield* Scope.make()
          yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
          const profile = yield* Layer.buildWithScope(processLayer, scope)
          return {
            program: runToolWithCtx(
              BashTool,
              { command: "sleep 30", run_in_background: true },
              ctx,
            ).pipe(Effect.provideContext(profile)),
            at: () => claimed,
            // Interrupted or started, no new process generation can reconcile
            // this claim: its resource owns cleanup when the scope closes.
            invariant: () =>
              Effect.gen(function* () {
                yield* Scope.close(scope, Exit.void)
                const claim = yield* BackgroundBashStorage.pipe(
                  Effect.flatMap((storage) =>
                    storage.claimStart({
                      ...key,
                      command: "sleep 30",
                      cwd: Option.some(directory),
                      outputFile: `${directory}/second-claim.txt`,
                    }),
                  ),
                  Effect.provide(BackgroundBashStorage.Live.pipe(Layer.provide(storageLayer))),
                )
                expect(claim._tag).toBe("Terminal")
                if (claim._tag === "Terminal") expect(claim.state.status).toBe("interrupted")
              }),
          }
        }),
      ).pipe(Effect.timeout("20 seconds")),
    // One run per step after the claim, each with a real process: about 16 runs.
    25_000,
  )

  it.scopedLive(
    "is marked interrupted when its fiber stops, not left running under this process",
    () =>
      Effect.gen(function* () {
        const ctx = { ...stubCtx, toolCallId: ToolCallId.make("tc-stopped-fiber") }
        const directory = yield* makeTempDirectoryScoped("gent-background-bash-")
        const storageLayer = fileStorage(`${directory}/storage.db`)
        const scope = yield* Scope.make()
        const firstProfile = yield* Layer.buildWithScope(makeProcessLayer(storageLayer), scope)
        const started = yield* runToolWithCtx(
          BashTool,
          { command: "sleep 2", run_in_background: true },
          ctx,
        ).pipe(Effect.provideContext(firstProfile))
        expect(started.exitCode).toBe(0)
        // The resource closes in a server that keeps running: no reconcile
        // of another generation will ever reach this row.
        yield* Scope.close(scope, Exit.void)

        const claim = yield* Effect.gen(function* () {
          const storage = yield* BackgroundBashStorage
          return yield* storage.claimStart({
            sessionId: ctx.sessionId,
            branchId: ctx.branchId,
            toolCallId: ctx.toolCallId,
            command: "sleep 2",
            cwd: Option.none(),
            outputFile: `${directory}/second-claim.txt`,
          })
        }).pipe(Effect.provide(makeProcessLayer(storageLayer)))
        expect(claim._tag).toBe("Terminal")
        if (claim._tag === "Terminal") expect(claim.state.status).toBe("interrupted")
      }).pipe(withProcessTimeout),
    processTestTimeout,
  )

  // Quiet: a job writes nothing to the pipe the dead server held, so no
  // write ends it. In the second case the leader exits before the crash and
  // only its descendant keeps the process group.
  const crashCases = [
    {
      name: "a quiet job that outlived a crashed server stops when the next server starts",
      command: (directory: string, _execPath: string) =>
        `echo $$ > ${directory}/job.pid; sleep 30; touch ${directory}/late`,
      leaderExits: false,
    },
    {
      name: "a descendant that outlived its exited leader and a crashed server stops when the next server starts",
      // The descendant runs the test runtime: macOS hides the environment of
      // its own signed programs, so only such a process shows the job's token.
      command: (directory: string, execPath: string) =>
        `echo $$ > ${directory}/job.pid; (${execPath} -e "setTimeout(() => {}, 30000)"; touch ${directory}/late) & while ! test -f ${directory}/go; do sleep 0.05; done`,
      leaderExits: true,
    },
  ]
  for (const crashCase of crashCases) {
    it.scopedLive.layer(BunPlatformLive)(
      crashCase.name,
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const path = yield* Path.Path
          const platform = yield* GentPlatform
          const directory = yield* fs.realPath(yield* makeTempDirectoryScoped("gent-bg-crash-"))
          const storagePath = `${directory}/gent.db`
          const pidFile = `${directory}/job.pid`
          const command = crashCase.command(directory, yield* platform.execPath)
          const hostEntry = yield* path.fromFileUrl(
            new URL("./helpers/background-bash-host.ts", import.meta.url),
          )
          const host = yield* ChildProcess.make(yield* platform.execPath, [hostEntry], {
            cwd: directory,
            forceKillAfter: "2 seconds",
            env: { BG_STORAGE_PATH: storagePath, BG_HOME: directory, BG_COMMAND: command },
            extendEnv: true,
            stdout: "ignore",
            stderr: "inherit",
          })
          const pid = Number(
            yield* waitFor(
              fs.readFileString(pidFile).pipe(Effect.orElseSucceed(() => "")),
              (text) => text.trim() !== "",
              10_000,
              "the job's pid",
            ),
          )
          expect(Number.isSafeInteger(pid) && pid > 0).toBe(true)
          // A red run must not leave the job's group behind.
          yield* Effect.addFinalizer(() => Effect.ignore(platform.signal(-pid, "SIGKILL")))
          const storageLayer = SqliteStorage.WithSql(BunSqlite.file(storagePath)).pipe(
            Layer.provide(BunPlatformLive),
          )
          // The host names the job's process in the row before it crashes.
          yield* waitFor(
            Effect.gen(function* () {
              return yield* (yield* BackgroundBashStorage).staleJobs
            }).pipe(Effect.provide(BackgroundBashStorage.Live.pipe(Layer.provide(storageLayer)))),
            (jobs) => jobs.some((job) => Option.exists(job.process, (found) => found.pid === pid)),
            10_000,
            "the job's recorded process",
          )
          if (crashCase.leaderExits) {
            // The leader exits after its process is recorded; the job still runs.
            yield* fs.writeFileString(`${directory}/go`, "")
            yield* waitFor(
              platform.signal(pid, 0).pipe(Effect.exit),
              Exit.isFailure,
              5_000,
              "the job's leader exited",
            )
          }
          yield* host.kill({ killSignal: "SIGKILL" })
          yield* host.exitCode.pipe(Effect.ignore)
          // The server died without a finalizer: the job's group runs on.
          yield* platform.signal(-pid, 0)

          // The next server's background resource builds over the same store.
          const unread = yield* Effect.gen(function* () {
            const storage = yield* BackgroundBashStorage
            return yield* storage.interruptedJobs({
              sessionId: stubCtx.sessionId,
              branchId: BranchId.make("test-branch"),
            })
          }).pipe(Effect.provide(makeProcessLayer(storageLayer)))

          // Every process of the job's group is gone, and the notice says it stopped.
          yield* waitFor(
            platform.signal(-pid, 0).pipe(Effect.exit),
            Exit.isFailure,
            5_000,
            "the job's process group stopped",
          )
          expect(yield* fs.exists(`${directory}/late`)).toBe(false)
          expect(unread).toMatchObject([
            { toolCallId: ToolCallId.make("crashed-host-job"), command, mayStillRun: false },
          ])
        }).pipe(Effect.timeout("20 seconds")),
      25_000,
    )
  }

  it.scopedLive.layer(BunPlatformLive)(
    "a restart leaves alone a process that took a stale job's pid",
    () =>
      Effect.gen(function* () {
        const platform = yield* GentPlatform
        const directory = yield* makeTempDirectoryScoped("gent-bg-reused-pid-")
        // A live process the job does not own: same pid, another start time.
        const other = yield* ChildProcess.make("sleep", ["30"], {
          forceKillAfter: "2 seconds",
          stdout: "ignore",
          stderr: "ignore",
        })
        const storageLayer = SqliteStorage.WithSql(BunSqlite.file(`${directory}/gent.db`)).pipe(
          Layer.provide(BunPlatformLive),
        )
        yield* Effect.gen(function* () {
          yield* BackgroundBashStorage
          const sql = yield* SqlClient.SqlClient
          yield* sql`
            INSERT INTO background_bash_jobs
              (session_id, branch_id, tool_call_id, command, status, started_at, owner_generation, pid, process_start_id, output_file)
            VALUES ('s', 'b', 'reused', 'sleep 30', 'running', 0, 'earlier-process', ${other.pid}, 'Thu Jan  1 00:00:00 1970', '/out/reused.txt')
          `
        }).pipe(Effect.provide(BackgroundBashStorage.Live.pipe(Layer.provideMerge(storageLayer))))

        const unread = yield* Effect.gen(function* () {
          const storage = yield* BackgroundBashStorage
          return yield* storage.interruptedJobs({
            sessionId: SessionId.make("s"),
            branchId: BranchId.make("b"),
          })
        }).pipe(Effect.provide(makeProcessLayer(storageLayer)))

        yield* platform.signal(other.pid, 0)
        expect(unread).toMatchObject([
          { toolCallId: ToolCallId.make("reused"), mayStillRun: false },
        ])
      }).pipe(Effect.timeout("10 seconds")),
    15_000,
  )

  it.scopedLive(
    "a restart that may not signal a stale job's group says the job may still run",
    () =>
      Effect.gen(function* () {
        const directory = yield* makeTempDirectoryScoped("gent-bg-denied-")
        const startedAt = "Thu Jan  1 00:00:00 1970"
        const signals: Array<string> = []
        // The job's leader still holds its pid, but the group belongs to
        // another user: `ps` names the job's own start time and every `kill`
        // is refused, as procps prints it.
        const bytes = (text: string) => Stream.make(new TextEncoder().encode(text))
        const answer = (exitCode: number, stdout: string, stderr: string) =>
          ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(4242),
            exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
            isRunning: Effect.succeed(false),
            kill: () => Effect.void,
            stdin: Sink.drain,
            stdout: bytes(stdout),
            stderr: bytes(stderr),
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
            unref: Effect.succeed(Effect.void),
          })
        const spawner = ChildProcessSpawner.make((command) =>
          Effect.sync(() => {
            if (command._tag !== "StandardCommand" || command.command !== "kill") {
              return answer(0, `${startedAt}\n`, "")
            }
            signals.push(command.args.join(" "))
            return answer(1, "", `kill: (${command.args.at(-1) ?? ""}): Operation not permitted\n`)
          }),
        )
        const storageLayer = fileStorage(`${directory}/gent.db`)
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          yield* sql`
            INSERT INTO background_bash_jobs
              (session_id, branch_id, tool_call_id, command, status, started_at, owner_generation, pid, process_start_id, output_file)
            VALUES ('s', 'b', 'denied', 'sleep 30', 'running', 0, 'earlier-process', 4242, ${startedAt}, '/out/denied.txt')
          `
        }).pipe(Effect.provide(BackgroundBashStorage.Live.pipe(Layer.provideMerge(storageLayer))))

        const unread = yield* Effect.gen(function* () {
          const storage = yield* BackgroundBashStorage
          return yield* storage.interruptedJobs({
            sessionId: SessionId.make("s"),
            branchId: BranchId.make("b"),
          })
        }).pipe(
          Effect.provide(
            BackgroundBashLayer.pipe(
              Layer.provideMerge(
                Layer.mergeAll(
                  storageLayer,
                  BunCrypto.layer,
                  BunFileSystem.layer,
                  Path.layer,
                  Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
                ),
              ),
            ),
          ),
        )

        expect(signals[0]).toBe("-TERM -- -4242")
        expect(unread).toMatchObject([{ toolCallId: ToolCallId.make("denied"), mayStillRun: true }])
      }).pipe(Effect.timeout("10 seconds")),
    15_000,
  )

  it.scopedLive.layer(BunFileSystem.layer)(
    "opening a session after a restart starts no turn; the next turns read the job until one answers",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "gent-bg-restart-" })
        const storagePath = `${directory}/gent.db`
        // The jobs wait for a file nobody writes, so they are running when the
        // first process stops. One prints first; the other writes nothing.
        const command = `while ! test -f ${directory}/never; do sleep 0.02; done`
        const printing = `printf started; ${command}`
        // Every process has the one home (the directory), so a job's file outlives the
        // server that wrote it.
        const textOf = (message: { readonly parts: ReadonlyArray<Prompt.Part> }) =>
          message.parts
            .map((part) => {
              if (part.type === "text") return part.text
              return ""
            })
            .join("")
        const noticesIn = <
          M extends { readonly role: string; readonly parts: ReadonlyArray<Prompt.Part> },
        >(
          messages: ReadonlyArray<M>,
        ) =>
          messages.filter((message) => message.role === "user" && textOf(message).includes(command))

        // First process: the turn starts the job and ends; then the server stops.
        const target = yield* Effect.scoped(
          Effect.gen(function* () {
            const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
              multiToolCallStep(
                { toolName: "bash", input: { command, run_in_background: true } },
                { toolName: "bash", input: { command: printing, run_in_background: true } },
              ),
              textStep("background commands started"),
            ])
            const { client, sessionId, branchId } = yield* createRpcHarness({
              ...e2ePreset,
              providerLayer,
              storagePath,
              cwd: directory,
              home: directory,
            })
            yield* client.message.send({ sessionId, branchId, content: "start the job" })
            yield* waitFor(
              client.session.getSnapshot({ sessionId, branchId }),
              (snapshot) =>
                snapshot.runtime._tag === "Idle" &&
                snapshot.messages.some((message) => message.role === "tool"),
              5_000,
              "the jobs started and the turn ended",
            )
            // The printing job's output reaches its file before the server stops.
            yield* waitFor(
              fs.readDirectory(directory, { recursive: true }).pipe(
                Effect.flatMap((entries) =>
                  Effect.forEach(
                    entries.filter(
                      (entry) => entry.includes("background-bash/") && entry.endsWith(".txt"),
                    ),
                    (entry) => fs.readFileString(`${directory}/${entry}`),
                  ),
                ),
                Effect.orElseSucceed((): ReadonlyArray<string> => []),
              ),
              (texts) => texts.includes("started"),
              5_000,
              "the printing job's output was saved",
            )
            return { sessionId, branchId }
          }),
        )

        // A model that records the turn notices each call carries after the
        // conversation. A call listed in `failing` fails its stream, so that
        // turn never answers.
        const recordingModel = (failing: ReadonlySet<number>) =>
          Effect.gen(function* () {
            const systems = yield* Ref.make<ReadonlyArray<string>>([])
            const providerLayer = LanguageModelLayers.testStream((options) =>
              Effect.gen(function* () {
                const { notices } = turnRequestText(options.prompt)
                const call = (yield* Ref.updateAndGet(systems, (all) => [...all, notices])).length
                if (failing.has(call)) {
                  return yield* AiError.make({
                    module: "Test",
                    method: "streamText",
                    reason: new AiError.AuthenticationError({
                      kind: "Unknown",
                      description: "the keychain is locked",
                    }),
                  })
                }
                return Stream.fromIterable([
                  textDeltaPart(`reply ${call}`),
                  finishPart({ finishReason: "stop" }),
                ])
              }),
            )
            return { systems, providerLayer }
          })
        const ask = (
          client: Effect.Success<ReturnType<typeof createRpcClient>>["client"],
          systems: Ref.Ref<ReadonlyArray<string>>,
          calls: number,
        ) =>
          client.message
            .send({ ...target, content: "what happened?" })
            .pipe(
              Effect.andThen(
                waitFor(
                  Effect.all([client.session.getSnapshot(target), Ref.get(systems)]),
                  ([snapshot, all]) => snapshot.runtime._tag === "Idle" && all.length === calls,
                  5_000,
                  `model call ${calls} and the turn ended`,
                ),
              ),
              Effect.andThen(Ref.get(systems)),
            )
        const heading = "# Interrupted background commands"

        // Second process: opening the session starts no turn. The next turns
        // read the job until one answers with it shown.
        yield* Effect.scoped(
          Effect.gen(function* () {
            const { systems, providerLayer } = yield* recordingModel(new Set([1]))
            const { client } = yield* createRpcClient(
              createE2ELayer({
                ...e2ePreset,
                providerLayer,
                storagePath,
                home: directory,
              }),
            )
            yield* client.session.getSnapshot(target)
            // Absence has no event to wait for: a notice that starts a turn
            // makes the first model call within this window.
            const woke = yield* Effect.exit(
              waitFor(Ref.get(systems), (all) => all.length > 0, 1_000, "a turn started"),
            )
            expect(woke._tag).toBe("Failure")
            // The first turn shows the job, but its stream fails: it stays unread.
            const failed = yield* ask(client, systems, 1)
            expect(failed[0]).toContain(heading)
            expect(failed[0]).toContain(command)
            expect(failed[0]).toContain("start one again only when the user asks for it")
            // A file is named only when it holds output, and holds only what was written before the stop.
            expect(failed[0]).toContain(printing)
            expect(failed[0]).toMatch(/output up to the stop is in \S+\/background-bash\/\S+\.txt/)
            expect((failed[0] ?? "").split("output up to the stop is in")).toHaveLength(2)
            expect(failed[0]).toContain("it wrote no output before the stop")
            expect(failed[0]).toContain("holds only the output written before the stop")
            // The cause is not named: a reload stops a job as a restart does.
            expect(failed[0]).toContain(
              "stopped before they finished (a server restart or a reload)",
            )
            const answered = yield* ask(client, systems, 2)
            expect(answered[1]).toContain(heading)
            const after = yield* ask(client, systems, 3)
            expect(after[2]).not.toContain(heading)
            // No message carries the notice: it lived in the prompt only.
            const snapshot = yield* client.session.getSnapshot(target)
            expect(noticesIn(snapshot.messages)).toHaveLength(0)
          }),
        )

        // Third process: the read mark is on the row, so a new turn shows nothing.
        yield* Effect.scoped(
          Effect.gen(function* () {
            const { systems, providerLayer } = yield* recordingModel(new Set())
            const { client } = yield* createRpcClient(
              createE2ELayer({
                ...e2ePreset,
                providerLayer,
                storagePath,
                home: directory,
              }),
            )
            const prompts = yield* ask(client, systems, 1)
            expect(prompts[0]).not.toContain(heading)
          }),
        )
      }).pipe(Effect.timeout("20 seconds")),
    25_000,
  )
})

// ── named bash permits ──────────────────────────────────────────────────────

/** Controlled OS lifetime. The process exits before its group cleanup ends. */
const permittedProcessBoundary = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const exited = yield* Deferred.make<void>()
  const cleaning = yield* Deferred.make<void>()
  const cleaned = yield* Deferred.make<void>()
  const events: string[] = []
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      if (command._tag !== "StandardCommand" || command.command !== "bash")
        return yield* Effect.die("Expected bash")
      if (command.args[2] === "gent-command") {
        const receipt = Option.getOrThrow(Option.fromUndefinedOr(command.args[3]))
        yield* fs.writeFileString(receipt, "4242\nfixture-start\n")
      }
      events.push("start")
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          yield* Deferred.succeed(cleaning, void 0)
          yield* Deferred.await(cleaned)
          events.push("end")
        }),
      )
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(4242),
        exitCode: Deferred.await(exited).pipe(Effect.as(ChildProcessSpawner.ExitCode(0))),
        isRunning: Deferred.isDone(exited).pipe(Effect.map((done) => !done)),
        kill: () => Deferred.succeed(exited, void 0).pipe(Effect.asVoid),
        stdin: Sink.drain,
        stdout: Stream.empty,
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      })
    }),
  )
  // Failed assertions must not leave an uninterruptible finalizer waiting.
  yield* Effect.addFinalizer(() => Deferred.succeed(cleaned, void 0))
  return {
    exited,
    cleaning,
    cleaned,
    events,
    layer: Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
  }
})

describe("bash named permits", () => {
  for (const background of [false, true]) {
    it.scopedLive(
      `a mismatched limit is a typed bash error before spawning (background=${background})`,
      () =>
        Effect.gen(function* () {
          const notices = yield* Ref.make<ReadonlyArray<Notice>>([])
          const ctx = yield* inTempCwd({
            ...liveSession((notice) => Ref.update(notices, (all) => [...all, notice])),
            Permits: testToolContext().Permits,
          })
          const holder = yield* ctx.Permits.with("bash-gate", 1, Effect.never).pipe(
            Effect.forkScoped,
          )
          yield* waitFor(ctx.Permits.list, (rows) => rows[0]?.holders.length === 1)
          const result = yield* provideBun(
            Effect.gen(function* () {
              const result = yield* runToolWithCtx(
                BashTool,
                {
                  command: "must-not-spawn",
                  permit: { name: "bash-gate", limit: 2 },
                  run_in_background: background,
                },
                ctx,
              ).pipe(Effect.result)
              if (background) {
                const storage = yield* BackgroundBashStorage
                const claim = yield* storage.claimStart({
                  sessionId: ctx.sessionId,
                  branchId: ctx.branchId,
                  toolCallId: Option.getOrThrow(Option.fromUndefinedOr(ctx.toolCallId)),
                  command: "must-not-spawn",
                  cwd: Option.some(ctx.cwd),
                  outputFile: `${ctx.cwd}/must-not-spawn.txt`,
                })
                let state: string = claim._tag
                if (claim._tag === "Terminal") state = claim.state.status
                expect({
                  state,
                  notices: yield* Ref.get(notices),
                  pending: yield* storage.undeliveredJobs(ctx),
                }).toMatchObject({
                  state: "failed",
                  notices: [],
                  pending: [],
                })
              }
              return result
            }),
          )
          expect(Result.isFailure(result)).toBe(true)
          if (Result.isFailure(result)) {
            expect(result.failure._tag).toBe("BashError")
            expect(result.failure.message).toBe('Permit "bash-gate" has limit 1, requested 2')
          }
          yield* Fiber.interrupt(holder)
        }).pipe(Effect.timeout("5 seconds")),
    )
  }

  it.scopedLive.layer(BunServices.layer)(
    "a foreground timeout starts after its permit queue wait",
    () =>
      Effect.gen(function* () {
        const ctx = yield* inTempCwd({ ...stubCtx, Permits: testToolContext().Permits })
        const boundary = yield* permittedProcessBoundary
        const body = Effect.gen(function* () {
          const holder = yield* ctx.Permits.with("bash-gate", 1, Effect.never).pipe(
            Effect.forkScoped,
          )
          yield* waitFor(ctx.Permits.list, (rows) => rows[0]?.holders.length === 1).pipe(
            TestClock.withLive,
          )
          const queued = yield* runToolWithCtx(
            BashTool,
            {
              command: "queued",
              timeout: 100,
              permit: { name: "bash-gate", limit: 1 },
            },
            ctx,
          ).pipe(Effect.forkScoped)
          yield* waitFor(ctx.Permits.list, (rows) => rows[0]?.waiters.length === 1).pipe(
            TestClock.withLive,
          )
          yield* TestClock.adjust("200 millis")
          yield* Deferred.succeed(boundary.exited, void 0)
          yield* Deferred.succeed(boundary.cleaned, void 0)
          yield* Fiber.interrupt(holder)
          const result = yield* Fiber.join(queued)
          expect({
            result,
            events: boundary.events,
            permits: yield* ctx.Permits.list,
          }).toMatchObject({
            result: { exitCode: 0 },
            events: ["start", "end"],
            permits: [],
          })
        })
        yield* body.pipe(
          Effect.ensuring(Deferred.succeed(boundary.cleaned, void 0)),
          Effect.provide(Layer.mergeAll(makePlatformLayer(), boundary.layer, TestClock.layer())),
        )
      }).pipe(Effect.timeout("6 seconds")),
  )

  it.scopedLive.layer(BunServices.layer)(
    "a foreground timeout keeps its permit through detached process cleanup",
    () =>
      Effect.gen(function* () {
        const ctx = yield* inTempCwd({ ...stubCtx, Permits: testToolContext().Permits })
        const boundary = yield* permittedProcessBoundary
        const body = Effect.gen(function* () {
          const first = yield* runToolWithCtx(
            BashTool,
            {
              command: "first",
              timeout: 100,
              permit: { name: "bash-gate", limit: 1 },
            },
            ctx,
          ).pipe(Effect.result)
          expect(Result.isFailure(first)).toBe(true)
          if (Result.isFailure(first)) expect(first.failure._tag).toBe("BashError")
          yield* Deferred.await(boundary.cleaning)
          const second = yield* runToolWithCtx(
            BashTool,
            {
              command: "second",
              permit: { name: "bash-gate", limit: 1 },
            },
            ctx,
          ).pipe(Effect.forkScoped)
          yield* waitFor(ctx.Permits.list, (rows) => rows[0]?.waiters.length === 1)
          expect(boundary.events).toEqual(["start"])
          yield* Deferred.succeed(boundary.exited, void 0)
          yield* Deferred.succeed(boundary.cleaned, void 0)
          yield* Fiber.join(second)
          expect(boundary.events).toEqual(["start", "end", "start", "end"])
          expect(yield* ctx.Permits.list).toEqual([])
        })
        yield* body.pipe(
          Effect.ensuring(Deferred.succeed(boundary.cleaned, void 0)),
          Effect.provide(Layer.merge(makePlatformLayer(), boundary.layer)),
        )
      }).pipe(Effect.timeout("6 seconds")),
  )

  it.scopedLive.layer(BunServices.layer)(
    "a TERM-resistant foreground group ends before the next permitted command starts",
    () =>
      Effect.gen(function* () {
        const ctx = yield* inTempCwd({ ...stubCtx, Permits: testToolContext().Permits })
        const pidFile = `${ctx.cwd}/first.pid`
        const fs = yield* FileSystem.FileSystem
        const platform = yield* GentPlatform
        const body = Effect.gen(function* () {
          yield* runToolWithCtx(
            BashTool,
            {
              command: `trap '' TERM; echo $$ > ${pidFile}; sleep 30`,
              timeout: 500,
              permit: { name: "bash-gate", limit: 1 },
            },
            ctx,
          ).pipe(Effect.result)
          const pid = Number(yield* fs.readFileString(pidFile))
          yield* Effect.addFinalizer(() => platform.signal(-pid, "SIGKILL").pipe(Effect.ignore))
          expect(Exit.isSuccess(yield* Effect.exit(platform.signal(-pid, 0)))).toBe(true)
          // The next command probes the first group at its own start, before any
          // assertions in this fiber can hide an early permit release.
          const second = yield* runToolWithCtx(
            BashTool,
            {
              command: `if kill -0 -- -${pid} 2>/dev/null; then printf overlap; else printf gone; fi`,
              permit: { name: "bash-gate", limit: 1 },
            },
            ctx,
          )
          expect(second.stdout).toBe("gone")
          expect(yield* ctx.Permits.list).toEqual([])
        })
        yield* provideBun(body)
      }).pipe(Effect.provide(BunPlatformLive), Effect.timeout("8 seconds")),
    10_000,
  )
})

it.scopedLive.layer(BunServices.layer)(
  "a queued background bash keeps its permit after its turn until process cleanup ends",
  () =>
    Effect.gen(function* () {
      const boundary = yield* permittedProcessBoundary
      const exposed = yield* Deferred.make<ExtensionContextService["Permits"]>()
      const extensionId = ExtensionId.make("bash-permit-probe")
      const probe = defineExtension({
        id: extensionId,
        setup: Effect.gen(function* () {
          const host = yield* ExtensionHost
          yield* host.register(
            "resource",
            defineResource({
              id: "bash-permit-process-boundary",
              scope: "process",
              layer: boundary.layer,
            }),
          )
          yield* host.register(
            "request",
            request({
              id: "connect",
              input: Schema.Struct({}),
              output: Schema.Void,
              execute: () =>
                Effect.gen(function* () {
                  yield* Deferred.succeed(exposed, (yield* ExtensionContext).Permits)
                }),
            }),
          )
        }),
      })
      const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
        toolCallStep("bash", {
          command: "first",
          run_in_background: true,
          permit: { name: "bash-gate", limit: 1 },
        }),
        textStep("accepted"),
        textStep("finished"),
      ])
      const directory = yield* makeTempDirectoryScoped("gent-bash-permit-rpc-")
      const { client, sessionId, branchId } = yield* createRpcHarness({
        ...e2ePreset,
        providerLayer,
        home: directory,
        cwd: directory,
        extensionInputs: [...e2ePreset.extensionInputs, probe],
      })
      yield* Effect.addFinalizer(() => Deferred.succeed(boundary.cleaned, void 0))
      yield* client.extension.request({
        sessionId,
        branchId,
        extensionId,
        capabilityId: "connect",
        input: {},
      })
      const permits = yield* Deferred.await(exposed)
      const first = yield* permits.with("bash-gate", 1, Effect.never).pipe(Effect.forkScoped)
      yield* waitFor(client.permits.list(), (rows) => rows[0]?.holders.length === 1)
      yield* client.message.send({ sessionId, branchId, content: "run queued bash" })
      const snapshot = yield* waitFor(
        client.session.getSnapshot({ sessionId, branchId }),
        (snapshot) =>
          snapshot.runtime._tag === "Idle" &&
          snapshot.messages.some((message) => message.role === "tool"),
        5_000,
        "the background bash turn ended",
      )
      const results = snapshot.messages
        .filter((message) => message.role === "tool")
        .flatMap((message) => message.parts)
      expect(results).toContainEqual(
        expect.objectContaining({
          type: "tool-result",
          result: expect.objectContaining({ status: "queued" }),
        }),
      )
      expect(boundary.events).toEqual([])
      expect((yield* client.permits.list())[0]?.waiters).toHaveLength(1)
      yield* Fiber.interrupt(first)
      yield* waitFor(
        Effect.sync(() => boundary.events.length),
        (count) => count === 1,
      )
      const second = yield* permits
        .with(
          "bash-gate",
          1,
          Effect.sync(() => boundary.events.push("next")),
        )
        .pipe(Effect.forkScoped)
      yield* waitFor(client.permits.list(), (rows) => rows[0]?.waiters.length === 1)
      yield* Deferred.succeed(boundary.exited, void 0)
      yield* Deferred.await(boundary.cleaning)
      expect(boundary.events).toEqual(["start"])
      expect((yield* client.permits.list())[0]?.holders).toHaveLength(1)
      yield* Deferred.succeed(boundary.cleaned, void 0)
      yield* Fiber.join(second)
      expect(boundary.events).toEqual(["start", "end", "next"])
      yield* waitFor(
        client.session.getSnapshot({ sessionId, branchId }),
        (snapshot) =>
          snapshot.runtime._tag === "Idle" &&
          snapshot.messages.some((message) => message.metadata?.customType === "background-bash"),
      )
      yield* controls.assertDone
    }).pipe(Effect.timeout("12 seconds")),
  15_000,
)

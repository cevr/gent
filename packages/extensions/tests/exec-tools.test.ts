import { describe, expect, it, test } from "effect-bun-test"
import {
  Cause,
  Clock,
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
  References,
  Schema,
  Scope,
  Stream,
} from "effect"
import {
  addBackgroundBashColumn,
  BackgroundBashLayer,
  BackgroundBashStorage,
  BackgroundBashStorageError,
  BackgroundBashSupervisorLive,
  BashParams,
  BashTool,
  runBashCommand,
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
import { BunPlatformLive } from "@gent/core/host"
import { ExtensionServiceError, maximumModelToolResultChars } from "@gent/core/extensions/api"
import { SqlClient } from "effect/sql"
import { isToolResultFor } from "./helpers/tool-event.js"
import type * as Prompt from "effect/ai/Prompt"
import * as AiError from "effect/ai/AiError"

const makeProcessLayer = <A, E>(storageLayer: Layer.Layer<A, E>) => {
  const base = Layer.mergeAll(
    storageLayer,
    BunCrypto.layer,
    BunFileSystem.layer,
    Path.layer,
    BunChildProcessSpawner.layer.pipe(Layer.provide(Layer.merge(BunFileSystem.layer, Path.layer))),
  )
  return BackgroundBashLayer.pipe(Layer.provideMerge(base))
}

const makeProcessLayerWithFailingMarkFailed = <A, E>(storageLayer: Layer.Layer<A, E>) => {
  const base = Layer.mergeAll(
    storageLayer,
    BunCrypto.layer,
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
    SqliteStorage.MemoryWithSql(Layer.empty, {}).pipe(Layer.provide(BunPlatformLive)),
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
        // A data directory that is a file: no job file can go under it.
        const dataDir = path.join(home, "not-a-directory")
        yield* fs.writeFileString(dataDir, "")
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
  cwd: process.cwd(),
  home: "/nonexistent/gent-test-home",
  Session: {
    getSession: dieStub("getSession"),
    getDetail: dieStub("getDetail"),
    renameCurrent: dieStub("renameCurrent"),
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

/** The jobs table as it was before interrupted jobs had a read mark. */
const oldBackgroundBashTable = `
  CREATE TABLE background_bash_jobs (
    session_id TEXT NOT NULL,
    branch_id TEXT NOT NULL,
    tool_call_id TEXT NOT NULL,
    command TEXT NOT NULL,
    cwd TEXT,
    status TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    completed_at INTEGER,
    exit_code INTEGER,
    message TEXT,
    owner_generation TEXT,
    PRIMARY KEY (session_id, branch_id, tool_call_id)
  )
`

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
  it.live(
    "a command that ignores SIGTERM returns at its timeout, not after the kill",
    () =>
      Effect.gen(function* () {
        const started = yield* Clock.currentTimeMillis
        const exit = yield* Effect.exit(
          provideBun(
            runToolWithCtx(BashTool, { command: "trap '' TERM; sleep 30", timeout: 500 }, stubCtx),
          ),
        )
        const elapsed = (yield* Clock.currentTimeMillis) - started
        expect(Exit.isFailure(exit)).toBe(true)
        expect(elapsed).toBeLessThan(1_500)
      }).pipe(withProcessTimeout),
    processTestTimeout,
  )

  it.live(
    "a multibyte character split across output chunks decodes whole",
    () =>
      Effect.gen(function* () {
        const result = yield* provideBun(
          runToolWithCtx(
            BashTool,
            { command: "printf '\\xc3'; sleep 0.2; printf '\\xa9'" },
            stubCtx,
          ),
        )

        expect(result.stdout).toBe("é")
      }).pipe(withProcessTimeout),
    processTestTimeout,
  )

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

  // The stub context's `approve` dies, so an ask would fail the test. The
  // command runs and fails at once: its directory does not exist.
  it.live(
    "a command runs as given, with no ask",
    () =>
      Effect.gen(function* () {
        const result = yield* provideBun(
          runToolWithCtx(
            BashTool,
            { command: "git -C /nonexistent/gent-probe-x push --force" },
            stubCtx,
          ),
        )
        expect(result.status).toBeUndefined()
        expect(result.exitCode).not.toBe(0)
        expect(result.stderr).toContain("/nonexistent/gent-probe-x")
      }).pipe(withProcessTimeout),
    processTestTimeout,
  )

  it.live(
    "keeps a result past the model bound but within the kept ends whole, with no file",
    () =>
      Effect.gen(function* () {
        // One line per iteration, far past the model-facing bound.
        const lineCount = 4000
        const result = yield* provideBun(
          runToolWithCtx(BashTool, { command: `seq 1 ${lineCount} | sed 's/^/line /'` }, stubCtx),
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
        const fs = yield* FileSystem.FileSystem
        const cwd = yield* makeTempDirectoryScoped("gent-test-cwd-")
        const result = yield* provideBun(runToolWithCtx(BashTool, { command: "pwd", cwd }, stubCtx))

        // the temp root may resolve through a symlink (/private/tmp on macOS)
        expect(result.stdout.trim()).toBe(yield* fs.realPath(cwd))
        expect(result.exitCode).toBe(0)
      }).pipe(withProcessTimeout, Effect.scoped, Effect.provide(BunFileSystem.layer)),
    processTestTimeout,
  )

  it.live(
    "runs in the session directory, not the server directory",
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
              return { sessionDir, plain, relative, split }
            }),
          ),
        )

        expect(result.sessionDir).not.toBe(process.cwd())
        expect(result.plain.stdout.trim()).toBe(result.sessionDir)
        expect(result.relative.stdout.trim()).toBe(`${result.sessionDir}/sub`)
        expect(result.split.stdout.trim()).toBe(`${result.sessionDir}/sub`)
      }).pipe(withProcessTimeout),
    processTestTimeout,
  )

  it.live(
    "Bash executes a directory change in the command",
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
        // ExtensionSessionService.getSession answers undefined for an absent session.
        // oxlint-disable-next-line effect/noNullish -- the facade's absent-session answer.
        const absentSession: Session | undefined = undefined
        const ctx = withSession(stubCtx, {
          ...stubCtx.Session,
          getSession: () => Effect.succeed(absentSession),
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

  it.scopedLive(
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
        const directory = yield* makeTempDirectoryScoped("gent-background-bash-")
        const storageLayer = SqliteStorage.LiveWithSql(
          `${directory}/storage.db`,
          Layer.empty,
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

  // A build before the output file stored the whole output on the row. A
  // replay cuts that message to its head and tail and writes no file for it.
  it.scopedLive(
    "a replayed row that holds a whole long output is cut, with no file written",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "gent-bg-old-row-" })
        const sent = yield* Deferred.make<{ sourceId: string; content: string }>()
        const toolCallId = ToolCallId.make("tc-old-row-replay")
        const ctx = withSession(
          { ...stubCtx, toolCallId, home },
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
            send: onQueue((notice) => Deferred.succeed(sent, notice)),
          },
        )
        const storageLayer = SqliteStorage.LiveWithSql(`${home}/gent.db`, Layer.empty, {}).pipe(
          Layer.provide(Layer.merge(BunServices.layer, BunPlatformLive)),
        )
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
        expect(yield* fs.exists(`${home}/.gent/background-bash`)).toBe(false)
      }).pipe(Effect.provide(BunFileSystem.layer), withProcessTimeout),
    processTestTimeout,
  )

  // A build that streamed output to the job's file also kept a follow-up's
  // worth on the row. A replay names that file, unchanged.
  it.scopedLive(
    "a replayed row longer than its bound names the job's file when it exists",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "gent-bg-row-file-" })
        const sent = yield* Deferred.make<{ sourceId: string; content: string }>()
        const toolCallId = ToolCallId.make("tc/row-file-replay")
        const ctx = withSession(
          { ...stubCtx, toolCallId, home },
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
            send: onQueue((notice) => Deferred.succeed(sent, notice)),
          },
        )
        const storageLayer = SqliteStorage.LiveWithSql(`${home}/gent.db`, Layer.empty, {}).pipe(
          Layer.provide(Layer.merge(BunServices.layer, BunPlatformLive)),
        )
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
        const directory = yield* makeTempDirectoryScoped("gent-background-bash-")
        const storageLayer = SqliteStorage.LiveWithSql(
          `${directory}/storage.db`,
          Layer.empty,
          {},
        ).pipe(Layer.provide(Layer.merge(BunServices.layer, BunPlatformLive)))

        const result = yield* runToolWithCtx(
          BashTool,
          {
            command: "printf should-not-run",
            cwd: "/nonexistent/gent-missing-cwd",
            run_in_background: true,
          },
          ctx,
        ).pipe(Effect.provide(makeProcessLayerWithFailingMarkFailed(storageLayer)))
        expect(result.exitCode).toBe(0)

        const followUp = yield* Effect.exit(Deferred.await(sent).pipe(Effect.timeout("250 millis")))
        expect(followUp._tag).toBe("Failure")
      }).pipe(withProcessTimeout),
    processTestTimeout,
  )

  it.scopedLive(
    "a repeated start of a job a restart interrupted sends no message and leaves the job unread",
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
        const directory = yield* makeTempDirectoryScoped("gent-background-bash-")
        const storageLayer = SqliteStorage.LiveWithSql(
          `${directory}/storage.db`,
          Layer.empty,
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
        const storageLayer = SqliteStorage.LiveWithSql(
          `${directory}/storage.db`,
          Layer.empty,
          {},
        ).pipe(Layer.provide(Layer.merge(BunServices.layer, BunPlatformLive)))
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
          })
        }).pipe(Effect.provideContext(secondProfile))
        expect(claim._tag).toBe("AlreadyRunning")
      }).pipe(Effect.scoped, withProcessTimeout),
    processTestTimeout,
  )

  it.live("a running job from a table before owner generations is interrupted", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* sql.unsafe(`
        CREATE TABLE background_bash_jobs (
          session_id TEXT NOT NULL,
          branch_id TEXT NOT NULL,
          tool_call_id TEXT NOT NULL,
          command TEXT NOT NULL,
          cwd TEXT,
          status TEXT NOT NULL,
          started_at INTEGER NOT NULL,
          completed_at INTEGER,
          exit_code INTEGER,
          message TEXT,
          PRIMARY KEY (session_id, branch_id, tool_call_id)
        )
      `)
      yield* sql`
        INSERT INTO background_bash_jobs (session_id, branch_id, tool_call_id, command, status, started_at)
        VALUES ('s', 'b', 'legacy', 'sleep 9', 'running', 0)
      `
      const claim = yield* Effect.gen(function* () {
        const storage = yield* BackgroundBashStorage
        yield* storage.reconcileInterrupted
        return yield* storage.claimStart({
          sessionId: SessionId.make("s"),
          branchId: BranchId.make("b"),
          toolCallId: ToolCallId.make("legacy"),
          command: "sleep 9",
          cwd: Option.none(),
        })
      }).pipe(Effect.provide(BackgroundBashStorage.Live))
      expect(claim._tag).toBe("Terminal")
      if (claim._tag === "Terminal") expect(claim.state.status).toBe("interrupted")
    }).pipe(
      Effect.provide(
        SqliteStorage.MemoryWithSql(Layer.empty, {}).pipe(Layer.provide(BunPlatformLive)),
      ),
    ),
  )

  it.live("a column another process added after this one read the table is no failure", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* sql.unsafe(oldBackgroundBashTable)
      // This process read the old table; then the other one added the column.
      const staleColumns = ["session_id", "branch_id", "tool_call_id", "owner_generation"]
      yield* sql.unsafe(`ALTER TABLE background_bash_jobs ADD COLUMN notice_read_at INTEGER`)
      const added = yield* Effect.exit(
        addBackgroundBashColumn(staleColumns, "notice_read_at", "INTEGER"),
      )
      expect(added._tag).toBe("Success")
      // A failure that leaves the column missing still fails.
      yield* sql.unsafe(`DROP TABLE background_bash_jobs`)
      const missing = yield* Effect.exit(addBackgroundBashColumn([], "notice_read_at", "INTEGER"))
      expect(missing._tag).toBe("Failure")
    }).pipe(
      Effect.provide(
        SqliteStorage.MemoryWithSql(Layer.empty, {}).pipe(Layer.provide(BunPlatformLive)),
      ),
    ),
  )

  it.live(
    "a job interrupted before notices had a read mark is shown once more, never dropped",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql.unsafe(oldBackgroundBashTable)
        // The earlier code may or may not have told the branch of `earlier`:
        // it did only when the branch's loop opened. `running` belongs to a
        // server that is gone.
        yield* sql`
        INSERT INTO background_bash_jobs (session_id, branch_id, tool_call_id, command, status, started_at, completed_at)
        VALUES ('s', 'b', 'earlier', 'sleep 8', 'interrupted', 0, 5),
               ('s', 'b', 'running', 'sleep 9', 'running', 1, NULL)
      `
        const branch = { sessionId: SessionId.make("s"), branchId: BranchId.make("b") }
        const unread = yield* Effect.gen(function* () {
          const storage = yield* BackgroundBashStorage
          yield* storage.reconcileInterrupted
          const before = yield* storage.interruptedJobs(branch)
          yield* storage.markNoticesRead(branch, [
            ToolCallId.make("earlier"),
            ToolCallId.make("running"),
          ])
          return { before, after: yield* storage.interruptedJobs(branch) }
        }).pipe(Effect.provide(BackgroundBashStorage.Live))
        expect(unread.before).toEqual([
          { toolCallId: ToolCallId.make("earlier"), command: "sleep 8" },
          { toolCallId: ToolCallId.make("running"), command: "sleep 9" },
        ])
        expect(unread.after).toEqual([])
      }).pipe(
        Effect.provide(
          SqliteStorage.MemoryWithSql(Layer.empty, {}).pipe(Layer.provide(BunPlatformLive)),
        ),
      ),
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
              new Branch({ id: stubCtx.branchId, sessionId: stubCtx.sessionId, createdAt: now }),
            ]),
            send: onQueue((notice) =>
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
            ),
          },
        )
        const directory = yield* makeTempDirectoryScoped("gent-background-bash-")
        const storageLayer = SqliteStorage.LiveWithSql(
          `${directory}/storage.db`,
          Layer.empty,
          {},
        ).pipe(Layer.provide(Layer.merge(BunServices.layer, BunPlatformLive)))
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

/**
 * Exec-tools RPC acceptance test — exercises the `bash` tool through a real
 * agent turn (LLM emits the tool call, runtime dispatches it inside the
 * per-request scope, BunChildProcessSpawner from BunServices spawns a real
 * process). The tool tests above call the executor directly through
 * `runToolWithCtx`, which bypasses the scope boundary production uses.
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
          const storageLayer = SqliteStorage.LiveWithSql(storagePath, Layer.empty, {}).pipe(
            Layer.provide(Layer.merge(BunServices.layer, BunPlatformLive)),
          )
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

  /** Live heap bytes after a full collection; Bun counts array buffers in it. */
  const liveBytes = Effect.sync(() => {
    Bun.gc(true)
    return process.memoryUsage().heapUsed
  })

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

describe("foreground command output", () => {
  /** Live heap bytes after a full collection; Bun counts array buffers in it. */
  const liveBytes = Effect.sync(() => {
    Bun.gc(true)
    return process.memoryUsage().heapUsed
  })

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
        }).pipe(
          Effect.provide(
            SqliteStorage.LiveWithSql(storagePath, Layer.empty, {}).pipe(
              Layer.provide(Layer.merge(BunServices.layer, BunPlatformLive)),
            ),
          ),
        )
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

  // A build before the 2,000-character row bound stored up to a follow-up's
  // worth of output on the row, and streamed all of it to the job's file. The
  // notice once cut that row to its bound and named no file.
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
        const storageLayer = SqliteStorage.LiveWithSql(storagePath, Layer.empty, {}).pipe(
          Layer.provide(Layer.merge(BunServices.layer, BunPlatformLive)),
        )
        yield* Effect.gen(function* () {
          const storage = yield* BackgroundBashStorage
          const job = (toolCallId: ToolCallId) => ({ sessionId, branchId, toolCallId })
          yield* storage.claimStart({
            ...job(finished),
            command: "seq 1 1000",
            cwd: Option.some(directory),
          })
          yield* storage.markCompleted(job(finished), { exitCode: 0, message: printed })
          yield* storage.recordDelivery(job(finished), false)
          yield* storage.claimStart({
            ...job(stopped),
            command: "sleep 100",
            cwd: Option.some(directory),
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
          const ctx = withSession(
            { ...stubCtx, home: directory, toolCallId: ToolCallId.make(`delivery-${entry.name}`) },
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
              send: onQueue((notice) => Ref.update(notices, (all) => [...all, notice.sourceId])),
            },
          )
          const storageLayer = SqliteStorage.LiveWithSql(
            `${directory}/storage.db`,
            Layer.empty,
            {},
          ).pipe(Layer.provide(Layer.merge(BunServices.layer, BunPlatformLive)))
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
    "interruption after a durable start claim leaves a scope-owned job",
    () =>
      Effect.gen(function* () {
        const directory = yield* makeTempDirectoryScoped("gent-background-claim-")
        const ctx = {
          ...stubCtx,
          home: directory,
          toolCallId: ToolCallId.make("claim-interrupted"),
        }
        const key = { sessionId: ctx.sessionId, branchId: ctx.branchId, toolCallId: ctx.toolCallId }
        const storageLayer = SqliteStorage.LiveWithSql(
          `${directory}/storage.db`,
          Layer.empty,
          {},
        ).pipe(Layer.provide(Layer.merge(BunServices.layer, BunPlatformLive)))
        // Interrupt at the existing storage boundary after the real transaction commits.
        const interruptedStorage = Layer.effect(
          BackgroundBashStorage,
          Effect.gen(function* () {
            const storage = yield* BackgroundBashStorage
            return BackgroundBashStorage.of({
              ...storage,
              claimStart: (input) =>
                Effect.withFiber((fiber) =>
                  storage.claimStart(input).pipe(
                    Effect.tap((claim) =>
                      Effect.sync(() => {
                        if (claim._tag === "Started") fiber.interruptUnsafe()
                      }),
                    ),
                  ),
                ),
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
        const start = yield* runToolWithCtx(
          BashTool,
          { command: "sleep 30", run_in_background: true },
          ctx,
        ).pipe(Effect.provideContext(profile), Effect.forkChild)
        const outcome = yield* Fiber.await(start)
        expect(Exit.isFailure(outcome)).toBe(true)
        if (Exit.isFailure(outcome)) expect(Cause.hasInterruptsOnly(outcome.cause)).toBe(true)
        // No new process generation can reconcile this claim. Its resource must own cleanup.
        yield* Scope.close(scope, Exit.void)
        const claim = yield* BackgroundBashStorage.pipe(
          Effect.flatMap((storage) =>
            storage.claimStart({ ...key, command: "sleep 30", cwd: Option.some(directory) }),
          ),
          Effect.provide(BackgroundBashStorage.Live.pipe(Layer.provide(storageLayer))),
        )
        expect(claim._tag).toBe("Terminal")
        if (claim._tag === "Terminal") expect(claim.state.status).toBe("interrupted")
      }).pipe(withProcessTimeout),
    processTestTimeout,
  )

  it.scopedLive(
    "is marked interrupted when its fiber stops, not left running under this process",
    () =>
      Effect.gen(function* () {
        const ctx = { ...stubCtx, toolCallId: ToolCallId.make("tc-stopped-fiber") }
        const directory = yield* makeTempDirectoryScoped("gent-background-bash-")
        const storageLayer = SqliteStorage.LiveWithSql(
          `${directory}/storage.db`,
          Layer.empty,
          {},
        ).pipe(Layer.provide(Layer.merge(BunServices.layer, BunPlatformLive)))
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
          })
        }).pipe(Effect.provide(makeProcessLayer(storageLayer)))
        expect(claim._tag).toBe("Terminal")
        if (claim._tag === "Terminal") expect(claim.state.status).toBe("interrupted")
      }).pipe(withProcessTimeout),
    processTestTimeout,
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

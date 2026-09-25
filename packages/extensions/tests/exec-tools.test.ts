import { describe, expect, it, test } from "effect-bun-test"
import {
  Clock,
  ConfigProvider,
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
  addBackgroundBashColumn,
  BackgroundBashLayer,
  BackgroundBashStorage,
  BackgroundBashStorageError,
  BackgroundBashSupervisorLive,
  BashParams,
  BashTool,
  injectGitTrailers,
  runBashCommand,
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
  runToolWithCtx,
  testToolContext,
  type TestToolContext,
  turnRequestText,
  RuntimeEnvironment,
  SqliteStorage,
} from "@gent/core/test-utils"
import { shippedPreset } from "./helpers/test-preset.js"
import { toolResultSummary } from "@gent/core/extensions/branch-tools"
import { BunChildProcessSpawner, BunFileSystem, BunServices } from "@effect/platform-bun"
import { BunPlatformLive } from "@gent/core/host"
import { ExtensionServiceError, maximumModelToolResultChars } from "@gent/core/extensions/api"
import { e2ePreset } from "./helpers/test-preset"
import { SqlClient } from "effect/unstable/sql"
import { isToolResultFor } from "./helpers/tool-event.js"
import type * as Prompt from "effect/unstable/ai/Prompt"
import * as AiError from "effect/unstable/ai/AiError"

// ── bash command parsing ────────────────────────────────────────────────────

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

  test("a directory word with shell expansion stays in the command for bash", () => {
    for (const command of [
      "cd ~/proj && ls",
      'cd "$HOME/x" && ls',
      "cd $DIR; ls",
      "cd `pwd` && ls",
      "cd src/* && ls",
    ]) {
      expect(Option.isNone(splitCdCommand(command)), command).toBe(true)
    }
  })

  test("cd - stays in the command for bash", () => {
    expect(Option.isNone(splitCdCommand("cd - && ls"))).toBe(true)
  })

  test("a single-quoted directory is literal and still splits", () => {
    expect(splitCdCommand("cd '$x' && ls")).toEqual(Option.some({ cwd: "$x", command: "ls" }))
  })
})

describe("injectGitTrailers", () => {
  const trailer = "--trailer=Session-Id:s1"
  const inject = (command: string) => injectGitTrailers(command, SessionId.make("s1"))

  test("a commit gets the session trailer right after the commit word", () => {
    expect(inject('git commit -m "fix bug"')).toBe(`git commit ${trailer} -m "fix bug"`)
  })

  test("a commit after git global options gets the trailer", () => {
    expect(inject("git -C sub commit -m a")).toBe(`git -C sub commit ${trailer} -m a`)
    expect(inject("git --no-pager commit -m a")).toBe(`git --no-pager commit ${trailer} -m a`)
    expect(inject('git -C "my dir" commit -m a')).toBe(`git -C "my dir" commit ${trailer} -m a`)
  })

  test("a commit that names its own Session-Id trailer keeps it; the other commits get one", () => {
    expect(inject('git commit --trailer "Session-Id: x" -m a && git commit -m b')).toBe(
      `git commit --trailer "Session-Id: x" -m a && git commit ${trailer} -m b`,
    )
    expect(inject("git commit --trailer=session-id:x -m a")).toBe(
      "git commit --trailer=session-id:x -m a",
    )
  })

  test("another trailer, or a message that reads --trailer, keeps the session trailer", () => {
    for (const command of [
      'git commit --trailer "Co-authored-by: X <x@x>" -m a',
      'git commit -m a -m "--trailer"',
      'git commit -m "--trailer=Session-Id: x"',
    ]) {
      expect(inject(command), command).toBe(command.replace("git commit", `git commit ${trailer}`))
    }
  })

  test("a commit found only by name in another command's words gets no trailer", () => {
    for (const command of ["gh issue create --title x git commit -m y", "ls -la git commit -m y"]) {
      expect(inject(command), command).toBe(command)
    }
  })

  test("a commit a runner runs gets the trailer", () => {
    for (const command of [
      "timeout 60 -- git commit -m y",
      "nix develop -c git commit -m y",
      "mise exec -- git commit -m y",
      "pnpm exec git commit -m y",
    ]) {
      expect(inject(command), command).toBe(command.replace("git commit", `git commit ${trailer}`))
    }
  })

  test("a commit in a coproc or a function body gets the trailer", () => {
    expect(inject("coproc git commit -m y")).toBe(`coproc git commit ${trailer} -m y`)
    expect(inject("coproc c { git commit -m y; }")).toBe(`coproc c { git commit ${trailer} -m y; }`)
    expect(inject("function f { git commit -m y; }")).toBe(
      `function f { git commit ${trailer} -m y; }`,
    )
  })

  test("a heredoc with an escaped delimiter gets no trailer in its body", () => {
    const command = "cat <<\\EOF > notes.md\n$(git commit -m x)\nEOF"
    expect(inject(command)).toBe(command)
  })

  test("every commit in a chained command gets the trailer", () => {
    expect(inject("git commit -m a && git commit -m b")).toBe(
      `git commit ${trailer} -m a && git commit ${trailer} -m b`,
    )
    expect(inject("git add a.ts; git commit -m a | cat")).toBe(
      `git add a.ts; git commit ${trailer} -m a | cat`,
    )
  })

  test("a message that mentions git commit is left as written", () => {
    for (const command of [
      'git commit -m "revert git commit abc"',
      "git commit -m 'fix git commit hook'",
      'git commit -m "$(cat <<\'EOF\'\nexplain git commit -m "quoted"\nEOF\n)"',
    ]) {
      const result = inject(command)
      expect(result, command).toBe(command.replace("git commit", `git commit ${trailer}`))
    }
  })

  test("a heredoc body that mentions git commit is left as written", () => {
    const command = "git commit -F - <<EOF\nsee git commit docs\nEOF"
    expect(inject(command)).toBe(`git commit ${trailer} -F - <<EOF\nsee git commit docs\nEOF`)
  })

  test("text that only mentions git commit is not a commit", () => {
    for (const command of [
      "echo 'run git commit later'",
      'git log --grep "git commit"',
      "cat <<EOF\ngit commit -m x\nEOF",
      "ls # git commit -m x",
    ]) {
      expect(inject(command), command).toBe(command)
    }
  })

  test("a commit inside a script a shell runs gets the trailer", () => {
    expect(inject("bash -c 'git commit -m a'")).toBe(`bash -c 'git commit ${trailer} -m a'`)
    expect(inject('echo "$(git commit -m a)"')).toBe(`echo "$(git commit ${trailer} -m a)"`)
  })

  test("a commit in an escaped script word gets no trailer that would split the word", () => {
    for (const command of ["bash -c git\\ commit\\ -m\\ x", 'bash -c "git "commit\\ -m\\ x']) {
      expect(inject(command), command).toBe(command)
    }
    expect(inject("bash -c \"sh -c 'git commit -m x'\"")).toBe(
      `bash -c "sh -c 'git commit ${trailer} -m x'"`,
    )
  })

  test("a commit in a git alias runs with the trailer", () => {
    expect(inject("git -c alias.c='!git commit -m x' c")).toBe(
      `git -c alias.c='!git commit ${trailer} -m x' c`,
    )
  })

  test("a stored git alias and a printed git commit get no trailer", () => {
    for (const command of [
      "git config alias.ci 'commit -v'",
      'git config --global alias.ci "commit"',
      "git config alias.c '!git commit -m x'",
      "echo git commit -m x",
      "echo 'git commit' | grep commit",
    ]) {
      expect(inject(command), command).toBe(command)
    }
  })

  test("a commit that env -S runs gets the trailer", () => {
    expect(inject("env -S git commit -m x")).toBe(`env -S git commit ${trailer} -m x`)
    expect(inject("env -S 'git commit -m x'")).toBe(`env -S 'git commit ${trailer} -m x'`)
  })

  test("an escaped quote in ANSI-C quoting does not hide a later commit", () => {
    expect(inject("git commit -m $'x8\\'s' && git commit -m x9")).toBe(
      `git commit ${trailer} -m $'x8\\'s' && git commit ${trailer} -m x9`,
    )
  })

  test("git push → unchanged", () => {
    const cmd = "git push origin main"
    expect(inject(cmd)).toBe(cmd)
  })

  test("git commit-tree → unchanged", () => {
    const cmd = "git commit-tree abc -m msg"
    expect(inject(cmd)).toBe(cmd)
  })

  test("already has a Session-Id trailer → unchanged", () => {
    const cmd = 'git commit --trailer "Session-Id: bar" -m "msg"'
    expect(inject(cmd)).toBe(cmd)
  })

  it.live("each rewritten commit runs in bash and records the message and trailer", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dir = yield* fs.makeTempDirectoryScoped()
      const git = "git -c user.name=t -c user.email=t@t -c commit.gpgsign=false"
      const script = [
        `git init -q ${dir}/r && cd ${dir}/r`,
        `${git} commit -q --allow-empty -m "revert git commit abc"`,
        `${git} commit -q --allow-empty -m 'fix git commit hook'`,
        `${git} commit -q --allow-empty -F - <<EOF\nsee git commit docs\nEOF`,
        `${git} commit -q --allow-empty -m $'it\\'s done' && ${git} commit -q --allow-empty -m after`,
        `env -S '${git} commit -q --allow-empty -m split'`,
        `env -S ${git} commit -q --allow-empty -m joined`,
        `git log --format=%B%x00`,
      ].join("\n")
      const result = yield* runBashCommand(inject(script), Option.none()).pipe(Effect.scoped)
      expect(result.exitCode, result.stderr).toBe(0)
      const messages = result.stdout
        .split("\0")
        .map((message) => message.trim())
        .filter((message) => message.length > 0)
      expect(messages).toEqual([
        "joined\n\nSession-Id: s1",
        "split\n\nSession-Id: s1",
        "after\n\nSession-Id: s1",
        "it's done\n\nSession-Id: s1",
        "see git commit docs\n\nSession-Id: s1",
        "fix git commit hook\n\nSession-Id: s1",
        "revert git commit abc\n\nSession-Id: s1",
      ])
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.timeout("4 seconds")),
  )
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

// ── bash execution ──────────────────────────────────────────────────────────

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
    "a huge completion notice is bounded and names a file that holds the whole output",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "gent-bg-output-" })
        const text = yield* hugeBackgroundNotice([RuntimeEnvironment.Live({ cwd: "/tmp", home })])

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
        const text = yield* hugeBackgroundNotice([
          RuntimeEnvironment.Live({ cwd: "/tmp", home }),
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
        const saved = yield* fs.readFileString(path.resolve("/tmp", file))
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
        const text = yield* hugeBackgroundNotice([
          RuntimeEnvironment.Live({ cwd: "/tmp", home }),
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

/** The completion notice of a background job whose output is far past the bound. */
const hugeBackgroundNotice = Effect.fn("test.hugeBackgroundNotice")(function* (
  extraLayers: ReadonlyArray<Layer.Layer<never>>,
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
    durableApproval: true,
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
        const storageLayer = SqliteStorage.LiveWithSql(
          `${home}/gent.db`,
          () => Layer.empty,
          {},
        ).pipe(Layer.provide(Layer.merge(BunServices.layer, BunPlatformLive)))
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
        const toolCallId = ToolCallId.make("tc-row-file-replay")
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
        const storageLayer = SqliteStorage.LiveWithSql(
          `${home}/gent.db`,
          () => Layer.empty,
          {},
        ).pipe(Layer.provide(Layer.merge(BunServices.layer, BunPlatformLive)))
        const output = Array.from({ length: 3000 }, (_, index) => `row line ${index + 1}\n`).join(
          "",
        )
        const folder = `${home}/.gent/background-bash/${ctx.sessionId}/${ctx.branchId}`
        const file = `${folder}/${toolCallId}.txt`
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
        ).pipe(Effect.provide(makeProcessLayerWithFailingMarkFailed(storageLayer)))
        expect(result.exitCode).toBe(0)

        const followUp = yield* Effect.exit(Deferred.await(sent).pipe(Effect.timeout("250 millis")))
        expect(followUp._tag).toBe("Failure")
      }).pipe(withProcessTimeout),
    processTestTimeout,
  )

  it.live(
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
          },
        ])
      }).pipe(withProcessTimeout),
    processTestTimeout,
  )

  it.live(
    "another profile building in the same server leaves a running job running",
    () =>
      Effect.gen(function* () {
        const ctx = { ...stubCtx, toolCallId: ToolCallId.make("tc-two-profiles") }
        const millis = yield* Clock.currentTimeMillis
        const storageLayer = SqliteStorage.LiveWithSql(
          `/tmp/gent-background-bash-profiles-${millis}.db`,
          () => Layer.empty,
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
        SqliteStorage.MemoryWithSql(() => Layer.empty, {}).pipe(Layer.provide(BunPlatformLive)),
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
        SqliteStorage.MemoryWithSql(() => Layer.empty, {}).pipe(Layer.provide(BunPlatformLive)),
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
          SqliteStorage.MemoryWithSql(() => Layer.empty, {}).pipe(Layer.provide(BunPlatformLive)),
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

  it.live(
    "a refused completion a later replay delivers is not also kept as a notice",
    () =>
      Effect.gen(function* () {
        const toolCallId = ToolCallId.make("tc-refused-replay")
        const branch = { sessionId: stubCtx.sessionId, branchId: stubCtx.branchId }
        const delivered = yield* Ref.make<ReadonlyArray<string>>([])
        const refusing = yield* Ref.make(true)
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
                  return yield* new ExtensionServiceError({
                    service: "Session",
                    operation: "send",
                    message: "Follow-up queue full (max 10)",
                  })
                }
                yield* Ref.update(delivered, (all) => [...all, notice.sourceId])
              }),
            ),
          },
        )
        const millis = yield* Clock.currentTimeMillis
        const storageLayer = SqliteStorage.LiveWithSql(
          `/tmp/gent-background-bash-refused-replay-${millis}.db`,
          () => Layer.empty,
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
 * process). The existing `bash.test.ts` calls the executor directly via
 * `runToolWithCtx`, which bypasses the scope boundary production uses.
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

describe("background job output", () => {
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
          extraLayers: [RuntimeEnvironment.Live({ cwd: directory, home: directory })],
        })
        const file = `${directory}/.gent/background-bash/${sessionId}/${branchId}/${toolCallId}.txt`
        const baseline = yield* liveBytes
        yield* client.message.send({ sessionId, branchId, content: "start the job" })
        yield* waitFor(fs.exists(produced), (exists) => exists, 20_000, "the job printed")

        // The job printed 96 MiB and still runs; the server holds only its ends.
        const held = (yield* liveBytes) - baseline
        expect(held).toBeLessThan(bytes / 8)

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
        const started = yield* client.session.getSnapshot({ sessionId, branchId })
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

describe("background bash after session deletion", () => {
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
          extraLayers: [RuntimeEnvironment.Live({ cwd: directory, home: directory })],
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
            SqliteStorage.LiveWithSql(storagePath, () => Layer.empty, {}).pipe(
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
          extraLayers: [RuntimeEnvironment.Live({ cwd: directory, home: directory })],
        })
        const printed = Array.from({ length: 1000 }, (_, index) => `${index + 1}\n`).join("")
        const finished = ToolCallId.make("tc-long-row")
        const stopped = ToolCallId.make("tc-stopped-no-file")
        const file = `${directory}/.gent/background-bash/${sessionId}/${branchId}/${finished}.txt`
        yield* fs.makeDirectory(`${directory}/.gent/background-bash/${sessionId}/${branchId}`, {
          recursive: true,
        })
        yield* fs.writeFileString(file, printed)
        const storageLayer = SqliteStorage.LiveWithSql(storagePath, () => Layer.empty, {}).pipe(
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
  it.live(
    "is marked interrupted when its fiber stops, not left running under this process",
    () =>
      Effect.gen(function* () {
        const ctx = { ...stubCtx, toolCallId: ToolCallId.make("tc-stopped-fiber") }
        const millis = yield* Clock.currentTimeMillis
        const storageLayer = SqliteStorage.LiveWithSql(
          `/tmp/gent-background-bash-stopped-${millis}.db`,
          () => Layer.empty,
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
        // Every process has the one home, so a job's file outlives the server that wrote it.
        const sharedHome = RuntimeEnvironment.Live({ cwd: directory, home: directory })
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
              extraLayers: [sharedHome],
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
                extraLayers: [sharedHome],
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
                extraLayers: [sharedHome],
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

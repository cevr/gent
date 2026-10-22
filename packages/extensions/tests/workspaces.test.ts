import { describe, expect, it } from "effect-bun-test"
import {
  Clock,
  Context,
  Crypto,
  DateTime,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Predicate,
  Ref,
  Schema,
  type Scope,
  Stream,
} from "effect"
import { BunServices } from "@effect/platform-bun"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import type * as Prompt from "effect/ai/Prompt"
import { Hex } from "effect/encoding"
import { workspaceIdForCwd } from "@gent/core/host"
import {
  CredentialSlot,
  ExtensionContext,
  getToolId,
  omitUndefined,
  type QuotaReading,
  reportProviderQuota,
  RequestId,
  runProcess,
} from "@gent/core/extensions/api"
import {
  collectTestContributions,
  ConfigService,
  createE2ELayer,
  createRpcClient,
  createRpcHarness,
  CurrentWorkspaceId,
  finishPart,
  LanguageModelLayers,
  makeTempDirectoryScoped,
  runtimeHostContext,
  runToolWithCtx,
  TEST_MODEL_ID,
  testLeafContext,
  testToolContext,
  textDeltaPart,
  toolCallPart,
  UserConfig,
  waitFor,
} from "@gent/core/test-utils"
import { BranchId, Session, SessionId, ToolCallId } from "@gent/core/protocol"
import { SESSION_TOOLS_EXTENSION_ID, SessionToolsExtension } from "../src/session-tools.js"
import { THREAD_ROUND_END_TYPE } from "../src/threads.js"
import {
  makeWorkspacesExtension,
  WORKSPACES_EXTENSION_ID,
  WorkspaceKind,
  type WorkspacePlace,
  Workspaces,
  type WorkspacesOptions,
} from "../src/workspaces.js"
import { e2ePreset } from "./helpers/test-preset"
import { isToolResultFor } from "./helpers/tool-event.js"

// ── fixtures ────────────────────────────────────────────────────────────────

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

/** A rift program that does not exist: a snapshot falls back to a worktree, an explicit rift is refused. */
const NO_RIFT = "/nonexistent/gent-test/rift"

/** One shell command; its trimmed stdout, or a defect that names it. */
const sh = (cwd: string, command: string) =>
  runProcess("sh", ["-c", command], { cwd }).pipe(
    Effect.orDie,
    Effect.flatMap((result) => {
      if (result.exitCode === 0) return Effect.succeed(result.stdout.trim())
      return Effect.die(`${command} exited ${result.exitCode}: ${result.stderr}`)
    }),
  )

/**
 * A repository with one commit, then the parent's uncommitted state: a
 * changed file, a deleted file, an untracked file and an ignored dependency.
 * It lies one level down, so rift's storage beside it stays in the temp
 * directory. `.rift` marks it as a rift workspace, as `rift init` would.
 */
const dirtyRepository = Effect.gen(function* () {
  const root = yield* makeTempDirectoryScoped("ws-origin-")
  yield* sh(
    root,
    [
      "mkdir origin && cd origin",
      "git init -q -b main",
      "git config user.name Test",
      "git config user.email test@example.com",
      "mkdir sub build",
      "printf 'one\\n' > kept.txt",
      "printf 'two\\n' > changed.txt",
      "printf 'three\\n' > deleted.txt",
      "printf 'deep\\n' > sub/deep.txt",
      "printf 'source\\n' > build/source.ts",
      "printf 'node_modules\\n' > .gitignore",
      "git add -A",
      "git commit -qm init",
      "printf 'rift-root\\n' > .rift && printf '/.rift\\n' >> .git/info/exclude",
      "printf 'two parent\\n' > changed.txt",
      "rm deleted.txt",
      "printf 'new\\n' > untracked.txt",
      "mkdir node_modules",
      "printf 'dep\\n' > node_modules/dep.js",
    ].join(" && "),
  )
  return yield* sh(`${root}/origin`, "pwd -P")
})

/** What `git status` and `HEAD` say of a working tree: the parent's view, compared before and after. */
const treeState = (repo: string) =>
  Effect.all({
    status: sh(repo, "git status --porcelain=v1 --untracked-files=all"),
    head: sh(repo, "git rev-parse HEAD"),
    changed: sh(repo, "cat changed.txt"),
  })

const exists = (file: string) =>
  Effect.gen(function* () {
    return yield* (yield* FileSystem.FileSystem).exists(file)
  }).pipe(Effect.orDie)

const worktreeCount = (origin: string) =>
  sh(origin, "git worktree list --porcelain | grep -c '^worktree '")

/**
 * The stub's program: it reads its mode from `mode` beside it, copies under
 * `into` (or `copies/` beside it) and gives the copy its own `.rift` id, as
 * rift does, and appends each request to `requests.log`. A copy without
 * `copyAll` drops `build` and `node_modules`, as rift's filter does. A
 * destination that is there already is refused with `already_exists` and
 * left, as rift does; mode `taken` makes it first, as a racing start would.
 * `ancestors.json` beside it, when there, maps a path to its ancestors.
 */
const RIFT_STUB = [
  "#!/usr/bin/env bun",
  'const fs = require("node:fs")',
  'const { execFileSync } = require("node:child_process")',
  "const dir = import.meta.dir",
  'const mode = fs.readFileSync(dir + "/mode", "utf8")',
  "const input = await Bun.stdin.text()",
  'fs.appendFileSync(dir + "/requests.log", input + "\\n")',
  "const request = JSON.parse(input)",
  "const answer = (value) => process.stdout.write(JSON.stringify(value))",
  'const chains = fs.existsSync(dir + "/ancestors.json") ? JSON.parse(fs.readFileSync(dir + "/ancestors.json", "utf8")) : {}',
  'if (request.command === "ancestors") answer({ status: "ok", value: chains[request.of] ?? [] })',
  'else if (request.command === "create") {',
  '  const into = request.into ?? dir + "/copies"',
  '  const dest = into + "/" + request.name',
  '  if (mode === "taken") {',
  "    fs.mkdirSync(dest, { recursive: true })",
  '    fs.writeFileSync(dest + "/theirs.txt", "theirs\\n")',
  "  }",
  '  if (mode === "cow") {',
  '    answer({ status: "error", error: { code: "cow_unavailable", message: "copy-on-write is not available here" } })',
  "  } else if (fs.existsSync(dest)) {",
  '    answer({ status: "error", error: { code: "already_exists", message: dest + " already exists" } })',
  "  } else {",
  "    fs.mkdirSync(into, { recursive: true })",
  '    execFileSync("cp", ["-a", request.from, dest])',
  '    if (request.copyAll !== true) for (const name of ["build", "node_modules"]) fs.rmSync(dest + "/" + name, { recursive: true, force: true })',
  '    fs.writeFileSync(dest + "/.rift", "rift-" + request.name + "\\n")',
  '    answer({ status: "ok", value: dest })',
  "  }",
  "} else {",
  '  answer({ status: "error", error: { code: "invalid_request", message: "unknown" } })',
  "}",
].join("\n")

/**
 * A stand-in `rift` that answers `rpc` as rift does, with `cp -a` for a
 * copy. `mode` is `ok`, `cow` (no copy-on-write here), or `taken` (another
 * start makes the destination first). `ancestors` maps a path to the rift
 * workspaces it is a copy of; every other path is a source.
 */
const riftStub = (
  mode: "ok" | "cow" | "taken",
  ancestors: Readonly<Record<string, ReadonlyArray<string>>> = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const dir = yield* makeTempDirectoryScoped("ws-rift-")
    const log = `${dir}/requests.log`
    const program = `${dir}/rift`
    yield* fs.writeFileString(`${dir}/mode`, mode)
    yield* fs.writeFileString(`${dir}/ancestors.json`, encodeJson(ancestors))
    yield* fs.writeFileString(program, RIFT_STUB)
    yield* fs.chmod(program, 0o755)
    const requests = fs.readFileString(log).pipe(
      Effect.orElseSucceed(() => ""),
      Effect.flatMap((text) =>
        Effect.forEach(
          text.split("\n").filter((line) => line.length > 0),
          (line) => Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(line),
        ),
      ),
      Effect.orDie,
    )
    return { program, requests }
  })

/**
 * How a system names the file system type: GNU `stat -f -c %T` prints it;
 * BSD `stat` (macOS) has no `-c`, prints the device for `-f %Sd`, and the
 * device's `mount` line names the type.
 */
type FileSystemAnswer = { readonly gnu: string } | { readonly bsd: string }
const BTRFS: FileSystemAnswer = { gnu: "btrfs" }
const EXT4: FileSystemAnswer = { gnu: "ext4" }
const APFS: FileSystemAnswer = { bsd: "apfs" }

const answered = (output: string, exitCode = 0) =>
  ChildProcess.make("sh", ["-c", `printf '%s\\n' "$0"; exit ${exitCode}`, output], {
    forceKillAfter: "1 second",
  })

/** The `stat` and `mount` answers of a system whose file system is `fs`, for `args`. */
const fileSystemProcess = (fs: FileSystemAnswer, command: string, args: ReadonlyArray<string>) => {
  if ("gnu" in fs) return answered(fs.gnu)
  if (command === "stat" && args.includes("-c")) return answered("stat: illegal option -- c", 1)
  if (command === "stat") return answered("disk9s9")
  return answered(`/dev/disk1s1 on / (hfs, local)\n/dev/disk9s9 on /x (${fs.bsd}, local)`)
}

/**
 * The platform with `stat`, `mount` and `df` answered, where a test needs a
 * file system this machine may not have (btrfs, ext4, APFS as macOS names
 * it), or one whose free space is unknown. Every other process runs.
 */
const platformWith = (answers: {
  readonly fs?: FileSystemAnswer
  readonly noFreeSpace?: boolean
}) =>
  Layer.effect(
    ChildProcessSpawner.ChildProcessSpawner,
    Effect.gen(function* () {
      const real = yield* ChildProcessSpawner.ChildProcessSpawner
      return ChildProcessSpawner.make((command) => {
        if (
          command._tag === "StandardCommand" &&
          (command.command === "stat" || command.command === "mount") &&
          Predicate.isNotUndefined(answers.fs)
        ) {
          return real.spawn(fileSystemProcess(answers.fs, command.command, command.args))
        }
        if (command._tag === "StandardCommand" && command.command === "df" && answers.noFreeSpace) {
          return real.spawn(
            ChildProcess.make("sh", ["-c", "echo 'df: no answer' >&2; exit 1"], {
              forceKillAfter: "1 second",
            }),
          )
        }
        return real.spawn(command)
      })
    }),
  ).pipe(Layer.provide(BunServices.layer))

interface Parent {
  readonly sessionId: SessionId
  readonly branchId: BranchId
}
const parentA: Parent = { sessionId: SessionId.make("parent-a"), branchId: BranchId.make("main-a") }
const parentB: Parent = { sessionId: SessionId.make("parent-b"), branchId: BranchId.make("main-a") }

const key = (id: string) => RequestId.make(id)
const SNAPSHOT = WorkspaceKind.cases.Snapshot.make({})
const riftKind = (name: string, from?: string) =>
  WorkspaceKind.cases.Rift.make({ name, ...omitUndefined({ from }) })
const childSession = SessionId.make("child-session")

/**
 * The installed `@gent/workspaces` extension: its places resource as the
 * host builds it, and its hooks, run in a leaf whose home is `home` and
 * whose session is `parent`.
 */
const installed = (home: string, options: WorkspacesOptions) =>
  Effect.gen(function* () {
    const contributions = yield* collectTestContributions(makeWorkspacesExtension(options).setup)
    const resource = contributions.resources?.find(
      (found) => found.id === "@gent/workspaces/places",
    )
    const deletedSlot = (contributions.hooks ?? []).find(
      (slot): slot is Extract<typeof slot, { readonly kind: "sessionDeleted" }> =>
        slot.kind === "sessionDeleted",
    )
    if (Predicate.isUndefined(resource) || Predicate.isUndefined(deletedSlot)) {
      return yield* Effect.die("the workspaces extension registers no places or no sessionDeleted")
    }
    const build: Effect.Effect<Context.Context<Workspaces>, never, Scope.Scope> = Layer.build(
      resource.layer,
    ).pipe(Effect.orDie)
    const services = yield* build
    const places = Context.get(services, Workspaces)
    const session = testToolContext().Session
    const as =
      (parent: Parent) =>
      <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(
          Effect.provideService(
            ExtensionContext,
            testLeafContext(
              testToolContext({
                cwd: home,
                home,
                sessionId: parent.sessionId,
                branchId: parent.branchId,
                Session: session,
              }),
            ),
          ),
        )
    const within = as(parentA)
    /** The place `workspace` asks for, from `cwd` for the call `id`, as a thread start makes one. */
    const place = (
      id: string,
      cwd: string,
      workspace: WorkspaceKind = SNAPSHOT,
      parent: Parent = parentA,
    ) =>
      as(parent)(
        places.locate({ key: key(id), cwd, workspace }).pipe(Effect.flatMap(places.acquire)),
      )
    /** A snapshot start from `cwd` for the call `id`: a copy. */
    const start = (id: string, cwd: string, parent: Parent = parentA) =>
      place(id, cwd, SNAPSHOT, parent).pipe(
        Effect.filterOrElse(
          (found): found is Extract<WorkspacePlace, { readonly _tag: "Copy" }> =>
            found._tag === "Copy",
          () => Effect.die("a snapshot is not a copy"),
        ),
      )
    /** The session delete of `sessionId`, as the host runs the hook. */
    const deleted = (sessionId: SessionId) =>
      within(deletedSlot.hook.handler({ sessionId, branchIds: [] })).pipe(
        Effect.provideContext(services),
      )
    const recordFile = (name: string) => `${home}/.gent/workspaces/${name}.json`
    return { places, within, place, start, deleted, recordFile }
  })

const RecordJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown))

/**
 * Rewrites the record on disk as a crash or a hand edit leaves it: `set`
 * replaces fields, `drop` removes them.
 */
const editRecord = (
  file: string,
  edit: { readonly set?: Readonly<Record<string, string>>; readonly drop?: ReadonlyArray<string> },
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const record = yield* Schema.decodeEffect(RecordJson)(yield* fs.readFileString(file))
    const kept = Object.entries(record).filter(([field]) => !(edit.drop ?? []).includes(field))
    const next = { ...Object.fromEntries(kept), ...edit.set }
    yield* fs.writeFileString(file, yield* Schema.encodeEffect(RecordJson)(next))
  }).pipe(Effect.orDie)

/** The record on disk, as JSON. */
const recordOf = (file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    return yield* Schema.decodeEffect(RecordJson)(yield* fs.readFileString(file))
  }).pipe(Effect.orDie)

const live = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.timeout("20 seconds"))

// ── the worktree copy ───────────────────────────────────────────────────────

describe("a worktree copy", () => {
  it.live(
    "holds the parent's working tree, at the parent's place, and leaves the parent as it was",
    () =>
      live(
        Effect.gen(function* () {
          const origin = yield* dirtyRepository
          const home = yield* makeTempDirectoryScoped("ws-home-")
          const before = yield* treeState(origin)
          const { start } = yield* installed(home, { rift: NO_RIFT })
          const place = yield* start("call-1", `${origin}/sub`)
          expect(place.backend).toBe("worktree")
          expect(place.notes[0]).toContain("a git worktree, because")
          expect(place.cwd).toBe(`${place.path}/sub`)
          expect(place.branch).toBe(`gent/${place.name}`)
          expect(yield* sh(place.path, "cat changed.txt")).toBe("two parent")
          expect(yield* sh(place.path, "cat untracked.txt")).toBe("new")
          expect(yield* sh(place.path, "cat build/source.ts")).toBe("source")
          expect(yield* exists(`${place.path}/deleted.txt`)).toBe(false)
          // An ignored dependency is not part of the working tree git keeps.
          expect(yield* exists(`${place.path}/node_modules`)).toBe(false)
          // The changes arrive unstaged, as the parent has them.
          expect(yield* sh(place.path, "git status --porcelain=v1 --untracked-files=all")).toBe(
            before.status.replace("?? node_modules/dep.js\n", ""),
          )
          expect(yield* treeState(origin)).toEqual(before)
        }),
      ),
  )

  it.live(
    "a repeated start adopts its copy; another call, or the same call from another parent, gets its own",
    () =>
      live(
        Effect.gen(function* () {
          const origin = yield* dirtyRepository
          const home = yield* makeTempDirectoryScoped("ws-home-")
          const { start } = yield* installed(home, { rift: NO_RIFT })
          const first = yield* start("call-1", origin)
          yield* sh(first.path, "printf 'mid\\n' > mid-turn.txt")
          const again = yield* start("call-1", origin)
          expect(again.path).toBe(first.path)
          expect(yield* sh(again.path, "cat mid-turn.txt")).toBe("mid")
          const other = yield* start("call-2", origin)
          expect(other.path).not.toBe(first.path)
          // A provider can repeat a call id in another session: that is another start.
          const elsewhere = yield* start("call-1", origin, parentB)
          expect(elsewhere.path).not.toBe(first.path)
          expect(yield* exists(`${elsewhere.path}/mid-turn.txt`)).toBe(false)
          expect(yield* worktreeCount(origin)).toBe("4")
        }),
      ),
  )

  it.live(
    "runs the .rift.toml postcreate hooks in the copy, in either form rift reads, and their output is not the child's work",
    () =>
      live(
        Effect.gen(function* () {
          const origin = yield* dirtyRepository
          yield* sh(
            origin,
            [
              'printf \'version = 1\\n[hooks]\\npostcreate = [{ run = "printf %%s \\\\"$RIFT_SOURCE\\\\" > from-hook.txt" }]\\n\' > .rift.toml',
              "git add .rift.toml",
              "git commit -qm hooks",
            ].join(" && "),
          )
          const home = yield* makeTempDirectoryScoped("ws-home-")
          const { places, within, start } = yield* installed(home, { rift: NO_RIFT })
          const place = yield* start("call-1", origin)
          expect(yield* sh(place.path, "cat from-hook.txt")).toBe(origin)
          // The base is the copy after its hooks: the hook's file is no work of the child.
          yield* within(places.bind(place.name, childSession))
          const work = yield* within(places.collect(childSession))
          expect(Option.map(work, (found) => found.files)).toEqual(Option.some(0))
          expect(yield* sh(origin, "git branch --list 'gent/*'")).toBe("")
        }),
      ),
  )

  it.live("a .rift.toml rift would refuse runs no hook, and the start says why", () =>
    live(
      Effect.gen(function* () {
        const origin = yield* dirtyRepository
        yield* sh(
          origin,
          [
            'printf \'version = 1\\n[[hooks.postcreate]]\\nrun = "touch ran"\\nshell = "bash"\\n\' > .rift.toml',
            "git add .rift.toml",
            "git commit -qm hooks",
          ].join(" && "),
        )
        const home = yield* makeTempDirectoryScoped("ws-home-")
        const { start } = yield* installed(home, { rift: NO_RIFT })
        const place = yield* start("call-1", origin)
        expect(yield* exists(`${place.path}/ran`)).toBe(false)
        expect(place.notes.join("\n")).toContain(".rift.toml is not valid")
      }),
    ),
  )

  it.live(
    "a .rift.toml whose version is not a TOML integer runs no hook, and the start says why",
    () =>
      live(
        Effect.gen(function* () {
          const origin = yield* dirtyRepository
          const home = yield* makeTempDirectoryScoped("ws-home-")
          const { start } = yield* installed(home, { rift: NO_RIFT })
          // rift reads `version` as a u32: a float or a string is refused, whatever its value.
          for (const [id, version] of [
            ["call-float", "1.0"],
            ["call-exponent", "1e0"],
            ["call-string", '"1"'],
          ] as const) {
            yield* sh(
              origin,
              `printf 'version = ${version}\\n[[hooks.postcreate]]\\nrun = "touch ran"\\n' > .rift.toml`,
            )
            const place = yield* start(id, origin)
            expect(yield* exists(`${place.path}/ran`)).toBe(false)
            expect(place.notes.join("\n")).toContain(".rift.toml is not valid")
          }
          yield* sh(
            origin,
            `printf 'version = 1\\n[[hooks.postcreate]]\\nrun = "touch ran"\\n' > .rift.toml`,
          )
          const integer = yield* start("call-integer", origin)
          expect(yield* exists(`${integer.path}/ran`)).toBe(true)
        }),
      ),
  )

  it.live(
    "refuses a directory outside git, a file system short of space, and one whose space is unknown",
    () =>
      live(
        Effect.gen(function* () {
          const plain = yield* makeTempDirectoryScoped("ws-plain-")
          const origin = yield* dirtyRepository
          const home = yield* makeTempDirectoryScoped("ws-home-")
          const roomy = yield* installed(home, { rift: NO_RIFT })
          const outside = yield* roomy.start("call-1", plain).pipe(Effect.flip)
          expect(outside.message).toContain("needs a git repository")
          const full = yield* installed(home, {
            rift: NO_RIFT,
            minimumFreeBytes: Number.MAX_SAFE_INTEGER,
          })
          const refused = yield* full.start("call-1", origin).pipe(Effect.flip)
          expect(refused.message).toContain("a snapshot thread needs")
          expect(refused.message).toContain("start the thread without a snapshot workspace")
          const unknown = yield* roomy
            .start("call-2", origin)
            .pipe(Effect.flip, Effect.provide(platformWith({ noFreeSpace: true })))
          expect(unknown.message).toContain("cannot tell how much space is free")
          expect(yield* worktreeCount(origin)).toBe("1")
        }),
      ),
  )

  it.live("an interrupted making stops at once, and a release removes what it made", () =>
    live(
      Effect.gen(function* () {
        const origin = yield* dirtyRepository
        yield* sh(
          origin,
          [
            "printf 'version = 1\\n[[hooks.postcreate]]\\nrun = \"touch started && exec sleep 30\"\\n' > .rift.toml",
            "git add .rift.toml",
            "git commit -qm hooks",
          ].join(" && "),
        )
        const home = yield* makeTempDirectoryScoped("ws-home-")
        const { places, within } = yield* installed(home, { rift: NO_RIFT })
        const start = yield* within(
          places.locate({ key: key("call-1"), cwd: origin, workspace: SNAPSHOT }),
        )
        const making = yield* within(places.acquire(start)).pipe(Effect.forkScoped)
        const copy = `${home}/.gent/workspaces/worktrees/${start.name}`
        yield* waitFor(exists(`${copy}/started`), (found) => found, 10_000, "the hook started")
        yield* Fiber.interrupt(making).pipe(Effect.timeout("5 seconds"))
        yield* within(places.release(start.name))
        expect(yield* exists(copy)).toBe(false)
        expect(yield* worktreeCount(origin)).toBe("1")
      }),
    ),
  )
})

// ── collect and release ─────────────────────────────────────────────────────

describe("a copy's work", () => {
  it.live("comes back as one commit over the copy as it started, and the parent's tree stays", () =>
    live(
      Effect.gen(function* () {
        const origin = yield* dirtyRepository
        const home = yield* makeTempDirectoryScoped("ws-home-")
        const before = yield* treeState(origin)
        const { places, within, start } = yield* installed(home, { rift: NO_RIFT })
        const place = yield* start("call-1", origin)
        yield* within(places.bind(place.name, childSession))
        yield* sh(
          place.path,
          "printf 'two child\\n' > changed.txt && printf 'child\\n' > child.txt",
        )
        const work = yield* within(places.collect(childSession))
        expect(Option.map(work, (found) => found.branch)).toEqual(Option.some(place.branch))
        expect(
          Option.map(work, (found) => [found.files, found.insertions, found.deletions]),
        ).toEqual(Option.some([2, 2, 1]))
        // Only the child's own changes: the parent's uncommitted state is in the base.
        expect(yield* sh(origin, `git show --name-only --format= ${place.branch}`)).toBe(
          "changed.txt\nchild.txt",
        )
        expect(yield* sh(origin, `git show ${place.branch}:changed.txt`)).toBe("two child")
        expect(yield* sh(origin, `git show ${place.branch}^:changed.txt`)).toBe("two parent")
        expect(yield* sh(origin, `git rev-parse ${place.branch}^^`)).toBe(before.head)
        expect(yield* treeState(origin)).toEqual(before)
        // The same work is the same commit.
        const commit = yield* sh(origin, `git rev-parse ${place.branch}`)
        yield* within(places.collect(childSession))
        expect(yield* sh(origin, `git rev-parse ${place.branch}`)).toBe(commit)
        // A copy put back as it started holds no work, and gent's branch goes.
        yield* sh(place.path, "printf 'two parent\\n' > changed.txt && rm child.txt")
        const none = yield* within(places.collect(childSession))
        expect(Option.map(none, (found) => Predicate.isUndefined(found.branch))).toEqual(
          Option.some(true),
        )
        expect(yield* sh(origin, "git branch --list 'gent/*'")).toBe("")
      }),
    ),
  )

  it.live("a branch someone else moved stays where they put it, and the copy stays", () =>
    live(
      Effect.gen(function* () {
        const origin = yield* dirtyRepository
        const home = yield* makeTempDirectoryScoped("ws-home-")
        const { places, within, start, deleted } = yield* installed(home, { rift: NO_RIFT })
        const place = yield* start("call-1", origin)
        yield* within(places.bind(place.name, childSession))
        yield* sh(place.path, "printf 'child\\n' > child.txt")
        yield* within(places.collect(childSession))
        // The owner points the branch at their own commit.
        yield* sh(origin, `git branch -f ${place.branch} HEAD`)
        const theirs = yield* sh(origin, "git rev-parse HEAD")
        yield* sh(place.path, "printf 'more\\n' > more.txt")
        const work = yield* within(places.collect(childSession))
        expect(Option.flatMap(work, (found) => Option.fromUndefinedOr(found.problem))).toEqual(
          Option.some(
            `${place.branch} was moved since gent last wrote it; gent left it, and the work stays in the copy`,
          ),
        )
        expect(yield* sh(origin, `git rev-parse ${place.branch}`)).toBe(theirs)
        yield* deleted(childSession)
        expect(yield* exists(`${place.path}/more.txt`)).toBe(true)
        expect(yield* sh(origin, `git rev-parse ${place.branch}`)).toBe(theirs)
      }),
    ),
  )

  it.live("a branch a worktree has checked out stays as it is", () =>
    live(
      Effect.gen(function* () {
        const origin = yield* dirtyRepository
        const home = yield* makeTempDirectoryScoped("ws-home-")
        const elsewhere = yield* makeTempDirectoryScoped("ws-elsewhere-")
        const { places, within, start } = yield* installed(home, { rift: NO_RIFT })
        const place = yield* start("call-1", origin)
        yield* within(places.bind(place.name, childSession))
        yield* sh(place.path, "printf 'child\\n' > child.txt")
        yield* within(places.collect(childSession))
        const written = yield* sh(origin, `git rev-parse ${place.branch}`)
        yield* sh(origin, `git worktree add -q ${elsewhere}/checkout ${place.branch}`)
        yield* sh(place.path, "printf 'more\\n' > more.txt")
        const work = yield* within(places.collect(childSession))
        expect(
          Option.exists(work, (found) => found.problem?.includes("is checked out in") === true),
        ).toBe(true)
        expect(yield* sh(origin, `git rev-parse ${place.branch}`)).toBe(written)
        expect(yield* sh(`${elsewhere}/checkout`, "git status --porcelain")).toBe("")
      }),
    ),
  )

  it.live("a release whose collect fails keeps the copy and its record", () =>
    live(
      Effect.gen(function* () {
        const origin = yield* dirtyRepository
        const home = yield* makeTempDirectoryScoped("ws-home-")
        const { places, within, start, deleted, recordFile } = yield* installed(home, {
          rift: NO_RIFT,
        })
        const place = yield* start("call-1", origin)
        yield* within(places.bind(place.name, childSession))
        yield* sh(place.path, "printf 'late\\n' > late.txt")
        // Another git process holds the branch's lock: the collect cannot write it.
        const lock = `${origin}/.git/refs/heads/${place.branch}.lock`
        yield* sh(origin, `mkdir -p "$(dirname ${lock})" && touch ${lock}`)
        yield* deleted(childSession)
        expect(yield* exists(`${place.path}/late.txt`)).toBe(true)
        expect(yield* exists(recordFile(place.name))).toBe(true)
        // Once the lock goes, the delete's release brings the late work back and removes the copy.
        yield* sh(origin, `rm ${lock}`)
        yield* deleted(childSession)
        expect(yield* exists(place.path)).toBe(false)
        expect(yield* sh(origin, `git show ${place.branch}:late.txt`)).toBe("late")
      }),
    ),
  )

  it.live("a released copy is gone, and its branch stays", () =>
    live(
      Effect.gen(function* () {
        const origin = yield* dirtyRepository
        const home = yield* makeTempDirectoryScoped("ws-home-")
        const { places, within, start, deleted } = yield* installed(home, { rift: NO_RIFT })
        const place = yield* start("call-1", origin)
        yield* within(places.bind(place.name, childSession))
        // Work after the last collect still reaches the branch: the release collects first.
        yield* sh(place.path, "printf 'late\\n' > late.txt")
        yield* deleted(childSession)
        expect(yield* exists(place.path)).toBe(false)
        expect(yield* within(places.find(childSession))).toEqual(Option.none())
        expect(yield* sh(origin, `git show ${place.branch}:late.txt`)).toBe("late")
        expect(yield* worktreeCount(origin)).toBe("1")
        expect(yield* sh(origin, "git for-each-ref refs/gent")).toBe("")
      }),
    ),
  )
})

// ── records gent cannot prove ───────────────────────────────────────────────

describe("a record gent cannot prove", () => {
  it.live("that points at the origin never removes the origin", () =>
    live(
      Effect.gen(function* () {
        const origin = yield* dirtyRepository
        const home = yield* makeTempDirectoryScoped("ws-home-")
        const before = yield* treeState(origin)
        const { places, within, start, deleted, recordFile } = yield* installed(home, {
          rift: NO_RIFT,
        })
        const place = yield* start("call-1", origin)
        yield* within(places.bind(place.name, childSession))
        yield* editRecord(recordFile(place.name), { set: { path: origin } })
        yield* deleted(childSession)
        expect(yield* exists(`${origin}/kept.txt`)).toBe(true)
        expect(yield* treeState(origin)).toEqual(before)
        expect(yield* exists(recordFile(place.name))).toBe(true)
      }),
    ),
  )

  it.live("whose worktree names another git directory is kept, and so is that directory", () =>
    live(
      Effect.gen(function* () {
        const origin = yield* dirtyRepository
        const home = yield* makeTempDirectoryScoped("ws-home-")
        const before = yield* treeState(origin)
        const { places, within, start, deleted, recordFile } = yield* installed(home, {
          rift: NO_RIFT,
        })
        const place = yield* start("call-1", origin)
        yield* within(places.bind(place.name, childSession))
        // The copy's `.git` now names the origin's own git directory.
        yield* sh(place.path, `printf 'gitdir: ${origin}/.git\\n' > .git`)
        const refused = yield* within(places.collect(childSession)).pipe(Effect.flip)
        expect(refused.message).toContain("not one of the origin's worktrees")
        yield* deleted(childSession)
        expect(yield* exists(place.path)).toBe(true)
        expect(yield* exists(recordFile(place.name))).toBe(true)
        expect(yield* exists(`${origin}/.git/gent-workspace`)).toBe(false)
        expect(yield* treeState(origin)).toEqual(before)
      }),
    ),
  )

  it.live("left creating with nothing at its path makes the copy again", () =>
    live(
      Effect.gen(function* () {
        const origin = yield* dirtyRepository
        const home = yield* makeTempDirectoryScoped("ws-home-")
        const { start, recordFile } = yield* installed(home, { rift: NO_RIFT })
        const place = yield* start("call-1", origin)
        // A crash after the base ref was made: the record holds the base, the ref names it.
        yield* sh(origin, `git worktree remove --force ${place.path}`)
        yield* editRecord(recordFile(place.name), { set: { phase: "creating" } })
        const again = yield* start("call-1", origin)
        expect(again.path).toBe(place.path)
        expect(yield* sh(again.path, "cat changed.txt")).toBe("two parent")
        expect(yield* recordOf(recordFile(place.name))).toMatchObject({ phase: "ready" })
      }),
    ),
  )

  it.live("left creating with its marked copy removes that copy and makes it again", () =>
    live(
      Effect.gen(function* () {
        const origin = yield* dirtyRepository
        const home = yield* makeTempDirectoryScoped("ws-home-")
        const { start, recordFile } = yield* installed(home, { rift: NO_RIFT })
        const place = yield* start("call-1", origin)
        // A crash while the hooks ran: the copy is marked, the record still says creating.
        yield* sh(place.path, "printf 'half\\n' > half-made.txt")
        yield* editRecord(recordFile(place.name), { set: { phase: "creating" } })
        const again = yield* start("call-1", origin)
        expect(again.path).toBe(place.path)
        expect(yield* exists(`${again.path}/half-made.txt`)).toBe(false)
        expect(yield* worktreeCount(origin)).toBe("2")
      }),
    ),
  )

  it.live(
    "left creating with an unmarked directory keeps the directory and refuses the start",
    () =>
      live(
        Effect.gen(function* () {
          const origin = yield* dirtyRepository
          const home = yield* makeTempDirectoryScoped("ws-home-")
          const { places, within, start, recordFile } = yield* installed(home, { rift: NO_RIFT })
          const place = yield* start("call-1", origin)
          yield* sh(
            place.path,
            "printf 'mine\\n' > mine.txt && rm \"$(git rev-parse --absolute-git-dir)/gent-workspace\"",
          )
          yield* editRecord(recordFile(place.name), { set: { phase: "creating" } })
          const refused = yield* start("call-1", origin).pipe(Effect.flip)
          expect(refused.message).toContain("gent keeps")
          const kept = yield* within(places.release(place.name)).pipe(Effect.flip)
          expect(kept.message).toContain("it holds no marker of this start")
          expect(yield* sh(place.path, "cat mine.txt")).toBe("mine")
        }),
      ),
  )

  it.live(
    "a base ref that already exists, or that someone moved, is left alone, and the copy stays",
    () =>
      live(
        Effect.gen(function* () {
          const origin = yield* dirtyRepository
          const home = yield* makeTempDirectoryScoped("ws-home-")
          const { places, within, start, deleted, recordFile } = yield* installed(home, {
            rift: NO_RIFT,
          })
          const head = yield* sh(origin, "git rev-parse HEAD")
          // Someone holds the base ref's name before the start.
          const taken = yield* within(
            places.locate({ key: key("call-1"), cwd: origin, workspace: SNAPSHOT }),
          )
          yield* sh(origin, `git update-ref refs/gent/base/${taken.name} HEAD`)
          const refused = yield* start("call-1", origin).pipe(Effect.flip)
          expect(refused.message).toContain(`refs/gent/base/${taken.name}`)
          expect(yield* sh(origin, `git rev-parse refs/gent/base/${taken.name}`)).toBe(head)
          expect(yield* recordOf(recordFile(taken.name))).toMatchObject({ phase: "retained" })
          yield* within(places.release(taken.name))
          expect(yield* exists(`${home}/.gent/workspaces/worktrees/${taken.name}`)).toBe(true)
          expect(yield* sh(origin, `git rev-parse refs/gent/base/${taken.name}`)).toBe(head)
          // Someone moves the base ref of a live copy: its release keeps the copy and the ref.
          const place = yield* start("call-2", origin)
          yield* within(places.bind(place.name, childSession))
          yield* sh(origin, `git update-ref refs/gent/base/${place.name} HEAD`)
          yield* deleted(childSession)
          expect(yield* exists(place.path)).toBe(true)
          expect(yield* exists(recordFile(place.name))).toBe(true)
          expect(yield* sh(origin, `git rev-parse refs/gent/base/${place.name}`)).toBe(head)
        }),
      ),
  )

  it.live("a session bound to one copy is not bound to another", () =>
    live(
      Effect.gen(function* () {
        const origin = yield* dirtyRepository
        const home = yield* makeTempDirectoryScoped("ws-home-")
        const { places, within, start } = yield* installed(home, { rift: NO_RIFT })
        const first = yield* start("call-1", origin)
        const second = yield* start("call-2", origin)
        yield* within(places.bind(first.name, childSession))
        const refused = yield* within(places.bind(second.name, childSession)).pipe(Effect.flip)
        expect(refused.message).toContain(first.name)
        expect(Option.map(yield* within(places.find(childSession)), (found) => found.path)).toEqual(
          Option.some(first.path),
        )
      }),
    ),
  )

  it.live("bound to one child is not bound to another", () =>
    live(
      Effect.gen(function* () {
        const origin = yield* dirtyRepository
        const home = yield* makeTempDirectoryScoped("ws-home-")
        const { places, within, start } = yield* installed(home, { rift: NO_RIFT })
        const place = yield* start("call-1", origin)
        yield* within(places.bind(place.name, childSession))
        const other = SessionId.make("other-child")
        const refused = yield* within(places.bind(place.name, other)).pipe(Effect.flip)
        expect(refused.message).toContain("belongs to session child-session")
        expect(Option.map(yield* within(places.find(childSession)), (found) => found.path)).toEqual(
          Option.some(place.path),
        )
        expect(yield* within(places.find(other))).toEqual(Option.none())
      }),
    ),
  )
})

// ── the rift copy ───────────────────────────────────────────────────────────

/** Where rift puts the copies of the rift workspace `origin`: `.rifts/<name>` beside it. */
const storageOf = (origin: string) =>
  `${origin.slice(0, origin.lastIndexOf("/"))}/.rifts/${origin.slice(origin.lastIndexOf("/") + 1)}`

/** The `create` requests a rift stub was sent. */
const createsOf = (requests: ReadonlyArray<unknown>) =>
  requests.filter(
    (request) => Predicate.hasProperty(request, "command") && request.command === "create",
  )

describe("a rift copy", () => {
  it.live(
    "is one whole-tree copy on btrfs, made without rift's hooks; its work is fetched into no ref, and the copy stays after its session",
    () =>
      live(
        Effect.gen(function* () {
          const origin = yield* dirtyRepository
          const home = yield* makeTempDirectoryScoped("ws-home-")
          const rift = yield* riftStub("ok")
          const before = yield* treeState(origin)
          const { places, within, start, deleted, recordFile } = yield* installed(home, {
            rift: rift.program,
          })
          const place = yield* start("call-1", origin)
          const storage = `${origin.slice(0, origin.lastIndexOf("/"))}/.rifts/origin`
          expect(place.backend).toBe("rift")
          expect(place.path).toBe(`${storage}/${place.name}`)
          expect(place.notes).toEqual([])
          expect(yield* exists(`${place.path}/node_modules/dep.js`)).toBe(true)
          expect(yield* rift.requests).toEqual([
            { command: "ancestors", of: origin },
            {
              command: "create",
              from: origin,
              name: place.name,
              into: storage,
              copyAll: true,
              hooks: false,
            },
          ])
          yield* within(places.bind(place.name, childSession))
          yield* sh(place.path, "printf 'child\\n' > child.txt")
          const work = yield* within(places.collect(childSession))
          expect(Option.map(work, (found) => found.branch)).toEqual(Option.some(place.branch))
          expect(yield* sh(origin, `git show ${place.branch}:child.txt`)).toBe("child")
          expect(yield* sh(origin, `git show --name-only --format= ${place.branch}`)).toBe(
            "child.txt",
          )
          // The fetch wrote no ref of the origin but the branch, and no FETCH_HEAD.
          expect(yield* sh(origin, "git for-each-ref --format='%(refname)'")).toBe(
            `refs/heads/${place.branch}\nrefs/heads/main`,
          )
          expect(yield* exists(`${origin}/.git/FETCH_HEAD`)).toBe(false)
          expect(yield* treeState(origin)).toEqual(before)
          // The session goes; its last work is collected, and the copy stays, retained.
          yield* sh(place.path, "printf 'late\\n' > late.txt")
          yield* deleted(childSession)
          expect(yield* sh(origin, `git show ${place.branch}:late.txt`)).toBe("late")
          expect(yield* exists(`${place.path}/late.txt`)).toBe(true)
          expect(yield* recordOf(recordFile(place.name))).toMatchObject({
            phase: "retained",
            retained: "rift removal cannot refuse a copy with descendants atomically",
          })
          expect(Predicate.hasProperty(yield* recordOf(recordFile(place.name)), "sessionId")).toBe(
            true,
          )
          expect(yield* within(places.find(childSession))).toEqual(Option.none())
          // gent never asks rift to remove a copy.
          expect(
            (yield* rift.requests).filter(
              (request) =>
                !Predicate.hasProperty(request, "command") ||
                (request.command !== "ancestors" && request.command !== "create"),
            ),
          ).toEqual([])
          // A repeated start does not adopt a retained copy.
          const refused = yield* start("call-1", origin).pipe(Effect.flip)
          expect(refused.message).toContain("retained")
        }).pipe(Effect.provide(platformWith({ fs: BTRFS }))),
      ),
  )

  it.live(
    "whose marker path or git directory is a link is refused, and the file behind the link stays",
    () =>
      live(
        Effect.gen(function* () {
          const outside = yield* makeTempDirectoryScoped("ws-outside-")
          yield* sh(outside, "printf 'valuable\\n' > valuable.txt")
          const home = yield* makeTempDirectoryScoped("ws-home-")
          const rift = yield* riftStub("ok")
          const { places, within, start, recordFile } = yield* installed(home, {
            rift: rift.program,
          })
          // A link at the marker's place in the origin: copyAll copies the link.
          const linked = yield* dirtyRepository
          yield* sh(linked, `ln -s ${outside}/valuable.txt .git/gent-workspace`)
          const atMarker = yield* start("call-1", linked).pipe(Effect.flip)
          expect(atMarker.message).toContain("gent keeps")
          expect(yield* sh(outside, "cat valuable.txt")).toBe("valuable")
          // A link for the git directory: the copy's `.git` names the origin's real one.
          const moved = yield* dirtyRepository
          yield* sh(moved, `mv .git ${outside}/real.git && ln -s ${outside}/real.git .git`)
          const atGitDir = yield* start("call-2", moved).pipe(Effect.flip)
          expect(atGitDir.message).toContain("gent keeps")
          expect(yield* exists(`${outside}/real.git/gent-workspace`)).toBe(false)
          // Both copies stay, retained: gent never removes a rift copy.
          for (const [id, origin] of [
            ["call-1", linked],
            ["call-2", moved],
          ] as const) {
            const located = yield* within(
              places.locate({ key: key(id), cwd: origin, workspace: SNAPSHOT }),
            )
            expect(yield* recordOf(recordFile(located.name))).toMatchObject({ phase: "retained" })
            yield* within(places.release(located.name))
            expect(yield* exists(recordFile(located.name))).toBe(true)
          }
        }).pipe(Effect.provide(platformWith({ fs: BTRFS }))),
      ),
  )

  it.live("a second copy that inherits the marker is not adopted, collected or removed", () =>
    live(
      Effect.gen(function* () {
        const origin = yield* dirtyRepository
        const home = yield* makeTempDirectoryScoped("ws-home-")
        const elsewhere = yield* sh(yield* makeTempDirectoryScoped("ws-elsewhere-"), "pwd -P")
        const rift = yield* riftStub("ok")
        const { places, within, start, deleted, recordFile } = yield* installed(home, {
          rift: rift.program,
        })
        const place = yield* start("call-1", origin)
        yield* within(places.bind(place.name, childSession))
        // A copy of the copy, with the same name, the marker and the rift id in it.
        const second = `${elsewhere}/${place.name}`
        yield* sh(
          elsewhere,
          `cp -a ${place.path} ${second} && printf 'second\\n' > ${second}/second.txt`,
        )
        // The record names it by path and cwd: it is not in the directory the record names.
        yield* editRecord(recordFile(place.name), { set: { path: second, cwd: second } })
        const outside = yield* within(places.collect(childSession)).pipe(Effect.flip)
        expect(outside.message).toContain("not in the directory its record names")
        // The record names its directory too: the marker holds the first copy's real path.
        yield* editRecord(recordFile(place.name), { set: { root: elsewhere } })
        const collected = yield* within(places.collect(childSession)).pipe(Effect.flip)
        expect(collected.message).toContain("it holds no marker of this start")
        const adopted = yield* start("call-1", origin).pipe(Effect.flip)
        expect(adopted.message).toContain("gent keeps")
        yield* deleted(childSession)
        expect(yield* sh(second, "cat second.txt")).toBe("second")
        expect(yield* exists(place.path)).toBe(true)
        expect(yield* recordOf(recordFile(place.name))).toMatchObject({
          phase: "ready",
          path: second,
        })
        expect(yield* sh(origin, "git branch --list 'gent/*'")).toBe("")
      }).pipe(Effect.provide(platformWith({ fs: BTRFS }))),
    ),
  )

  it.live(
    "is never a filtered copy: on a file system rift does not copy on (ext4) the copy is a worktree, with every tracked file",
    () =>
      live(
        Effect.gen(function* () {
          const origin = yield* dirtyRepository
          const home = yield* makeTempDirectoryScoped("ws-home-")
          const rift = yield* riftStub("ok")
          const { places, within, start } = yield* installed(home, { rift: rift.program })
          const place = yield* start("call-1", origin)
          expect(place.backend).toBe("worktree")
          expect(place.notes[0]).toContain(
            "the origin's file system is ext4, which rift does not copy on",
          )
          expect(yield* rift.requests).toEqual([])
          // rift's filter drops `build/`; a worktree holds the tracked file, and no deletion is work.
          expect(yield* sh(place.path, "cat build/source.ts")).toBe("source")
          yield* within(places.bind(place.name, childSession))
          const work = yield* within(places.collect(childSession))
          expect(Option.map(work, (found) => found.files)).toEqual(Option.some(0))
        }).pipe(Effect.provide(platformWith({ fs: EXT4 }))),
      ),
  )

  it.live("falls back to a worktree where rift cannot copy, and says why", () =>
    live(
      Effect.gen(function* () {
        const origin = yield* dirtyRepository
        const home = yield* makeTempDirectoryScoped("ws-home-")
        const rift = yield* riftStub("cow")
        const { start } = yield* installed(home, { rift: rift.program })
        const place = yield* start("call-1", origin)
        expect(place.backend).toBe("worktree")
        expect(place.notes[0]).toContain("rift could not copy (cow_unavailable)")
      }).pipe(Effect.provide(platformWith({ fs: BTRFS }))),
    ),
  )

  it.live("is the snapshot's backend on APFS, as macOS names its file system", () =>
    live(
      Effect.gen(function* () {
        const origin = yield* dirtyRepository
        const home = yield* makeTempDirectoryScoped("ws-home-")
        const rift = yield* riftStub("ok")
        const { start } = yield* installed(home, { rift: rift.program })
        const place = yield* start("call-1", origin)
        expect(place.backend).toBe("rift")
        expect(place.path).toBe(`${storageOf(origin)}/${place.name}`)
        expect(yield* worktreeCount(origin)).toBe("1")
      }).pipe(Effect.provide(platformWith({ fs: APFS }))),
    ),
  )
})

// ── the rift workspace ──────────────────────────────────────────────────────

describe("a rift workspace", () => {
  it.live(
    "is refused where rift does not copy, cannot copy, or is missing, and is never a worktree",
    () =>
      live(
        Effect.gen(function* () {
          const origin = yield* dirtyRepository
          const home = yield* makeTempDirectoryScoped("ws-home-")
          const ok = yield* riftStub("ok")
          const cow = yield* riftStub("cow")
          const ask = riftKind("w1")
          // A file system rift does not copy on: refused before rift is asked to copy.
          const onExt4 = yield* installed(home, { rift: ok.program })
          const unsupported = yield* onExt4
            .place("call-1", origin, ask)
            .pipe(Effect.flip, Effect.provide(platformWith({ fs: EXT4 })))
          expect(unsupported.message).toContain("gent makes no copy and no worktree")
          expect(createsOf(yield* ok.requests)).toEqual([])
          // rift refuses the copy: the record goes, and no worktree takes its place.
          const refusing = yield* installed(home, { rift: cow.program })
          const refused = yield* refusing
            .place("call-2", origin, ask)
            .pipe(Effect.flip, Effect.provide(platformWith({ fs: BTRFS })))
          expect(refused.message).toContain("rift could not copy (cow_unavailable)")
          expect(refused.message).toContain("gent makes no worktree in its place")
          // No rift at all: refused when the source is read.
          const missing = yield* installed(home, { rift: NO_RIFT })
          const absent = yield* missing
            .place("call-3", origin, ask)
            .pipe(Effect.flip, Effect.provide(platformWith({ fs: BTRFS })))
          expect(absent.message).toContain("A rift workspace needs rift")
          expect(yield* worktreeCount(origin)).toBe("1")
          expect(yield* exists(`${storageOf(origin)}/w1`)).toBe(false)
          for (const [id, at] of [
            ["call-1", onExt4],
            ["call-2", refusing],
          ] as const) {
            const located = yield* at.within(
              at.places.locate({ key: key(id), cwd: origin, workspace: ask }),
            )
            expect(yield* exists(at.recordFile(located.name))).toBe(false)
          }
        }),
      ),
  )

  it.live(
    "copies the warm source of the caller's copy by default, and refuses a source that is itself a copy, writing nothing",
    () =>
      live(
        Effect.gen(function* () {
          const warm = yield* dirtyRepository
          // The caller works in a copy of the warm source.
          const copy = yield* dirtyRepository
          const home = yield* makeTempDirectoryScoped("ws-home-")
          const rift = yield* riftStub("ok", { [copy]: [warm] })
          const { place, recordFile } = yield* installed(home, { rift: rift.program })
          const made = yield* place("call-1", copy, riftKind("w1"))
          expect(made._tag).toBe("Copy")
          expect(made.path).toBe(`${storageOf(warm)}/w1`)
          expect(createsOf(yield* rift.requests)).toEqual([
            {
              command: "create",
              from: warm,
              name: "w1",
              into: storageOf(warm),
              copyAll: true,
              hooks: false,
            },
          ])
          expect(yield* recordOf(recordFile(made.name))).toMatchObject({
            kind: "rift",
            copyName: "w1",
            sourceId: "rift-root",
            origin: warm,
            phase: "ready",
          })
          // `from` names the copy: refused, and nothing is asked of rift or written.
          const refused = yield* place("call-2", warm, riftKind("w2", copy)).pipe(Effect.flip)
          expect(refused.message).toContain(`${copy} is a rift copy of ${warm}`)
          expect(createsOf(yield* rift.requests)).toHaveLength(1)
          expect(yield* exists(`${storageOf(copy)}/w2`)).toBe(false)
          expect(yield* exists(`${storageOf(warm)}/w2`)).toBe(false)
        }).pipe(Effect.provide(platformWith({ fs: BTRFS }))),
      ),
  )

  it.live(
    "refuses a target that is there already and leaves it; the same start adopts its own copy",
    () =>
      live(
        Effect.gen(function* () {
          const origin = yield* dirtyRepository
          const home = yield* makeTempDirectoryScoped("ws-home-")
          const rift = yield* riftStub("ok")
          const { place, within, places, recordFile } = yield* installed(home, {
            rift: rift.program,
          })
          const first = yield* place("call-1", origin, riftKind("w1"))
          yield* sh(first.path, "printf 'mid\\n' > mid-turn.txt")
          const again = yield* place("call-1", origin, riftKind("w1"))
          expect(again.path).toBe(first.path)
          expect(createsOf(yield* rift.requests)).toHaveLength(1)
          // Another start that names the same copy: refused before rift is asked.
          const taken = yield* place("call-2", origin, riftKind("w1")).pipe(Effect.flip)
          expect(taken.message).toContain("gent does not adopt it")
          expect(yield* sh(first.path, "cat mid-turn.txt")).toBe("mid")
          // A directory someone else made there: the same.
          yield* sh(
            origin,
            `mkdir -p ${storageOf(origin)}/w2 && printf 'mine\\n' > ${storageOf(origin)}/w2/mine.txt`,
          )
          const theirs = yield* place("call-3", origin, riftKind("w2")).pipe(Effect.flip)
          expect(theirs.message).toContain("gent does not adopt it")
          expect(yield* sh(`${storageOf(origin)}/w2`, "ls -A")).toBe("mine.txt")
          expect(createsOf(yield* rift.requests)).toHaveLength(1)
          for (const [id, name] of [
            ["call-2", "w1"],
            ["call-3", "w2"],
          ] as const) {
            const located = yield* within(
              places.locate({ key: key(id), cwd: origin, workspace: riftKind(name) }),
            )
            expect(yield* exists(recordFile(located.name))).toBe(false)
          }
        }).pipe(Effect.provide(platformWith({ fs: BTRFS }))),
      ),
  )

  it.live("a target rift finds there already stays as it is, and gent forgets its record", () =>
    live(
      Effect.gen(function* () {
        const origin = yield* dirtyRepository
        const home = yield* makeTempDirectoryScoped("ws-home-")
        // Another start makes the copy between gent's look and rift's create.
        const rift = yield* riftStub("taken")
        const { places, within, place, recordFile } = yield* installed(home, {
          rift: rift.program,
        })
        const refused = yield* place("call-1", origin, riftKind("w1")).pipe(Effect.flip)
        expect(refused.message).toContain("rift could not copy (already_exists)")
        expect(yield* sh(`${storageOf(origin)}/w1`, "ls -A")).toBe("theirs.txt")
        const located = yield* within(
          places.locate({ key: key("call-1"), cwd: origin, workspace: riftKind("w1") }),
        )
        expect(yield* exists(recordFile(located.name))).toBe(false)
      }).pipe(Effect.provide(platformWith({ fs: BTRFS }))),
    ),
  )

  it.live("whose setup hook fails fails the start, names the copy it keeps, and retains it", () =>
    live(
      Effect.gen(function* () {
        const origin = yield* dirtyRepository
        yield* sh(
          origin,
          `printf 'version = 1\\n[[hooks.postcreate]]\\nrun = "exit 3"\\n' > .rift.toml`,
        )
        const home = yield* makeTempDirectoryScoped("ws-home-")
        const rift = yield* riftStub("ok")
        const { places, within, place, recordFile } = yield* installed(home, {
          rift: rift.program,
        })
        const failed = yield* place("call-1", origin, riftKind("w1")).pipe(Effect.flip)
        const copy = `${storageOf(origin)}/w1`
        expect(failed._tag).toBe("WorkspaceHookFailed")
        if (failed._tag !== "WorkspaceHookFailed") return
        expect(failed.path).toBe(copy)
        expect(failed.message).toContain(`gent keeps the copy at ${copy}`)
        expect(yield* exists(`${copy}/kept.txt`)).toBe(true)
        const located = yield* within(
          places.locate({ key: key("call-1"), cwd: origin, workspace: riftKind("w1") }),
        )
        expect(yield* recordOf(recordFile(located.name))).toMatchObject({ phase: "retained" })
      }).pipe(Effect.provide(platformWith({ fs: BTRFS }))),
    ),
  )
})

// ── the path workspace ──────────────────────────────────────────────────────

describe("a path workspace", () => {
  it.live("attaches the directory as it is: no copy, no hook, and its end deletes nothing", () =>
    live(
      Effect.gen(function* () {
        const origin = yield* dirtyRepository
        yield* sh(
          origin,
          `printf 'version = 1\\n[[hooks.postcreate]]\\nrun = "touch ran"\\n' > .rift.toml`,
        )
        const before = yield* treeState(origin)
        const home = yield* makeTempDirectoryScoped("ws-home-")
        const rift = yield* riftStub("ok")
        const { places, within, place, deleted, recordFile } = yield* installed(home, {
          rift: rift.program,
        })
        const attached = yield* place(
          "call-1",
          origin,
          WorkspaceKind.cases.Path.make({ path: "sub" }),
        )
        expect(attached._tag).toBe("Attached")
        expect(attached).toMatchObject({
          path: `${origin}/sub`,
          cwd: `${origin}/sub`,
        })
        expect(yield* exists(`${origin}/sub/ran`)).toBe(false)
        expect(yield* exists(`${origin}/ran`)).toBe(false)
        expect(yield* rift.requests).toEqual([])
        expect(yield* worktreeCount(origin)).toBe("1")
        // Bound, it gives no work back, and the session's delete only forgets it.
        yield* within(places.bind(attached.name, childSession))
        expect(yield* within(places.collect(childSession))).toEqual(Option.none())
        yield* deleted(childSession)
        expect(yield* sh(origin, "cat sub/deep.txt")).toBe("deep")
        expect(yield* treeState(origin)).toEqual(before)
        expect(yield* exists(recordFile(attached.name))).toBe(false)
        // Released unbound, the same.
        const unbound = yield* place(
          "call-2",
          origin,
          WorkspaceKind.cases.Path.make({ path: origin }),
        )
        yield* within(places.release(unbound.name))
        expect(yield* sh(origin, "cat kept.txt")).toBe("one")
        expect(yield* treeState(origin)).toEqual(before)
        expect(yield* exists(recordFile(unbound.name))).toBe(false)
        // A directory outside git, or a path that is not there, is refused.
        const plain = yield* makeTempDirectoryScoped("ws-plain-")
        const outside = yield* place(
          "call-3",
          origin,
          WorkspaceKind.cases.Path.make({ path: plain }),
        ).pipe(Effect.flip)
        expect(outside.message).toContain("needs a git repository")
        const nowhere = yield* place(
          "call-4",
          origin,
          WorkspaceKind.cases.Path.make({ path: "missing" }),
        ).pipe(Effect.flip)
        expect(nowhere.message).toContain("to exist")
      }),
    ),
  )
})

// ── snapshot threads ────────────────────────────────────────────────────────

const threadTask = "THREAD-TASK: write thread.txt"

/** What a `thread.start` asks for: one delegate task in a copy, whose end wakes the starter. */
const snapshotStart = {
  task: threadTask,
  agent: "delegate",
  notify: "starter",
  workspace: { snapshot: true },
}

/** `snapshotStart` as the tool's handler gets it: its input decoded. */
const decodedSnapshotStart = { ...snapshotStart, workspace: SNAPSHOT }

/** Every text part of the prompt's user and assistant messages, in order. */
const promptTexts = (prompt: Prompt.Prompt): ReadonlyArray<string> =>
  prompt.content.flatMap((message) => {
    if (message.role === "system") return []
    return message.content.flatMap((part) => {
      if (part.type !== "text") return []
      return [part.text]
    })
  })

const calledTools = (prompt: Prompt.Prompt): number =>
  prompt.content.filter(
    (message) =>
      message.role === "assistant" && message.content.some((part) => part.type === "tool-call"),
  ).length

const reply = (text: string) =>
  Stream.fromIterable([textDeltaPart(text), finishPart({ finishReason: "stop" })])

const toolStep = (name: string, input: Parameters<typeof toolCallPart>[1], id: string) =>
  Stream.fromIterable([
    toolCallPart(name, input, { toolCallId: ToolCallId.make(id) }),
    finishPart({ finishReason: "tool-calls" }),
  ])

/**
 * A starter that starts one snapshot thread and ends its turn; the thread
 * writes `thread.txt` by a relative path (its session's cwd is the copy) and
 * answers. The round's end wakes the starter once more. A thread's request
 * is the one whose first text (its round's text) ends with the task.
 */
const snapshotModel = (quota: Effect.Effect<void> = Effect.void) =>
  LanguageModelLayers.testStream((options) => {
    const texts = promptTexts(options.prompt)
    const calls = calledTools(options.prompt)
    if (texts[0]?.endsWith(threadTask) === true) {
      if (calls === 0) {
        return Effect.succeed(
          toolStep("write", { path: "thread.txt", content: "from the thread\n" }, "write-1"),
        )
      }
      return Effect.succeed(reply("wrote it"))
    }
    if (texts.some((text) => text.startsWith('Thread "'))) return Effect.succeed(reply("read it"))
    if (calls === 0) {
      return Effect.as(quota, toolStep("thread.start", snapshotStart, "start-1"))
    }
    return Effect.succeed(reply("started"))
  })

/** The shipped extensions, with the workspaces extension on a rift that is not there. */
const harnessIn = (
  origin: string,
  home: string,
  admission?: Parameters<typeof createRpcHarness>[0]["admission"],
) =>
  createRpcHarness({
    ...e2ePreset,
    extensionInputs: [
      ...e2ePreset.extensionInputs.filter(
        (extension) => extension.manifest.id !== WORKSPACES_EXTENSION_ID,
      ),
      makeWorkspacesExtension({ rift: NO_RIFT }),
    ],
    providerLayer: snapshotModel(),
    cwd: origin,
    home,
    admission,
  })

/**
 * `harnessIn` with the starter walking the `anthropic` sign-in `work`, whose
 * step that calls `thread.start` reads the week as `reading` says.
 */
const meteredHarnessIn = (origin: string, home: string, reading: QuotaReading) =>
  createRpcHarness({
    ...e2ePreset,
    extensionInputs: [
      ...e2ePreset.extensionInputs.filter(
        (extension) => extension.manifest.id !== WORKSPACES_EXTENSION_ID,
      ),
      makeWorkspacesExtension({ rift: NO_RIFT }),
    ],
    providerLayer: snapshotModel(reportProviderQuota([reading])),
    configServiceLayer: ConfigService.Test(
      new UserConfig({
        model: TEST_MODEL_ID,
        providers: { anthropic: { authOrder: [CredentialSlot.make("work")] } },
      }),
    ),
    cwd: origin,
    home,
  })

/** The message a thread's round end wakes its starter with. */
const roundEndOf = <
  M extends { readonly metadata?: { readonly customType?: string; readonly details?: unknown } },
>(
  messages: ReadonlyArray<M>,
) => messages.find((message) => message.metadata?.customType === THREAD_ROUND_END_TYPE)

const textOf = (message: Option.Option<{ readonly parts: ReadonlyArray<Prompt.Part> }>) =>
  Option.match(message, { onNone: () => [], onSome: (found) => found.parts })
    .flatMap((part) => {
      if (part.type !== "text") return []
      return [part.text]
    })
    .join("")

/** What `thread.start` says of a snapshot thread's place. */
const StartedInCopy = Schema.fromJsonString(
  Schema.Struct({ workspace: Schema.Struct({ path: Schema.String, branch: Schema.String }) }),
)

/** The copy and the branch a snapshot thread's round end names. */
const WorkOfRoundEnd = Schema.Struct({
  sessionId: SessionId,
  workspace: Schema.Struct({ path: Schema.String, branch: Schema.String }),
})

/**
 * The request id `thread.start` gives its thread's create for the tool call
 * `toolCallId` from `starter`, which is the key its copy is located by: a
 * digest of the start's identity, as `Threads.start` derives it.
 */
const threadCreateKey = (starter: Parent, toolCallId: string) =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto
    const identity = ["thread.create", starter.sessionId, starter.branchId, toolCallId].join("\n")
    const digest = yield* crypto.digest("SHA-256", new TextEncoder().encode(identity))
    return `thread:${Hex.encode(digest).slice(0, 32)}`
  }).pipe(Effect.orDie)

type HostSession = Effect.Success<ReturnType<typeof runtimeHostContext>>["Session"]
type CreateParams = Parameters<HostSession["create"]>[0]

describe("a snapshot thread", () => {
  it.live(
    "edits its own copy, leaves the starter's tree as it was, and hands back a branch that holds the edit",
    () =>
      Effect.gen(function* () {
        const origin = yield* dirtyRepository
        const home = yield* makeTempDirectoryScoped("ws-home-")
        const before = yield* treeState(origin)
        const harness = yield* harnessIn(origin, home)
        const starter = { sessionId: harness.sessionId, branchId: harness.branchId }
        // A start that ran before a crash left its copy: the start adopts it.
        const earlier = yield* installed(home, { rift: NO_RIFT })
        const planted = yield* earlier.start(
          yield* threadCreateKey(starter, "start-1"),
          origin,
          starter,
        )
        const started = yield* harness.client.session
          .events({ sessionId: harness.sessionId, branchId: harness.branchId })
          .pipe(
            Stream.filter(isToolResultFor("thread.start")),
            Stream.take(1),
            Stream.runCollect,
            Effect.map((events) => Array.from(events)[0]?.event),
            Effect.forkScoped,
          )
        yield* harness.client.message.send({
          sessionId: harness.sessionId,
          branchId: harness.branchId,
          content: "delegate it in a copy",
        })
        const result = yield* Fiber.join(started)
        expect(result?._tag).toBe("ToolCallSucceeded")
        if (result?._tag !== "ToolCallSucceeded") return
        const handle = yield* Schema.decodeUnknownEffect(StartedInCopy)(result.output)
        expect(handle.workspace).toEqual({ path: planted.cwd, branch: planted.branch })
        const snapshot = yield* waitFor(
          harness.client.session.getSnapshot({
            sessionId: harness.sessionId,
            branchId: harness.branchId,
          }),
          (current) =>
            Predicate.isNotUndefined(roundEndOf(current.messages)) &&
            current.runtime._tag === "Idle",
          15_000,
          "the thread's round end woke the starter",
        )
        const roundEnd = roundEndOf(snapshot.messages)
        const roundEndText = textOf(Option.fromUndefinedOr(roundEnd))
        expect(roundEndText).toMatch(/^Thread ".*" \(agent delegate\) round 1 completed\./)
        expect(roundEndText).toContain(`Work: branch ${planted.branch}`)
        expect(roundEnd?.metadata?.details).toMatchObject({
          workspace: { branch: planted.branch, files: 1, insertions: 1, deletions: 0 },
        })
        // The branch is named for the copy, and the origin holds it.
        expect(planted.branch).toBe(`gent/${planted.path.split("/").at(-1)}`)
        expect(
          yield* sh(origin, `git rev-parse --verify --quiet refs/heads/${planted.branch}`),
        ).toMatch(/^[0-9a-f]{40}$/)
        // The edit is in the copy and on the branch, never in the starter's tree.
        expect(yield* sh(planted.path, "cat thread.txt")).toBe("from the thread")
        expect(yield* sh(origin, `git show ${planted.branch}:thread.txt`)).toBe("from the thread")
        expect(yield* exists(`${origin}/thread.txt`)).toBe(false)
        expect(yield* treeState(origin)).toEqual(before)
        // One copy: the start adopted the planted one.
        expect(yield* worktreeCount(origin)).toBe("2")
        // The thread read where it works.
        const thread = (yield* harness.client.session.list()).find(
          (session) => session.parentSessionId === harness.sessionId,
        )
        expect(thread?.cwd).toBe(planted.cwd)
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.timeout("25 seconds")),
    30_000,
  )

  it.live(
    "of a path-confined starter is refused file calls in its copy, which lies outside the starter's paths",
    () =>
      Effect.gen(function* () {
        const origin = yield* dirtyRepository
        const home = yield* makeTempDirectoryScoped("ws-home-")
        // The starter run may write anywhere in its own cwd, and nowhere else.
        const harness = yield* harnessIn(origin, home, {
          runSpec: { overrides: { paths: [{ path: ".", access: "write" }] } },
        })
        yield* harness.client.message.send({
          sessionId: harness.sessionId,
          branchId: harness.branchId,
          content: "delegate it in a copy",
        })
        yield* waitFor(
          harness.client.session.getSnapshot({
            sessionId: harness.sessionId,
            branchId: harness.branchId,
          }),
          (current) =>
            Predicate.isNotUndefined(roundEndOf(current.messages)) &&
            current.runtime._tag === "Idle",
          15_000,
          "the thread's round end woke the starter",
        )
        const thread = (yield* harness.client.session.list()).find(
          (session) => session.parentSessionId === harness.sessionId,
        )
        expect(thread?.cwd).not.toBe(origin)
        const copy = thread?.cwd ?? ""
        // The starter's scopes resolve against the starter's cwd, not the copy.
        expect(yield* exists(`${copy}/thread.txt`)).toBe(false)
        expect(yield* exists(`${origin}/thread.txt`)).toBe(false)
        const branches = yield* harness.client.branch.list({
          sessionId: thread?.id ?? harness.sessionId,
        })
        const messages = yield* harness.client.message.list({
          branchId: branches[0]?.id ?? harness.branchId,
        })
        const results = messages
          .flatMap((message) => message.parts)
          .filter((part) => part.type === "tool-result")
        expect(results.map((part) => part.isFailure)).toEqual([true])
        expect(encodeJson(results[0]?.result)).toContain("outside this agent's paths")
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.timeout("25 seconds")),
    30_000,
  )

  it.live(
    "whose session cannot be created leaves no copy behind",
    () =>
      Effect.gen(function* () {
        const origin = yield* dirtyRepository
        const home = yield* makeTempDirectoryScoped("ws-home-")
        const harness = yield* harnessIn(origin, home)
        // A starter at the depth limit cannot start a thread: the thread's create fails.
        let starter = { sessionId: harness.sessionId, branchId: harness.branchId }
        for (const _ of [1, 2, 3]) {
          const next = yield* harness.client.session.create({
            cwd: origin,
            parentSessionId: starter.sessionId,
            parentBranchId: starter.branchId,
          })
          starter = next
        }
        const started = yield* harness.client.session.events(starter).pipe(
          Stream.filter(isToolResultFor("thread.start")),
          Stream.take(1),
          Stream.runCollect,
          Effect.map((events) => Array.from(events)[0]?.event),
          Effect.forkScoped,
        )
        yield* harness.client.message.send({ ...starter, content: "delegate it in a copy" })
        const result = yield* Fiber.join(started)
        expect(result?._tag).toBe("ToolCallFailed")
        if (result?._tag !== "ToolCallFailed") return
        expect([result.summary, result.output].join(" ")).toContain("depth limit")
        expect(yield* worktreeCount(origin)).toBe("1")
        // The copy was made before the create failed: its parent directory stays, empty.
        expect(yield* exists(`${home}/.gent/workspaces/worktrees`)).toBe(true)
        const fs = yield* FileSystem.FileSystem
        const left = yield* fs
          .readDirectory(`${home}/.gent/workspaces`)
          .pipe(Effect.orElseSucceed(() => []))
        expect(left.filter((file) => file.endsWith(".json"))).toEqual([])
        const worktrees = yield* fs
          .readDirectory(`${home}/.gent/workspaces/worktrees`)
          .pipe(Effect.orElseSucceed(() => []))
        expect(worktrees).toEqual([])
        expect(yield* sh(origin, "git for-each-ref refs/gent")).toBe("")
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.timeout("25 seconds")),
    30_000,
  )

  it.live(
    "on an account with no lane is refused before its copy is made",
    () =>
      Effect.gen(function* () {
        const origin = yield* dirtyRepository
        const home = yield* makeTempDirectoryScoped("ws-home-")
        const resetAt = (yield* Clock.currentTimeMillis) + 3_600_000
        const harness = yield* meteredHarnessIn(origin, home, {
          window: "7d",
          utilization: 1,
          resetAt,
          rejected: true,
        })
        const started = yield* harness.client.session
          .events({ sessionId: harness.sessionId, branchId: harness.branchId })
          .pipe(
            Stream.filter(isToolResultFor("thread.start")),
            Stream.take(1),
            Stream.runCollect,
            Effect.map((events) => Array.from(events)[0]?.event),
            Effect.forkScoped,
          )
        yield* harness.client.message.send({
          sessionId: harness.sessionId,
          branchId: harness.branchId,
          content: "delegate it in a copy",
        })
        const result = yield* Fiber.join(started)
        expect(result?._tag).toBe("ToolCallFailed")
        if (result?._tag !== "ToolCallFailed") return
        expect([result.summary, result.output].join(" ")).toContain("No lane on anthropic")
        // No copy, no record, no branch: the precheck ran before the making.
        expect(yield* worktreeCount(origin)).toBe("1")
        expect(yield* exists(`${home}/.gent/workspaces/worktrees`)).toBe(false)
        const fs = yield* FileSystem.FileSystem
        const left = yield* fs
          .readDirectory(`${home}/.gent/workspaces`)
          .pipe(Effect.orElseSucceed(() => []))
        expect(left.filter((file) => file.endsWith(".json"))).toEqual([])
        expect(yield* sh(origin, "git for-each-ref refs/gent")).toBe("")
        const threads = (yield* harness.client.session.list()).filter(
          (session) => session.parentSessionId === harness.sessionId,
        )
        expect(threads).toEqual([])
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.timeout("25 seconds")),
    30_000,
  )

  it.live(
    "whose copy cannot be made frees the lane its precheck was admitted",
    () =>
      Effect.gen(function* () {
        // No repository: the copy's making fails after the precheck.
        const origin = yield* makeTempDirectoryScoped("ws-plain-")
        const home = yield* makeTempDirectoryScoped("ws-home-")
        // A week that never moves: no capacity, and every admitted run counts.
        const harness = yield* meteredHarnessIn(origin, home, {
          window: "7d",
          utilization: 0.1,
          resetAt: (yield* Clock.currentTimeMillis) + 20 * 3_600_000,
          rejected: false,
        })
        const session = { sessionId: harness.sessionId, branchId: harness.branchId }
        const started = yield* harness.client.session.events(session).pipe(
          Stream.filter(isToolResultFor("thread.start")),
          Stream.take(1),
          Stream.runCollect,
          Effect.map((events) => Array.from(events)[0]?.event),
          Effect.forkScoped,
        )
        yield* harness.client.message.send({ ...session, content: "delegate it in a copy" })
        expect((yield* Fiber.join(started))?._tag).toBe("ToolCallFailed")
        yield* waitFor(
          harness.client.session.getSnapshot(session),
          (current) => current.runtime._tag === "Idle",
          10_000,
          "the starter's turn ended",
        )
        // Read at once: the failed start holds no lane.
        const lanes = yield* harness.client.accounts.lanes()
        expect(lanes.providers.map((provider) => provider.load)).toEqual([0])
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.timeout("25 seconds")),
    30_000,
  )

  it.live(
    "a start from two starters with one tool call id makes two threads, each with its own copy",
    () =>
      Effect.gen(function* () {
        const origin = yield* dirtyRepository
        const home = yield* makeTempDirectoryScoped("ws-home-")
        const harness = yield* harnessIn(origin, home)
        const second = yield* harness.client.session.create({ cwd: origin })
        const starters = [{ sessionId: harness.sessionId, branchId: harness.branchId }, second]
        // Each starter's model calls `thread.start` with the same tool call id, `start-1`.
        const roundEnds = yield* Effect.forEach(starters, (starter) =>
          Effect.gen(function* () {
            yield* harness.client.message.send({ ...starter, content: "delegate it in a copy" })
            const snapshot = yield* waitFor(
              harness.client.session.getSnapshot(starter),
              (current) =>
                Predicate.isNotUndefined(roundEndOf(current.messages)) &&
                current.runtime._tag === "Idle",
              15_000,
              "the thread's round end woke its starter",
            )
            return roundEndOf(snapshot.messages)?.metadata?.details
          }),
        )
        const threads = (yield* harness.client.session.list()).filter((session) =>
          starters.some((starter) => starter.sessionId === session.parentSessionId),
        )
        expect(threads).toHaveLength(2)
        expect(new Set(threads.map((thread) => thread.cwd)).size).toBe(2)
        const works = roundEnds.map((details) => Schema.decodeUnknownSync(WorkOfRoundEnd)(details))
        expect(new Set(works.map((work) => work.workspace.branch)).size).toBe(2)
        for (const [index, work] of works.entries()) {
          // Each round end names its own starter's thread, and the copy that thread works in.
          const thread = threads.find((found) => found.id === work.sessionId)
          expect(thread?.parentSessionId).toBe(starters[index]?.sessionId)
          expect(thread?.cwd).toBe(work.workspace.path)
          expect(work.workspace.branch).toBe(`gent/${work.workspace.path.split("/").at(-1)}`)
          expect(yield* sh(work.workspace.path, "cat thread.txt")).toBe("from the thread")
          expect(yield* sh(origin, `git show ${work.workspace.branch}:thread.txt`)).toBe(
            "from the thread",
          )
        }
        expect(yield* worktreeCount(origin)).toBe("3")
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.timeout("40 seconds")),
    45_000,
  )

  it.live(
    "an admission stopped after its session was stored keeps the copy for that session; one stopped before removes it",
    () =>
      live(
        Effect.gen(function* () {
          const origin = yield* dirtyRepository
          // A copy's place is its real path: on macOS the temp root is a link.
          const home = yield* (yield* FileSystem.FileSystem).realPath(
            yield* makeTempDirectoryScoped("ws-home-"),
          )
          const fs = yield* FileSystem.FileSystem
          const { places, within } = yield* installed(home, { rift: NO_RIFT })
          // The registered `thread.start`, run as the host runs a call, from a stored starter.
          const contributions = yield* collectTestContributions(SessionToolsExtension.setup)
          const startTool = contributions.tools?.find(
            (candidate) => getToolId(candidate) === "thread.start",
          )
          const resource = contributions.resources?.find(
            (candidate) => candidate.id === "@gent/session-tools/threads",
          )
          if (Predicate.isUndefined(startTool) || Predicate.isUndefined(resource)) {
            return yield* Effect.die("session tools register no thread.start or threads resource")
          }
          const context = yield* Layer.build(
            createE2ELayer({
              ...e2ePreset,
              cwd: origin,
              home,
              providerLayer: LanguageModelLayers.testStream(() => Effect.succeed(reply("done"))),
            }),
          )
          const buildThreads: Effect.Effect<
            Context.Context<never>,
            never,
            Scope.Scope
          > = Layer.build(resource.layer).pipe(Effect.provideContext(context), Effect.orDie)
          const threads = yield* buildThreads
          const { client } = yield* createRpcClient(Layer.succeedContext(context))
          const starter: Parent = yield* client.session.create({ cwd: origin })
          const stored = yield* Ref.make<ReadonlyArray<Session>>([])
          /** Core stores the session, then the call is interrupted before it returns. */
          const storeThenStop = (sessionId: SessionId) => (params: CreateParams) =>
            Effect.gen(function* () {
              const now = yield* DateTime.nowAsDate
              const session = new Session({
                id: sessionId,
                cwd: params.cwd,
                // The calling session is always the starter (`Session.create` names none).
                parentSessionId: starter.sessionId,
                parentBranchId: params.parentBranchId,
                createdAt: now,
                updatedAt: now,
              })
              yield* Ref.update(stored, (all) => [...all, session])
              return yield* Effect.interrupt
            })
          const admit = (
            id: string,
            session: Partial<Pick<HostSession, "create" | "listSessions">>,
          ) =>
            Effect.gen(function* () {
              const host = yield* runtimeHostContext(starter)
              // @effect-diagnostics-next-line anyUnknownInErrorContext:off -- a registered tool's channels are erased, as at the extension membrane
              return yield* runToolWithCtx(startTool, decodedSnapshotStart, {
                ...host,
                Session: { ...host.Session, listSessions: () => Ref.get(stored), ...session },
                extensionId: SESSION_TOOLS_EXTENSION_ID,
                toolCallId: ToolCallId.make(id),
              })
            }).pipe(
              Effect.provideContext(Context.merge(context, threads)),
              Effect.provideService(Workspaces, places),
              Effect.provideService(CurrentWorkspaceId, workspaceIdForCwd(origin)),
              Effect.exit,
            )
          // A copy is named by the start's whole identity, which the test does
          // not derive: each admission's copy is the one it added to the copies.
          const worktrees = `${home}/.gent/workspaces/worktrees`
          const copies = fs
            .readDirectory(worktrees)
            .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []))
          const admitted = (id: string, session: Parameters<typeof admit>[1]) =>
            Effect.gen(function* () {
              const before = yield* copies
              const exit = yield* admit(id, session)
              const added = (yield* copies).filter((name) => !before.includes(name))
              return { exit, added: added.map((name) => `${worktrees}/${name}`) }
            })
          // Stored, then stopped: the copy is the stored session's.
          const committed = SessionId.make("stored-thread")
          const afterStore = yield* admitted("call-stored", { create: storeThenStop(committed) })
          expect(Exit.hasInterrupts(afterStore.exit)).toBe(true)
          expect(afterStore.added).toHaveLength(1)
          const kept = afterStore.added[0] ?? ""
          expect(yield* exists(kept)).toBe(true)
          expect(Option.map(yield* within(places.find(committed)), (found) => found.path)).toEqual(
            Option.some(kept),
          )
          // Stopped before anything was stored: the copy goes.
          const beforeStore = yield* admitted("call-unstored", { create: () => Effect.interrupt })
          expect(Exit.hasInterrupts(beforeStore.exit)).toBe(true)
          expect(beforeStore.added).toEqual([])
          // A check that cannot tell keeps the copy.
          const unknown = yield* admitted("call-unknown", {
            create: storeThenStop(SessionId.make("unknown-thread")),
            listSessions: () => Effect.die("the session list is not readable"),
          })
          expect(Exit.hasInterrupts(unknown.exit)).toBe(true)
          expect(unknown.added).toHaveLength(1)
          expect(yield* exists(unknown.added[0] ?? "")).toBe(true)
        }),
      ),
  )
})

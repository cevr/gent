import { describe, expect, it } from "effect-bun-test"
import {
  Context,
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
import { ExtensionContext, RequestId, runProcess } from "@gent/core/extensions/api"
import {
  collectTestContributions,
  createRpcHarness,
  finishPart,
  LanguageModelLayers,
  makeTempDirectoryScoped,
  runToolWithCtx,
  testLeafContext,
  testToolContext,
  textDeltaPart,
  toolCallPart,
  waitFor,
} from "@gent/core/test-utils"
import { BranchId, Session, SessionId, ToolCallId } from "@gent/core/protocol"
import { StartChild } from "../src/delegate.js"
import {
  makeWorkspacesExtension,
  WORKSPACES_EXTENSION_ID,
  Workspaces,
  type WorkspacesOptions,
} from "../src/workspaces.js"
import { e2ePreset } from "./helpers/test-preset"
import { isToolResultFor } from "./helpers/tool-event.js"

// ── fixtures ────────────────────────────────────────────────────────────────

/** A rift program that does not exist: a copy on btrfs falls back to a worktree. */
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
 * `copyAll` drops `build` and `node_modules`, as rift's filter does.
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
  'if (request.command === "ancestors") answer({ status: "ok", value: [] })',
  'else if (request.command === "create") {',
  '  if (mode === "cow") {',
  '    answer({ status: "error", error: { code: "cow_unavailable", message: "copy-on-write is not available here" } })',
  "  } else {",
  '    const into = request.into ?? dir + "/copies"',
  '    const dest = into + "/" + request.name',
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
 * copy. `mode` is `ok`, or `cow` (no copy-on-write here).
 */
const riftStub = (mode: "ok" | "cow") =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const dir = yield* makeTempDirectoryScoped("ws-rift-")
    const log = `${dir}/requests.log`
    const program = `${dir}/rift`
    yield* fs.writeFileString(`${dir}/mode`, mode)
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
 * The platform with `stat -f` and `df` answered, where a test needs a file
 * system this machine may not have: btrfs, or one whose free space is
 * unknown. Every other process runs.
 */
const platformWith = (answers: { readonly btrfs?: boolean; readonly noFreeSpace?: boolean }) =>
  Layer.effect(
    ChildProcessSpawner.ChildProcessSpawner,
    Effect.gen(function* () {
      const real = yield* ChildProcessSpawner.ChildProcessSpawner
      return ChildProcessSpawner.make((command) => {
        if (command._tag === "StandardCommand" && command.command === "stat" && answers.btrfs) {
          return real.spawn(
            ChildProcess.make("printf", ["btrfs\\n"], { forceKillAfter: "1 second" }),
          )
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
    /** A start from `cwd` for the call `id`, as the delegate makes one. */
    const start = (id: string, cwd: string, parent: Parent = parentA) =>
      as(parent)(places.locate({ key: key(id), cwd }).pipe(Effect.flatMap(places.acquire)))
    /** The session delete of `sessionId`, as the host runs the hook. */
    const deleted = (sessionId: SessionId) =>
      within(deletedSlot.hook.handler({ sessionId, branchIds: [] })).pipe(
        Effect.provideContext(services),
      )
    const recordFile = (name: string) => `${home}/.gent/workspaces/${name}.json`
    return { places, within, start, deleted, recordFile }
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
          expect(refused.message).toContain("a snapshot child needs")
          expect(refused.message).toContain('isolation "shared"')
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
        const start = yield* within(places.locate({ key: key("call-1"), cwd: origin }))
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
          const taken = yield* within(places.locate({ key: key("call-1"), cwd: origin }))
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
        }).pipe(Effect.provide(platformWith({ btrfs: true }))),
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
            const located = yield* within(places.locate({ key: key(id), cwd: origin }))
            expect(yield* recordOf(recordFile(located.name))).toMatchObject({ phase: "retained" })
            yield* within(places.release(located.name))
            expect(yield* exists(recordFile(located.name))).toBe(true)
          }
        }).pipe(Effect.provide(platformWith({ btrfs: true }))),
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
      }).pipe(Effect.provide(platformWith({ btrfs: true }))),
    ),
  )

  it.live(
    "is never a filtered copy: off btrfs the copy is a worktree, with every tracked file",
    () =>
      live(
        Effect.gen(function* () {
          const origin = yield* dirtyRepository
          const home = yield* makeTempDirectoryScoped("ws-home-")
          const rift = yield* riftStub("ok")
          const { places, within, start } = yield* installed(home, { rift: rift.program })
          const place = yield* start("call-1", origin)
          expect(place.backend).toBe("worktree")
          expect(place.notes[0]).toContain("not btrfs")
          expect(yield* rift.requests).toEqual([])
          // rift's filter drops `build/`; a worktree holds the tracked file, and no deletion is work.
          expect(yield* sh(place.path, "cat build/source.ts")).toBe("source")
          yield* within(places.bind(place.name, childSession))
          const work = yield* within(places.collect(childSession))
          expect(Option.map(work, (found) => found.files)).toEqual(Option.some(0))
        }),
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
      }).pipe(Effect.provide(platformWith({ btrfs: true }))),
    ),
  )
})

// ── snapshot children ───────────────────────────────────────────────────────

const childTask = "CHILD-TASK: write child.txt"

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
 * A parent that starts one snapshot child and ends its turn; the child
 * writes `child.txt` by a relative path (its session's cwd is the copy) and
 * answers. The completion wakes the parent once more.
 */
const snapshotModel = () =>
  LanguageModelLayers.testStream((options) => {
    const texts = promptTexts(options.prompt)
    const calls = calledTools(options.prompt)
    if (texts[0]?.endsWith(childTask) === true) {
      if (calls === 0) {
        return Effect.succeed(
          toolStep("write", { path: "child.txt", content: "from the child\n" }, "write-1"),
        )
      }
      return Effect.succeed(reply("wrote it"))
    }
    if (texts.some((text) => text.startsWith("Child agent")))
      return Effect.succeed(reply("read it"))
    if (calls === 0) {
      return Effect.succeed(
        toolStep("delegate.start", { todo: childTask, isolation: "snapshot" }, "start-1"),
      )
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

const completionOf = <
  M extends { readonly metadata?: { readonly customType?: string; readonly details?: unknown } },
>(
  messages: ReadonlyArray<M>,
) => messages.find((message) => message.metadata?.customType === "child-completion")

const textOf = (message: Option.Option<{ readonly parts: ReadonlyArray<Prompt.Part> }>) =>
  Option.match(message, { onNone: () => [], onSome: (found) => found.parts })
    .flatMap((part) => {
      if (part.type !== "text") return []
      return [part.text]
    })
    .join("")

/** What `delegate.start` says of a snapshot child's place. */
const StartedInCopy = Schema.fromJsonString(
  Schema.Struct({ workspace: Schema.Struct({ path: Schema.String, branch: Schema.String }) }),
)

/** The copy and the branch a snapshot child's completion names. */
const WorkOfCompletion = Schema.Struct({
  sessionId: SessionId,
  workspace: Schema.Struct({ path: Schema.String, branch: Schema.String }),
})

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

type CreateParams = Parameters<ReturnType<typeof testToolContext>["Session"]["create"]>[0]

describe("a snapshot child", () => {
  it.live(
    "edits its own copy, leaves the parent's tree as it was, and hands back a branch that holds the edit",
    () =>
      Effect.gen(function* () {
        const origin = yield* dirtyRepository
        const home = yield* makeTempDirectoryScoped("ws-home-")
        const before = yield* treeState(origin)
        const harness = yield* harnessIn(origin, home)
        // A start that ran before a crash left its copy: the start adopts it.
        const earlier = yield* installed(home, { rift: NO_RIFT })
        const planted = yield* earlier.start("start-1", origin, {
          sessionId: harness.sessionId,
          branchId: harness.branchId,
        })
        const started = yield* harness.client.session
          .events({ sessionId: harness.sessionId, branchId: harness.branchId })
          .pipe(
            Stream.filter(isToolResultFor("delegate.start")),
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
            Predicate.isNotUndefined(completionOf(current.messages)) &&
            current.runtime._tag === "Idle",
          15_000,
          "the child's completion woke the parent",
        )
        const completion = completionOf(snapshot.messages)
        expect(textOf(Option.fromUndefinedOr(completion))).toContain(
          `Work: branch ${planted.branch}`,
        )
        expect(completion?.metadata?.details).toMatchObject({
          workspace: { branch: planted.branch, files: 1, insertions: 1, deletions: 0 },
        })
        // The edit is in the copy and on the branch, never in the parent's tree.
        expect(yield* sh(planted.path, "cat child.txt")).toBe("from the child")
        expect(yield* sh(origin, `git show ${planted.branch}:child.txt`)).toBe("from the child")
        expect(yield* exists(`${origin}/child.txt`)).toBe(false)
        expect(yield* treeState(origin)).toEqual(before)
        // One copy: the start adopted the planted one.
        expect(yield* worktreeCount(origin)).toBe("2")
        // The child read where it works.
        const child = (yield* harness.client.session.list()).find(
          (session) => session.parentSessionId === harness.sessionId,
        )
        expect(child?.cwd).toBe(planted.cwd)
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.timeout("25 seconds")),
    30_000,
  )

  it.live(
    "of a path-confined parent is refused file calls in its copy, which lies outside the parent's paths",
    () =>
      Effect.gen(function* () {
        const origin = yield* dirtyRepository
        const home = yield* makeTempDirectoryScoped("ws-home-")
        // The parent run may write anywhere in its own cwd, and nowhere else.
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
            Predicate.isNotUndefined(completionOf(current.messages)) &&
            current.runtime._tag === "Idle",
          15_000,
          "the child's completion woke the parent",
        )
        const child = (yield* harness.client.session.list()).find(
          (session) => session.parentSessionId === harness.sessionId,
        )
        expect(child?.cwd).not.toBe(origin)
        const copy = child?.cwd ?? ""
        // The parent's scopes resolve against the parent's cwd, not the copy.
        expect(yield* exists(`${copy}/child.txt`)).toBe(false)
        expect(yield* exists(`${origin}/child.txt`)).toBe(false)
        const branches = yield* harness.client.branch.list({
          sessionId: child?.id ?? harness.sessionId,
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
        // A parent at the depth limit cannot spawn: its child's create fails.
        let parent = { sessionId: harness.sessionId, branchId: harness.branchId }
        for (const _ of [1, 2, 3]) {
          const next = yield* harness.client.session.create({
            cwd: origin,
            parentSessionId: parent.sessionId,
            parentBranchId: parent.branchId,
          })
          parent = next
        }
        const started = yield* harness.client.session.events(parent).pipe(
          Stream.filter(isToolResultFor("delegate.start")),
          Stream.take(1),
          Stream.runCollect,
          Effect.map((events) => Array.from(events)[0]?.event),
          Effect.forkScoped,
        )
        yield* harness.client.message.send({ ...parent, content: "delegate it in a copy" })
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
    "a start from two parents with one tool call id makes two children, each with its own copy",
    () =>
      Effect.gen(function* () {
        const origin = yield* dirtyRepository
        const home = yield* makeTempDirectoryScoped("ws-home-")
        const harness = yield* harnessIn(origin, home)
        const second = yield* harness.client.session.create({ cwd: origin })
        const parents = [{ sessionId: harness.sessionId, branchId: harness.branchId }, second]
        // Each parent's model calls `delegate.start` with the same tool call id, `start-1`.
        const completions = yield* Effect.forEach(parents, (parent) =>
          Effect.gen(function* () {
            yield* harness.client.message.send({ ...parent, content: "delegate it in a copy" })
            const snapshot = yield* waitFor(
              harness.client.session.getSnapshot(parent),
              (current) =>
                Predicate.isNotUndefined(completionOf(current.messages)) &&
                current.runtime._tag === "Idle",
              15_000,
              "the child's completion woke its parent",
            )
            return completionOf(snapshot.messages)?.metadata?.details
          }),
        )
        const children = (yield* harness.client.session.list()).filter((session) =>
          parents.some((parent) => parent.sessionId === session.parentSessionId),
        )
        expect(children).toHaveLength(2)
        expect(new Set(children.map((child) => child.cwd)).size).toBe(2)
        const works = completions.map((details) =>
          Schema.decodeUnknownSync(WorkOfCompletion)(details),
        )
        expect(new Set(works.map((work) => work.workspace.branch)).size).toBe(2)
        for (const [index, work] of works.entries()) {
          // Each completion names its own parent's child, and the copy that child works in.
          const child = children.find((found) => found.id === work.sessionId)
          expect(child?.parentSessionId).toBe(parents[index]?.sessionId)
          expect(child?.cwd).toBe(work.workspace.path)
          expect(work.workspace.branch).toBe(`gent/${work.workspace.path.split("/").at(-1)}`)
          expect(yield* sh(work.workspace.path, "cat child.txt")).toBe("from the child")
          expect(yield* sh(origin, `git show ${work.workspace.branch}:child.txt`)).toBe(
            "from the child",
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
          const home = yield* makeTempDirectoryScoped("ws-home-")
          const { places, within } = yield* installed(home, { rift: NO_RIFT })
          const stored = yield* Ref.make<ReadonlyArray<Session>>([])
          /** Core stores the session, then the call is interrupted before it returns. */
          const storeThenStop = (sessionId: SessionId) => (params: CreateParams) =>
            Effect.gen(function* () {
              const now = yield* DateTime.nowAsDate
              const session = new Session({
                id: sessionId,
                cwd: params.cwd,
                // The calling session is always the parent (`Session.create` names none).
                parentSessionId: parentA.sessionId,
                parentBranchId: params.parentBranchId,
                createdAt: now,
                updatedAt: now,
              })
              yield* Ref.update(stored, (all) => [...all, session])
              return yield* Effect.interrupt
            })
          const admit = (
            id: string,
            session: Partial<
              Pick<ReturnType<typeof testToolContext>["Session"], "create" | "listSessions">
            >,
          ) =>
            runToolWithCtx(
              StartChild,
              { todo: "a task", isolation: "snapshot" },
              {
                ...testToolContext({
                  cwd: origin,
                  home,
                  sessionId: parentA.sessionId,
                  branchId: parentA.branchId,
                  Session: {
                    ...testToolContext().Session,
                    listSessions: () => Ref.get(stored),
                    ...session,
                  },
                }),
                toolCallId: ToolCallId.make(id),
              },
            ).pipe(Effect.provideService(Workspaces, places), Effect.exit)
          const copyOf = (id: string) =>
            within(places.locate({ key: key(id), cwd: origin })).pipe(
              Effect.map((start) => `${home}/.gent/workspaces/worktrees/${start.name}`),
            )
          // Stored, then stopped: the copy is the stored session's.
          const committed = SessionId.make("stored-child")
          const afterStore = yield* admit("call-stored", { create: storeThenStop(committed) })
          expect(Exit.hasInterrupts(afterStore)).toBe(true)
          const kept = yield* copyOf("call-stored")
          expect(yield* exists(kept)).toBe(true)
          expect(Option.map(yield* within(places.find(committed)), (found) => found.path)).toEqual(
            Option.some(kept),
          )
          // Stopped before anything was stored: the copy goes.
          const beforeStore = yield* admit("call-unstored", { create: () => Effect.interrupt })
          expect(Exit.hasInterrupts(beforeStore)).toBe(true)
          expect(yield* exists(yield* copyOf("call-unstored"))).toBe(false)
          // A check that cannot tell keeps the copy.
          const unknown = yield* admit("call-unknown", {
            create: storeThenStop(SessionId.make("unknown-child")),
            listSessions: () => Effect.die("the session list is not readable"),
          })
          expect(Exit.hasInterrupts(unknown)).toBe(true)
          expect(yield* exists(yield* copyOf("call-unknown"))).toBe(true)
        }),
      ),
  )
})

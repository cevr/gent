import { describe, expect, it } from "effect-bun-test"
import { Effect, Fiber, FileSystem, Option, Predicate, Schema, Stream } from "effect"
import { BunServices } from "@effect/platform-bun"
import type * as Prompt from "effect/ai/Prompt"
import { ExtensionContext, RequestId, runProcess } from "@gent/core/extensions/api"
import {
  createRpcHarness,
  finishPart,
  LanguageModelLayers,
  makeTempDirectoryScoped,
  testLeafContext,
  testToolContext,
  textDeltaPart,
  toolCallPart,
  waitFor,
} from "@gent/core/test-utils"
import { SessionId, ToolCallId } from "@gent/core/protocol"
import {
  makeWorkspacesExtension,
  riftPostcreateHooks,
  WORKSPACES_EXTENSION_ID,
  WorkspaceRecord,
  type WorkspacesOptions,
  workspacesService,
} from "../src/workspaces.js"
import { e2ePreset } from "./helpers/test-preset"
import { isToolResultFor } from "./helpers/tool-event.js"

// ── fixtures ────────────────────────────────────────────────────────────────

/** A rift program that does not exist: the copy falls back to a worktree. */
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
 */
const dirtyRepository = Effect.gen(function* () {
  const origin = yield* makeTempDirectoryScoped("ws-origin-")
  yield* sh(
    origin,
    [
      "git init -q -b main",
      "git config user.name Test",
      "git config user.email test@example.com",
      "mkdir sub",
      "printf 'one\\n' > kept.txt",
      "printf 'two\\n' > changed.txt",
      "printf 'three\\n' > deleted.txt",
      "printf 'deep\\n' > sub/deep.txt",
      "printf 'node_modules\\n' > .gitignore",
      "git add -A",
      "git commit -qm init",
      "printf 'two parent\\n' > changed.txt",
      "rm deleted.txt",
      "printf 'new\\n' > untracked.txt",
      "mkdir node_modules",
      "printf 'dep\\n' > node_modules/dep.js",
    ].join(" && "),
  )
  return yield* sh(origin, "pwd -P")
})

/** What `git status` and `HEAD` say of a working tree: the parent's view, compared before and after. */
const treeState = (repo: string) =>
  Effect.all({
    status: sh(repo, "git status --porcelain=v1 --untracked-files=all"),
    head: sh(repo, "git rev-parse HEAD"),
    changed: sh(repo, "cat changed.txt"),
  })

/**
 * The stub's program: it reads its mode from `mode` beside it, copies under
 * `copies/` beside it, and appends each request to `requests.log`.
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
  'if (request.command === "create") {',
  '  if (mode === "cow") {',
  '    answer({ status: "error", error: { code: "cow_unavailable", message: "copy-on-write is not available here" } })',
  "  } else {",
  '    const dest = dir + "/copies/" + request.name',
  '    fs.mkdirSync(dir + "/copies", { recursive: true })',
  '    execFileSync("cp", ["-a", request.from, dest])',
  '    if (mode === "hook") answer({ status: "error", error: { code: "hook_failed", message: "postcreate exited 1", path: dest, hook: "postcreate", committed: true } })',
  '    else answer({ status: "ok", value: dest })',
  "  }",
  '} else if (request.command === "remove") {',
  "  fs.rmSync(request.at, { recursive: true, force: true })",
  '  answer({ status: "ok", value: null })',
  "} else {",
  '  answer({ status: "error", error: { code: "invalid_request", message: "unknown" } })',
  "}",
].join("\n")

/**
 * A stand-in `rift` that answers `rpc` as rift does. It copies the source
 * with `cp -a` under `root`, logs each request, and answers per `mode`:
 * `ok`, `cow` (no copy-on-write here), or `hook` (a postcreate hook failed
 * after the copy was made).
 */
const riftStub = (mode: "ok" | "cow" | "hook") =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const dir = yield* makeTempDirectoryScoped("ws-rift-")
    const root = `${dir}/copies`
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
    return { program, root, requests }
  })

/** The service under a leaf context whose home is `home`, on the Bun platform. */
const places = (home: string, options: WorkspacesOptions) => {
  const service = workspacesService(options)
  const session = testToolContext().Session
  const leaf = testLeafContext(
    testToolContext({
      cwd: home,
      home,
      Session: { ...session, listActiveLoops: Effect.succeed([]) },
    }),
  )
  const within = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.provideService(ExtensionContext, leaf))
  return { service, within }
}

const exists = (file: string) =>
  Effect.gen(function* () {
    return yield* (yield* FileSystem.FileSystem).exists(file)
  }).pipe(Effect.orDie)

const key = (id: string) => RequestId.make(id)
const childSession = SessionId.make("child-session")

// ── the worktree copy ───────────────────────────────────────────────────────

describe("a worktree copy", () => {
  it.live(
    "holds the parent's working tree, at the parent's place, and leaves the parent as it was",
    () =>
      Effect.gen(function* () {
        const origin = yield* dirtyRepository
        const home = yield* makeTempDirectoryScoped("ws-home-")
        const before = yield* treeState(origin)
        const { service, within } = places(home, { rift: NO_RIFT })
        const place = yield* within(service.acquire({ key: key("call-1"), cwd: `${origin}/sub` }))
        expect(place.backend).toBe("worktree")
        expect(place.notes[0]).toContain("a git worktree, because rift did not run")
        expect(place.cwd).toBe(`${place.path}/sub`)
        expect(place.branch).toBe(`gent/${place.name}`)
        expect(yield* sh(place.path, "cat changed.txt")).toBe("two parent")
        expect(yield* sh(place.path, "cat untracked.txt")).toBe("new")
        expect(yield* exists(`${place.path}/deleted.txt`)).toBe(false)
        // An ignored dependency is not part of the working tree git keeps.
        expect(yield* exists(`${place.path}/node_modules`)).toBe(false)
        // The changes arrive unstaged, as the parent has them.
        expect(yield* sh(place.path, "git status --porcelain=v1 --untracked-files=all")).toBe(
          before.status.replace("?? node_modules/dep.js\n", ""),
        )
        expect(yield* treeState(origin)).toEqual(before)
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.timeout("20 seconds")),
  )

  it.live("adopts the copy a repeated start made, and gives another start its own", () =>
    Effect.gen(function* () {
      const origin = yield* dirtyRepository
      const home = yield* makeTempDirectoryScoped("ws-home-")
      const { service, within } = places(home, { rift: NO_RIFT })
      const first = yield* within(service.acquire({ key: key("call-1"), cwd: origin }))
      yield* sh(first.path, "printf 'mid\\n' > mid-turn.txt")
      const again = yield* within(service.acquire({ key: key("call-1"), cwd: origin }))
      expect(again.path).toBe(first.path)
      expect(again.notes).toEqual([])
      expect(yield* sh(again.path, "cat mid-turn.txt")).toBe("mid")
      const other = yield* within(service.acquire({ key: key("call-2"), cwd: origin }))
      expect(other.path).not.toBe(first.path)
      const worktrees = yield* sh(origin, "git worktree list --porcelain | grep -c '^worktree '")
      expect(worktrees).toBe("3")
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.timeout("20 seconds")),
  )

  it.live("runs the .rift.toml postcreate hooks in the copy, with rift's variables", () =>
    Effect.gen(function* () {
      const origin = yield* dirtyRepository
      yield* sh(
        origin,
        [
          'printf \'version = 1\\n\\n[[hooks.postcreate]]\\nrun = "printf %s \\\\"$RIFT_SOURCE\\\\" > from-hook.txt"\\n\' > .rift.toml',
          "git add .rift.toml",
          "git commit -qm hooks",
        ].join(" && "),
      )
      const home = yield* makeTempDirectoryScoped("ws-home-")
      const { service, within } = places(home, { rift: NO_RIFT })
      const place = yield* within(service.acquire({ key: key("call-1"), cwd: origin }))
      expect(yield* sh(place.path, "cat from-hook.txt")).toBe(origin)
      expect(place.notes).toHaveLength(1)
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.timeout("20 seconds")),
  )

  it.live("refuses a directory outside git, and a file system short of space", () =>
    Effect.gen(function* () {
      const plain = yield* makeTempDirectoryScoped("ws-plain-")
      const origin = yield* dirtyRepository
      const home = yield* makeTempDirectoryScoped("ws-home-")
      const roomy = places(home, { rift: NO_RIFT })
      const outside = yield* roomy.within(
        roomy.service.acquire({ key: key("call-1"), cwd: plain }).pipe(Effect.flip),
      )
      expect(outside.message).toContain("needs a git repository")
      const full = places(home, { rift: NO_RIFT, minimumFreeBytes: Number.MAX_SAFE_INTEGER })
      const refused = yield* full.within(
        full.service.acquire({ key: key("call-1"), cwd: origin }).pipe(Effect.flip),
      )
      expect(refused.message).toContain("a snapshot child needs")
      expect(refused.message).toContain('isolation "shared"')
      expect(yield* exists(`${home}/.gent/workspaces/worktrees`)).toBe(false)
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.timeout("20 seconds")),
  )
})

// ── collect and release ─────────────────────────────────────────────────────

describe("a copy's work", () => {
  it.live(
    "comes back as one commit over the parent's working tree, and the parent's tree stays",
    () =>
      Effect.gen(function* () {
        const origin = yield* dirtyRepository
        const home = yield* makeTempDirectoryScoped("ws-home-")
        const before = yield* treeState(origin)
        const { service, within } = places(home, { rift: NO_RIFT })
        const place = yield* within(service.acquire({ key: key("call-1"), cwd: origin }))
        yield* within(service.bind(place.name, childSession))
        yield* sh(
          place.path,
          "printf 'two child\\n' > changed.txt && printf 'child\\n' > child.txt",
        )
        const work = yield* within(service.collect(childSession))
        expect(Option.map(work, (found) => found.branch)).toEqual(
          Option.some(Option.some(place.branch)),
        )
        expect(
          Option.map(work, (found) => [found.files, found.insertions, found.deletions]),
        ).toEqual(Option.some([2, 2, 1]))
        // Only the child's own changes: the parent's uncommitted state is the base.
        expect(yield* sh(origin, `git show --name-only --format= ${place.branch}`)).toBe(
          "changed.txt\nchild.txt",
        )
        expect(yield* sh(origin, `git show ${place.branch}:changed.txt`)).toBe("two child")
        expect(yield* sh(origin, `git show ${place.branch}^:changed.txt`)).toBe("two parent")
        expect(yield* sh(origin, `git rev-parse ${place.branch}^^`)).toBe(before.head)
        expect(yield* treeState(origin)).toEqual(before)
        // The same work is the same commit.
        const commit = yield* sh(origin, `git rev-parse ${place.branch}`)
        yield* within(service.collect(childSession))
        expect(yield* sh(origin, `git rev-parse ${place.branch}`)).toBe(commit)
        // A copy put back as it started holds no work, and its branch goes.
        yield* sh(place.path, "printf 'two parent\\n' > changed.txt && rm child.txt")
        const none = yield* within(service.collect(childSession))
        expect(Option.map(none, (found) => found.branch)).toEqual(Option.some(Option.none()))
        expect(yield* sh(origin, "git branch --list 'gent/*'")).toBe("")
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.timeout("20 seconds")),
  )

  it.live("a released copy is gone, and its branch stays", () =>
    Effect.gen(function* () {
      const origin = yield* dirtyRepository
      const home = yield* makeTempDirectoryScoped("ws-home-")
      const { service, within } = places(home, { rift: NO_RIFT })
      const place = yield* within(service.acquire({ key: key("call-1"), cwd: origin }))
      yield* within(service.bind(place.name, childSession))
      // Work after the last collect still reaches the branch: the release collects first.
      yield* sh(place.path, "printf 'late\\n' > late.txt")
      yield* within(service.releaseSession(childSession))
      expect(yield* exists(place.path)).toBe(false)
      expect(yield* within(service.find(childSession))).toEqual(Option.none())
      expect(yield* sh(origin, `git show ${place.branch}:late.txt`)).toBe("late")
      expect(yield* sh(origin, "git worktree list --porcelain | grep -c '^worktree '")).toBe("1")
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.timeout("20 seconds")),
  )

  it.live("a copy idle for two days is pruned once its child is not running", () =>
    Effect.gen(function* () {
      const origin = yield* dirtyRepository
      const home = yield* makeTempDirectoryScoped("ws-home-")
      const fs = yield* FileSystem.FileSystem
      const { service, within } = places(home, { rift: NO_RIFT })
      const fresh = yield* within(service.acquire({ key: key("call-1"), cwd: origin }))
      const idle = yield* within(service.acquire({ key: key("call-2"), cwd: origin }))
      yield* within(service.bind(idle.name, childSession))
      const file = `${home}/.gent/workspaces/${idle.name}.json`
      const codec = Schema.fromJsonString(WorkspaceRecord)
      const record = yield* Schema.decodeEffect(codec)(yield* fs.readFileString(file))
      const threeDays = 3 * 24 * 60 * 60 * 1000
      yield* fs.writeFileString(
        file,
        yield* Schema.encodeEffect(codec)({ ...record, touchedAt: record.touchedAt - threeDays }),
      )
      yield* within(service.prune())
      expect(yield* exists(idle.path)).toBe(false)
      expect(yield* exists(fresh.path)).toBe(true)
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.timeout("20 seconds")),
  )
})

// ── the rift copy ───────────────────────────────────────────────────────────

describe("a rift copy", () => {
  it.live("is made by rift rpc, its work is fetched into the origin, and rift removes it", () =>
    Effect.gen(function* () {
      const origin = yield* dirtyRepository
      const home = yield* makeTempDirectoryScoped("ws-home-")
      const rift = yield* riftStub("ok")
      const before = yield* treeState(origin)
      const { service, within } = places(home, { rift: rift.program })
      const place = yield* within(service.acquire({ key: key("call-1"), cwd: origin }))
      expect(place.backend).toBe("rift")
      expect(place.path).toBe(`${rift.root}/${place.name}`)
      expect(place.notes).toEqual([])
      // A whole-tree copy only where the copy is one snapshot (btrfs).
      const btrfs = (yield* sh(origin, "stat -f -c %T .")) === "btrfs"
      expect(yield* rift.requests).toEqual([
        { command: "create", from: origin, name: place.name, copyAll: btrfs },
      ])
      yield* within(service.bind(place.name, childSession))
      yield* sh(place.path, "printf 'child\\n' > child.txt")
      const work = yield* within(service.collect(childSession))
      expect(Option.flatMap(work, (found) => found.branch)).toEqual(Option.some(place.branch))
      expect(yield* sh(origin, `git show ${place.branch}:child.txt`)).toBe("child")
      expect(yield* sh(origin, `git show --name-only --format= ${place.branch}`)).toBe("child.txt")
      expect(yield* treeState(origin)).toEqual(before)
      yield* within(service.releaseSession(childSession))
      expect(yield* exists(place.path)).toBe(false)
      expect((yield* rift.requests).at(-1)).toEqual({ command: "remove", at: place.path })
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.timeout("20 seconds")),
  )

  it.live("falls back to a worktree where rift cannot copy on write, and says why", () =>
    Effect.gen(function* () {
      const origin = yield* dirtyRepository
      const home = yield* makeTempDirectoryScoped("ws-home-")
      const rift = yield* riftStub("cow")
      const { service, within } = places(home, { rift: rift.program })
      const place = yield* within(service.acquire({ key: key("call-1"), cwd: origin }))
      expect(place.backend).toBe("worktree")
      expect(place.notes[0]).toContain("rift could not copy (cow_unavailable)")
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.timeout("20 seconds")),
  )

  it.live("keeps a copy whose postcreate hook failed, with a note", () =>
    Effect.gen(function* () {
      const origin = yield* dirtyRepository
      const home = yield* makeTempDirectoryScoped("ws-home-")
      const rift = yield* riftStub("hook")
      const { service, within } = places(home, { rift: rift.program })
      const place = yield* within(service.acquire({ key: key("call-1"), cwd: origin }))
      expect(place.backend).toBe("rift")
      expect(place.notes).toEqual(["postcreate hook failed: postcreate exited 1"])
      expect(yield* exists(`${place.path}/changed.txt`)).toBe(true)
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.timeout("20 seconds")),
  )
})

describe("the .rift.toml reader", () => {
  it.effect("reads the postcreate commands in order and refuses a form it does not read", () =>
    Effect.gen(function* () {
      const hooks = yield* riftPostcreateHooks(
        [
          "# setup",
          "version = 1",
          "[[hooks.precreate]]",
          'run = "pnpm run check"',
          "[[hooks.postcreate]]",
          'run = "bun install --frozen-lockfile" # dependencies',
          "[[hooks.postcreate]]",
          "run = 'echo \"$RIFT_ID\"'",
        ].join("\n"),
      )
      expect(hooks).toEqual(["bun install --frozen-lockfile", 'echo "$RIFT_ID"'])
      const inline = yield* riftPostcreateHooks(
        'version = 1\n[hooks]\npostcreate = [{ run = "x" }]',
      ).pipe(Effect.flip)
      expect(inline.message).toContain("line 2")
      const unversioned = yield* riftPostcreateHooks('[[hooks.postcreate]]\nrun = "x"').pipe(
        Effect.flip,
      )
      expect(unversioned.message).toContain("version = 1")
    }),
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
const harnessIn = (origin: string, home: string) =>
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

describe("a snapshot child", () => {
  it.live(
    "edits its own copy, leaves the parent's tree as it was, and hands back a branch that holds the edit",
    () =>
      Effect.gen(function* () {
        const origin = yield* dirtyRepository
        const home = yield* makeTempDirectoryScoped("ws-home-")
        const before = yield* treeState(origin)
        // A start that ran before a crash left its copy: the start adopts it.
        const earlier = places(home, { rift: NO_RIFT })
        const planted = yield* earlier.within(
          earlier.service.acquire({ key: key("start-1"), cwd: origin }),
        )
        const harness = yield* harnessIn(origin, home)
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
        expect(yield* sh(origin, "git worktree list --porcelain | grep -c '^worktree '")).toBe("2")
        // The child read where it works.
        const child = (yield* harness.client.session.list()).find(
          (session) => session.parentSessionId === harness.sessionId,
        )
        expect(child?.cwd).toBe(planted.cwd)
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
        expect(yield* sh(origin, "git worktree list --porcelain | grep -c '^worktree '")).toBe("1")
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
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.timeout("25 seconds")),
    30_000,
  )
})

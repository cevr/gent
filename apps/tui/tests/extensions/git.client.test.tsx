/** @jsxImportSource @opentui/solid */
import { describe, expect, it, test } from "effect-bun-test"
import { Effect, FileSystem, Option } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { BunServices } from "@effect/platform-bun"
import {
  AgentEvent,
  BranchId,
  dateFromMillis,
  EventEnvelope,
  SessionId,
  ToolCallId,
} from "@gent/core/protocol"
import { EventId, makeTempDirectoryScoped } from "@gent/core/test-utils"
import gitExtension, {
  branchText,
  type Checkout,
  checkoutLabels,
  parseNumstat,
  parseStatus,
  readCheckout,
} from "../../src/extensions/git.client"
import type { StatusLabelItem } from "../../src/extensions/client-facets"
import { App } from "../../src/app"
import { provideClientServices } from "../extension-test-harness-boundary"
import { createMockClient, createMockRuntime, renderScoped } from "../render-harness-boundary"
import { waitForFrame, waitUntil } from "../helpers-boundary"

const sessionId = SessionId.make("git-session")
const branchId = BranchId.make("git-branch")

/** A git command in `cwd` with a fixed author and no signing, so a commit never asks. */
const git = (cwd: string, ...args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const code = yield* spawner.exitCode(
      ChildProcess.make(
        "git",
        [
          "-c",
          "user.email=probe@gent.test",
          "-c",
          "user.name=probe",
          "-c",
          "commit.gpgsign=false",
          ...args,
        ],
        { cwd, forceKillAfter: "2 seconds" },
      ),
    )
    if (code !== 0) return yield* Effect.die(`git ${args.join(" ")} exited ${code}`)
  })

/** A repository on `trunk` with one commit that holds `kept.txt` (two lines). */
const makeRepo = (prefix: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const repo = yield* makeTempDirectoryScoped(prefix)
    yield* git(repo, "init", "-q", "-b", "trunk")
    yield* fs.writeFileString(`${repo}/kept.txt`, "one\ntwo\n")
    yield* git(repo, "add", "kept.txt")
    yield* git(repo, "commit", "-q", "-m", "first")
    return repo
  })

const labelTexts = (labels: ReadonlyArray<StatusLabelItem>) => labels.map((label) => label.text)

// ── parsers ─────────────────────────────────────────────────────────────────

describe("git status parsing", () => {
  test("a branch with an upstream reads its ahead and behind counts", () => {
    const { head } = parseStatus(
      [
        "# branch.oid 1a2b3c4d5e6f",
        "# branch.head main",
        "# branch.upstream origin/main",
        "# branch.ab +2 -1",
        "",
      ].join("\0"),
    )
    expect(Option.getOrNull(head.branch)).toBe("main")
    expect(Option.getOrNull(head.upstream)).toBe("origin/main")
    expect([head.ahead, head.behind]).toEqual([2, 1])
  })

  test("a detached head has no branch and an unborn branch has no commit", () => {
    const detached = parseStatus("# branch.oid 1a2b3c4d5e6f\0# branch.head (detached)\0").head
    expect(Option.isNone(detached.branch)).toBe(true)
    expect(Option.getOrNull(detached.oid)).toBe("1a2b3c4d5e6f")
    const unborn = parseStatus("# branch.oid (initial)\0# branch.head trunk\0").head
    expect(Option.getOrNull(unborn.branch)).toBe("trunk")
    expect(Option.isNone(unborn.oid)).toBe(true)
  })

  test("each kind of changed path reads as one entry with its letter", () => {
    const { entries } = parseStatus(
      [
        "# branch.oid 1a2b3c4d5e6f",
        "# branch.head main",
        "1 .M N... 100644 100644 100644 aaaa bbbb src/a file.ts",
        "1 A. N... 000000 100644 100644 0000 cccc added.ts",
        "1 .D N... 100644 100644 000000 dddd dddd gone.ts",
        "2 R. N... 100644 100644 100644 eeee eeee R100 new name.ts",
        "old name.ts",
        "u UU N... 100644 100644 100644 100644 ffff gggg hhhh both.ts",
        "? notes/todo.md",
        "",
      ].join("\0"),
    )
    expect(entries.map((entry) => [entry.status, entry.path])).toEqual([
      ["M", "src/a file.ts"],
      ["A", "added.ts"],
      ["D", "gone.ts"],
      ["R", "new name.ts"],
      ["U", "both.ts"],
      ["?", "notes/todo.md"],
    ])
    expect(Option.getOrNull(entries[3]?.from ?? Option.none())).toBe("old name.ts")
  })

  test("numstat keys a rename by its new path and a binary file has no line counts", () => {
    const counts = parseNumstat(
      ["12\t3\tsrc/a.ts", "4\t0\t", "old.ts", "new.ts", "-\t-\tlogo.png", ""].join("\0"),
    )
    expect(Option.getOrNull(counts.get("src/a.ts") ?? Option.none())).toEqual({
      added: 12,
      deleted: 3,
    })
    expect(Option.getOrNull(counts.get("new.ts") ?? Option.none())).toEqual({
      added: 4,
      deleted: 0,
    })
    expect(counts.has("old.ts")).toBe(false)
    expect(Option.isNone(counts.get("logo.png") ?? Option.some({ added: 0, deleted: 0 }))).toBe(
      true,
    )
  })
})

// ── labels ──────────────────────────────────────────────────────────────────

describe("git labels", () => {
  const head = {
    branch: Option.some("main"),
    oid: Option.some("1a2b3c4d5e6f"),
    upstream: Option.some("origin/main"),
    ahead: 0,
    behind: 0,
  }

  test("the branch label names the branch with its arrows, or the commit when detached", () => {
    expect(Option.getOrNull(branchText(head))).toBe("main")
    expect(Option.getOrNull(branchText({ ...head, ahead: 2, behind: 1 }))).toBe("main ↑2 ↓1")
    expect(Option.getOrNull(branchText({ ...head, branch: Option.none() }))).toBe(
      "detached @1a2b3c4",
    )
    expect(Option.getOrNull(branchText({ ...head, oid: Option.none() }))).toBe("main")
  })

  test("a clean checkout shows the branch alone and a dirty one adds the change count", () => {
    const clean: Checkout = { root: "/r", gitDir: "/r/.git", head, files: [] }
    expect(labelTexts(checkoutLabels(clean))).toEqual(["main"])
    const dirty: Checkout = {
      ...clean,
      files: [
        {
          path: "a.ts",
          from: Option.none(),
          status: "M",
          lines: Option.some({ added: 10, deleted: 4 }),
        },
        { path: "b.png", from: Option.none(), status: "A", lines: Option.none() },
        {
          path: "c.ts",
          from: Option.none(),
          status: "?",
          lines: Option.some({ added: 2, deleted: 0 }),
        },
      ],
    }
    const labels = checkoutLabels(dirty)
    expect(labelTexts(labels)).toEqual(["main", "3 files +12 -4"])
    expect(labels[1]?.short?.text).toBe("+12 -4")
  })
})

// ── reads ───────────────────────────────────────────────────────────────────

describe("git checkout read", () => {
  it.live("a read counts tracked, renamed, binary and untracked changes against HEAD", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const repo = yield* makeRepo("gent-git-read-")
      yield* fs.writeFileString(`${repo}/moved.txt`, "a\nb\nc\n")
      yield* git(repo, "add", "moved.txt")
      yield* git(repo, "commit", "-q", "-m", "second")
      yield* fs.writeFileString(`${repo}/kept.txt`, "one\nTWO\nthree\n")
      yield* git(repo, "mv", "moved.txt", "renamed.txt")
      yield* fs.writeFile(`${repo}/logo.bin`, new Uint8Array([0, 1, 2, 0]))
      yield* git(repo, "add", "logo.bin")
      yield* fs.makeDirectory(`${repo}/notes`)
      yield* fs.writeFileString(`${repo}/notes/todo.md`, "x\ny")
      const checkout = yield* readCheckout(`${repo}/notes`, new Map())
      if (Option.isNone(checkout)) return yield* Effect.die("no checkout")
      const byPath = new Map(checkout.value.files.map((file) => [file.path, file]))
      expect(checkout.value.root.endsWith(repo.split("/").pop() ?? "")).toBe(true)
      expect(byPath.get("kept.txt")?.status).toBe("M")
      expect(Option.getOrNull(byPath.get("kept.txt")?.lines ?? Option.none())).toEqual({
        added: 2,
        deleted: 1,
      })
      expect(byPath.get("renamed.txt")?.status).toBe("R")
      expect(Option.getOrNull(byPath.get("renamed.txt")?.from ?? Option.none())).toBe("moved.txt")
      expect(byPath.get("logo.bin")?.status).toBe("A")
      expect(Option.getOrNull(byPath.get("logo.bin")?.lines ?? Option.none())).toBeNull()
      expect(Option.getOrNull(byPath.get("notes/todo.md")?.lines ?? Option.none())).toEqual({
        added: 2,
        deleted: 0,
      })
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.timeout("8 seconds")),
  )

  it.live("an unborn branch counts its staged lines and a directory outside git has none", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const repo = yield* makeTempDirectoryScoped("gent-git-unborn-")
      yield* git(repo, "init", "-q", "-b", "fresh")
      yield* fs.writeFileString(`${repo}/a.txt`, "1\n2\n3\n")
      yield* git(repo, "add", "a.txt")
      const checkout = yield* readCheckout(repo, new Map())
      if (Option.isNone(checkout)) return yield* Effect.die("no checkout")
      expect(labelTexts(checkoutLabels(checkout.value))).toEqual(["fresh", "1 file +3 -0"])
      const outside = yield* makeTempDirectoryScoped("gent-git-outside-")
      expect(Option.isNone(yield* readCheckout(outside, new Map()))).toBe(true)
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.timeout("8 seconds")),
  )
})

// ── refresh ─────────────────────────────────────────────────────────────────

/** The extension's labels for `cwd`, with the event feed a test drives. */
const mountLabels = (cwd: string) =>
  Effect.gen(function* () {
    const subscribers = new Set<(envelope: EventEnvelope) => void>()
    const cleanups: Array<() => void> = []
    yield* Effect.addFinalizer(() => Effect.sync(() => cleanups.forEach((cleanup) => cleanup())))
    const contributions = yield* provideClientServices(gitExtension.setup, {
      workspace: { cwd, home: cwd },
      sessionEventSubscribers: subscribers,
      currentSession: () => ({ sessionId, branchId }),
      lifecycle: { addCleanup: (cleanup) => cleanups.push(cleanup) },
    })
    const produce = contributions.statusLabels?.[0]?.produce ?? (() => [])
    let ids = 0
    const emit = (event: AgentEvent) => {
      ids += 1
      const envelope = EventEnvelope.make({ id: EventId.make(ids), createdAt: ids, event })
      for (const subscriber of subscribers) subscriber(envelope)
    }
    const texts = () => labelTexts(produce())
    return { texts, emit }
  })

describe("git refresh", () => {
  it.live("a tool call reads the checkout again once the burst settles", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const repo = yield* makeRepo("gent-git-tool-")
      const { texts, emit } = yield* mountLabels(repo)
      yield* waitUntil(() => texts().join("|") === "trunk", "the clean checkout")
      yield* fs.writeFileString(`${repo}/written.txt`, "hello\n")
      emit(
        AgentEvent.cases.ToolCallSucceeded.make({
          sessionId,
          branchId,
          toolCallId: ToolCallId.make("call-1"),
          toolName: "write",
        }),
      )
      yield* waitUntil(() => texts().join("|") === "trunk|1 file +1 -0", "the written file", 2_500)
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.timeout("8 seconds")),
  )

  it.live("a turn's end reads the checkout again at once", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const repo = yield* makeRepo("gent-git-turn-")
      const { texts, emit } = yield* mountLabels(repo)
      yield* waitUntil(() => texts().join("|") === "trunk", "the clean checkout")
      yield* fs.writeFileString(`${repo}/kept.txt`, "one\n")
      emit(AgentEvent.cases.TurnCompleted.make({ sessionId, branchId, durationMs: 10 }))
      // Inside the tool settle time: the turn's end does not wait for it.
      yield* waitUntil(() => texts().join("|") === "trunk|1 file +0 -1", "the edited file", 700)
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.timeout("8 seconds")),
  )

  it.live("a commit made outside the session moves the labels through the git directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const repo = yield* makeRepo("gent-git-watch-")
      yield* fs.writeFileString(`${repo}/kept.txt`, "one\n")
      const { texts } = yield* mountLabels(repo)
      yield* waitUntil(() => texts().join("|") === "trunk|1 file +0 -1", "the edited file")
      yield* git(repo, "commit", "-q", "-am", "edit")
      yield* git(repo, "checkout", "-q", "-b", "next")
      yield* waitUntil(() => texts().join("|") === "next", "the commit and the checkout", 1_500)
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.timeout("8 seconds")),
  )
})

// ── status row ──────────────────────────────────────────────────────────────

const renderRow = (cwd: string, width: number) =>
  renderScoped(() => <App />, {
    client: createMockClient(),
    runtime: createMockRuntime(),
    builtins: [gitExtension],
    cwd,
    width,
    height: 20,
    initialSession: {
      id: sessionId,
      activeBranchId: branchId,
      name: "Git",
      createdAt: dateFromMillis(0),
      updatedAt: dateFromMillis(0),
    },
  })

const statusLine = (frame: string) => frame.split("\n").find((line) => line.includes("ready")) ?? ""

describe("git status row", () => {
  it.live(
    "a wide row shows the branch with its arrows and the changes; a narrow one their short forms",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const repo = yield* makeRepo("gent-git-row-")
        yield* git(repo, "branch", "base")
        yield* fs.writeFileString(`${repo}/ahead.txt`, "a\n")
        yield* git(repo, "add", "ahead.txt")
        yield* git(repo, "commit", "-q", "-m", "ahead")
        yield* git(repo, "checkout", "-q", "base")
        yield* fs.writeFileString(`${repo}/behind.txt`, "b\n")
        yield* git(repo, "add", "behind.txt")
        yield* git(repo, "commit", "-q", "-m", "behind")
        yield* git(repo, "checkout", "-q", "trunk")
        yield* git(repo, "branch", "-q", "--set-upstream-to=base")
        yield* fs.writeFileString(`${repo}/kept.txt`, "one\ntwo\nthree\n")
        yield* fs.writeFileString(`${repo}/new.txt`, "x\ny\n")

        const dir = repo.split("/").pop() ?? ""
        const full = `ready · ${dir} · trunk ↑1 ↓1 · 2 files +3 -0`
        const setup = yield* renderRow(repo, 120)
        const rowAt = (width: number, row: string) =>
          Effect.gen(function* () {
            setup.resize(width, 20)
            yield* waitForFrame(setup, (frame) => statusLine(frame).trim() === row, row)
          })
        yield* waitForFrame(setup, (frame) => statusLine(frame).trim() === full, full)
        // At 60 columns the whole row still fits.
        yield* rowAt(60, full)
        // The cwd goes first, then the change count takes its `+/-` form,
        // then the branch goes; the phase word stays last.
        yield* rowAt(40, "ready · trunk ↑1 ↓1 · 2 files +3 -0")
        yield* rowAt(30, "ready · trunk ↑1 ↓1 · +3 -0")
        yield* rowAt(20, "ready · +3 -0")
        yield* rowAt(120, full)
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.timeout("8 seconds")),
  )

  it.live("the status row names an unborn branch, and a detached head by its commit", () =>
    Effect.gen(function* () {
      const repo = yield* makeTempDirectoryScoped("gent-git-head-")
      const dir = repo.split("/").pop() ?? ""
      const rowOf = Effect.gen(function* () {
        const setup = yield* renderRow(repo, 60)
        const frame = yield* waitForFrame(
          setup,
          (next) => statusLine(next).trim() !== `ready · ${dir}`,
          "the branch",
        )
        return statusLine(frame).trim()
      }).pipe(Effect.scoped)
      yield* git(repo, "init", "-q", "-b", "trunk")
      expect(yield* rowOf).toBe(`ready · ${dir} · trunk`)
      yield* git(repo, "commit", "-q", "--allow-empty", "-m", "first")
      yield* git(repo, "checkout", "-q", "--detach")
      expect(yield* rowOf).toMatch(new RegExp(`^ready · ${dir} · detached @[0-9a-f]{7}$`))
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.timeout("8 seconds")),
  )

  // The labels watch the checkout's own git directory, which git names: a
  // session in a subdirectory, or in a worktree whose `.git` is a file,
  // follows a checkout as soon as git writes HEAD.
  it.live("the status row follows a checkout from a subdirectory and from a worktree", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const root = yield* makeTempDirectoryScoped("gent-git-follow-")
      const repo = `${root}/repo`
      yield* fs.makeDirectory(`${repo}/sub`, { recursive: true })
      yield* git(repo, "init", "-q", "-b", "trunk")
      yield* git(repo, "commit", "-q", "--allow-empty", "-m", "first")
      yield* git(repo, "worktree", "add", "-q", "-b", "side", `${root}/worktree`)
      const follows = (cwd: string, label: string, before: string, after: string) =>
        Effect.gen(function* () {
          const setup = yield* renderRow(cwd, 120)
          yield* waitForFrame(
            setup,
            (frame) => statusLine(frame).trim() === `ready · ${label} · ${before}`,
            before,
          )
          yield* git(cwd, "checkout", "-q", "-b", after)
          yield* waitForFrame(
            setup,
            (frame) => statusLine(frame).trim() === `ready · ${label} · ${after}`,
            after,
            1_500,
          )
        }).pipe(Effect.scoped)
      yield* follows(`${repo}/sub`, "repo/sub", "trunk", "feature")
      yield* follows(`${root}/worktree`, "worktree", "side", "side-next")
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.timeout("8 seconds")),
  )
})

/** @jsxImportSource @opentui/solid */
import { describe, expect, it, test } from "effect-bun-test"
import { Clock, Effect, Fiber, FileSystem, Option, Result, Schedule } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { BunServices } from "@effect/platform-bun"
import { RendererControlState } from "@opentui/core"
import {
  AgentEvent,
  BranchId,
  dateFromMillis,
  EventEnvelope,
  SessionId,
  ToolCallId,
} from "@gent/core/protocol"
import { runProcess } from "@gent/core/extensions/api"
import { EventId, makeTempDirectoryScoped } from "@gent/core/test-utils"
import gitExtension, {
  branchText,
  type Checkout,
  checkoutLabels,
  checksVerdict,
  parseNumstat,
  parseStatus,
  readCheckout,
  readPullRequest,
  reviewTarget,
  pageWorkTree,
  pagerCommand,
  workTreeCommand,
} from "../../src/extensions/git.client"
import type { StatusLabelItem } from "../../src/extensions/client-facets"
import { App } from "../../src/app"
import { provideClientServices } from "../extension-test-harness-boundary"
import {
  createMockClient,
  createMockRuntime,
  renderScoped,
  type TestTools,
  testPlatformLayer,
  testPlatformServices,
  renderFrame,
} from "../render-harness-boundary"
import { waitForFrame, waitUntil } from "../helpers-boundary"
import { makeHandover } from "../../src/os"

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

/** The empty tree of a SHA-1 repository: an unborn branch's base. */
const SHA1_EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"

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
    const clean: Checkout = { root: "/r", gitDir: "/r/.git", base: "HEAD", head, files: [] }
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

  it.live(
    "an unborn branch counts its lines against the empty tree and a directory outside git has none",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const repo = yield* makeTempDirectoryScoped("gent-git-unborn-")
        yield* git(repo, "init", "-q", "-b", "fresh")
        yield* fs.writeFileString(`${repo}/a.txt`, "1\n2\n3\n")
        yield* git(repo, "add", "a.txt")
        // A line added after the staging counts too: the change is the work tree, as against HEAD.
        yield* fs.writeFileString(`${repo}/a.txt`, "1\n2\n3\n4\n")
        const checkout = yield* readCheckout(repo, new Map())
        if (Option.isNone(checkout)) return yield* Effect.die("no checkout")
        expect(checkout.value.base).toBe(SHA1_EMPTY_TREE)
        expect(labelTexts(checkoutLabels(checkout.value))).toEqual(["fresh", "1 file +4 -0"])
        const outside = yield* makeTempDirectoryScoped("gent-git-outside-")
        expect(Option.isNone(yield* readCheckout(outside, new Map()))).toBe(true)
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.timeout("8 seconds")),
  )
})

// ── refresh ─────────────────────────────────────────────────────────────────

/** The extension's labels for `cwd`, with the event feed a test drives. */
const mountLabels = (cwd: string, tools: TestTools = {}) =>
  Effect.gen(function* () {
    const subscribers = new Set<(envelope: EventEnvelope) => void>()
    const cleanups: Array<() => void> = []
    yield* Effect.addFinalizer(() => Effect.sync(() => cleanups.forEach((cleanup) => cleanup())))
    const contributions = yield* provideClientServices(gitExtension.setup, {
      workspace: { cwd, home: cwd },
      sessionEventSubscribers: subscribers,
      currentSession: () => ({ sessionId, branchId }),
      lifecycle: { addCleanup: (cleanup) => cleanups.push(cleanup) },
      tools,
    })
    const produce = contributions.statusLabels?.[0]?.produce ?? (() => [])
    let ids = 0
    const emit = (event: AgentEvent) => {
      ids += 1
      const envelope = EventEnvelope.make({ id: EventId.make(ids), createdAt: ids, event })
      for (const subscriber of subscribers) subscriber(envelope)
    }
    const texts = () => labelTexts(produce())
    const labels = () => produce()
    return { texts, labels, emit }
  })

/**
 * A stand-in `gh` in its own directory: it appends a line to `calls` on each
 * run, then prints `stdout` with `CALLS` replaced by the count of runs so
 * far, prints `stderr` to its error stream and exits with `code`.
 */
const fakeGh = (reply: {
  readonly stdout?: string
  readonly stderr?: string
  readonly code?: number
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const dir = yield* makeTempDirectoryScoped("gent-fake-gh-")
    const program = `${dir}/gh`
    yield* fs.writeFileString(`${dir}/stdout`, reply.stdout ?? "")
    yield* fs.writeFileString(`${dir}/stderr`, reply.stderr ?? "")
    yield* fs.writeFileString(
      program,
      [
        "#!/bin/sh",
        `echo "$*" >> '${dir}/calls'`,
        `n=$(wc -l < '${dir}/calls' | tr -d ' ')`,
        `sed "s/CALLS/$n/" '${dir}/stdout'`,
        `cat '${dir}/stderr' >&2`,
        `exit ${reply.code ?? 0}`,
        "",
      ].join("\n"),
    )
    yield* fs.chmod(program, 0o755)
    const calls = fs.readFileString(`${dir}/calls`).pipe(
      Effect.map((text) => text.split("\n").filter((line) => line.length > 0).length),
      Effect.orElseSucceed(() => 0),
    )
    return { program, calls }
  })

/** `gh pr view --json` for open pull request 7, whose one check passed. */
const PR_JSON =
  '{"number":7,"title":"Show the branch","url":"https://github.invalid/o/r/pull/7",' +
  '"state":"OPEN","isDraft":false,"reviewDecision":"",' +
  '"statusCheckRollup":[{"__typename":"CheckRun","status":"COMPLETED","conclusion":"SUCCESS"}]}'

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

describe("git pull request", () => {
  test("checks fail on any failure, then wait on any running check, then pass", () => {
    expect(checksVerdict([])).toBe("none")
    expect(
      checksVerdict([
        { status: "COMPLETED", conclusion: "SUCCESS" },
        { status: "IN_PROGRESS", conclusion: "" },
        { state: "FAILURE" },
      ]),
    ).toBe("fail")
    expect(
      checksVerdict([{ status: "COMPLETED", conclusion: "SUCCESS" }, { state: "PENDING" }]),
    ).toBe("pending")
    expect(
      checksVerdict([{ status: "COMPLETED", conclusion: "SKIPPED" }, { state: "SUCCESS" }]),
    ).toBe("pass")
  })

  test("the label names the request with its checks, or says it is a draft, merged or closed", () => {
    const checkout: Checkout = {
      root: "/r",
      gitDir: "/r/.git",
      base: "HEAD",
      head: {
        branch: Option.some("main"),
        oid: Option.some("1a2b3c4"),
        upstream: Option.none(),
        ahead: 0,
        behind: 0,
      },
      files: [],
    }
    const pr = {
      number: 7,
      title: "t",
      url: "u",
      state: "OPEN",
      isDraft: false,
      statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
    }
    const labelOf = (fields: Partial<typeof pr>) => {
      const labels = checkoutLabels(checkout, Option.some({ ...pr, ...fields }))
      return [labels[1]?.text, labels[1]?.color]
    }
    expect(labelOf({})).toEqual(["#7 ✓", "success"])
    expect(
      labelOf({ statusCheckRollup: [{ status: "COMPLETED", conclusion: "FAILURE" }] }),
    ).toEqual(["#7 ✗", "error"])
    expect(labelOf({ statusCheckRollup: [{ status: "QUEUED", conclusion: "" }] })).toEqual([
      "#7 …",
      "warning",
    ])
    expect(labelOf({ statusCheckRollup: [] })).toEqual(["#7", "textMuted"])
    expect(labelOf({ isDraft: true })).toEqual(["#7 draft", "textMuted"])
    expect(labelOf({ state: "MERGED" })).toEqual(["#7 merged", "textMuted"])
    expect(labelOf({ state: "CLOSED" })).toEqual(["#7 closed", "textMuted"])
  })

  it.live("gh answers a request, no request, a sign-in failure, or is not there", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTempDirectoryScoped("gent-git-gh-")
      const readWith = (tools: TestTools) =>
        readPullRequest(cwd).pipe(Effect.result, Effect.provide(testPlatformLayer(tools)))
      const open = yield* fakeGh({ stdout: PR_JSON })
      const found = yield* readWith({ gh: open.program })
      expect(Result.isSuccess(found) && Option.getOrNull(found.success)?.number).toBe(7)
      expect(yield* open.calls).toBe(1)
      const none = yield* fakeGh({
        stderr: 'no pull requests found for branch "trunk"\n',
        code: 1,
      })
      const absent = yield* readWith({ gh: none.program })
      expect(Result.isSuccess(absent) && Option.isNone(absent.success)).toBe(true)
      const signedOut = yield* fakeGh({
        stderr: "To get started with GitHub CLI, please run:  gh auth login\n",
        code: 4,
      })
      const refused = yield* readWith({ gh: signedOut.program })
      expect(Result.isFailure(refused) && refused.failure._tag).toBe("GhReadError")
      const missing = yield* readWith({})
      expect(Result.isFailure(missing) && missing.failure._tag).toBe("GhMissing")
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.timeout("8 seconds")),
  )

  it.live("the pull request label follows a commit and leaves gh alone for an edit", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const repo = yield* makeRepo("gent-git-pr-")
      yield* git(repo, "branch", "base")
      yield* git(repo, "branch", "-q", "--set-upstream-to=base")
      // The stand-in names its request by the count of asks, so the label
      // says how many times gh ran.
      const gh = yield* fakeGh({ stdout: PR_JSON.replace('"number":7', '"number":CALLS') })
      const { texts, emit } = yield* mountLabels(repo, { gh: gh.program })
      yield* waitUntil(() => texts().join("|") === "trunk|#1 ✓", "the pull request")
      // A commit moves the branch ahead of its upstream: the request is asked again.
      yield* fs.writeFileString(`${repo}/kept.txt`, "one\n")
      yield* git(repo, "commit", "-q", "-am", "ahead")
      yield* waitUntil(() => texts().join("|") === "trunk ↑1|#2 ✓", "the commit", 1_500)
      // An edit changes no branch fact: the labels move, gh is not asked.
      yield* fs.writeFileString(`${repo}/kept.txt`, "one\ntwo\n")
      emit(AgentEvent.cases.TurnCompleted.make({ sessionId, branchId, durationMs: 10 }))
      yield* waitUntil(() => texts().join("|") === "trunk ↑1|#2 ✓|1 file +1 -0", "the edit")
      // The next commit is the third ask; an ask for the edit would make it the fourth.
      yield* git(repo, "commit", "-q", "-am", "ahead again")
      yield* waitUntil(() => texts().join("|") === "trunk ↑2|#3 ✓", "the next commit", 1_500)
      expect(yield* gh.calls).toBe(3)
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.timeout("8 seconds")),
  )

  it.live("with no gh on the path the labels show no pull request", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const repo = yield* makeRepo("gent-git-nogh-")
      yield* fs.writeFileString(`${repo}/kept.txt`, "one\n")
      const { texts } = yield* mountLabels(repo)
      yield* waitUntil(() => texts().join("|") === "trunk|1 file +0 -1", "the checkout")
      yield* git(repo, "checkout", "-q", "-b", "next")
      yield* waitUntil(() => texts().join("|") === "next|1 file +0 -1", "the branch move", 1_500)
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.timeout("8 seconds")),
  )
})

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

// ── review ──────────────────────────────────────────────────────────────────

describe("git review commands", () => {
  test("/diff names the work tree, some paths in it, or the branch's pull request", () => {
    expect(reviewTarget("", "/r")).toEqual({ _tag: "WorkTree", cwd: "/r", pathspecs: [] })
    expect(reviewTarget(" a.ts  src/b.ts ", "/r")).toEqual({
      _tag: "WorkTree",
      cwd: "/r",
      pathspecs: ["a.ts", "src/b.ts"],
    })
    expect(reviewTarget("pr", "/r")).toEqual({ _tag: "PullRequest", cwd: "/r" })
  })

  test("hunk reviews the work tree against the checkout's base", () => {
    const all = { _tag: "WorkTree" as const, cwd: "/r", pathspecs: [] }
    const one = { ...all, pathspecs: ["a.ts"] }
    // Against HEAD, so a staged change shows as the pane counts it.
    expect(workTreeCommand(all, "HEAD")).toEqual(["hunk", ["diff", "--watch", "HEAD"]])
    expect(workTreeCommand(one, "HEAD")).toEqual([
      "hunk",
      ["diff", "--watch", "HEAD", "--", "a.ts"],
    ])
    // An unborn branch has no HEAD: its base is the empty tree.
    expect(workTreeCommand(all, SHA1_EMPTY_TREE)).toEqual([
      "hunk",
      ["diff", "--watch", SHA1_EMPTY_TREE],
    ])
  })

  test("a pager setting of words runs as that program, and one with shell syntax runs in sh as git runs it", () => {
    expect(pagerCommand("less")).toEqual(["less", []])
    expect(pagerCommand("less  -R\t-S")).toEqual(["less", ["-R", "-S"]])
    for (const pager of [
      "delta | less",
      "LESS=R less",
      "less '-R'",
      "$HOME/bin/pager",
      "~/pager",
    ]) {
      expect(pagerCommand(pager)).toEqual(["sh", ["-c", pager, pager]])
    }
  })
})

/**
 * A stand-in program: a shell script, in its own directory, made of the lines
 * `script` gives for that directory. `log` reads `<dir>/log`.
 */
const fakeProgram = (name: string, script: (dir: string) => ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const dir = yield* makeTempDirectoryScoped(`gent-fake-${name}-`)
    const program = `${dir}/${name}`
    yield* fs.writeFileString(program, ["#!/bin/sh", ...script(dir), ""].join("\n"))
    yield* fs.chmod(program, 0o755)
    const log = fs.readFileString(`${dir}/log`).pipe(Effect.orElseSucceed(() => ""))
    return { program, dir, log }
  })

/** A `hunk` that logs where it ran and its arguments, and the patch it was handed. */
const fakeHunk = fakeProgram("hunk", (dir) => [
  `echo "$PWD|$*" >> '${dir}/log'`,
  `if [ "$1" = patch ]; then cat "$2" >> '${dir}/log'; fi`,
])

/** A `gh` whose `pr view` answers `view` and whose `pr diff` prints `patch`. */
const fakePullRequestGh = (view: string, patch: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const gh = yield* fakeProgram("gh", (dir) => [
      `if [ "$2" = diff ]; then cat '${dir}/patch'; else cat '${dir}/view'; fi`,
    ])
    yield* fs.writeFileString(`${gh.dir}/view`, view)
    yield* fs.writeFileString(`${gh.dir}/patch`, patch)
    return gh
  })

/** Open pull request 7 with a title too long for a narrow pane, whose one check passed. */
const LONG_PR_JSON = PR_JSON.replace(
  '"title":"Show the branch"',
  '"title":"Show the branch, its pull request and the changed lines in the composer"',
)

const PATCH = "diff --git a/kept.txt b/kept.txt\n--- a/kept.txt\n+++ b/kept.txt\n"

/** The app on `cwd`, with `tools` for `gh` and `hunk`. */
const renderApp = (cwd: string, width: number, tools: TestTools) =>
  Effect.gen(function* () {
    const services = yield* testPlatformServices(tools)
    return yield* renderScoped(() => <App />, {
      client: createMockClient(),
      runtime: createMockRuntime(),
      builtins: [gitExtension],
      services,
      cwd,
      width,
      height: 30,
      initialSession: {
        id: sessionId,
        activeBranchId: branchId,
        name: "Git",
        createdAt: dateFromMillis(0),
        updatedAt: dateFromMillis(0),
      },
    })
  })

type RenderSetup = Effect.Success<ReturnType<typeof renderApp>>

/** Run `/<command>` from the composer. */
const slash = (setup: RenderSetup, command: string) =>
  Effect.gen(function* () {
    yield* Effect.promise(() => setup.mockInput.typeText(command))
    setup.mockInput.pressEnter()
  })

const frameLine = (frame: string, text: string) =>
  frame.split("\n").find((line) => line.includes(text)) ?? ""

describe("git pane", () => {
  it.live(
    "/git lists the changed files and the pull request, fits a narrow terminal, and esc or ctrl+c closes it",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const repo = yield* makeRepo("gent-git-pane-")
        yield* fs.writeFileString(`${repo}/kept.txt`, "one\ntwo\nthree\n")
        const deep = "docs/notes/of/the/review/pane/in/a/narrow/terminal.md"
        yield* fs.makeDirectory(`${repo}/docs/notes/of/the/review/pane/in/a/narrow`, {
          recursive: true,
        })
        yield* fs.writeFileString(`${repo}/${deep}`, "a\nb\nc\n")
        const gh = yield* fakePullRequestGh(LONG_PR_JSON, PATCH)
        const setup = yield* renderApp(repo, 120, { gh: gh.program })
        yield* waitForFrame(setup, (frame) => frame.includes("#7 ✓"), "the pull request label")
        yield* slash(setup, "/git")
        const wide = yield* waitForFrame(
          setup,
          (frame) => frame.includes("git · trunk · 2 files +4 -0"),
          "the git pane",
        )
        expect(frameLine(wide, "kept.txt")).toMatch(/M {2}kept\.txt +\+1 -0/)
        expect(frameLine(wide, "terminal.md")).toMatch(new RegExp(`\\? {2}${deep} +\\+3`))
        expect(frameLine(wide, "#7 Show")).toContain(
          "#7 Show the branch, its pull request and the changed lines in the composer · open · checks ✓",
        )
        expect(wide).toContain("↑↓ move · enter review · esc close")

        // Narrow: the long path keeps its end, the request its number and verdict.
        setup.resize(60, 30)
        const narrow = yield* waitForFrame(
          setup,
          (frame) => frameLine(frame, "#7 Show").includes("· open · ✓"),
          "the narrow pane",
        )
        expect(frameLine(narrow, "terminal.md")).toMatch(/\? {2}…\/.*narrow\/terminal\.md +\+3/)
        expect(frameLine(narrow, "#7 Show")).not.toContain("checks")
        setup.resize(120, 30)
        yield* waitForFrame(
          setup,
          (frame) => frameLine(frame, "#7 Show").includes("· open · checks ✓"),
          "the wide pane again",
        )

        setup.mockInput.pressEscape()
        yield* waitForFrame(setup, (frame) => !frame.includes("git · trunk"), "esc closes")
        yield* slash(setup, "/git")
        yield* waitForFrame(setup, (frame) => frame.includes("git · trunk"), "the pane again")
        setup.mockInput.pressKey("c", { ctrl: true })
        yield* waitForFrame(setup, (frame) => !frame.includes("git · trunk"), "ctrl+c closes")
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.timeout("12 seconds")),
    15_000,
  )

  it.live(
    "the pane names a gh that is not signed in in its note row",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const repo = yield* makeRepo("gent-git-note-")
        yield* fs.writeFileString(`${repo}/kept.txt`, "one\n")
        const gh = yield* fakeGh({
          stderr: "To get started with GitHub CLI, please run:  gh auth login\n",
          code: 4,
        })
        const setup = yield* renderApp(repo, 80, { gh: gh.program })
        yield* slash(setup, "/git")
        yield* waitForFrame(
          setup,
          (frame) =>
            frame.includes("git · trunk · 1 file +0 -1") &&
            frame.includes("gh is not signed in · gh auth login"),
          "the note row",
        )
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.timeout("10 seconds")),
    12_000,
  )

  it.live(
    "enter on a file hands the terminal to hunk at the checkout's root, and on the request hands it gh's patch",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const repo = yield* makeRepo("gent-git-enter-")
        yield* fs.makeDirectory(`${repo}/sub`)
        yield* fs.writeFileString(`${repo}/kept.txt`, "one\ntwo\nthree\n")
        const hunk = yield* fakeHunk
        const gh = yield* fakePullRequestGh(PR_JSON, PATCH)
        const setup = yield* renderApp(`${repo}/sub`, 100, { gh: gh.program, hunk: hunk.program })
        yield* waitForFrame(setup, (frame) => frame.includes("#7 ✓"), "the pull request label")
        yield* slash(setup, "/git")
        yield* waitForFrame(setup, (frame) => frame.includes("#7 Show the branch"), "the pane")
        setup.mockInput.pressEnter()
        const realRepo = yield* fs.realPath(repo)
        yield* waitForLog(hunk.log, (log) =>
          log.includes(`${realRepo}|diff --watch HEAD -- kept.txt`),
        )
        // Keys belong to hunk until the renderer takes the terminal back.
        yield* waitUntil(
          () => setup.renderer.controlState !== RendererControlState.EXPLICIT_SUSPENDED,
          "the terminal back",
        )
        // The pane stays open for the next row.
        yield* waitForFrame(setup, (frame) => frame.includes("#7 Show the branch"), "the pane")
        setup.mockInput.pressArrow("down")
        yield* Effect.promise(() => setup.renderOnce())
        setup.mockInput.pressEnter()
        const log = yield* waitForLog(hunk.log, (text) => text.includes(PATCH))
        expect(log).toMatch(/\|patch .*gent-pr-.*\.patch\n/)
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.timeout("10 seconds")),
    12_000,
  )

  it.live(
    "without hunk, /diff pages the untracked files' lines too in git's colors, writes nothing to the repository, and says hunk was not found",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const repo = yield* makeRepo("gent-git-pager-")
        yield* fs.writeFileString(`${repo}/kept.txt`, "one\ntwo\nthree\n")
        yield* fs.writeFileString(`${repo}/new.txt`, "brand new line\n")
        // A tracked file whose time moved but not its lines: a diff that may
        // write would refresh its index entry.
        yield* fs.writeFileString(`${repo}/same.txt`, "same\n")
        yield* git(repo, "add", "same.txt")
        yield* git(repo, "commit", "-q", "-m", "same")
        const seconds = (yield* Clock.currentTimeMillis) / 1000
        yield* fs.utimes(`${repo}/same.txt`, seconds, seconds + 60)
        const pager = yield* fakeProgram("pager", (dir) => [`cat > '${dir}/log'`])
        yield* git(repo, "config", "core.pager", pager.program)
        yield* git(repo, "config", "color.diff", "always")
        // A hook that writes: the review must never give it a reason to run.
        yield* fs.writeFileString(
          `${repo}/.git/hooks/post-index-change`,
          `#!/bin/sh\ntouch '${pager.dir}/hook-ran'\n`,
        )
        yield* fs.chmod(`${repo}/.git/hooks/post-index-change`, 0o755)
        const objects = yield* gitOutput(repo, "count-objects", "-v")
        const index = yield* fs.readFile(`${repo}/.git/index`)
        const setup = yield* renderApp(repo, 100, {})
        yield* waitForFrame(setup, (frame) => frame.includes("2 files +2 -0"), "the checkout")
        yield* slash(setup, "/diff")
        yield* waitForFrame(
          setup,
          (frame) => frame.includes("hunk not found · using the git pager"),
          "the note",
        )
        const paged = yield* waitForLog(pager.log, (log) => plain(log).includes("+brand new line"))
        expect(plain(paged)).toContain("+three")
        expect(plain(paged)).toContain("+++ b/new.txt")
        // color.diff=always: the pager gets git's colors, as `git diff` would give it.
        expect(paged).toContain("\u001b[")
        // No object, no index write, no hook; the untracked file stays untracked.
        expect(yield* gitOutput(repo, "count-objects", "-v")).toBe(objects)
        expect(yield* fs.readFile(`${repo}/.git/index`)).toEqual(index)
        expect(yield* fs.exists(`${pager.dir}/hook-ran`)).toBe(false)
        expect(yield* gitOutput(repo, "--no-optional-locks", "status", "--porcelain")).toContain(
          "?? new.txt",
        )

        // Where git would not color for a terminal, the pager gets no colors.
        yield* waitUntil(
          () => setup.renderer.controlState !== RendererControlState.EXPLICIT_SUSPENDED,
          "the terminal back",
        )
        yield* git(repo, "config", "color.diff", "false")
        yield* fs.remove(`${pager.dir}/log`)
        yield* slash(setup, "/diff")
        const uncolored = yield* waitForLog(pager.log, (log) => log.includes("+brand new line"))
        expect(uncolored).not.toContain("\u001b[")
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.timeout("10 seconds")),
    12_000,
  )

  it.live(
    "without hunk, /diff pr pages gh's patch with the git pager",
    () =>
      Effect.gen(function* () {
        const repo = yield* makeRepo("gent-git-pr-pager-")
        const pager = yield* fakeProgram("pager", (dir) => [`cat > '${dir}/log'`])
        yield* git(repo, "config", "core.pager", pager.program)
        const gh = yield* fakePullRequestGh(PR_JSON, PATCH)
        const setup = yield* renderApp(repo, 100, { gh: gh.program })
        yield* waitForFrame(setup, (frame) => frame.includes("#7 ✓"), "the pull request label")
        yield* slash(setup, "/diff pr")
        yield* waitForFrame(
          setup,
          (frame) => frame.includes("hunk not found · using the git pager"),
          "the note",
        )
        yield* waitForLog(pager.log, (log) => log.includes(PATCH))
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.timeout("10 seconds")),
    12_000,
  )

  it.live(
    "an interrupted page stops the patch and the pager before gent takes the terminal back",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const repo = yield* makeRepo("gent-git-stop-")
        // More patch than a pipe holds: git waits on a pager that never reads.
        yield* fs.writeFileString(
          `${repo}/big.txt`,
          "a line of the untracked file\n".repeat(40_000),
        )
        // The pager ignores SIGPIPE and sleeps as one process, as `less` waits for a key.
        const pager = yield* fakeProgram("pager", (dir) => [
          `echo $$ > '${dir}/log'`,
          "trap '' PIPE",
          "exec sleep 600",
        ])
        yield* git(repo, "config", "core.pager", pager.program)
        const watched: Array<number> = []
        let aliveAtResume: ReadonlyArray<number> = [-1]
        const handover = makeHandover({
          suspend: () => {},
          resume: () => {
            aliveAtResume = watched.filter(isAlive)
          },
        })
        const review = yield* Effect.forkChild(
          handover(pageWorkTree({ _tag: "WorkTree", cwd: repo, pathspecs: [] }, "HEAD")),
        )
        const pagerPid = Number((yield* waitForLog(pager.log, (log) => log.endsWith("\n"))).trim())
        watched.push(pagerPid)
        // A test that fails leaves no sleeper behind.
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => watched.filter(isAlive).forEach((pid) => process.kill(pid, "SIGKILL"))),
        )
        const producer = yield* waitForLog(childGits, (pids) => pids.length > 0)
        watched.push(...producer.split("\n").map(Number))
        yield* Fiber.interrupt(review)
        expect(aliveAtResume).toEqual([])
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.timeout("10 seconds")),
    12_000,
  )

  it.live(
    "a pager the reader quits before the patch ends closes the review with no failure and no git left",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const repo = yield* makeRepo("gent-git-quit-")
        yield* fs.writeFileString(
          `${repo}/big.txt`,
          "a line of the untracked file\n".repeat(40_000),
        )
        // The reader reads a screen and quits: the pager closes the pipe under the patch.
        const pager = yield* fakeProgram("pager", () => ["exec head -c 4096 > /dev/null"])
        yield* git(repo, "config", "core.pager", pager.program)
        const handover = makeHandover({ suspend: () => {}, resume: () => {} })
        yield* handover(pageWorkTree({ _tag: "WorkTree", cwd: repo, pathspecs: [] }, "HEAD"))
        expect(yield* childGits).toBe("")
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.timeout("10 seconds")),
    12_000,
  )

  it.live(
    "a review the reader stops with a signal names no failure",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const repo = yield* makeRepo("gent-git-stopped-")
        yield* fs.writeFileString(`${repo}/kept.txt`, "one\ntwo\nthree\n")
        // ctrl+c in a cooked terminal reaches the program, which ends on the signal.
        const hunk = yield* fakeProgram("hunk", (dir) => [
          `echo "$*" >> '${dir}/log'`,
          "kill -TERM $$",
        ])
        const setup = yield* renderApp(repo, 100, { hunk: hunk.program })
        yield* waitForFrame(setup, (frame) => frame.includes("1 file +1 -0"), "the checkout")
        yield* slash(setup, "/diff")
        yield* waitForLog(hunk.log, (log) => log.includes("diff --watch HEAD"))
        yield* waitUntil(
          () => setup.renderer.controlState !== RendererControlState.EXPLICIT_SUSPENDED,
          "the terminal back",
        )
        yield* Effect.promise(() => setup.renderOnce())
        expect(renderFrame(setup)).not.toContain("failed")
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.timeout("10 seconds")),
    12_000,
  )
})

/** `text` without its color escapes. */
const plain = (text: string) => {
  const [first = "", ...escaped] = text.split("\u001b")
  return [first, ...escaped.map((part) => part.replace(/^\[[0-9;]*m/, ""))].join("")
}

/** The process is there: signal 0 finds it. */
const isAlive = (pid: number) => Result.isSuccess(Result.try(() => process.kill(pid, 0)))

/** The ids of the `git` processes this test process runs, one per line. */
const childGits = runProcess("pgrep", ["-P", String(process.pid), "-x", "git"]).pipe(
  Effect.map((result) => result.stdout.trim()),
  Effect.orElseSucceed(() => ""),
)

/** What a git command in `cwd` prints. */
const gitOutput = (cwd: string, ...args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    return yield* spawner.string(
      ChildProcess.make("git", [...args], { cwd, forceKillAfter: "2 seconds" }),
    )
  })

/** Poll a stand-in's log until `done` holds, and answer it. */
const waitForLog = <R,>(log: Effect.Effect<string, never, R>, done: (text: string) => boolean) =>
  log.pipe(
    Effect.filterOrFail(done),
    // 250 polls 20 ms apart: five seconds.
    Effect.retry({ schedule: Schedule.spaced("20 millis"), times: 250 }),
    Effect.orDie,
  )

import { describe, expect, it } from "effect-bun-test"
import { Clock, Duration, Effect, FileSystem, Path, Schema } from "effect"
import { BunServices } from "@effect/platform-bun"
import {
  defineExtension,
  ExtensionContext,
  ExtensionHost,
  ExtensionId,
  ref,
  resolveDataDir,
  runProcess,
  tool,
} from "@gent/core/extensions/api"
import {
  createRpcHarness,
  LanguageModelLayers,
  makeTempDirectoryScoped,
  multiToolCallStep,
  textStep,
  toolCallStep,
  waitFor,
} from "@gent/core/test-utils"
import { type BranchId, messagePartsText, type SessionId } from "@gent/core/protocol"
import { CheckpointList, CheckpointsRpc, pruneCheckpoints, TurnPatch } from "../src/checkpoints.js"
import { e2ePreset } from "./helpers/test-preset"

// ── fixtures ────────────────────────────────────────────────────────────────

/** One shell command; its trimmed stdout, or a defect that names it. */
const sh = (cwd: string, command: string) =>
  runProcess("sh", ["-c", command], { cwd }).pipe(
    Effect.orDie,
    Effect.flatMap((result) => {
      if (result.exitCode === 0) return Effect.succeed(result.stdout.trim())
      return Effect.die(`${command} exited ${result.exitCode}: ${result.stderr}`)
    }),
  )

/** A repository with one commit, one level down in a temp directory. */
const repository = Effect.gen(function* () {
  const root = yield* makeTempDirectoryScoped("cp-repo-")
  yield* sh(
    root,
    [
      "mkdir repo && cd repo",
      "git init -q -b main",
      "git config user.name Test",
      "git config user.email test@example.com",
      "printf 'one\\n' > a.txt",
      "printf 'dist\\n' > .gitignore",
      "git add -A",
      "git commit -qm init",
    ].join(" && "),
  )
  return yield* sh(`${root}/repo`, "pwd -P")
})

const FileParams = Schema.Struct({ path: Schema.String, content: Schema.String })
const PathParams = Schema.Struct({ path: Schema.String })

/** A file write in the session's work tree. */
const PutTool = tool({
  id: "put",
  description: "Write a file",
  params: FileParams,
  output: Schema.String,
  execute: ({ path: file, content }) =>
    Effect.gen(function* () {
      const ctx = yield* ExtensionContext
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const target = path.resolve(ctx.cwd, file)
      yield* fs.makeDirectory(path.dirname(target), { recursive: true })
      yield* fs.writeFileString(target, content)
      return "written"
    }).pipe(Effect.orDie),
})

/** A file read that declares no side effect. */
const PeekTool = tool({
  id: "peek",
  description: "Read a file",
  readonly: true,
  params: PathParams,
  output: Schema.String,
  execute: ({ path: file }) =>
    Effect.gen(function* () {
      const ctx = yield* ExtensionContext
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      return yield* fs.readFileString(path.resolve(ctx.cwd, file))
    }).pipe(Effect.orDie),
})

const FileToolsExtension = defineExtension({
  id: "checkpoint-test-files",
  setup: Effect.gen(function* () {
    const host = yield* ExtensionHost
    yield* host.register("tool", PutTool, PeekTool)
  }),
})

const put = (file: string, content: string) => toolCallStep("put", { path: file, content })

type Steps = Parameters<typeof LanguageModelLayers.sequence>[0]

/** A session in `cwd` with the shipped extensions, the test file tools and a scripted model. */
const checkpointSession = (cwd: string, home: string, steps: Steps) =>
  Effect.gen(function* () {
    const { layer: providerLayer } = yield* LanguageModelLayers.sequence(steps)
    const { client, sessionId, branchId } = yield* createRpcHarness({
      ...e2ePreset,
      extensionInputs: [...e2ePreset.extensionInputs, FileToolsExtension],
      providerLayer,
      cwd,
      home,
    })
    /** The checkpoint requests and a turn runner for one session's branch. */
    const at = (target: { readonly sessionId: SessionId; readonly branchId: BranchId }) => {
      const call = (
        capability: { readonly extensionId: string; readonly capabilityId: string },
        input: Record<string, number>,
      ) =>
        client.extension.request({
          ...target,
          extensionId: ExtensionId.make(capability.extensionId),
          capabilityId: capability.capabilityId,
          input,
        })
      const list = call(ref(CheckpointsRpc.List), {}).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(CheckpointList)),
      )
      const patch = (n: number) =>
        call(ref(CheckpointsRpc.Patch), { n }).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(TurnPatch)),
        )
      /** Send `content`, wait for the reply `answer`, then for the turn's end checkpoint. */
      const turn = (content: string, answer: string) =>
        Effect.gen(function* () {
          yield* client.message.send({ ...target, content })
          yield* waitFor(
            client.message.list({ branchId: target.branchId }),
            (messages) =>
              messages.some(
                (message) =>
                  message.role === "assistant" && messagePartsText(message.parts) === answer,
              ),
            8000,
            `reply ${answer}`,
          )
          yield* waitFor(
            list,
            (found) => found.turns.length > 0 && found.turns[0]?.state !== "open",
            8000,
            `end checkpoint of ${content}`,
          )
        })
      return { list, patch, turn }
    }
    const { list, patch, turn } = at({ sessionId, branchId })
    return { client, sessionId, branchId, list, patch, turn, at }
  })

/** The one store under the home's data directory, when there is one. */
const storeOf = (home: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const root = `${yield* resolveDataDir(home)}/checkpoints`
    if (!(yield* fs.exists(root))) return []
    const entries = yield* fs.readDirectory(root)
    return entries.map((entry) => `${root}/${entry}`)
  }).pipe(Effect.orDie)

const storeRefs = (store: string) =>
  sh(store, `git --git-dir="${store}" for-each-ref --format='%(refname)'`).pipe(
    Effect.map((text) => text.split("\n").filter((line) => line.length > 0)),
  )

/** What the user's repository holds: its refs, its objects and its index. */
const repositoryState = (repo: string) =>
  Effect.all({
    refs: sh(repo, "git for-each-ref --format='%(refname) %(objectname)'"),
    objects: sh(repo, "git count-objects -v"),
    index: sh(repo, "sha256sum .git/index"),
    hooks: sh(repo, "ls .git"),
  })

// ── capture ─────────────────────────────────────────────────────────────────

describe("turn checkpoints", () => {
  it.live(
    "a turn that writes a file records a start and an end, and the user's repository gains no ref, object or index change",
    () =>
      Effect.gen(function* () {
        const repo = yield* repository
        const home = yield* makeTempDirectoryScoped("cp-home-")
        const before = yield* repositoryState(repo)
        const session = yield* checkpointSession(repo, home, [
          put("a.txt", "two\n"),
          textStep("done 1"),
        ])
        yield* session.turn("change a", "done 1")
        const listed = yield* session.list
        expect(listed.problem).toBeUndefined()
        expect(listed.turns.map((row) => [row.n, row.prompt, row.state])).toEqual([
          [1, "change a", "captured"],
        ])
        expect(listed.turns[0]).toMatchObject({ files: 1, insertions: 1, deletions: 1 })
        const stores = yield* storeOf(home)
        expect(stores.length).toBe(1)
        const refs = yield* storeRefs(stores[0] ?? "")
        expect(refs.length).toBe(2)
        expect(refs.filter((ref) => ref.endsWith("/start")).length).toBe(1)
        expect(refs.filter((ref) => ref.endsWith("/end")).length).toBe(1)
        expect(yield* repositoryState(repo)).toEqual(before)
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.timeout("25 seconds")),
    30_000,
  )

  it.live(
    "a turn of only read-only tools, or of no tool, records nothing",
    () =>
      Effect.gen(function* () {
        const repo = yield* repository
        const home = yield* makeTempDirectoryScoped("cp-home-")
        const session = yield* checkpointSession(repo, home, [
          toolCallStep("peek", { path: "a.txt" }),
          textStep("done 1"),
          textStep("done 2"),
        ])
        yield* session.turn("read a", "done 1")
        yield* session.turn("say hi", "done 2")
        const listed = yield* session.list
        expect(listed.turns.map((row) => [row.n, row.state])).toEqual([
          [1, "none"],
          [2, "none"],
        ])
        expect(yield* storeOf(home)).toEqual([])
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.timeout("25 seconds")),
    30_000,
  )

  it.live(
    "every tool call of a turn, in one step or a later one, shares the turn's first start",
    () =>
      Effect.gen(function* () {
        const repo = yield* repository
        const home = yield* makeTempDirectoryScoped("cp-home-")
        const session = yield* checkpointSession(repo, home, [
          multiToolCallStep(
            { toolName: "put", input: { path: "a.txt", content: "two\n" } },
            { toolName: "put", input: { path: "b.txt", content: "bee\n" } },
          ),
          put("c.txt", "sea\n"),
          textStep("done 1"),
        ])
        yield* session.turn("change three", "done 1")
        const listed = yield* session.list
        expect(listed.turns[0]).toMatchObject({ state: "captured", files: 3 })
        const refs = yield* storeRefs((yield* storeOf(home))[0] ?? "")
        expect(refs.length).toBe(2)
        const patch = yield* session.patch(1)
        for (const file of ["a.txt", "b.txt", "c.txt"]) expect(patch.patch).toContain(`b/${file}`)
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.timeout("25 seconds")),
    30_000,
  )

  it.live(
    "the turn patch shows only the turn's change; an edit made between turns shows in neither",
    () =>
      Effect.gen(function* () {
        const repo = yield* repository
        const home = yield* makeTempDirectoryScoped("cp-home-")
        const session = yield* checkpointSession(repo, home, [
          put("a.txt", "two\n"),
          textStep("done 1"),
          put("b.txt", "bee\n"),
          textStep("done 2"),
        ])
        yield* session.turn("change a", "done 1")
        yield* sh(repo, "printf 'mine\\n' > user.txt")
        yield* session.turn("add b", "done 2")
        const latest = yield* session.patch(1)
        expect(latest.prompt).toBe("add b")
        expect(latest.patch).toContain("b/b.txt")
        expect(latest.patch).not.toContain("user.txt")
        expect(latest.patch).not.toContain("a.txt")
        const earlier = yield* session.patch(2)
        expect(earlier.patch).toContain("b/a.txt")
        expect(earlier.patch).toContain("+two")
        expect(earlier.patch).not.toContain("user.txt")
        expect(earlier.patch).not.toContain("b.txt")
        // Nothing but a git patch: no comment line, since no other session wrote the tree.
        expect(earlier.patch.startsWith("diff --git")).toBe(true)
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.timeout("25 seconds")),
    30_000,
  )

  it.live(
    "a session outside a git work tree records nothing and says why",
    () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDirectoryScoped("cp-plain-")
        const home = yield* makeTempDirectoryScoped("cp-home-")
        const session = yield* checkpointSession(cwd, home, [
          put("a.txt", "two\n"),
          textStep("done 1"),
        ])
        yield* session.turn("change a", "done 1")
        const listed = yield* session.list
        expect(listed.problem).toContain("checkpoints need a git work tree")
        expect(yield* storeOf(home)).toEqual([])
        const refused = yield* session.patch(1).pipe(Effect.flip)
        expect(String(refused.message)).toContain("checkpoints need a git work tree")
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.timeout("25 seconds")),
    30_000,
  )

  it.live(
    "no hook of the store runs during a capture",
    () =>
      Effect.gen(function* () {
        const repo = yield* repository
        const home = yield* makeTempDirectoryScoped("cp-home-")
        const session = yield* checkpointSession(repo, home, [
          put("a.txt", "two\n"),
          textStep("done 1"),
          put("b.txt", "bee\n"),
          textStep("done 2"),
        ])
        yield* session.turn("change a", "done 1")
        const store = (yield* storeOf(home))[0] ?? ""
        const marker = `${home}/hook-ran`
        for (const hook of ["reference-transaction", "post-index-change", "post-commit"])
          yield* sh(
            store,
            `mkdir -p hooks && printf '#!/bin/sh\\ntouch "${marker}"\\n' > hooks/${hook} && chmod +x hooks/${hook}`,
          )
        yield* session.turn("add b", "done 2")
        expect((yield* storeRefs(store)).length).toBe(4)
        expect(yield* sh(home, `test -e "${marker}" && echo ran || echo none`)).toBe("none")
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.timeout("25 seconds")),
    30_000,
  )

  it.live(
    "a spawned session captures only in a work tree whose store exists",
    () =>
      Effect.gen(function* () {
        const repo = yield* repository
        const home = yield* makeTempDirectoryScoped("cp-home-")
        const session = yield* checkpointSession(repo, home, [
          put("child-1.txt", "one\n"),
          textStep("child 1"),
          put("a.txt", "two\n"),
          textStep("parent 1"),
          put("child-2.txt", "two\n"),
          textStep("child 2"),
        ])
        const child = yield* session.client.session.create({
          cwd: repo,
          parentSessionId: session.sessionId,
          parentBranchId: session.branchId,
        })
        const inChild = session.at(child)
        yield* inChild.turn("child work", "child 1")
        expect((yield* inChild.list).turns.map((row) => row.state)).toEqual(["none"])
        expect(yield* storeOf(home)).toEqual([])
        yield* session.turn("parent work", "parent 1")
        yield* inChild.turn("more child work", "child 2")
        expect((yield* inChild.list).turns.map((row) => row.state)).toEqual(["captured", "none"])
        expect((yield* storeRefs((yield* storeOf(home))[0] ?? "")).length).toBe(4)
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.timeout("25 seconds")),
    30_000,
  )

  it.live(
    "a turn patch names another session whose turn overlapped it",
    () =>
      Effect.gen(function* () {
        const repo = yield* repository
        const home = yield* makeTempDirectoryScoped("cp-home-")
        const session = yield* checkpointSession(repo, home, [
          put("a.txt", "two\n"),
          textStep("done 1"),
        ])
        yield* session.turn("change a", "done 1")
        const store = (yield* storeOf(home))[0] ?? ""
        const atOf = (kind: string) =>
          sh(
            store,
            `git --git-dir="${store}" for-each-ref --format='%(contents:trailers:key=Gent-At,valueonly)' 'refs/checkpoints/**/${kind}'`,
          ).pipe(Effect.map(Number))
        const startAt = yield* atOf("start")
        const endAt = yield* atOf("end")
        // Another session's turn, recorded as a capture records it, spans this turn.
        const plant = (kind: string, at: number) =>
          sh(
            store,
            [
              `tree=$(git --git-dir="${store}" mktree < /dev/null)`,
              `commit=$(git --git-dir="${store}" -c user.name=t -c user.email=t@t commit-tree "$tree" -m "other" -m "Gent-Kind: ${kind}
Gent-Session: other-session
Gent-Branch: other-branch
Gent-Turn: other-turn
Gent-At: ${at}")`,
              `git --git-dir="${store}" update-ref refs/checkpoints/6f/6f/6f/${kind} "$commit"`,
            ].join(" && "),
          )
        yield* plant("start", startAt - 5)
        yield* plant("end", endAt + 5)
        const patch = yield* session.patch(1)
        expect(patch.patch.split("\n")[0]).toBe(
          "# other sessions also wrote this work tree during this turn: other-session",
        )
        expect(patch.patch).toContain("b/a.txt")
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.timeout("25 seconds")),
    30_000,
  )
})

// ── retention ───────────────────────────────────────────────────────────────

describe("checkpoint retention", () => {
  it.live(
    "a deleted session's checkpoints go",
    () =>
      Effect.gen(function* () {
        const repo = yield* repository
        const home = yield* makeTempDirectoryScoped("cp-home-")
        const session = yield* checkpointSession(repo, home, [
          put("a.txt", "two\n"),
          textStep("done 1"),
        ])
        yield* session.turn("change a", "done 1")
        const store = (yield* storeOf(home))[0] ?? ""
        expect((yield* storeRefs(store)).length).toBe(2)
        yield* session.client.session.delete({ sessionId: session.sessionId })
        yield* waitFor(storeRefs(store), (refs) => refs.length === 0, 8000, "refs removed")
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.timeout("25 seconds")),
    30_000,
  )

  it.live(
    "checkpoints past 30 days go at the retention pass, and a store whose work tree is gone goes",
    () =>
      Effect.gen(function* () {
        const repo = yield* repository
        const home = yield* makeTempDirectoryScoped("cp-home-")
        const session = yield* checkpointSession(repo, home, [
          put("a.txt", "two\n"),
          textStep("done 1"),
        ])
        yield* session.turn("change a", "done 1")
        const dataDir = yield* resolveDataDir(home)
        const store = (yield* storeOf(home))[0] ?? ""
        const now = yield* Clock.currentTimeMillis
        yield* pruneCheckpoints(dataDir, now)
        expect((yield* storeRefs(store)).length).toBe(2)
        yield* pruneCheckpoints(dataDir, now + Duration.toMillis(Duration.days(31)))
        expect(yield* storeRefs(store)).toEqual([])
        yield* sh(repo, `mv "${repo}" "${repo}-gone"`)
        yield* pruneCheckpoints(dataDir, now)
        expect(yield* storeOf(home)).toEqual([])
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.timeout("25 seconds")),
    30_000,
  )
})

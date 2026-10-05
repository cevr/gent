import { describe, expect, it } from "effect-bun-test"
import { Clock, Duration, Effect, FileSystem, Option, Path, Schema } from "effect"
import { BunServices } from "@effect/platform-bun"
import {
  defineExtension,
  ExtensionContext,
  ExtensionHost,
  ExtensionId,
  ref,
  RequestId,
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
import { BranchId, messagePartsText, type SessionId } from "@gent/core/protocol"
import {
  CheckpointList,
  CheckpointsRpc,
  pruneCheckpoints,
  RevertAction,
  RevertInput,
  RevertOutcome,
  TurnPatch,
} from "../src/checkpoints.js"
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

const FileParams = Schema.Struct({
  path: Schema.String,
  content: Schema.String,
  /** The content this many times over: a big file from a small call. */
  times: Schema.optional(Schema.Int),
})
const PathParams = Schema.Struct({ path: Schema.String })

/** A file write in the session's work tree. */
const PutTool = tool({
  id: "put",
  description: "Write a file",
  params: FileParams,
  output: Schema.String,
  execute: ({ path: file, content, times }) =>
    Effect.gen(function* () {
      const ctx = yield* ExtensionContext
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const target = path.resolve(ctx.cwd, file)
      yield* fs.makeDirectory(path.dirname(target), { recursive: true })
      yield* fs.writeFileString(target, content.repeat(times ?? 1))
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

/** A removal in the session's work tree: a file (its directory stays), or a directory with all in it. */
const DropTool = tool({
  id: "drop",
  description: "Remove a file",
  params: PathParams,
  output: Schema.String,
  execute: ({ path: file }) =>
    Effect.gen(function* () {
      const ctx = yield* ExtensionContext
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      yield* fs.remove(path.resolve(ctx.cwd, file), { recursive: true })
      return "removed"
    }).pipe(Effect.orDie),
})

const FileToolsExtension = defineExtension({
  id: "checkpoint-test-files",
  setup: Effect.gen(function* () {
    const host = yield* ExtensionHost
    yield* host.register("tool", PutTool, PeekTool, DropTool)
  }),
})

const put = (file: string, content: string) => toolCallStep("put", { path: file, content })

type Steps = Parameters<typeof LanguageModelLayers.sequence>[0]

const BranchIdOf = (id: string) => BranchId.make(id)

const filesOf = (n: number) => RevertAction.cases.Turn.make({ n, conversation: false })
const bothOf = (n: number) => RevertAction.cases.Turn.make({ n, conversation: true })
const UNDO = RevertAction.cases.Undo.make({})
const FINISH = RevertAction.cases.Finish.make({})

/** The text of a file, or `<absent>`. */
const contentOf = (repo: string, file: string) =>
  sh(repo, `if [ -e '${file}' ]; then cat '${file}'; else echo '<absent>'; fi`)

/** A session in `cwd` with the shipped extensions, the test file tools and a scripted model. */
const checkpointSession = (cwd: string, home: string, steps: Steps) =>
  Effect.gen(function* () {
    const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence(steps)
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
        input: { readonly n?: number } | typeof RevertInput.Encoded,
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
      const revert = (requestId: string, action: RevertAction, overwrite = false) =>
        call(
          ref(CheckpointsRpc.Revert),
          Schema.encodeSync(RevertInput)({
            requestId: RequestId.make(requestId),
            action,
            overwrite,
          }),
        ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(RevertOutcome)))
      return { list, patch, turn, revert }
    }
    const { list, patch, turn, revert } = at({ sessionId, branchId })
    return { client, controls, sessionId, branchId, list, patch, turn, revert, at }
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

/** The file `gent-gc` of a store: when git last collected its garbage. */
const collectedAt = (store: string) =>
  sh(store, "if [ -e gent-gc ]; then cat gent-gc; else echo none; fi")

/**
 * Set `name` in the process environment to `next` (unset on none); the value
 * it held. The environment is the boundary under test: gent's git commands
 * inherit it, as they inherit the user's.
 */
const swapEnv = (name: string, next: Option.Option<string>) => {
  // oxlint-disable-next-line effect/noGlobals -- the process environment is what git inherits, and the only way a global git config reaches it.
  const env = process.env
  const previous = Option.fromUndefinedOr(env[name])
  if (Option.isSome(next)) env[name] = next.value
  else delete env[name]
  return previous
}

/** `name` set in the process environment for the scope. */
const scopedEnv = (name: string, value: string) =>
  Effect.acquireRelease(
    Effect.sync(() => swapEnv(name, Option.some(value))),
    (previous) => Effect.sync(() => swapEnv(name, previous)),
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

  it.live(
    "a store command reads no user or system git config: a global clean filter never runs and the bytes stay exact",
    () =>
      Effect.gen(function* () {
        const repo = yield* repository
        const home = yield* makeTempDirectoryScoped("cp-home-")
        const config = yield* makeTempDirectoryScoped("cp-config-")
        const marker = `${config}/filter-ran`
        const fs = yield* FileSystem.FileSystem
        yield* fs.writeFileString(`${config}/attributes`, "* filter=upper\n")
        yield* fs.writeFileString(`${config}/upper`, `#!/bin/sh\ntouch "${marker}"\ntr a-z A-Z\n`, {
          mode: 0o755,
        })
        yield* fs.writeFileString(
          `${config}/gitconfig`,
          `[core]\n\tattributesFile = ${config}/attributes\n[filter "upper"]\n\tclean = ${config}/upper\n`,
        )
        yield* scopedEnv("GIT_CONFIG_GLOBAL", `${config}/gitconfig`)
        const session = yield* checkpointSession(repo, home, [
          put("a.txt", "lowercase\n"),
          textStep("done 1"),
        ])
        yield* session.turn("change a", "done 1")
        const store = (yield* storeOf(home))[0] ?? ""
        const end = (yield* storeRefs(store)).find((name) => name.endsWith("/end")) ?? ""
        expect(yield* sh(store, `git --git-dir="${store}" cat-file blob '${end}:a.txt'`)).toBe(
          "lowercase",
        )
        expect(yield* sh(config, `test -e "${marker}" && echo ran || echo none`)).toBe("none")
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.timeout("25 seconds")),
    30_000,
  )

  it.live(
    "system attributes do not reach the store: every store command runs without them",
    () =>
      Effect.gen(function* () {
        const repo = yield* repository
        const home = yield* makeTempDirectoryScoped("cp-home-")
        const bin = yield* makeTempDirectoryScoped("cp-bin-")
        const fs = yield* FileSystem.FileSystem
        const real = yield* sh(bin, "command -v git")
        const path = yield* sh(bin, 'printf %s "$PATH"')
        // `text` turns CRLF into LF on the way into a repository. git 2.43
        // reads system attributes from `/etc/gitattributes` only; where a
        // mount namespace is at hand the wrapper plants the file there.
        yield* fs.writeFileString(`${bin}/attributes`, "*.txt text\n")
        yield* fs.writeFileString(
          `${bin}/git`,
          [
            "#!/bin/sh",
            `printf '%s %s\\n' "\${GIT_ATTR_NOSYSTEM:-unset}" "$*" >> "${bin}/log"`,
            "if bwrap --dev-bind / / --tmpfs /etc true 2>/dev/null; then",
            `  exec bwrap --dev-bind / / --tmpfs /etc --ro-bind "${bin}/attributes" /etc/gitattributes "${real}" "$@"`,
            "fi",
            `exec "${real}" "$@"`,
            "",
          ].join("\n"),
          { mode: 0o755 },
        )
        yield* scopedEnv("PATH", `${bin}:${path}`)
        const session = yield* checkpointSession(repo, home, [
          put("a.txt", "crlf\r\n"),
          textStep("done 1"),
        ])
        yield* session.turn("change a", "done 1")
        const store = (yield* storeOf(home))[0] ?? ""
        // Read before the checks below run git through the wrapper too.
        const log = yield* fs.readFileString(`${bin}/log`)
        const storeCommands = log.split("\n").filter((line) => line.includes(`--git-dir=${store}`))
        expect(storeCommands.length).toBeGreaterThan(0)
        expect(storeCommands.filter((line) => !line.startsWith("1 "))).toEqual([])
        const end = (yield* storeRefs(store)).find((name) => name.endsWith("/end")) ?? ""
        expect(
          yield* sh(
            store,
            `"${real}" --git-dir="${store}" cat-file blob '${end}:a.txt' | od -An -c`,
          ),
        ).toBe("c   r   l   f  \\r  \\n")
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.timeout("25 seconds")),
    30_000,
  )

  it.live(
    "a git template directory does not reach the store: its filter never runs",
    () =>
      Effect.gen(function* () {
        const repo = yield* repository
        const home = yield* makeTempDirectoryScoped("cp-home-")
        const template = yield* makeTempDirectoryScoped("cp-template-")
        const marker = `${template}/filter-ran`
        const fs = yield* FileSystem.FileSystem
        yield* fs.makeDirectory(`${template}/info`)
        yield* fs.writeFileString(`${template}/info/attributes`, "* filter=upper\n")
        yield* fs.writeFileString(
          `${template}/upper`,
          `#!/bin/sh\ntouch "${marker}"\ntr a-z A-Z\n`,
          {
            mode: 0o755,
          },
        )
        yield* fs.writeFileString(
          `${template}/config`,
          `[filter "upper"]\n\tclean = ${template}/upper\n`,
        )
        yield* scopedEnv("GIT_TEMPLATE_DIR", template)
        const session = yield* checkpointSession(repo, home, [
          put("a.txt", "lowercase\n"),
          textStep("done 1"),
        ])
        yield* session.turn("change a", "done 1")
        const store = (yield* storeOf(home))[0] ?? ""
        const end = (yield* storeRefs(store)).find((name) => name.endsWith("/end")) ?? ""
        expect(yield* sh(store, `git --git-dir="${store}" cat-file blob '${end}:a.txt'`)).toBe(
          "lowercase",
        )
        expect(yield* sh(template, `test -e "${marker}" && echo ran || echo none`)).toBe("none")
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.timeout("25 seconds")),
    30_000,
  )

  it.live(
    "a read of the user's repository never runs its fsmonitor",
    () =>
      Effect.gen(function* () {
        const repo = yield* repository
        const home = yield* makeTempDirectoryScoped("cp-home-")
        const marker = `${home}/fsmonitor-ran`
        yield* sh(
          home,
          `printf '#!/bin/sh\\ntouch "${marker}"\\nexit 1\\n' > fsmonitor && chmod +x fsmonitor`,
        )
        yield* sh(repo, `git config core.fsmonitor "${home}/fsmonitor"`)
        const session = yield* checkpointSession(repo, home, [
          put("a.txt", "two\n"),
          textStep("done 1"),
        ])
        yield* session.turn("change a", "done 1")
        expect((yield* session.list).turns.map((row) => row.state)).toEqual(["captured"])
        expect(yield* sh(home, `test -e "${marker}" && echo ran || echo none`)).toBe("none")
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.timeout("25 seconds")),
    30_000,
  )

  it.live(
    "a session in a gent workspace copy with no store records nothing",
    () =>
      Effect.gen(function* () {
        const repo = yield* repository
        const home = yield* makeTempDirectoryScoped("cp-home-")
        yield* sh(repo, "printf 'copy\\n' > .git/gent-workspace")
        const session = yield* checkpointSession(repo, home, [
          put("a.txt", "two\n"),
          textStep("done 1"),
        ])
        yield* session.turn("change a", "done 1")
        expect((yield* session.list).turns.map((row) => row.state)).toEqual(["none"])
        expect(yield* storeOf(home)).toEqual([])
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.timeout("25 seconds")),
    30_000,
  )
})

// ── revert ──────────────────────────────────────────────────────────────────

const timed = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.timeout("25 seconds"))

describe("turn reverts", () => {
  it.live(
    "a files-only revert restores the turn's paths byte for byte, removes a file the turn made, and keeps ignored files, big untracked files and files only the user changed",
    () =>
      timed(
        Effect.gen(function* () {
          const repo = yield* repository
          const home = yield* makeTempDirectoryScoped("cp-home-")
          // `text` with no eol: a capture that converted line ends would store LF.
          yield* sh(
            repo,
            "printf 'crlf.txt text\\n' > .gitattributes && printf 'x\\r\\ny\\r\\n' > crlf.txt && git add -A && git commit -qm attrs",
          )
          const bigSize = 3 * 1024 * 1024
          const session = yield* checkpointSession(repo, home, [
            multiToolCallStep(
              { toolName: "put", input: { path: "a.txt", content: "two\n" } },
              { toolName: "put", input: { path: "new/made.txt", content: "made\n" } },
              { toolName: "put", input: { path: "crlf.txt", content: "changed\r\n" } },
              { toolName: "put", input: { path: "dist/out.js", content: "built\n" } },
              { toolName: "put", input: { path: "big.bin", content: "z", times: bigSize } },
            ),
            textStep("done 1"),
          ])
          yield* session.turn("change things", "done 1")
          yield* sh(repo, "printf 'mine\\n' > user.txt")
          const outcome = yield* session.revert("revert-1", filesOf(1))
          expect(outcome).toEqual({
            _tag: "Reverted",
            files: ["a.txt", "crlf.txt", "new/made.txt"],
          })
          expect(yield* contentOf(repo, "a.txt")).toBe("one")
          expect(yield* sh(repo, "od -An -c crlf.txt")).toBe("x  \\r  \\n   y  \\r  \\n")
          expect(yield* sh(repo, "test -e new && echo there || echo gone")).toBe("gone")
          expect(yield* contentOf(repo, "dist/out.js")).toBe("built")
          expect(yield* sh(repo, "wc -c < big.bin")).toBe(String(bigSize))
          expect(yield* contentOf(repo, "user.txt")).toBe("mine")
          // The user's index, HEAD and branches do not move.
          expect(yield* sh(repo, "git status --porcelain=v1")).toContain("?? user.txt")
          expect(yield* sh(repo, "git log --oneline | wc -l")).toBe("2")
        }),
      ),
    30_000,
  )

  it.live(
    "a revert over a file the user also changed refuses and names it; overwrite writes it; undo returns the user's edit",
    () =>
      timed(
        Effect.gen(function* () {
          const repo = yield* repository
          const home = yield* makeTempDirectoryScoped("cp-home-")
          const session = yield* checkpointSession(repo, home, [
            put("a.txt", "two\n"),
            textStep("done 1"),
          ])
          yield* session.turn("change a", "done 1")
          yield* sh(repo, "printf 'mine\\n' > a.txt")
          const refused = yield* session.revert("revert-1", filesOf(1))
          expect(refused).toMatchObject({ _tag: "Refused", conflicts: ["a.txt"] })
          expect(yield* contentOf(repo, "a.txt")).toBe("mine")
          expect((yield* session.list).undo).toBeUndefined()
          const overwritten = yield* session.revert("revert-2", filesOf(1), true)
          expect(overwritten).toEqual({ _tag: "Reverted", files: ["a.txt"] })
          expect(yield* contentOf(repo, "a.txt")).toBe("one")
          expect((yield* session.list).undo).toEqual({ requestId: "revert-2", files: 1 })
          const undone = yield* session.revert("undo-1", UNDO)
          expect(undone).toEqual({ _tag: "Reverted", files: ["a.txt"] })
          expect(yield* contentOf(repo, "a.txt")).toBe("mine")
        }),
      ),
    30_000,
  )

  it.live(
    "a running loop in the same work tree blocks a revert; a running child in another work tree does not",
    () =>
      timed(
        Effect.gen(function* () {
          const repo = yield* repository
          const home = yield* makeTempDirectoryScoped("cp-home-")
          const elsewhere = yield* makeTempDirectoryScoped("cp-elsewhere-")
          const session = yield* checkpointSession(repo, home, [
            put("a.txt", "two\n"),
            textStep("done 1"),
            { ...textStep("near 1"), gated: true },
            { ...textStep("away 1"), gated: true },
          ])
          yield* session.turn("change a", "done 1")
          const near = yield* session.client.session.create({
            cwd: repo,
            parentSessionId: session.sessionId,
            parentBranchId: session.branchId,
          })
          yield* session.client.message.send({ ...near, content: "work here" })
          yield* session.controls.waitForCall(2)
          const refused = yield* session.revert("revert-1", filesOf(1))
          expect(refused._tag).toBe("Refused")
          if (refused._tag === "Refused") expect(refused.reason).toContain(near.sessionId)
          expect(yield* contentOf(repo, "a.txt")).toBe("two")
          yield* session.controls.emitAll(2)
          yield* waitFor(
            session.client.message.list({ branchId: near.branchId }),
            (messages) => messages.some((message) => messagePartsText(message.parts) === "near 1"),
            8000,
            "near reply",
          )
          const away = yield* session.client.session.create({
            cwd: elsewhere,
            parentSessionId: session.sessionId,
            parentBranchId: session.branchId,
          })
          yield* session.client.message.send({ ...away, content: "work there" })
          yield* session.controls.waitForCall(3)
          const reverted = yield* session.revert("revert-2", filesOf(1))
          expect(reverted).toEqual({ _tag: "Reverted", files: ["a.txt"] })
          yield* session.controls.emitAll(3)
        }),
      ),
    30_000,
  )

  it.live(
    "a conversation revert forks before the turn and restores files; a repeat with the same request id makes no second branch; the first turn has no conversation to revert",
    () =>
      timed(
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
          yield* session.turn("add b", "done 2")
          const outcome = yield* session.revert("revert-1", bothOf(1))
          expect(outcome._tag).toBe("Reverted")
          if (outcome._tag !== "Reverted") return
          expect(outcome.files).toEqual(["b.txt"])
          const forked = BranchIdOf(outcome.branchId ?? "")
          expect(forked).not.toBe(session.branchId)
          expect(yield* contentOf(repo, "b.txt")).toBe("<absent>")
          expect(yield* contentOf(repo, "a.txt")).toBe("two")
          const copied = yield* session.client.message.list({ branchId: forked })
          expect(copied.at(-1)?.role).toBe("assistant")
          expect(messagePartsText(copied.at(-1)?.parts ?? [])).toBe("done 1")
          expect(yield* session.revert("revert-1", bothOf(1))).toEqual(outcome)
          expect((yield* session.client.branch.list({ sessionId: session.sessionId })).length).toBe(
            2,
          )
          // The fork lists the copied turn, with the checkpoints of the turn it copies.
          const inFork = session.at({ sessionId: session.sessionId, branchId: forked })
          expect((yield* inFork.list).turns.map((row) => [row.prompt, row.state])).toEqual([
            ["change a", "captured"],
          ])
          const first = yield* session.revert("revert-2", bothOf(2))
          expect(first).toMatchObject({ _tag: "Refused" })
          if (first._tag === "Refused") expect(first.reason).toContain("this is the first turn")
          expect(yield* contentOf(repo, "a.txt")).toBe("two")
        }),
      ),
    30_000,
  )

  it.live(
    "a revert stopped after its target is listed as unfinished, and finishing it writes the target",
    () =>
      timed(
        Effect.gen(function* () {
          const repo = yield* repository
          const home = yield* makeTempDirectoryScoped("cp-home-")
          const session = yield* checkpointSession(repo, home, [
            put("a.txt", "two\n"),
            textStep("done 1"),
          ])
          yield* session.turn("change a", "done 1")
          yield* session.revert("revert-1", filesOf(1))
          // A stop between the target and the write: no `done`, the file as before.
          const store = (yield* storeOf(home))[0] ?? ""
          const done = (yield* storeRefs(store)).find((name) => name.endsWith("/done")) ?? ""
          yield* sh(store, `git --git-dir="${store}" update-ref -d '${done}'`)
          yield* sh(repo, "printf 'two\\n' > a.txt")
          expect((yield* session.list).unfinished).toEqual({ requestId: "revert-1" })
          const finished = yield* session.revert("finish-1", FINISH)
          expect(finished).toEqual({ _tag: "Reverted", files: ["a.txt"] })
          expect(yield* contentOf(repo, "a.txt")).toBe("one")
          expect((yield* session.list).unfinished).toBeUndefined()
        }),
      ),
    30_000,
  )

  it.live(
    "a child's edits made after its parent's turn revert with that turn; another top-level session's edits are kept",
    () =>
      timed(
        Effect.gen(function* () {
          const repo = yield* repository
          const home = yield* makeTempDirectoryScoped("cp-home-")
          const session = yield* checkpointSession(repo, home, [
            put("a.txt", "two\n"),
            textStep("done 1"),
            put("child.txt", "child\n"),
            textStep("child 1"),
            put("other.txt", "other\n"),
            textStep("other 1"),
          ])
          yield* session.turn("change a", "done 1")
          const child = yield* session.client.session.create({
            cwd: repo,
            parentSessionId: session.sessionId,
            parentBranchId: session.branchId,
          })
          yield* session.at(child).turn("child work", "child 1")
          const other = yield* session.client.session.create({ cwd: repo })
          yield* session.at(other).turn("other work", "other 1")
          const outcome = yield* session.revert("revert-1", filesOf(1))
          expect(outcome).toEqual({ _tag: "Reverted", files: ["a.txt", "child.txt"] })
          expect(yield* contentOf(repo, "child.txt")).toBe("<absent>")
          expect(yield* contentOf(repo, "other.txt")).toBe("other")
        }),
      ),
    30_000,
  )

  it.live(
    "an overwrite keeps the user's bytes of a file over 2 MiB, which no capture holds, and undo returns them",
    () =>
      timed(
        Effect.gen(function* () {
          const repo = yield* repository
          const home = yield* makeTempDirectoryScoped("cp-home-")
          yield* sh(repo, "printf 'v1\\n' > notes.txt")
          const session = yield* checkpointSession(repo, home, [
            put("notes.txt", "v2\n"),
            textStep("done 1"),
          ])
          yield* session.turn("change notes", "done 1")
          yield* sh(repo, "head -c 3145728 /dev/urandom > notes.txt")
          const sum = yield* sh(repo, "sha256sum notes.txt")
          const refused = yield* session.revert("revert-1", filesOf(1))
          expect(refused).toMatchObject({ _tag: "Refused", conflicts: ["notes.txt"] })
          const overwritten = yield* session.revert("revert-2", filesOf(1), true)
          expect(overwritten).toEqual({ _tag: "Reverted", files: ["notes.txt"] })
          expect(yield* contentOf(repo, "notes.txt")).toBe("v1")
          const undone = yield* session.revert("undo-1", UNDO)
          expect(undone).toEqual({ _tag: "Reverted", files: ["notes.txt"] })
          expect(yield* sh(repo, "sha256sum notes.txt")).toBe(sum)
        }),
      ),
    30_000,
  )

  it.live(
    "a stopped revert whose files changed since refuses to finish or repeat and names them; finish with overwrite keeps the edit for undo",
    () =>
      timed(
        Effect.gen(function* () {
          const repo = yield* repository
          const home = yield* makeTempDirectoryScoped("cp-home-")
          const session = yield* checkpointSession(repo, home, [
            put("a.txt", "two\n"),
            textStep("done 1"),
          ])
          yield* session.turn("change a", "done 1")
          yield* session.revert("revert-1", filesOf(1))
          const store = (yield* storeOf(home))[0] ?? ""
          const done = (yield* storeRefs(store)).find((name) => name.endsWith("/done")) ?? ""
          yield* sh(store, `git --git-dir="${store}" update-ref -d '${done}'`)
          // An edit after the stop: neither the revert's before nor its target.
          yield* sh(repo, "printf 'edited\\n' > a.txt")
          expect((yield* session.list).unfinished).toEqual({ requestId: "revert-1" })
          const finish = yield* session.revert("finish-1", FINISH)
          expect(finish).toMatchObject({ _tag: "Refused", conflicts: ["a.txt"] })
          expect(yield* contentOf(repo, "a.txt")).toBe("edited")
          const retry = yield* session.revert("revert-1", filesOf(1))
          expect(retry).toMatchObject({ _tag: "Refused", conflicts: ["a.txt"] })
          expect(yield* contentOf(repo, "a.txt")).toBe("edited")
          const overwritten = yield* session.revert("finish-1", FINISH, true)
          expect(overwritten).toEqual({ _tag: "Reverted", files: ["a.txt"] })
          expect(yield* contentOf(repo, "a.txt")).toBe("one")
          expect((yield* session.list).unfinished).toBeUndefined()
          const undone = yield* session.revert("undo-1", UNDO)
          expect(undone).toEqual({ _tag: "Reverted", files: ["a.txt"] })
          expect(yield* contentOf(repo, "a.txt")).toBe("edited")
        }),
      ),
    30_000,
  )

  it.live(
    "a link where the revert needs a directory refuses, names it and stays, with overwrite too",
    () =>
      timed(
        Effect.gen(function* () {
          const repo = yield* repository
          const home = yield* makeTempDirectoryScoped("cp-home-")
          const elsewhere = yield* makeTempDirectoryScoped("cp-elsewhere-")
          yield* sh(repo, "mkdir d && printf 'dee\\n' > d/a.txt && git add -A && git commit -qm d")
          const session = yield* checkpointSession(repo, home, [
            toolCallStep("drop", { path: "d/a.txt" }),
            textStep("done 1"),
          ])
          yield* session.turn("drop d/a", "done 1")
          yield* sh(repo, `rmdir d && ln -s "${elsewhere}" d`)
          for (const [id, overwrite] of [
            ["revert-1", false],
            ["revert-2", true],
          ] as const) {
            const outcome = yield* session.revert(id, filesOf(1), overwrite)
            expect(outcome).toMatchObject({ _tag: "Refused", conflicts: ["d"] })
          }
          expect(yield* sh(repo, "test -L d && echo link || echo other")).toBe("link")
          expect(yield* sh(elsewhere, "ls -A | wc -l")).toBe("0")
        }),
      ),
    30_000,
  )

  it.live(
    "a directory a removal leaves holding someone else's file stays, with the file",
    () =>
      timed(
        Effect.gen(function* () {
          const repo = yield* repository
          const home = yield* makeTempDirectoryScoped("cp-home-")
          const session = yield* checkpointSession(repo, home, [
            put("new/deep/made.txt", "made\n"),
            textStep("done 1"),
          ])
          yield* session.turn("make a file", "done 1")
          yield* sh(repo, "printf 'mine\\n' > new/mine.txt")
          const outcome = yield* session.revert("revert-1", filesOf(1))
          expect(outcome).toEqual({ _tag: "Reverted", files: ["new/deep/made.txt"] })
          expect(yield* sh(repo, "test -e new/deep && echo there || echo gone")).toBe("gone")
          expect(yield* contentOf(repo, "new/mine.txt")).toBe("mine")
        }),
      ),
    30_000,
  )

  it.live(
    "a turn that put a file where a directory was reverts: the file goes and the directory returns, and undo puts the file back",
    () =>
      timed(
        Effect.gen(function* () {
          const repo = yield* repository
          const home = yield* makeTempDirectoryScoped("cp-home-")
          yield* sh(repo, "mkdir d && printf 'dee\\n' > d/a.txt && git add -A && git commit -qm d")
          const session = yield* checkpointSession(repo, home, [
            toolCallStep("drop", { path: "d" }),
            put("d", "now a file\n"),
            textStep("done 1"),
          ])
          yield* session.turn("flatten d", "done 1")
          expect(yield* contentOf(repo, "d")).toBe("now a file")
          const outcome = yield* session.revert("revert-1", filesOf(1))
          expect(outcome).toEqual({ _tag: "Reverted", files: ["d", "d/a.txt"] })
          expect(yield* contentOf(repo, "d/a.txt")).toBe("dee")
          const undone = yield* session.revert("undo-1", UNDO)
          expect(undone).toEqual({ _tag: "Reverted", files: ["d", "d/a.txt"] })
          expect(yield* contentOf(repo, "d")).toBe("now a file")
        }),
      ),
    30_000,
  )

  it.live(
    "a path the turn changed that others changed and changed back is a conflict",
    () =>
      timed(
        Effect.gen(function* () {
          const repo = yield* repository
          const home = yield* makeTempDirectoryScoped("cp-home-")
          const session = yield* checkpointSession(repo, home, [
            put("a.txt", "two\n"),
            textStep("done 1"),
            put("a.txt", "two\n"),
            textStep("other 1"),
          ])
          yield* session.turn("change a", "done 1")
          yield* sh(repo, "printf 'three\\n' > a.txt")
          const other = yield* session.client.session.create({ cwd: repo })
          yield* session.at(other).turn("other work", "other 1")
          const outcome = yield* session.revert("revert-1", filesOf(1))
          expect(outcome).toMatchObject({ _tag: "Refused", conflicts: ["a.txt"] })
          expect(yield* contentOf(repo, "a.txt")).toBe("two")
        }),
      ),
    30_000,
  )

  it.live(
    "a removal the file system refuses fails the revert and leaves it unfinished; finish removes the file once allowed",
    () =>
      timed(
        Effect.gen(function* () {
          const repo = yield* repository
          const home = yield* makeTempDirectoryScoped("cp-home-")
          const session = yield* checkpointSession(repo, home, [
            put("locked/made.txt", "made\n"),
            textStep("done 1"),
          ])
          yield* session.turn("make a file", "done 1")
          // The release lets the temp directory go, should the test stop early.
          yield* Effect.acquireRelease(sh(repo, "chmod 555 locked"), () =>
            sh(repo, "if [ -d locked ]; then chmod 755 locked; fi"),
          )
          const failed = yield* session.revert("revert-1", filesOf(1)).pipe(Effect.flip)
          expect(String(failed.message)).toContain("locked/made.txt")
          expect(yield* contentOf(repo, "locked/made.txt")).toBe("made")
          expect((yield* session.list).unfinished).toEqual({ requestId: "revert-1" })
          yield* sh(repo, "chmod 755 locked")
          const finished = yield* session.revert("finish-1", FINISH)
          expect(finished).toEqual({ _tag: "Reverted", files: ["locked/made.txt"] })
          expect(yield* sh(repo, "test -e locked && echo there || echo gone")).toBe("gone")
        }),
      ),
    30_000,
  )
  it.live(
    "a file whose name a quoting channel would read as another file's keeps its own bytes for undo",
    () =>
      timed(
        Effect.gen(function* () {
          const repo = yield* repository
          const home = yield* makeTempDirectoryScoped("cp-home-")
          const fs = yield* FileSystem.FileSystem
          yield* fs.writeFileString(`${repo}/a`, "neighbor\n")
          const quoted = '"a"'
          const session = yield* checkpointSession(repo, home, [
            put(quoted, "made\n"),
            textStep("done 1"),
          ])
          yield* session.turn("make a quoted name", "done 1")
          yield* fs.writeFileString(`${repo}/${quoted}`, "user\n")
          const overwritten = yield* session.revert("revert-1", filesOf(1), true)
          expect(overwritten).toEqual({ _tag: "Reverted", files: [quoted] })
          expect(yield* fs.exists(`${repo}/${quoted}`)).toBe(false)
          expect(yield* fs.readFileString(`${repo}/a`)).toBe("neighbor\n")
          expect(yield* session.revert("undo-1", UNDO)).toEqual({
            _tag: "Reverted",
            files: [quoted],
          })
          expect(yield* fs.readFileString(`${repo}/${quoted}`)).toBe("user\n")
          expect(yield* fs.readFileString(`${repo}/a`)).toBe("neighbor\n")
        }),
      ),
    30_000,
  )

  it.live(
    "names with a line break or a tab revert and undo byte for byte",
    () =>
      timed(
        Effect.gen(function* () {
          const repo = yield* repository
          const home = yield* makeTempDirectoryScoped("cp-home-")
          const fs = yield* FileSystem.FileSystem
          const names = ["new\nline.txt", "tab\there.txt"]
          const session = yield* checkpointSession(repo, home, [
            multiToolCallStep(
              ...names.map((name) => ({
                toolName: "put",
                input: { path: name, content: "made\n" },
              })),
            ),
            textStep("done 1"),
          ])
          yield* session.turn("make odd names", "done 1")
          for (const name of names) yield* fs.writeFileString(`${repo}/${name}`, `user ${name}`)
          const overwritten = yield* session.revert("revert-1", filesOf(1), true)
          expect(overwritten).toEqual({ _tag: "Reverted", files: names })
          for (const name of names) expect(yield* fs.exists(`${repo}/${name}`)).toBe(false)
          expect(yield* session.revert("undo-1", UNDO)).toEqual({ _tag: "Reverted", files: names })
          for (const name of names)
            expect(yield* fs.readFileString(`${repo}/${name}`)).toBe(`user ${name}`)
        }),
      ),
    30_000,
  )
})

// ── retention ───────────────────────────────────────────────────────────────

describe("checkpoint retention", () => {
  it.live(
    "a deleted session's checkpoints go, and so does what only they kept",
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
        // What the refs kept goes at git's next collection, which runs now.
        yield* waitFor(collectedAt(store), (at) => at !== "none", 8000, "garbage collected")
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.timeout("25 seconds")),
    30_000,
  )

  it.live(
    "checkpoints past 30 days go at the retention pass, garbage goes once a day, and a store whose work tree is gone goes",
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
        // A pass collects garbage when the last collection is a day old, aged refs or not.
        expect(yield* collectedAt(store)).toBe(String(now))
        yield* pruneCheckpoints(dataDir, now + 1000)
        expect(yield* collectedAt(store)).toBe(String(now))
        const later = now + Duration.toMillis(Duration.days(1))
        yield* pruneCheckpoints(dataDir, later)
        expect(yield* collectedAt(store)).toBe(String(later))
        yield* pruneCheckpoints(dataDir, now + Duration.toMillis(Duration.days(31)))
        expect(yield* storeRefs(store)).toEqual([])
        yield* sh(repo, `mv "${repo}" "${repo}-gone"`)
        yield* pruneCheckpoints(dataDir, now)
        expect(yield* storeOf(home)).toEqual([])
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.timeout("25 seconds")),
    30_000,
  )
})

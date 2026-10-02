import { createContext, createSignal, type JSX, onCleanup, onMount } from "solid-js"
import { useRequiredContext } from "./utils"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { Context, Effect, Fiber, FileSystem, Option, Stream } from "effect"

// ── environment provider ────────────────────────────────────────────────────

/**
 * Environment context — env vars read via Effect Config at startup,
 * threaded to components via Solid context.
 */

interface EnvContextValue {
  /** $VISUAL editor */
  visual: Option.Option<string>
  /** $EDITOR editor */
  editor: Option.Option<string>
  /** Graceful shutdown — triggers Effect scope cleanup instead of process.exit */
  shutdown: () => void
  /** Sessions outlive the process. False for an in-memory store (`--debug`, `--isolate`): nothing to resume. */
  resumable: boolean
  /** Writes to the terminal the reader keeps, once the renderer is gone. */
  writeTerminal: (text: string) => void
}

interface EnvValue extends EnvContextValue {
  /**
   * True for the first exit the process starts, false for every one after
   * it. The guard lives here, with the shutdown it guards, so an exit from a
   * view that remounted, or from the fatal screen, never leaves twice.
   */
  beginExit: () => boolean
}

const EnvContext = createContext<EnvValue>()

export function useEnv(): EnvValue {
  return useRequiredContext(EnvContext, "useEnv must be used within EnvProvider")
}

interface EnvProviderProps {
  env: EnvContextValue
  children: JSX.Element
}

export function EnvProvider(props: EnvProviderProps) {
  let exiting = false
  const value: EnvValue = {
    ...props.env,
    beginExit: () => {
      if (exiting) return false
      exiting = true
      return true
    },
  }
  return <EnvContext.Provider value={value}>{props.children}</EnvContext.Provider>
}

// ── workspace provider ──────────────────────────────────────────────────────

interface WorkspaceContextValue {
  cwd: string
  home: string
  /** The checkout's top directory; none outside git or until the first read lands. */
  gitRoot: () => Option.Option<string>
  /** The branch, or `detached @<sha>`; none outside git or until the first read lands. */
  gitBranch: () => Option.Option<string>
}

const WorkspaceContext = createContext<WorkspaceContextValue>()

export function useWorkspace(): WorkspaceContextValue {
  return useRequiredContext(WorkspaceContext, "useWorkspace must be used within WorkspaceProvider")
}

interface WorkspaceProviderProps {
  cwd: string
  home: string
  children: JSX.Element
  services?: Context.Context<unknown>
}

interface GitInfo {
  readonly root: string
  readonly branch: string
}

const gitCommand = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* ChildProcess.make("git", [...args], {
        cwd,
        forceKillAfter: "2 seconds",
      })
      const chunks = yield* Stream.runCollect(handle.stdout)
      const decoder = new TextDecoder()
      return chunks.reduce((acc, chunk) => acc + decoder.decode(chunk), "").trim()
    }),
  )

const getGitInfo = (
  cwd: string,
): Effect.Effect<Option.Option<GitInfo>, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const root = yield* gitCommand(cwd, ["rev-parse", "--show-toplevel"]).pipe(
      Effect.catchEager(() => Effect.succeed("")),
    )
    if (root.length === 0) return Option.none()

    // `symbolic-ref` names an unborn branch too, and prints nothing when HEAD
    // is detached; a detached HEAD then reads by its commit.
    const branchName = yield* gitCommand(cwd, ["symbolic-ref", "--short", "-q", "HEAD"]).pipe(
      Effect.catchEager(() => Effect.succeed("")),
    )
    let branch = branchName
    if (branch.length === 0) {
      const sha = yield* gitCommand(cwd, ["rev-parse", "--short", "HEAD"]).pipe(
        Effect.catchEager(() => Effect.succeed("")),
      )
      if (sha.length === 0) return Option.none()
      branch = `detached @${sha}`
    }

    return Option.some({ root, branch })
  })

/** The files git writes when the checkout's branch or index moves. */
const GIT_STATE_FILES = new Set(["index", "HEAD", "MERGE_HEAD"])

/**
 * A tick each time the checkout may have moved. Git names the directory that
 * holds this checkout's HEAD and index: the launch directory may be a
 * subdirectory of the repository, or a worktree whose `.git` is a file. Its
 * writes are watched and debounced. Outside a repository nothing ticks. Where
 * the watch cannot run (no `FileSystem`, no git, a failed watch) a poll
 * stands in.
 */
const gitStateChanges = (
  cwd: string,
  fs: Option.Option<FileSystem.FileSystem>,
): Stream.Stream<void, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const watcher = yield* Effect.fromOption(fs)
      const gitDir = yield* gitCommand(cwd, ["rev-parse", "--absolute-git-dir"])
      if (gitDir.length === 0) return Stream.empty
      return watcher.watch(gitDir).pipe(
        Stream.filter((event) => GIT_STATE_FILES.has(event.path.split("/").pop() ?? "")),
        Stream.debounce("200 millis"),
        Stream.map((): void => {}),
      )
    }),
  ).pipe(
    Stream.catchCause((cause) =>
      Stream.fromEffect(
        Effect.logDebug("[workspace] git watch failed, falling back to polling").pipe(
          Effect.annotateLogs({ error: String(cause) }),
        ),
      ).pipe(Stream.drain, Stream.concat(Stream.tick("2 seconds"))),
    ),
  )

export function WorkspaceProvider(props: WorkspaceProviderProps) {
  const [gitInfo, setGitInfo] = createSignal<Option.Option<GitInfo>>(Option.none())
  const services = Option.getOrElse(Option.fromNullishOr(props.services), () => Context.empty())

  // One fiber reads the checkout now and again on each change; a read still
  // running when the next change lands is dropped for the newer one. It reads
  // `FileSystem` and the process spawner from the services the root provides
  // (`uiServices` in `main.tsx`); without a spawner nothing is read.
  onMount(() => {
    const spawner = Context.getOption(services, ChildProcessSpawner.ChildProcessSpawner)
    if (Option.isNone(spawner)) return
    const reads = Stream.concat(
      Stream.fromEffect(Effect.void),
      gitStateChanges(props.cwd, Context.getOption(services, FileSystem.FileSystem)),
    ).pipe(
      Stream.switchMap(() => Stream.fromEffect(getGitInfo(props.cwd))),
      Stream.runForEach((info) => Effect.sync(() => setGitInfo(info))),
    )
    const fiber = Effect.runForkWith(
      Context.make(ChildProcessSpawner.ChildProcessSpawner, spawner.value),
    )(reads)
    onCleanup(() => {
      Effect.runFork(Fiber.interrupt(fiber))
    })
  })

  const value: WorkspaceContextValue = {
    cwd: props.cwd,
    home: props.home,
    gitRoot: () => Option.map(gitInfo(), (info) => info.root),
    gitBranch: () => Option.map(gitInfo(), (info) => info.branch),
  }

  return <WorkspaceContext.Provider value={value}>{props.children}</WorkspaceContext.Provider>
}

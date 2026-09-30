import { createContext, createSignal, type JSX, onCleanup, onMount } from "solid-js"
import { useRequiredContext } from "./utils"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { type Cause, Context, Effect, Fiber, FileSystem, Option, Stream } from "effect"

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

const EnvContext = createContext<EnvContextValue>()

export function useEnv(): EnvContextValue {
  return useRequiredContext(EnvContext, "useEnv must be used within EnvProvider")
}

interface EnvProviderProps {
  env: EnvContextValue
  children: JSX.Element
}

export function EnvProvider(props: EnvProviderProps) {
  return <EnvContext.Provider value={props.env}>{props.children}</EnvContext.Provider>
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
      const handle = yield* ChildProcess.make("git", [...args], { cwd })
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

export function WorkspaceProvider(props: WorkspaceProviderProps) {
  const [gitInfo, setGitInfo] = createSignal<Option.Option<GitInfo>>(Option.none())
  const services = Option.getOrElse(Option.fromNullishOr(props.services), () => Context.empty())
  let currentFiber = Option.none<Fiber.Fiber<Option.Option<GitInfo>, never>>()

  const refreshGitInfo = () => {
    if (Option.isSome(currentFiber)) {
      Effect.runFork(Fiber.interrupt(currentFiber.value))
    }
    const gitServices = Context.getOption(services, ChildProcessSpawner.ChildProcessSpawner)
    if (Option.isNone(gitServices)) {
      setGitInfo(Option.none())
      return
    }
    const gitContext = Context.make(ChildProcessSpawner.ChildProcessSpawner, gitServices.value)
    currentFiber = Option.some(
      Effect.runForkWith(gitContext)(
        getGitInfo(props.cwd).pipe(
          Effect.tap((info) =>
            Effect.sync(() => {
              setGitInfo(info)
            }),
          ),
        ),
      ),
    )
  }

  onMount(() => {
    // Initial fetch
    refreshGitInfo()

    // Watch .git/index and .git/HEAD for changes (debounced)
    let debounceFiber = Option.none<Fiber.Fiber<void, never>>()
    const DEBOUNCE_MS = 200
    const debouncedRefresh = () => {
      if (Option.isSome(debounceFiber)) Effect.runFork(Fiber.interrupt(debounceFiber.value))
      debounceFiber = Option.some(
        Effect.runFork(
          Effect.sleep(`${DEBOUNCE_MS} millis`).pipe(
            Effect.andThen(
              Effect.sync(() => {
                debounceFiber = Option.none()
                refreshGitInfo()
              }),
            ),
          ),
        ),
      )
    }

    let watchFiber = Option.none<Fiber.Fiber<void, never>>()
    let fallbackFiber = Option.none<Fiber.Fiber<void, never>>()

    const startPollingFallback = (reason: Cause.Cause<unknown>) => {
      Effect.runFork(
        Effect.logDebug("[workspace] git watch failed, falling back to polling").pipe(
          Effect.annotateLogs({ error: String(reason) }),
        ),
      )
      fallbackFiber = Option.some(
        Effect.runFork(
          Effect.forever(
            Effect.sleep("2 seconds").pipe(Effect.andThen(Effect.sync(refreshGitInfo))),
          ),
        ),
      )
    }

    // The watch reads `FileSystem` and the process spawner from the services
    // the root provides (`uiServices` in `main.tsx`); without them the poll
    // stands in. Git names the directory that holds this checkout's HEAD and
    // index: the launch directory may be a subdirectory of the repository, or
    // a worktree whose `.git` is a file. Outside a repository nothing is
    // watched.
    const watchProgram = Effect.gen(function* () {
      const fs = yield* Effect.fromOption(Context.getOption(services, FileSystem.FileSystem))
      const spawner = yield* Effect.fromOption(
        Context.getOption(services, ChildProcessSpawner.ChildProcessSpawner),
      )
      const gitDir = yield* gitCommand(props.cwd, ["rev-parse", "--absolute-git-dir"]).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      )
      if (gitDir.length === 0) return
      yield* fs.watch(gitDir).pipe(
        Stream.runForEach((event) => {
          const name = Option.getOrElse(Option.fromNullishOr(event.path.split("/").pop()), () => "")
          if (name === "index" || name === "HEAD" || name === "MERGE_HEAD") {
            debouncedRefresh()
          }
          return Effect.void
        }),
      )
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          startPollingFallback(cause)
        }),
      ),
    )

    watchFiber = Option.some(Effect.runFork(watchProgram))

    onCleanup(() => {
      if (Option.isSome(currentFiber)) {
        Effect.runFork(Fiber.interrupt(currentFiber.value))
      }
      if (Option.isSome(debounceFiber)) Effect.runFork(Fiber.interrupt(debounceFiber.value))
      if (Option.isSome(watchFiber)) Effect.runFork(Fiber.interrupt(watchFiber.value))
      if (Option.isSome(fallbackFiber)) Effect.runFork(Fiber.interrupt(fallbackFiber.value))
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

import { createContext, useContext, onMount, onCleanup, createSignal } from "solid-js"
import type { JSX } from "solid-js"
import type { ChildProcessSpawner } from "effect/unstable/process"
import { ChildProcess } from "effect/unstable/process"
import { Effect, Fiber, FileSystem, Context, Stream } from "effect"
import { BunFileSystem } from "@effect/platform-bun"

export interface GitStatus {
  branch: string
  files: number
  additions: number
  deletions: number
}

interface WorkspaceContextValue {
  cwd: string
  home: string
  gitRoot: () => string | null
  gitStatus: () => GitStatus | null
  isGitRepo: () => boolean
  projectName: () => string
}

const WorkspaceContext = createContext<WorkspaceContextValue>()

export function useWorkspace(): WorkspaceContextValue {
  const ctx = useContext(WorkspaceContext)
  if (ctx === undefined) throw new Error("useWorkspace must be used within WorkspaceProvider")
  return ctx
}

interface WorkspaceProviderProps {
  cwd: string
  home: string
  children: JSX.Element
  services?: Context.Context<unknown>
}

interface GitInfo {
  root: string
  status: GitStatus
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
): Effect.Effect<GitInfo | null, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const root = yield* gitCommand(cwd, ["rev-parse", "--show-toplevel"]).pipe(
      Effect.catchEager(() => Effect.succeed("")),
    )
    if (root.length === 0) return null

    const branch = yield* gitCommand(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]).pipe(
      Effect.catchEager(() => Effect.succeed("")),
    )
    if (branch.length === 0) return null

    const diffText = yield* gitCommand(cwd, ["diff", "--stat", "HEAD"]).pipe(
      Effect.catchEager(() => Effect.succeed("")),
    )

    let files = 0
    let additions = 0
    let deletions = 0

    // Parse last line: " N files changed, X insertions(+), Y deletions(-)"
    const lines = diffText.trim().split("\n")
    const summaryLine = lines[lines.length - 1] ?? ""

    const filesMatch = summaryLine.match(/(\d+) files? changed/)
    const addMatch = summaryLine.match(/(\d+) insertions?\(\+\)/)
    const delMatch = summaryLine.match(/(\d+) deletions?\(-\)/)

    const filesValue = filesMatch?.[1]
    const addValue = addMatch?.[1]
    const delValue = delMatch?.[1]

    if (filesValue !== undefined) files = parseInt(filesValue, 10)
    if (addValue !== undefined) additions = parseInt(addValue, 10)
    if (delValue !== undefined) deletions = parseInt(delValue, 10)

    return { root, status: { branch, files, additions, deletions } }
  })

function deriveProjectName(cwd: string, gitRoot: string | null): string {
  // Prefer git repo name
  if (gitRoot !== null) {
    const parts = gitRoot.split("/")
    return parts[parts.length - 1] ?? gitRoot
  }
  // Fall back to cwd dirname
  const parts = cwd.split("/")
  return parts[parts.length - 1] ?? cwd
}

export function WorkspaceProvider(props: WorkspaceProviderProps) {
  const [gitInfo, setGitInfo] = createSignal<GitInfo | null>(null)
  const services = props.services ?? Context.empty()
  let currentFiber: Fiber.Fiber<GitInfo | null, never> | null = null

  const refreshGitInfo = () => {
    if (currentFiber !== null) {
      Effect.runFork(Fiber.interrupt(currentFiber))
    }
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- platform boundary validates foreign runtime shape before use
    const gitServices = services as Context.Context<ChildProcessSpawner.ChildProcessSpawner>
    currentFiber = Effect.runForkWith(gitServices)(
      getGitInfo(props.cwd).pipe(
        Effect.tap((info) =>
          Effect.sync(() => {
            setGitInfo(info)
          }),
        ),
      ),
    )
  }

  onMount(() => {
    // Initial fetch
    refreshGitInfo()

    // Watch .git/index and .git/HEAD for changes (debounced)
    let debounceFiber: Fiber.Fiber<void, never> | null = null
    const DEBOUNCE_MS = 200
    const debouncedRefresh = () => {
      if (debounceFiber !== null) Effect.runFork(Fiber.interrupt(debounceFiber))
      debounceFiber = Effect.runFork(
        Effect.sleep(`${DEBOUNCE_MS} millis`).pipe(
          Effect.andThen(
            Effect.sync(() => {
              debounceFiber = null
              refreshGitInfo()
            }),
          ),
        ),
      )
    }

    let watchFiber: Fiber.Fiber<void, never> | null = null
    let fallbackFiber: Fiber.Fiber<void, never> | null = null

    const gitDir = `${props.cwd}/.git`
    const startPollingFallback = (reason: unknown) => {
      Effect.runFork(
        Effect.logDebug("[workspace] git watch failed, falling back to polling").pipe(
          Effect.annotateLogs({ error: String(reason) }),
        ),
      )
      fallbackFiber = Effect.runFork(
        Effect.forever(Effect.sleep("2 seconds").pipe(Effect.andThen(Effect.sync(refreshGitInfo)))),
      )
    }

    const watchProgram = Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      yield* fs.watch(gitDir).pipe(
        Stream.runForEach((event) => {
          const name = event.path.split("/").pop() ?? ""
          if (name === "index" || name === "HEAD" || name === "MERGE_HEAD") {
            debouncedRefresh()
          }
          return Effect.void
        }),
      )
    }).pipe(
      // @effect-diagnostics-next-line strictEffectProvide:off solid mount edge — isolated FS effect
      Effect.provide(BunFileSystem.layer),
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          startPollingFallback(cause)
        }),
      ),
    )

    watchFiber = Effect.runFork(watchProgram)

    onCleanup(() => {
      if (currentFiber !== null) {
        Effect.runFork(Fiber.interrupt(currentFiber))
      }
      if (debounceFiber !== null) Effect.runFork(Fiber.interrupt(debounceFiber))
      if (watchFiber !== null) Effect.runFork(Fiber.interrupt(watchFiber))
      if (fallbackFiber !== null) Effect.runFork(Fiber.interrupt(fallbackFiber))
    })
  })

  const value: WorkspaceContextValue = {
    cwd: props.cwd,
    home: props.home,
    gitRoot: () => gitInfo()?.root ?? null,
    gitStatus: () => gitInfo()?.status ?? null,
    isGitRepo: () => gitInfo() !== null,
    projectName: () => deriveProjectName(props.cwd, gitInfo()?.root ?? null),
  }

  return <WorkspaceContext.Provider value={value}>{props.children}</WorkspaceContext.Provider>
}

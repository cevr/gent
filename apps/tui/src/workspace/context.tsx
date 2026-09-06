import { createContext, onMount, onCleanup, createSignal } from "solid-js"
import { useRequiredContext } from "../utils/solid-context"
import type { JSX } from "solid-js"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { Effect, Fiber, FileSystem, Context, Option, Stream } from "effect"
import type { Cause } from "effect"
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
  // eslint-disable-next-line effect/noNullish -- UI consumers use null while git metadata is unavailable.
  gitRoot: () => string | null
  // eslint-disable-next-line effect/noNullish -- UI consumers use null while git metadata is unavailable.
  gitStatus: () => GitStatus | null
  isGitRepo: () => boolean
  projectName: () => string
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
): Effect.Effect<Option.Option<GitInfo>, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const root = yield* gitCommand(cwd, ["rev-parse", "--show-toplevel"]).pipe(
      Effect.catchEager(() => Effect.succeed("")),
    )
    if (root.length === 0) return Option.none()

    const branch = yield* gitCommand(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]).pipe(
      Effect.catchEager(() => Effect.succeed("")),
    )
    if (branch.length === 0) return Option.none()

    const diffText = yield* gitCommand(cwd, ["diff", "--stat", "HEAD"]).pipe(
      Effect.catchEager(() => Effect.succeed("")),
    )

    let files = 0
    let additions = 0
    let deletions = 0

    // Parse last line: " N files changed, X insertions(+), Y deletions(-)"
    const lines = diffText.trim().split("\n")
    const summaryLine = Option.getOrElse(Option.fromNullishOr(lines[lines.length - 1]), () => "")

    const filesMatch = summaryLine.match(/(\d+) files? changed/)
    const addMatch = summaryLine.match(/(\d+) insertions?\(\+\)/)
    const delMatch = summaryLine.match(/(\d+) deletions?\(-\)/)

    const filesValue = Option.flatMap(Option.fromNullishOr(filesMatch), (match) =>
      Option.fromNullishOr(match[1]),
    )
    const addValue = Option.flatMap(Option.fromNullishOr(addMatch), (match) =>
      Option.fromNullishOr(match[1]),
    )
    const delValue = Option.flatMap(Option.fromNullishOr(delMatch), (match) =>
      Option.fromNullishOr(match[1]),
    )

    if (Option.isSome(filesValue)) files = parseInt(filesValue.value, 10)
    if (Option.isSome(addValue)) additions = parseInt(addValue.value, 10)
    if (Option.isSome(delValue)) deletions = parseInt(delValue.value, 10)

    return Option.some({ root, status: { branch, files, additions, deletions } })
  })

function deriveProjectName(cwd: string, gitRoot: Option.Option<string>): string {
  // Prefer git repo name
  if (Option.isSome(gitRoot)) {
    const parts = gitRoot.value.split("/")
    return Option.getOrElse(Option.fromNullishOr(parts[parts.length - 1]), () => gitRoot.value)
  }
  // Fall back to cwd dirname
  const parts = cwd.split("/")
  return Option.getOrElse(Option.fromNullishOr(parts[parts.length - 1]), () => cwd)
}

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

    const gitDir = `${props.cwd}/.git`
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

    const watchProgram = Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
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
      // @effect-diagnostics-next-line strictEffectProvide:off solid mount edge — isolated FS effect
      Effect.provide(BunFileSystem.layer),
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
    gitRoot: () => Option.getOrNull(Option.flatMap(gitInfo(), (info) => Option.some(info.root))),
    gitStatus: () =>
      Option.getOrNull(Option.flatMap(gitInfo(), (info) => Option.some(info.status))),
    isGitRepo: () => Option.isSome(gitInfo()),
    projectName: () =>
      deriveProjectName(
        props.cwd,
        Option.map(gitInfo(), (info) => info.root),
      ),
  }

  return <WorkspaceContext.Provider value={value}>{props.children}</WorkspaceContext.Provider>
}

import { createContext, useContext, onMount, onCleanup, createSignal } from "solid-js"
import type { JSX } from "solid-js"
import { Command } from "@effect/platform"
import { Effect, Fiber, Runtime } from "effect"

export interface GitStatus {
  branch: string
  files: number
  additions: number
  deletions: number
}

interface WorkspaceContextValue {
  cwd: string
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
  children: JSX.Element
  runtime?: Runtime.Runtime<unknown>
}

interface GitInfo {
  root: string
  status: GitStatus
}

const gitCommand = (cwd: string, args: ReadonlyArray<string>) =>
  Command.make("git", ...args).pipe(
    Command.workingDirectory(cwd),
    Command.string,
    Effect.map((text) => text.trim()),
  )

const getGitInfo = (cwd: string) =>
  Effect.gen(function* () {
    const root = yield* gitCommand(cwd, ["rev-parse", "--show-toplevel"]).pipe(
      Effect.catchAll(() => Effect.succeed("")),
    )
    if (root.length === 0) return null

    const branch = yield* gitCommand(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]).pipe(
      Effect.catchAll(() => Effect.succeed("")),
    )
    if (branch.length === 0) return null

    const diffText = yield* gitCommand(cwd, ["diff", "--stat", "HEAD"]).pipe(
      Effect.catchAll(() => Effect.succeed("")),
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
  const runtime = props.runtime ?? (Runtime.defaultRuntime as Runtime.Runtime<unknown>)
  let currentFiber: Fiber.RuntimeFiber<GitInfo | null, never> | null = null

  const refreshGitInfo = () => {
    if (currentFiber !== null) {
      Runtime.runFork(runtime)(Fiber.interruptFork(currentFiber))
    }
    currentFiber = Runtime.runFork(runtime)(
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
    let debounceTimer: ReturnType<typeof setTimeout> | null = null
    const DEBOUNCE_MS = 200
    const debouncedRefresh = () => {
      if (debounceTimer !== null) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => {
        debounceTimer = null
        refreshGitInfo()
      }, DEBOUNCE_MS)
    }

    const fsWatchers: { close: () => void }[] = []
    let fallbackInterval: ReturnType<typeof setInterval> | null = null

    try {
      const { watch } = require("node:fs")
      const gitDir = `${props.cwd}/.git`
      // Watch .git directory for index/HEAD changes
      const watcher = watch(
        gitDir,
        { persistent: false },
        (_eventType: string, filename: string | null) => {
          if (filename === "index" || filename === "HEAD" || filename === "MERGE_HEAD") {
            debouncedRefresh()
          }
        },
      )
      fsWatchers.push(watcher)
    } catch {
      // Fallback to polling if watch fails (not a git repo, etc.)
      fallbackInterval = setInterval(refreshGitInfo, 2000)
    }

    onCleanup(() => {
      if (currentFiber !== null) {
        Runtime.runFork(runtime)(Fiber.interruptFork(currentFiber))
      }
      if (debounceTimer !== null) clearTimeout(debounceTimer)
      for (const w of fsWatchers) w.close()
      if (fallbackInterval !== null) clearInterval(fallbackInterval)
    })
  })

  const value: WorkspaceContextValue = {
    cwd: props.cwd,
    gitRoot: () => gitInfo()?.root ?? null,
    gitStatus: () => gitInfo()?.status ?? null,
    isGitRepo: () => gitInfo() !== null,
    projectName: () => deriveProjectName(props.cwd, gitInfo()?.root ?? null),
  }

  return <WorkspaceContext.Provider value={value}>{props.children}</WorkspaceContext.Provider>
}

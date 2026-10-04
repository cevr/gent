import { createContext, type JSX } from "solid-js"
import { useRequiredContext } from "./utils"
import { Effect, FileSystem, Option, Path } from "effect"

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
}

const WorkspaceContext = createContext<WorkspaceContextValue>()

export function useWorkspace(): WorkspaceContextValue {
  return useRequiredContext(WorkspaceContext, "useWorkspace must be used within WorkspaceProvider")
}

interface WorkspaceProviderProps {
  cwd: string
  home: string
  children: JSX.Element
}

export function WorkspaceProvider(props: WorkspaceProviderProps) {
  const value: WorkspaceContextValue = { cwd: props.cwd, home: props.home }
  return <WorkspaceContext.Provider value={value}>{props.children}</WorkspaceContext.Provider>
}

// ── project root ────────────────────────────────────────────────────────────

/**
 * The nearest directory at or above `cwd` that holds a `.git` (a directory,
 * or the file a worktree has). A stat walk, no process: the host names the
 * cwd by its project and reads no git; the branch and the changes are the
 * `@gent/git` extension's. None outside a checkout, and when a stat fails.
 */
export const projectRoot = (
  cwd: string,
): Effect.Effect<Option.Option<string>, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    let dir = path.resolve(cwd)
    while (true) {
      if (yield* fs.exists(path.join(dir, ".git"))) return Option.some(dir)
      const parent = path.dirname(dir)
      if (parent === dir) return Option.none<string>()
      dir = parent
    }
  }).pipe(Effect.orElseSucceed(() => Option.none<string>()))

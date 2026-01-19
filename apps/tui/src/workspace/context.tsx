import { createContext, useContext, onMount, onCleanup, createSignal } from "solid-js"
import type { JSX } from "solid-js"
import { spawn } from "bun"

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
  if (!ctx) throw new Error("useWorkspace must be used within WorkspaceProvider")
  return ctx
}

interface WorkspaceProviderProps {
  cwd: string
  children: JSX.Element
}

interface GitInfo {
  root: string
  status: GitStatus
}

async function getGitInfo(cwd: string): Promise<GitInfo | null> {
  try {
    // Get repo root
    const rootProc = spawn(["git", "rev-parse", "--show-toplevel"], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    })
    const rootText = await new Response(rootProc.stdout).text()
    await rootProc.exited
    if (rootProc.exitCode !== 0) return null

    const root = rootText.trim()

    // Get branch name
    const branchProc = spawn(["git", "rev-parse", "--abbrev-ref", "HEAD"], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    })
    const branchText = await new Response(branchProc.stdout).text()
    await branchProc.exited
    if (branchProc.exitCode !== 0) return null

    const branch = branchText.trim()

    // Get diff stats (staged + unstaged)
    const diffProc = spawn(["git", "diff", "--stat", "HEAD"], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    })
    const diffText = await new Response(diffProc.stdout).text()
    await diffProc.exited

    let files = 0
    let additions = 0
    let deletions = 0

    // Parse last line: " N files changed, X insertions(+), Y deletions(-)"
    const lines = diffText.trim().split("\n")
    const summaryLine = lines[lines.length - 1] ?? ""

    const filesMatch = summaryLine.match(/(\d+) files? changed/)
    const addMatch = summaryLine.match(/(\d+) insertions?\(\+\)/)
    const delMatch = summaryLine.match(/(\d+) deletions?\(-\)/)

    if (filesMatch?.[1]) files = parseInt(filesMatch[1], 10)
    if (addMatch?.[1]) additions = parseInt(addMatch[1], 10)
    if (delMatch?.[1]) deletions = parseInt(delMatch[1], 10)

    return { root, status: { branch, files, additions, deletions } }
  } catch {
    return null
  }
}

function deriveProjectName(cwd: string, gitRoot: string | null): string {
  // Prefer git repo name
  if (gitRoot) {
    const parts = gitRoot.split("/")
    return parts[parts.length - 1] ?? gitRoot
  }
  // Fall back to cwd dirname
  const parts = cwd.split("/")
  return parts[parts.length - 1] ?? cwd
}

export function WorkspaceProvider(props: WorkspaceProviderProps) {
  const [gitInfo, setGitInfo] = createSignal<GitInfo | null>(null)

  onMount(() => {
    // Initial fetch
    void getGitInfo(props.cwd).then(setGitInfo)

    // Poll every 2 seconds
    const interval = setInterval(() => {
      void getGitInfo(props.cwd).then(setGitInfo)
    }, 2000)

    onCleanup(() => clearInterval(interval))
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

import type { AgentEvent, AgentMode } from "@gent/core"
import type { MessageInfoReadonly, SteerCommand } from "../client.js"

export interface Session {
  sessionId: string
  branchId: string
  name: string
}

// Discriminated union for session lifecycle
export type SessionState =
  | { status: "none" }
  | { status: "loading"; creating: boolean }
  | { status: "active"; session: Session }
  | { status: "switching"; fromSession: Session; toSessionId: string }

export interface SessionInfo {
  id: string
  name: string | undefined
  branchId: string | undefined
  createdAt: number
  updatedAt: number
}

export interface BranchInfo {
  id: string
  sessionId: string
  name: string | undefined
  createdAt: number
}

export interface ClientContextValue {
  // Session state (union)
  sessionState: () => SessionState

  // Derived helpers
  session: () => Session | null
  isActive: () => boolean
  isLoading: () => boolean

  // Actions - return void, update state internally
  sendMessage: (content: string, mode?: AgentMode) => Promise<void>
  createSession: (firstMessage?: string) => Promise<void>
  switchSession: (sessionId: string, branchId: string, name: string) => Promise<void>
  clearSession: () => void

  // Data fetching
  listMessages: () => Promise<readonly MessageInfoReadonly[]>
  listSessions: () => Promise<readonly SessionInfo[]>
  listBranches: () => Promise<readonly BranchInfo[]>
  createBranch: (name?: string) => Promise<string>

  // Event subscription
  subscribeEvents: (onEvent: (event: AgentEvent) => void) => () => void

  // Steering
  steer: (command: SteerCommand) => Promise<void>
}

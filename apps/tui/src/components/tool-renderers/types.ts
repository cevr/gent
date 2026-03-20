import type { JSX } from "@opentui/solid"
import type { ChildSessionEntry } from "../../hooks/use-child-sessions"

export interface ToolCall {
  id: string
  toolName: string
  status: "running" | "completed" | "error"
  input: unknown | undefined
  summary: string | undefined
  output: string | undefined
}

export interface ToolRendererProps {
  toolCall: ToolCall
  expanded: boolean
  childSessions?: ChildSessionEntry[]
}

export type ToolRenderer = (props: ToolRendererProps) => JSX.Element

import type { JSX } from "@opentui/solid"

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
}

export type ToolRenderer = (props: ToolRendererProps) => JSX.Element

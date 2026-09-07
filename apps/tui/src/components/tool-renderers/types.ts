import type { JSX } from "@opentui/solid"
import type { ChildSessionEntry } from "../../hooks/use-child-sessions"

export interface ToolCall {
  id: string
  toolName: string
  status: "running" | "completed" | "error"
  // eslint-disable-next-line effect/noNullish -- Renderer payloads preserve omitted tool fields from the event stream.
  input: unknown | undefined
  // eslint-disable-next-line effect/noNullish -- Renderer payloads preserve omitted tool fields from the event stream.
  summary: string | undefined
  // eslint-disable-next-line effect/noNullish -- Renderer payloads preserve omitted tool fields from the event stream.
  output: string | undefined
  /** Inner calls a cell admitted. Live feed only; saved results carry receipts. */
  operations?: ToolCall[]
}

export interface ToolRendererProps {
  toolCall: ToolCall
  expanded: boolean
  childSessions?: ChildSessionEntry[]
}

export type ToolRenderer = (props: ToolRendererProps) => JSX.Element

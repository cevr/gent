export type { ToolCall, ToolRendererProps, ToolRenderer } from "./types"
export { ReadToolRenderer } from "./read"
export { EditToolRenderer } from "./edit"
export { GenericToolRenderer } from "./generic"

import type { ToolRenderer } from "./types"
import { ReadToolRenderer } from "./read"
import { EditToolRenderer } from "./edit"

export const TOOL_RENDERERS: Record<string, ToolRenderer> = {
  read: ReadToolRenderer,
  edit: EditToolRenderer,
}

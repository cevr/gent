export type { ToolCall, ToolRendererProps, ToolRenderer } from "./types.js"
export { ReadToolRenderer } from "./read.js"
export { EditToolRenderer } from "./edit.js"
export { GenericToolRenderer } from "./generic.js"

import type { ToolRenderer } from "./types.js"
import { ReadToolRenderer } from "./read.js"
import { EditToolRenderer } from "./edit.js"

export const TOOL_RENDERERS: Record<string, ToolRenderer> = {
  read: ReadToolRenderer,
  edit: EditToolRenderer,
}

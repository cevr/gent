export type { ToolCall, ToolRendererProps, ToolRenderer } from "./types"
export { ReadToolRenderer } from "./read"
export { EditToolRenderer } from "./edit"
export { BashToolRenderer } from "./bash"
export { WriteToolRenderer } from "./write"
export { GrepToolRenderer } from "./grep"
export { GlobToolRenderer } from "./glob"
export { WebfetchToolRenderer } from "./webfetch"
export { GenericToolRenderer } from "./generic"

import type { ToolRenderer } from "./types"
import { ReadToolRenderer } from "./read"
import { EditToolRenderer } from "./edit"
import { BashToolRenderer } from "./bash"
import { WriteToolRenderer } from "./write"
import { GrepToolRenderer } from "./grep"
import { GlobToolRenderer } from "./glob"
import { WebfetchToolRenderer } from "./webfetch"

export const TOOL_RENDERERS: Record<string, ToolRenderer> = {
  read: ReadToolRenderer,
  edit: EditToolRenderer,
  bash: BashToolRenderer,
  write: WriteToolRenderer,
  grep: GrepToolRenderer,
  glob: GlobToolRenderer,
  webfetch: WebfetchToolRenderer,
}

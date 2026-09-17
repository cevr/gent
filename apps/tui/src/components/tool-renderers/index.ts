export type { ToolCall } from "./types"
import type { ToolRenderer } from "./types"
import {
  BashHeadlessToolRenderer,
  CellHeadlessToolRenderer,
  type HeadlessToolRenderer,
} from "../../headless-tool-renderers"

interface BuiltinToolRendererEntry {
  readonly toolNames: ReadonlyArray<string>
  readonly component: ToolRenderer
  readonly headless?: HeadlessToolRenderer
}
import { ReadToolRenderer } from "./read"
import { EditToolRenderer } from "./edit"
import { BashToolRenderer } from "./bash"
import { CellToolRenderer } from "./cell"
import { WriteToolRenderer } from "./write"
import { GrepToolRenderer } from "./grep"
import { SubagentToolRenderer } from "./subagent"
import { ReadSessionToolRenderer } from "./read-session"

/** Builtin tool renderers consumed by the `@gent/tools` client extension. */
export const BUILTIN_TOOL_RENDERERS: ReadonlyArray<BuiltinToolRendererEntry> = [
  { toolNames: ["read"], component: ReadToolRenderer },
  { toolNames: ["edit"], component: EditToolRenderer },
  { toolNames: ["bash"], component: BashToolRenderer, headless: BashHeadlessToolRenderer },
  { toolNames: ["cell"], component: CellToolRenderer, headless: CellHeadlessToolRenderer },
  { toolNames: ["write"], component: WriteToolRenderer },
  { toolNames: ["grep"], component: GrepToolRenderer },
  { toolNames: ["delegate"], component: SubagentToolRenderer },
  {
    toolNames: ["read_session"],
    component: ReadSessionToolRenderer,
  },
]

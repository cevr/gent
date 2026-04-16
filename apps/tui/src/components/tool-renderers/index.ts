export type { ToolCall, ToolRendererProps, ToolRenderer } from "./types"
export { ReadToolRenderer } from "./read"
export { EditToolRenderer } from "./edit"
export { BashToolRenderer } from "./bash"
export { WriteToolRenderer } from "./write"
export { GrepToolRenderer } from "./grep"
export { GlobToolRenderer } from "./glob"
export { WebfetchToolRenderer } from "./webfetch"
export { SubagentToolRenderer } from "./subagent"
export { ReviewToolRenderer } from "./review"
export { CounselToolRenderer } from "./counsel"
export { ResearchToolRenderer } from "./research"
export { SearchSessionsToolRenderer } from "./search-sessions"
export { ReadSessionToolRenderer } from "./read-session"
export { SkillsToolRenderer } from "./skills"
import type { ToolRenderer } from "./types"

interface BuiltinToolRendererEntry {
  readonly toolNames: ReadonlyArray<string>
  readonly component: ToolRenderer
}
import { ReadToolRenderer } from "./read"
import { EditToolRenderer } from "./edit"
import { BashToolRenderer } from "./bash"
import { WriteToolRenderer } from "./write"
import { GrepToolRenderer } from "./grep"
import { GlobToolRenderer } from "./glob"
import { WebfetchToolRenderer } from "./webfetch"
import { SubagentToolRenderer } from "./subagent"
import { ReviewToolRenderer } from "./review"
import { CounselToolRenderer } from "./counsel"
import { ResearchToolRenderer } from "./research"
import { SearchSessionsToolRenderer } from "./search-sessions"
import { ReadSessionToolRenderer } from "./read-session"
import { SkillsToolRenderer } from "./skills"

/** Builtin tool renderers consumed by the `@gent/tools` client extension. */
export const BUILTIN_TOOL_RENDERERS: ReadonlyArray<BuiltinToolRendererEntry> = [
  { toolNames: ["read"], component: ReadToolRenderer },
  { toolNames: ["edit"], component: EditToolRenderer },
  { toolNames: ["bash"], component: BashToolRenderer },
  { toolNames: ["write"], component: WriteToolRenderer },
  { toolNames: ["grep"], component: GrepToolRenderer },
  { toolNames: ["glob"], component: GlobToolRenderer },
  { toolNames: ["webfetch"], component: WebfetchToolRenderer },
  { toolNames: ["delegate"], component: SubagentToolRenderer },
  { toolNames: ["review"], component: ReviewToolRenderer },
  { toolNames: ["counsel"], component: CounselToolRenderer },
  { toolNames: ["research"], component: ResearchToolRenderer },
  { toolNames: ["search_sessions"], component: SearchSessionsToolRenderer },
  { toolNames: ["read_session"], component: ReadSessionToolRenderer },
  { toolNames: ["skills"], component: SkillsToolRenderer },
]

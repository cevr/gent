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
import {
  BUILTIN_HEADLESS_TOOL_RENDERERS,
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
  { toolNames: ["read"], component: ReadToolRenderer, headless: headlessFor("read") },
  { toolNames: ["edit"], component: EditToolRenderer, headless: headlessFor("edit") },
  { toolNames: ["bash"], component: BashToolRenderer, headless: headlessFor("bash") },
  { toolNames: ["write"], component: WriteToolRenderer, headless: headlessFor("write") },
  { toolNames: ["grep"], component: GrepToolRenderer, headless: headlessFor("grep") },
  { toolNames: ["glob"], component: GlobToolRenderer, headless: headlessFor("glob") },
  { toolNames: ["webfetch"], component: WebfetchToolRenderer, headless: headlessFor("webfetch") },
  { toolNames: ["delegate"], component: SubagentToolRenderer, headless: headlessFor("delegate") },
  { toolNames: ["review"], component: ReviewToolRenderer, headless: headlessFor("review") },
  { toolNames: ["counsel"], component: CounselToolRenderer, headless: headlessFor("counsel") },
  { toolNames: ["research"], component: ResearchToolRenderer, headless: headlessFor("research") },
  {
    toolNames: ["search_sessions"],
    component: SearchSessionsToolRenderer,
    headless: headlessFor("search_sessions"),
  },
  {
    toolNames: ["read_session"],
    component: ReadSessionToolRenderer,
    headless: headlessFor("read_session"),
  },
  { toolNames: ["skills"], component: SkillsToolRenderer, headless: headlessFor("skills") },
]

function headlessFor(toolName: string): HeadlessToolRenderer | undefined {
  for (const entry of BUILTIN_HEADLESS_TOOL_RENDERERS) {
    if (entry.toolNames.includes(toolName)) return entry.render
  }
  return undefined
}

export type { ToolCall, ToolRendererProps, ToolRenderer } from "./types"
export { ReadToolRenderer } from "./read"
export { EditToolRenderer } from "./edit"
export { BashToolRenderer } from "./bash"
export { WriteToolRenderer } from "./write"
export { GrepToolRenderer } from "./grep"
export { GlobToolRenderer } from "./glob"
export { WebfetchToolRenderer } from "./webfetch"
export { SubagentToolRenderer } from "./subagent"
export { GenericToolRenderer } from "./generic"
export { CodeReviewToolRenderer } from "./code-review"
export { SearchSessionsToolRenderer } from "./search-sessions"
export { ReadSessionToolRenderer } from "./read-session"
import type { ExtensionClientSetup } from "@gent/core/domain/extension-client.js"
import type { ToolRenderer } from "./types"
import { ReadToolRenderer } from "./read"
import { EditToolRenderer } from "./edit"
import { BashToolRenderer } from "./bash"
import { WriteToolRenderer } from "./write"
import { GrepToolRenderer } from "./grep"
import { GlobToolRenderer } from "./glob"
import { WebfetchToolRenderer } from "./webfetch"
import { SubagentToolRenderer } from "./subagent"
import { CodeReviewToolRenderer } from "./code-review"
import { SearchSessionsToolRenderer } from "./search-sessions"
import { ReadSessionToolRenderer } from "./read-session"

/** Builtin tool renderers in ExtensionClientSetup shape for the extension resolution pipeline */
export const BUILTIN_TOOL_RENDERERS: ExtensionClientSetup<ToolRenderer>["tools"] = [
  { toolNames: ["read"], component: ReadToolRenderer },
  { toolNames: ["edit"], component: EditToolRenderer },
  { toolNames: ["bash"], component: BashToolRenderer },
  { toolNames: ["write"], component: WriteToolRenderer },
  { toolNames: ["grep"], component: GrepToolRenderer },
  { toolNames: ["glob"], component: GlobToolRenderer },
  { toolNames: ["webfetch"], component: WebfetchToolRenderer },
  { toolNames: ["delegate"], component: SubagentToolRenderer },
  { toolNames: ["code_review"], component: CodeReviewToolRenderer },
  { toolNames: ["search_sessions"], component: SearchSessionsToolRenderer },
  { toolNames: ["read_session"], component: ReadSessionToolRenderer },
]

/** @deprecated Use BUILTIN_TOOL_RENDERERS + extension resolution pipeline instead */
export const TOOL_RENDERERS: Record<string, ToolRenderer> = Object.fromEntries(
  (BUILTIN_TOOL_RENDERERS ?? []).flatMap((entry) =>
    entry.toolNames.map((name) => [name, entry.component]),
  ),
)

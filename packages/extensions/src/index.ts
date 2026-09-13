import { Effect, Option, Schema } from "effect"
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import {
  defineResource,
  type GentExtension,
  defineExtension,
  ExtensionContext,
  ExtensionHost,
  ExtensionId,
  tool,
} from "@gent/core/extensions/api"
import { BuiltinArtifactIdentity } from "./artifact-identity.js"
import { CellExtension } from "./cell/cell-extension.js"
import { CompactionExtension, ModelContextCompactorResource } from "./compaction/index.js"
import { InstructionsExtension } from "./instructions/index.js"
import { CellBranchTools } from "./cell/cell-storage.js"
import { ExecToolsExtension } from "./exec-tools/index.js"
import { DelegateExtension } from "./delegate/delegate-tool.js"
import { AgentsExtension } from "./agents.js"
import { AgentsViewExtension } from "./agents-view/index.js"
import { AnthropicExtension } from "./anthropic/index.js"
import { OpenAIExtension } from "./openai/index.js"
import { GoogleExtension, MistralExtension } from "./openai-compatible-driver.js"
import { SkillsExtension } from "./skills/index.js"
import { AcpAgentsExtension } from "./acp-agents/index.js"
import { WorkflowsExtension } from "./workflows.js"
import { HandoffExtension } from "./handoff.js"
import { GoalExtension } from "./goal/index.js"
import { BtwExtension } from "./btw/index.js"
import { ReadTool } from "./fs-tools/read.js"
import { WriteTool } from "./fs-tools/write.js"
import { EditTool } from "./fs-tools/edit.js"
import { GrepTool } from "./fs-tools/grep.js"
import { FileIndex, FileIndexLive } from "./fs-tools/file-index.js"
import { WebFetchTool } from "./network-tools/webfetch.js"
import { WebSearchTool } from "./network-tools/websearch.js"
import { SearchSessionsTool } from "./session-tools/search-sessions.js"
import { ReadSessionTool } from "./session-tools/read-session.js"
import { AskUserTool } from "./interaction-tools/ask-user.js"
import { PromptTool } from "./interaction-tools/prompt.js"

const NAMING_INSTRUCTION = `
## Session naming
Call rename_session with a specific 3-5 word lowercase title once you understand what the user needs. If the conversation topic shifts significantly, rename again.`

const RenameSessionParams = Schema.Struct({
  name: Schema.String.annotate({
    description: "Short session title, 3-5 lowercase words describing the current task",
  }),
})

const RenameSessionResult = Schema.Struct({
  renamed: Schema.Boolean,
  name: Schema.optional(Schema.String),
})

const RenameSessionTool = tool({
  id: "rename_session",
  description:
    "Rename the current session. Call once you understand the task, and again if the topic shifts significantly.",
  params: RenameSessionParams,
  output: RenameSessionResult,
  execute: Effect.fn("RenameSessionTool.execute")(function* (
    params: typeof RenameSessionParams.Type,
  ) {
    const ctx = yield* ExtensionContext
    return yield* ctx.Session.renameCurrent(params.name)
  }),
})

export const FsToolsExtension = defineExtension({
  id: "@gent/fs-tools",
  setup: Effect.gen(function* () {
    const host = yield* ExtensionHost
    yield* host.register("tool", ReadTool, WriteTool, EditTool, GrepTool)
    yield* host.register(
      "resource",
      defineResource({
        id: "@gent/fs-tools/file-index",
        tag: FileIndex,
        scope: "process",
        layer: FileIndexLive({ home: host.home }),
      }),
    )
  }),
})

export const NetworkToolsExtension = defineExtension({
  id: "@gent/network-tools",
  setup: Effect.gen(function* () {
    const host = yield* ExtensionHost
    yield* host.register("tool", WebFetchTool, WebSearchTool)
  }),
})

export const SessionToolsExtension = defineExtension({
  id: "@gent/session-tools",
  setup: Effect.gen(function* () {
    const host = yield* ExtensionHost
    yield* host.register("tool", SearchSessionsTool, ReadSessionTool, RenameSessionTool)
    yield* host.on("systemPrompt", (input) => {
      if (input.interactive === false) {
        return Effect.succeed(input.basePrompt)
      }
      return Effect.succeed(input.basePrompt + NAMING_INSTRUCTION)
    })
  }),
})

export const INTERACTION_TOOLS_EXTENSION_ID = ExtensionId.make("@gent/interaction-tools")

export const InteractionToolsExtension = defineExtension({
  id: INTERACTION_TOOLS_EXTENSION_ID,
  setup: Effect.gen(function* () {
    const host = yield* ExtensionHost
    yield* host.register("tool", AskUserTool, PromptTool)
  }),
})

export {
  CompactionExtension,
  ModelContextCompactorResource,
  InstructionsExtension,
  ExecToolsExtension,
  DelegateExtension,
  AgentsExtension,
  SkillsExtension,
  AcpAgentsExtension,
  WorkflowsExtension,
  HandoffExtension,
  GoalExtension,
  BtwExtension,
  AgentsViewExtension,
}

/**
 * The cell: the surface the model runs code on, and the branch-tool feature
 * that surface needs installed. A root naming one names the other -- a `cell`
 * tool whose storage and kernel are missing fails on first use.
 */
export { CellExtension, CellBranchTools }
export { saveFullOutput } from "./exec-tools/save-output.js"

export const BuiltinExtensions: ReadonlyArray<GentExtension<ChildProcessSpawner | ExtensionHost>> =
  [
    CellExtension,
    CompactionExtension,
    InstructionsExtension,
    HandoffExtension,
    GoalExtension,
    BtwExtension,
    FsToolsExtension,
    ExecToolsExtension,
    NetworkToolsExtension,
    DelegateExtension,
    InteractionToolsExtension,
    SessionToolsExtension,
    AgentsExtension,
    AgentsViewExtension,
    WorkflowsExtension,
    SkillsExtension,
    AcpAgentsExtension,
    AnthropicExtension,
    OpenAIExtension,
    GoogleExtension,
    MistralExtension,
  ].map((extension) => {
    if (Option.isNone(BuiltinArtifactIdentity)) return extension
    return {
      ...extension,
      artifactIdentity: BuiltinArtifactIdentity.value,
    }
  })

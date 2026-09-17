import { Effect, Option } from "effect"
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import {
  defineResource,
  type GentExtension,
  defineExtension,
  ExtensionHost,
} from "@gent/core/extensions/api"
import { BuiltinArtifactIdentity } from "./artifact-identity.js"
import { CellExtension } from "./cell/cell-extension.js"
import { CompactionExtension, ModelContextCompactorResource } from "./compaction/index.js"
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
import { WakeExtension } from "./wake/index.js"
import { BtwExtension } from "./btw/index.js"
import { ReadTool } from "./fs-tools/read.js"
import { WriteTool } from "./fs-tools/write.js"
import { EditTool } from "./fs-tools/edit.js"
import { GrepTool } from "./fs-tools/grep.js"
import { FileIndex, FileIndexLive } from "./fs-tools/file-index.js"
import { NetworkToolsExtension } from "./network-tools.js"
import { SessionToolsExtension } from "./session-tools.js"
import { InteractionToolsExtension } from "./interaction-tools.js"

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

export {
  CompactionExtension,
  ModelContextCompactorResource,
  ExecToolsExtension,
  DelegateExtension,
  AgentsExtension,
  SkillsExtension,
  AcpAgentsExtension,
  WorkflowsExtension,
  HandoffExtension,
  GoalExtension,
  WakeExtension,
  BtwExtension,
  AgentsViewExtension,
  SessionToolsExtension,
}

/**
 * The cell: the surface the model runs code on, and the branch-tool feature
 * that surface needs installed. A root naming one names the other -- a `cell`
 * tool whose storage and kernel are missing fails on first use.
 */
export { CellExtension, CellBranchTools }

export const BuiltinExtensions: ReadonlyArray<GentExtension<ChildProcessSpawner | ExtensionHost>> =
  [
    CellExtension,
    CompactionExtension,
    HandoffExtension,
    GoalExtension,
    WakeExtension,
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

import { Effect, Option, Schema } from "effect"
import {
  defineExtension,
  defineResource,
  ExtensionHost,
  type GentExtension,
  LoadedArtifactIdentity,
} from "@gent/core/extensions/api"
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { CellExtension } from "./cell/cell-extension.js"
import { CompactionExtension, ModelContextCompactorResource } from "./compaction.js"
import { CellBranchTools } from "./cell/cell-storage.js"
import { ExecToolsExtension } from "./exec-tools/index.js"
import { DelegateExtension } from "./delegate.js"
import { AgentsExtension } from "./agents.js"
import { AgentsViewExtension } from "./agents-view.js"
import { AnthropicExtension } from "./anthropic/index.js"
import { OpenAIExtension } from "./openai/index.js"
import { GoogleExtension, MistralExtension } from "./openai-compatible-driver.js"
import { SkillsExtension } from "./skills/index.js"
import { AcpAgentsExtension } from "./acp-agents/index.js"
import { WorkflowsExtension } from "./workflows.js"
import { HandoffExtension } from "./handoff.js"
import { GoalExtension } from "./goal.js"
import { WakeExtension } from "./wake.js"
import { BtwExtension } from "./btw.js"
import { ReadTool } from "./fs-tools/read.js"
import { WriteTool } from "./fs-tools/write.js"
import { EditTool } from "./fs-tools/edit.js"
import { GrepTool } from "./fs-tools/grep.js"
import { FileIndex, FileIndexLive } from "./fs-tools/file-index.js"
import { NetworkToolsExtension } from "./network-tools.js"
import { SessionToolsExtension } from "./session-tools.js"
import { InteractionToolsExtension } from "./interaction-tools.js"

// ── artifact-identity ───────────────────────────────────────────────────────

/**
 * The compiled build replaces this symbol with a build-owned token before it
 * bundles the builtin extensions. Source-mode execution has no trusted build
 * boundary, so it remains unsupported for durable artifact replay.
 */
declare const __GENT_BUILTIN_ARTIFACT_ID__: unknown

const buildArtifactId = Option.flatMap(
  Effect.runSync(
    Effect.try({
      try: () => Option.some(__GENT_BUILTIN_ARTIFACT_ID__),
      catch: () => Option.none<unknown>(),
    }).pipe(Effect.catchEager(() => Effect.succeed(Option.none<unknown>()))),
  ),
  Schema.decodeUnknownOption(Schema.NonEmptyString),
)

const BuiltinArtifactIdentity: Option.Option<LoadedArtifactIdentity> = Option.map(
  buildArtifactId,
  (value) => LoadedArtifactIdentity.make(value),
)

// ── builtin composition ─────────────────────────────────────────────────────

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

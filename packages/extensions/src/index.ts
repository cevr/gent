import { type FileSystem, Option, type Path, Result, Schema } from "effect"
import {
  type ExtensionHost,
  type GentExtension,
  LoadedArtifactIdentity,
} from "@gent/core/extensions/api"
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { CellBranchTools, CellExtension } from "./cell.js"
import { CompactionExtension } from "./compaction.js"
import { ExecToolsExtension } from "./exec-tools.js"
import { DelegateExtension } from "./delegate.js"
import { AgentsExtension } from "./agents.js"
import { AgentsViewExtension } from "./agents-view.js"
import { AnthropicExtension } from "./anthropic.js"
import { OpenAIExtension } from "./openai.js"
import { GoogleExtension, MistralExtension } from "./providers.js"
import { SkillsExtension } from "./skills.js"
import { WorkflowsExtension } from "./workflows.js"
import { GoalExtension } from "./goal.js"
import { WakeExtension } from "./wake.js"
import { BtwExtension } from "./btw.js"
import { FsToolsExtension } from "./fs-tools.js"
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

// Source mode has no definition: reading the symbol throws a ReferenceError.
const buildArtifactId = Result.try(() => __GENT_BUILTIN_ARTIFACT_ID__).pipe(
  Result.getSuccess,
  Option.flatMap(Schema.decodeUnknownOption(Schema.NonEmptyString)),
)

const BuiltinArtifactIdentity: Option.Option<LoadedArtifactIdentity> = Option.map(
  buildArtifactId,
  (value) => LoadedArtifactIdentity.make(value),
)

// ── builtin composition ─────────────────────────────────────────────────────

/**
 * The branch-tool feature the cell in `BuiltinExtensions` needs. A root that
 * installs the builtins passes this too -- a `cell` tool whose storage and
 * kernel are missing fails on first use.
 */
export { CellBranchTools }

export const BuiltinExtensions: ReadonlyArray<
  GentExtension<ChildProcessSpawner | ExtensionHost | FileSystem.FileSystem | Path.Path>
> = [
  CellExtension,
  CompactionExtension,
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

import { type Crypto, type FileSystem, Option, type Path, Result, Schema } from "effect"
import {
  type ExtensionHost,
  type GentExtension,
  LoadedArtifactIdentity,
} from "@gent/core/extensions/api"
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import * as EffectAiAnthropic from "@effect/ai-anthropic"
import * as EffectAiOpenAi from "@effect/ai-openai"
import * as EffectPlatformBun from "@effect/platform-bun"
import * as EffectRoot from "effect"
import * as EffectAi from "effect/unstable/ai"
import * as EffectAiError from "effect/unstable/ai/AiError"
import * as EffectPrompt from "effect/unstable/ai/Prompt"
import * as EffectResponse from "effect/unstable/ai/Response"
import * as EffectTool from "effect/unstable/ai/Tool"
import * as EffectHttp from "effect/unstable/http"
import * as EffectHttpClientError from "effect/unstable/http/HttpClientError"
import * as EffectProcess from "effect/unstable/process"
import * as EffectChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner"
import * as EffectSql from "effect/unstable/sql"
import { CellBranchTools, CellExtension } from "./cell.js"
import { CompactionExtension } from "./compaction.js"
import { ExecToolsExtension } from "./exec-tools.js"
import { DelegateExtension } from "./delegate.js"
import { AgentsExtension } from "./agents.js"
import { AgentsViewExtension } from "./agents-view.js"
import { AnthropicExtension } from "./anthropic.js"
import { OpenAIExtension } from "./openai.js"
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
  GentExtension<
    ChildProcessSpawner | Crypto.Crypto | ExtensionHost | FileSystem.FileSystem | Path.Path
  >
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
].map((extension) => {
  if (Option.isNone(BuiltinArtifactIdentity)) return extension
  return {
    ...extension,
    artifactIdentity: BuiltinArtifactIdentity.value,
  }
})

// ── builtin peer modules ────────────────────────────────────────────────────

/**
 * Every `effect`, `effect/*` and `@effect/*` specifier a shipped extension
 * imports, bound to the module this build bundles. A host binds them before it
 * loads user extensions, so a user extension can import what a shipped one
 * does, and gets the same instances. The keys are exactly the specifiers the
 * shipped extensions import; `tests/index.test.ts` derives that set from their
 * sources and fails when the two differ.
 */
export const BuiltinExtensionModules: ReadonlyMap<string, () => object> = new Map<
  string,
  () => object
>([
  ["@effect/ai-anthropic", () => EffectAiAnthropic],
  ["@effect/ai-openai", () => EffectAiOpenAi],
  ["@effect/platform-bun", () => EffectPlatformBun],
  ["effect", () => EffectRoot],
  ["effect/unstable/ai", () => EffectAi],
  ["effect/unstable/ai/AiError", () => EffectAiError],
  ["effect/unstable/ai/Prompt", () => EffectPrompt],
  ["effect/unstable/ai/Response", () => EffectResponse],
  ["effect/unstable/ai/Tool", () => EffectTool],
  ["effect/unstable/http", () => EffectHttp],
  ["effect/unstable/http/HttpClientError", () => EffectHttpClientError],
  ["effect/unstable/process", () => EffectProcess],
  ["effect/unstable/process/ChildProcessSpawner", () => EffectChildProcessSpawner],
  ["effect/unstable/sql", () => EffectSql],
])

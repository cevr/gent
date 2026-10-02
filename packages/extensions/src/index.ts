import { type Crypto, type FileSystem, Option, type Path, Result, Schema } from "effect"
import {
  type ExtensionHost,
  type GentExtension,
  LoadedArtifactIdentity,
} from "@gent/core/extensions/api"
import type { ChildProcessSpawner } from "effect/process/ChildProcessSpawner"
import * as EffectPlatformBun from "@effect/platform-bun"
import * as EffectRoot from "effect"
import * as EffectAi from "effect/ai"
import * as EffectAiError from "effect/ai/AiError"
import * as EffectEncoding from "effect/encoding"
import * as EffectPrompt from "effect/ai/Prompt"
import * as EffectResponse from "effect/ai/Response"
import * as EffectTool from "effect/ai/Tool"
import * as EffectHttp from "effect/http"
import * as EffectHttpClientError from "effect/http/HttpClientError"
import * as EffectProcess from "effect/process"
import * as EffectChildProcessSpawner from "effect/process/ChildProcessSpawner"
import * as EffectSql from "effect/sql"
import { CellBranchTools, CellExtension } from "./cell.js"
import { CompactionExtension } from "./compaction.js"
import { ExecToolsExtension } from "./exec-tools.js"
import { DelegateExtension } from "./delegate.js"
import { AgentsExtension } from "./agents.js"
import { AgentsViewExtension } from "./agents-view.js"
import { AnthropicExtension } from "./anthropic.js"
import { OpenAIExtension } from "./openai.js"
import { OpenCodeExtension } from "./opencode.js"
import { CloudflareExtension } from "./cloudflare.js"
import { TypeSafeExtension } from "./typesafe.js"
import { SkillsExtension } from "./skills.js"
import { WorkflowsExtension } from "./workflows.js"
import { GoalExtension } from "./goal.js"
import { WakeExtension } from "./wake.js"
import { BtwExtension } from "./btw.js"
import { FsToolsExtension } from "./fs-tools.js"
import { NetworkToolsExtension } from "./network-tools.js"
import { McpExtension } from "./mcp.js"
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
  McpExtension,
  DelegateExtension,
  InteractionToolsExtension,
  SessionToolsExtension,
  AgentsExtension,
  AgentsViewExtension,
  WorkflowsExtension,
  SkillsExtension,
  AnthropicExtension,
  OpenAIExtension,
  TypeSafeExtension,
  OpenCodeExtension,
  CloudflareExtension,
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
 *
 * The provider SDKs load when a module first imports them, as the shipped
 * drivers load them: their generated schemas cost a launch time to evaluate.
 * Each loads through its `#unbound/*` alias (`package.json` `imports`): after
 * the bind, its own name resolves to this binding, and the binding would
 * import itself.
 */
export const BuiltinExtensionModules: ReadonlyMap<string, () => object | Promise<object>> = new Map<
  string,
  () => object | Promise<object>
>([
  // oxlint-disable-next-line effect/noDynamicImports -- the SDK loads when a module first imports it, not at launch
  ["@effect/ai-anthropic", () => import("#unbound/ai-anthropic")],
  // oxlint-disable-next-line effect/noDynamicImports -- the SDK loads when a module first imports it, not at launch
  ["@effect/ai-openai", () => import("#unbound/ai-openai")],
  // oxlint-disable-next-line effect/noDynamicImports -- the SDK loads when a module first imports it, not at launch
  ["@effect/ai-openai-compat", () => import("#unbound/ai-openai-compat")],
  // oxlint-disable-next-line effect/noDynamicImports -- the SDK loads when a module first imports it, not at launch
  ["@effect/ai-typesafe", () => import("#unbound/ai-typesafe")],
  // oxlint-disable-next-line effect/noPlatformLayerOutsideEntry -- a user extension resolves @effect/platform-bun here to share the instances a shipped extension imports; it provides no layer
  ["@effect/platform-bun", () => EffectPlatformBun],
  ["effect", () => EffectRoot],
  ["effect/ai", () => EffectAi],
  ["effect/ai/AiError", () => EffectAiError],
  ["effect/ai/Prompt", () => EffectPrompt],
  ["effect/ai/Response", () => EffectResponse],
  ["effect/ai/Tool", () => EffectTool],
  ["effect/encoding", () => EffectEncoding],
  ["effect/http", () => EffectHttp],
  ["effect/http/HttpClientError", () => EffectHttpClientError],
  ["effect/process", () => EffectProcess],
  ["effect/process/ChildProcessSpawner", () => EffectChildProcessSpawner],
  ["effect/sql", () => EffectSql],
])

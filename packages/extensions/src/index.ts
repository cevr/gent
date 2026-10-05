import { type Crypto, type FileSystem, Option, type Path, Result, Schema } from "effect"
import {
  type ExtensionHost,
  type GentExtension,
  LoadedArtifactIdentity,
} from "@gent/core/extensions/api"
import type { GentPlatform } from "@gent/core/extensions/branch-tools"
import type { ChildProcessSpawner } from "effect/process/ChildProcessSpawner"
import { CellExtension } from "./cell.js"
import { CompactionExtension } from "./compaction.js"
import { ExecToolsExtension } from "./exec-tools.js"
import { DelegateExtension } from "./delegate.js"
import { WorkspacesExtension } from "./workspaces.js"
import { CheckpointsExtension } from "./checkpoints.js"
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
import { RouterExtension } from "./router.js"
import { GuardExtension } from "./guard.js"
import { SessionToolsExtension } from "./session-tools.js"
import { ExtensionAdminExtension } from "./extension-admin.js"
import { InteractionToolsExtension } from "./interaction-tools.js"

// ── artifact-identity ───────────────────────────────────────────────────────

/**
 * The compiled build defines this symbol as `{ id, version }` before it
 * bundles the builtin extensions; the build's id names their artifact. The
 * same define names the build to discovery (`GentPlatform.build`).
 * Source-mode execution has no trusted build boundary, so it remains
 * unsupported for durable artifact replay.
 */
declare const __GENT_BUILD__: unknown

// Source mode has no definition: reading the symbol throws a ReferenceError.
const BuiltinArtifactIdentity: Option.Option<LoadedArtifactIdentity> = Result.try(
  () => __GENT_BUILD__,
).pipe(
  Result.getSuccess,
  Option.flatMap(Schema.decodeUnknownOption(Schema.Struct({ id: Schema.NonEmptyString }))),
  Option.map(({ id }) => LoadedArtifactIdentity.make(`build:${id}`)),
)

// ── builtin composition ─────────────────────────────────────────────────────

export const BuiltinExtensions: ReadonlyArray<
  GentExtension<
    | ChildProcessSpawner
    | Crypto.Crypto
    | ExtensionHost
    | FileSystem.FileSystem
    | GentPlatform
    | Path.Path
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
  RouterExtension,
  GuardExtension,
  WorkspacesExtension,
  CheckpointsExtension,
  DelegateExtension,
  InteractionToolsExtension,
  SessionToolsExtension,
  ExtensionAdminExtension,
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
 * Every `@effect/*` specifier a shipped extension imports, bound to the module
 * this build bundles. A host binds them before it loads user extensions, so a
 * user extension can import what a shipped one does, and gets the same
 * instances. `effect` and its `effect/*` modules are core's own dependency:
 * the core loader binds them (`extensionEntryModules`). The keys are exactly
 * the `@effect/*` specifiers the shipped extensions import;
 * `tests/index.test.ts` derives that set from their sources and fails when
 * the two differ. No shipped extension imports `@effect/platform-bun`: they
 * reach the host through `GentPlatform`. The Bun host binds it for a user
 * extension (`BunHostModules`, `@gent/core/host-bun`).
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
])

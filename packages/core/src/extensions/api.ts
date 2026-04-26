/**
 * Extension authoring API.
 *
 * Single entry point: `defineExtension({ id, resources?, capabilities?, ... })`.
 * The factory accepts typed sub-arrays (literal arrays OR `(ctx) => array` OR
 * `(ctx) => Effect<array>` per bucket), validates them, and produces a
 * `GentExtension` whose `setup()` returns `ExtensionContributions` buckets.
 *
 * After C8 there is no flat `Contribution[]`, no `_kind` discriminator, no
 * `filterByKind`. The bucket name IS the discrimination — TypeScript catches
 * a Projection placed in `capabilities` at the call site; runtime
 * `validatePackageShape` adds field-local error messages for runtime-loaded
 * (JS) extensions.
 *
 * Effect-native end-to-end: every contribution returns Effect. There are no
 * Promise edges in the contribution surface — gent is a library used inside
 * Effect programs.
 *
 * @example
 * ```ts
 * import { defineExtension, defineResource, tool } from "@gent/core/extensions/api"
 *
 * export default defineExtension({
 *   id: "my-ext",
 *   resources: [defineResource({ scope: "process", layer: MyService.Live })],
 *   capabilities: [tool(MyTool)],
 * })
 * ```
 *
 * @example with ctx + Effect
 * ```ts
 * export default defineExtension({
 *   id: "my-ext",
 *   capabilities: ({ ctx }) =>
 *     Effect.gen(function* () {
 *       const skills = yield* loadSkills(ctx.cwd)
 *       return [tool(SearchSkillsTool(skills))]
 *     }),
 * })
 * ```
 *
 * @module
 */
import { Effect } from "effect"
import { ExtensionLoadError } from "../domain/extension.js"
import { sealRuntimeLoadedEffect } from "../domain/extension-load-boundary.js"
import type {
  GentExtension,
  ExtensionSetupContext,
  ExtensionManifest,
} from "../domain/extension.js"
import type { ExtensionContributions } from "../domain/contribution.js"
import type { AgentDefinition } from "../domain/agent.js"
import type { AnyCapabilityContribution, CapabilityToken } from "../domain/capability.js"
import type { ExternalDriverContribution, ModelDriverContribution } from "../domain/driver.js"
import type { AnyProjectionContribution } from "../domain/projection.js"
import type { AnyResourceContribution } from "../domain/resource.js"
import type { AgentEvent, AgentEventTag } from "../domain/event.js"

// ── Re-exports for full-power extension authors ──

// `ToolContext` survives as the internal lowered execution context consumed by
// the provider bridge and the tool-runner registry. Authors construct tools
// via `tool({...})` from `domain/capability/tool.ts` (re-exported below).
export { makeToolContext, type ToolContext } from "../domain/tool.js"
export {
  defineAgent,
  AgentDefinition,
  AgentName,
  DEFAULT_AGENT_NAME,
  DriverRef,
  ModelDriverRef,
  ExternalDriverRef,
  AgentSpec,
  makeRunSpec,
  RunSpecSchema,
  AgentRunOverridesSchema,
  type AgentRunOverrides,
  resolveRunPersistence,
  getDurableAgentRunSessionId,
  AgentRunError,
  type AgentRunResult,
  type RunSpec,
} from "../domain/agent.js"
export {
  type GentExtension,
  type ExtensionActorDefinition,
  type AnyExtensionActorDefinition,
  type ExtensionEffect,
  type TurnProjection,
  type ReduceResult,
  type ExtensionReduceContext,
  type ExtensionTurnContext,
  type SystemPromptInput,
  type ToolExecuteInput,
  type PermissionCheckInput,
  type ContextMessagesInput,
  type TurnBeforeInput,
  type TurnAfterInput,
  type ToolResultInput,
  type MessageInputInput,
  type MessageOutputInput,
} from "../domain/extension.js"
export {
  ExtensionMessage,
  ExtensionMessageEnvelope,
  getExtensionMessageMetadata,
  getExtensionReplySchema,
  isExtensionRequestDefinition,
  isExtensionRequestMessage,
  listExtensionProtocolDefinitions,
  type ExtensionProtocol,
  type ExtensionCommandDefinition,
  type ExtensionCommandMessage,
  type ExtensionRequestDefinition,
  type ExtensionRequestMessage,
  type AnyExtensionCommandMessage,
  type AnyExtensionRequestMessage,
  type ExtractExtensionReply,
} from "../domain/extension-protocol.js"
export type { PromptSection } from "../domain/prompt.js"
export {
  sectionStartMarker,
  sectionEndMarker,
  sectionPatternFor,
  withSectionMarkers,
} from "../domain/prompt.js"
export type { TurnExecutor, TurnContext, TurnEvent } from "../domain/driver.js"
export {
  ProviderAuthError,
  TurnError,
  TextDelta,
  ReasoningDelta,
  ToolStarted,
  ToolCompleted,
  ToolFailed,
  Finished as TurnFinished,
  TurnEventUsage,
} from "../domain/driver.js"
export type {
  AnyDriverContribution,
  ExternalDriverContribution,
  ModelDriverContribution,
  ProviderAuthContribution,
  ProviderAuthInfo,
  ProviderAuthorizationResult,
  ProviderAuthorizeContext,
  ProviderCallbackContext,
  ProviderHints,
  ProviderResolution,
  PersistAuth,
} from "../domain/driver.js"
export { DriverError } from "../domain/driver.js"
export {
  AgentEvent,
  type AgentEventTag,
  type Question,
  QuestionSchema,
  QuestionOptionSchema,
  TaskCreated,
  TaskUpdated,
  TaskCompleted,
  TaskFailed,
  TaskStopped,
  TaskDeleted,
} from "../domain/event.js"
export { SessionId, BranchId, TaskId, ArtifactId, MessageId, ToolCallId } from "../domain/ids.js"
export { Model, ModelId } from "../domain/model.js"
export { Task, TaskStatus, TaskTransitionError, isValidTaskTransition } from "../domain/task.js"
export { AuthMethod } from "../domain/auth-method.js"
export { AuthOauth } from "../domain/auth-store.js"
export {
  type Message,
  type MessagePart,
  type MessageMetadata,
  type Branch,
} from "../domain/message.js"
export { PermissionRule, type PermissionResult } from "../domain/permission.js"
export { OutputBuffer, saveFullOutput, headTailChars } from "../domain/output-buffer.js"
export {
  ExtensionHostError,
  ExtensionHostSearchResult,
  type ExtensionHostContext,
} from "../domain/extension-host-context.js"
export { isRecord, isRecordArray } from "../domain/guards.js"
export { FileIndex } from "../domain/file-index.js"
export { FileLockService } from "../domain/file-lock.js"
export {
  type ExtensionContributions,
  // Smart constructor — returns a bare leaf value; the bucket it's placed
  // in is the discrimination (no `_kind` field).
  defineResource,
  resource,
} from "../domain/contribution.js"

// B11.5 typed capability factories — `audiences[] + intent` flag matrix
// is gone from the author surface. `CapabilityHost` dispatches by
// factory-origin metadata baked into the lowering. The B11.5 migration
// window closed in B11.5d; the legacy `defineTool` smart constructor
// and the dual-shape `tool()` overload were deleted there.
//
// See `domain/capability/{tool,request,action}.ts` for the typed shapes.
export { tool, type ToolCapabilityContext, type ToolInput } from "../domain/capability/tool.js"
export {
  request,
  type ReadRequestInput,
  type WriteRequestInput,
} from "../domain/capability/request.js"
export { action, type ActionInput, type ActionSurface } from "../domain/capability/action.js"
export type {
  CapabilityToken,
  CapabilityContribution,
  AnyCapabilityContribution,
  CapabilityContext,
  CapabilityCoreContext,
  ModelCapabilityContext,
  CapabilityRef,
  Audience,
  Intent,
  ModelAudienceFields,
} from "../domain/capability.js"
export {
  ref,
  CAPABILITY_REF,
  CapabilityError,
  CapabilityNotFoundError,
} from "../domain/capability.js"
export type {
  ResourceContribution,
  AnyResourceContribution,
  ResourceSpec,
  ResourceScope,
  ScopeOf,
  ResourceBusEnvelope,
  ResourceSubscription,
  ResourceSchedule,
  ResourceMachine,
  AnyResourceMachine,
  ResourceMachineInitContext,
} from "../domain/resource.js"
export type {
  ProjectionContribution,
  ProjectionContext,
  ProjectionTurnContext,
  AnyProjectionContribution,
} from "../domain/projection.js"
export { ProjectionError } from "../domain/projection.js"

// `ReadOnly` brand — type-level fence. Author services that should only
// be reachable from projections / read-intent capabilities by branding
// their Tag's inner shape with `ReadOnly<MyServiceShape>`. Use
// `withReadOnly(value)` to apply the brand at the Live layer construction
// site. See `domain/read-only.ts` for usage.
export {
  type ReadOnly,
  type ReadOnlyTag,
  ReadOnlyBrand,
  withReadOnly,
} from "../domain/read-only.js"
export { buildToolJsonSchema, flattenAllOf } from "../domain/tool-schema.js"

// ── Public API ──

// ExtensionSetupContext re-exported from domain — single source of truth
export type { ExtensionSetupContext } from "../domain/extension.js"

/**
 * Per-bucket spec accepted by `defineExtension`. Each bucket field can be:
 *   - a literal array (90% of cases — the extension contributes a constant set)
 *   - a `(args) => array` factory (when the bucket needs `ctx` but no Effect)
 *   - a `(args) => Effect<array>` factory (when setup needs Effect-typed work)
 *
 * Codex C8 review: prefer literal arrays as default; the variance behind one
 * helper (`resolveField`) keeps 26 of 30 builtin extensions ceremony-free
 * while preserving Effect for the 4 that genuinely need it.
 */
export type FieldSpec<A> =
  | ReadonlyArray<A>
  | ((args: {
      readonly ctx: ExtensionSetupContext
    }) => ReadonlyArray<A> | Effect.Effect<ReadonlyArray<A>, ExtensionLoadError>)

export interface DefineExtensionInput {
  readonly id: string
  readonly resources?: FieldSpec<AnyResourceContribution>
  readonly capabilities?: FieldSpec<CapabilityToken>
  readonly agents?: FieldSpec<AgentDefinition>
  readonly projections?: FieldSpec<AnyProjectionContribution>
  readonly modelDrivers?: FieldSpec<ModelDriverContribution>
  readonly externalDrivers?: FieldSpec<ExternalDriverContribution>
  readonly pulseTags?: ReadonlyArray<AgentEventTag>
}

/**
 * Resolve a single bucket field — accepts literal array, sync factory, or
 * Effect-returning factory. Errors are annotated with the bucket name so
 * the failure message points at the field, not "setup failed" (codex
 * C8 finding 2).
 */
const resolveField = <A>(
  manifest: ExtensionManifest,
  field: string,
  spec: FieldSpec<A> | undefined,
  ctx: ExtensionSetupContext,
): Effect.Effect<ReadonlyArray<A>, ExtensionLoadError> =>
  Effect.gen(function* () {
    if (spec === undefined) return []
    if (Array.isArray(spec)) return spec
    const result = yield* Effect.try({
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Effect membrane owns erased runtime context boundary
      try: () => (spec as (args: { ctx: ExtensionSetupContext }) => unknown)({ ctx }),
      catch: (cause) =>
        new ExtensionLoadError({
          extensionId: manifest.id,
          message: `${field} factory threw: ${String(cause)}`,
          cause,
        }),
    })
    // Effect-typed factory: yield it AND seal its failure channel into
    // ExtensionLoadError. Without this, an Effect-factory could escape its
    // declared error channel (e.g. `Effect.fail("bad")` on `unknown` would
    // be propagated raw — loader.ts only catches defects). Codex C8 BLOCK 1.
    if (Effect.isEffect(result)) {
      // @effect-diagnostics-next-line anyUnknownInErrorContext:off — runtime-loaded JS bucket factory crosses the explicit load membrane here; E/R are intentionally erased and re-sealed to ExtensionLoadError
      const value = yield* sealRuntimeLoadedEffect({
        extensionId: manifest.id,
        effect: () => result,
        failureMessage: (cause) => `${field} factory failed: ${String(cause)}`,
        defectMessage: (cause) => `${field} factory defect: ${String(cause)}`,
      })
      if (!Array.isArray(value)) {
        return yield* new ExtensionLoadError({
          extensionId: manifest.id,
          message: `${field} factory must resolve to an array, got ${typeof value}`,
        })
      }
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Effect membrane owns erased runtime context boundary
      return value as ReadonlyArray<A>
    }
    // Sync factory: validate shape — a JS extension returning a single item
    // (`capabilities: () => myCap`) would otherwise silently become "no items"
    // because `undefined > 0` is false in the bucket-include check.
    if (!Array.isArray(result)) {
      return yield* new ExtensionLoadError({
        extensionId: manifest.id,
        message: `${field} factory must return an array, got ${typeof result}`,
      })
    }
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Effect membrane owns erased runtime context boundary
    return result as ReadonlyArray<A>
  })

/**
 * Cross-bucket validation — runs after every bucket's spec resolves. Codex
 * C8 finding 4: field-local errors beat "_kind expected". The shape of the
 * messages is `Extension "@x" <field>[<i>] invalid: <reason>`.
 *
 * Invariants enforced here:
 *   - At most one Resource declares `machine` per extension. Without this,
 *     the runtime silently picks by array order and drops the rest.
 *   - Resource.machine must be process-scope until ephemeral composers wire
 *     Resource layers (codex BLOCK 3 on C3.5a).
 *   - Capability `audiences` must be non-empty.
 *   - `audiences:["model"]` capabilities must have a non-empty description
 *     (model-audience disclosure requirement; was activation.ts:282 check).
 *   - Intra-extension capability/agent/driver id/name collisions are
 *     surfaced (cross-extension collisions are scope-precedence's concern).
 */
const validateResources = (contribs: ExtensionContributions): string | undefined => {
  const machineResources = (contribs.resources ?? []).filter((r) => r.machine !== undefined)
  if (machineResources.length > 1) {
    return `resources: at most one Resource may declare \`machine\` (found ${machineResources.length}); the runtime would silently pick the first by array order and drop the rest`
  }
  const sessionScopedMachine = machineResources.find((r) => r.scope !== "process")
  if (sessionScopedMachine !== undefined) {
    return `resources: Resource.machine on scope "${sessionScopedMachine.scope}" is not yet supported (only "process" until per-cwd / ephemeral composers wire Resource layers). Move the machine to a process-scope Resource.`
  }
  return undefined
}

const validateCapabilities = (contribs: ExtensionContributions): string | undefined => {
  const capIds = new Map<string, number>()
  for (const [i, cap] of (contribs.capabilities ?? []).entries()) {
    if (cap.audiences === undefined || cap.audiences.length === 0) {
      return `capabilities[${i}] (${cap.id ?? "<no id>"}): \`audiences\` must be a non-empty array`
    }
    if (
      cap.audiences.includes("model") &&
      (cap.description === undefined || cap.description === "")
    ) {
      return `capabilities[${i}] (${cap.id}): model-audience capability requires a non-empty \`description\` (the model sees it as the tool description)`
    }
    if (capIds.has(cap.id)) {
      return `capabilities[${i}] (${cap.id}): duplicate id within extension (also at index ${capIds.get(cap.id)}); cross-extension collisions are resolved by scope precedence, but intra-extension collisions are an authoring bug`
    }
    capIds.set(cap.id, i)
  }
  return undefined
}

const validateAgents = (contribs: ExtensionContributions): string | undefined => {
  const agentNames = new Map<string, number>()
  for (const [i, a] of (contribs.agents ?? []).entries()) {
    if (agentNames.has(a.name)) {
      return `agents[${i}] (${a.name}): duplicate name within extension (also at index ${agentNames.get(a.name)})`
    }
    agentNames.set(a.name, i)
  }
  return undefined
}

const validateDriverIds = (contribs: ExtensionContributions): string | undefined => {
  const allDriverIds = new Map<string, string>()
  for (const [i, d] of (contribs.modelDrivers ?? []).entries()) {
    if (allDriverIds.has(d.id)) {
      return `modelDrivers[${i}] (${d.id}): driver id already used by ${allDriverIds.get(d.id)}`
    }
    allDriverIds.set(d.id, `modelDrivers[${i}]`)
  }
  for (const [i, d] of (contribs.externalDrivers ?? []).entries()) {
    if (allDriverIds.has(d.id)) {
      return `externalDrivers[${i}] (${d.id}): driver id already used by ${allDriverIds.get(d.id)}`
    }
    allDriverIds.set(d.id, `externalDrivers[${i}]`)
  }
  return undefined
}

/** Internal: cross-bucket validation invoked by `defineExtension` and
 *  `setupExtension` (the loader runs it defensively on raw `{ manifest, setup }`
 *  objects that bypassed `defineExtension`). */
export const validatePackageShape = (
  manifest: ExtensionManifest,
  contribs: ExtensionContributions,
): Effect.Effect<void, ExtensionLoadError> =>
  Effect.gen(function* () {
    const checks = [validateResources, validateCapabilities, validateAgents, validateDriverIds]
    for (const check of checks) {
      const message = check(contribs)
      if (message !== undefined) {
        return yield* new ExtensionLoadError({ extensionId: manifest.id, message })
      }
    }
  })

/**
 * Define an extension as typed contribution buckets.
 *
 * Each bucket is optional and homogeneously typed. Buckets accept a literal
 * array (most common), a `(ctx) => array` factory, or a `(ctx) => Effect<array>`
 * factory. Errors during resolution are annotated with the bucket name.
 *
 * Cross-bucket validation runs after all buckets resolve — see
 * `validatePackageShape` for the enforced invariants.
 *
 * @example
 * ```ts
 * import { defineExtension, defineResource, tool } from "@gent/core/extensions/api"
 *
 * export const MyExt = defineExtension({
 *   id: "my-ext",
 *   resources: [defineResource({ scope: "process", layer: MyService.Live })],
 *   capabilities: [tool(MyTool)],
 * })
 * ```
 */
export const defineExtension = (params: DefineExtensionInput): GentExtension => {
  const manifest: ExtensionManifest = { id: params.id }
  return {
    manifest,
    setup: (ctx) =>
      Effect.gen(function* () {
        const resources = yield* resolveField(manifest, "resources", params.resources, ctx)
        const capabilities = yield* resolveField(manifest, "capabilities", params.capabilities, ctx)
        const agents = yield* resolveField(manifest, "agents", params.agents, ctx)
        const projections = yield* resolveField(manifest, "projections", params.projections, ctx)
        const modelDrivers = yield* resolveField(manifest, "modelDrivers", params.modelDrivers, ctx)
        const externalDrivers = yield* resolveField(
          manifest,
          "externalDrivers",
          params.externalDrivers,
          ctx,
        )
        const contribs: ExtensionContributions = {
          ...(resources.length > 0 ? { resources } : {}),
          ...(capabilities.length > 0 ? { capabilities } : {}),
          ...(agents.length > 0 ? { agents } : {}),
          ...(projections.length > 0 ? { projections } : {}),
          ...(modelDrivers.length > 0 ? { modelDrivers } : {}),
          ...(externalDrivers.length > 0 ? { externalDrivers } : {}),
          ...(params.pulseTags !== undefined && params.pulseTags.length > 0
            ? { pulseTags: params.pulseTags }
            : {}),
        }
        yield* validatePackageShape(manifest, contribs)
        return contribs
      }),
  }
}

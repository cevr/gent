/**
 * Unified extension authoring API.
 *
 * One builder for both external authors (no Effect) and internal builtins (full power).
 *
 * @example
 * ```ts
 * import { extension } from "@gent/core/extensions/api"
 *
 * // Simple path — no Effect knowledge needed
 * export default extension("my-ext", async (ext, ctx) => {
 *   ext.tool({ name: "greet", description: "Say hello", execute: async (p) => `Hi ${p.name}!` })
 *   ext.on("prompt.system", async (input, next) => (await next(input)) + "\nBe nice.")
 *   ext.state({ initial: { n: 0 }, reduce: (s, e) => ({ state: s }) })
 * })
 *
 * // Full-power path — same builder, Effect-aware
 * export default extension("@gent/my-builtin", (ext) => {
 *   ext.tool(MyFullToolDefinition)
 *   ext.interceptor("prompt.system", (input, next) => next(input).pipe(Effect.map(...)))
 *   ext.actor(fromReducer({ id: "...", initial: ..., reduce: ... }))
 *   ext.layer(MyService.Live)
 *   ext.provider(myProvider)
 * })
 * ```
 *
 * @module
 */
import { Effect, Layer, Schema, Data } from "effect"
import {
  defineInterceptor,
  ExtensionLoadError,
  type GentExtension,
  type ExtensionSetup,
  type ExtensionInterceptorDescriptor,
  type ExtensionInterceptorKey,
  type ExtensionInterceptorMap,
  type SystemPromptInput,
  type ToolExecuteInput,
  type PermissionCheckInput,
  type ContextMessagesInput,
  type TurnAfterInput,
  type ToolResultInput,
  type ExtensionDeriveContext,
  type ExtensionProjection,
  type ExtensionProjectionConfig,
  type ExtensionReduceContext,
  type ReduceResult,
  type ExtensionEffect,
  type ProviderContribution,
  type InteractionHandlerContribution,
  type TagInjection,
  type SpawnExtensionRef,
} from "../domain/extension.js"
import {
  type ExtensionProtocol,
  listExtensionProtocolDefinitions,
} from "../domain/extension-protocol.js"
import {
  defineTool,
  ToolDefinitionBrand,
  type ToolAction,
  type ToolContext,
  type AnyToolDefinition,
} from "../domain/tool.js"
import { type AgentDefinition, AgentDefinitionBrand, defineAgent } from "../domain/agent.js"
import type { PromptSection } from "../domain/prompt.js"
import type { AgentEvent } from "../domain/event.js"
import type { PermissionResult } from "../domain/permission.js"
import type { Message, MessageMetadata } from "../domain/message.js"
import { fromReducer } from "../runtime/extensions/from-reducer.js"
import { ExtensionTurnControl } from "../runtime/extensions/turn-control.js"
import { interpretEffects } from "../runtime/extensions/extension-actor-shared.js"
import {
  createExtensionStorage,
  type ExtensionStorage,
} from "../runtime/extensions/extension-storage.js"
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { join as joinPath } from "node:path"

// ── Re-exports for full-power extension authors ──

export {
  fromReducer,
  type FromReducerConfig,
  type FromReducerResult,
} from "../runtime/extensions/from-reducer.js"
export {
  fromMachine,
  type FromMachineConfig,
  type FromMachineResult,
} from "../runtime/extensions/from-machine.js"
export {
  defineTool,
  ToolDefinitionBrand,
  type AnyToolDefinition,
  type ToolContext,
  type ToolAction,
} from "../domain/tool.js"
export { defineAgent, AgentDefinition, AgentDefinitionBrand } from "../domain/agent.js"
export {
  defineInterceptor,
  type ExtensionInterceptorDescriptor,
  type ExtensionInterceptorKey,
  type ExtensionInterceptorMap,
  type ProviderContribution,
  type InteractionHandlerContribution,
  type TagInjection,
  type SpawnExtensionRef,
  type ExtensionProjectionConfig,
  type ExtensionEffect,
  type ReduceResult,
  type ExtensionReduceContext,
  type ExtensionDeriveContext,
  type ExtensionProjection,
  type SystemPromptInput,
  type ToolExecuteInput,
  type PermissionCheckInput,
  type ContextMessagesInput,
  type TurnAfterInput,
  type ToolResultInput,
} from "../domain/extension.js"
export {
  ExtensionMessage,
  ExtensionMessageEnvelope,
  getExtensionMessageMetadata,
  getExtensionReplySchema,
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
export type { AgentEvent } from "../domain/event.js"
export type { ExtensionStorage } from "../runtime/extensions/extension-storage.js"

// ── Simple Parameter Types ──

interface SimpleParam {
  readonly type: "string" | "number" | "boolean"
  readonly description?: string
  readonly optional?: boolean
}

type SimpleParams = Record<string, SimpleParam>

// ── Simple Tool Definition ──

export interface SimpleToolDef {
  readonly name: string
  readonly description: string
  readonly action?: ToolAction
  readonly parameters?: SimpleParams
  readonly concurrency?: "serial" | "parallel"
  readonly idempotent?: boolean
  readonly interactive?: boolean
  readonly promptSnippet?: string
  readonly promptGuidelines?: ReadonlyArray<string>
  readonly execute: (
    params: Record<string, unknown>,
    ctx: ToolContext,
  ) => unknown | Promise<unknown>
}

// ── Simple Agent Definition ──

export interface SimpleAgentDef {
  readonly name: string
  readonly kind?: "primary" | "subagent" | "system"
  readonly model: string
  readonly systemPromptAddendum?: string
  readonly description?: string
  readonly allowedTools?: ReadonlyArray<string>
  readonly deniedTools?: ReadonlyArray<string>
  readonly temperature?: number
  readonly hidden?: boolean
}

// ── Simple Event (curated subset of AgentEvent for external authors) ──

export type SimpleEventType =
  // Session lifecycle
  | "session-started"
  | "session-name-updated"
  | "session-settings-updated"
  // Messages
  | "message-received"
  // Streaming
  | "stream-started"
  | "stream-chunk"
  | "stream-ended"
  // Turn lifecycle
  | "turn-completed"
  | "turn-recovery-applied"
  // Tool calls
  | "tool-call-started"
  | "tool-call-succeeded"
  | "tool-call-failed"
  // Agent lifecycle
  | "agent-switched"
  | "agent-restarted"
  // Subagent lifecycle
  | "subagent-spawned"
  | "subagent-succeeded"
  | "subagent-failed"
  // Tasks
  | "task-created"
  | "task-updated"
  | "task-completed"
  | "task-failed"
  | "task-stopped"
  | "task-deleted"
  // Branching
  | "branch-created"
  | "branch-switched"
  // Questions
  | "questions-asked"
  // Errors
  | "error-occurred"

export interface SimpleEvent {
  readonly type: SimpleEventType
  readonly _tag: string
  readonly raw: AgentEvent
}

/** Maps AgentEvent._tag to SimpleEventType. Diagnostic/internal events are intentionally omitted:
 *  MachineInspected, MachineTaskSucceeded, MachineTaskFailed, ExtensionUiSnapshot,
 *  PromptPresented, PromptConfirmed, PromptRejected, PromptEdited,
 *  HandoffPresented, HandoffConfirmed, HandoffRejected, InteractionDismissed,
 *  ProviderRetrying, BranchSummarized */
const EVENT_TAG_MAP: Record<string, SimpleEventType> = {
  SessionStarted: "session-started",
  SessionNameUpdated: "session-name-updated",
  SessionSettingsUpdated: "session-settings-updated",
  MessageReceived: "message-received",
  StreamStarted: "stream-started",
  StreamChunk: "stream-chunk",
  StreamEnded: "stream-ended",
  TurnCompleted: "turn-completed",
  TurnRecoveryApplied: "turn-recovery-applied",
  ToolCallStarted: "tool-call-started",
  ToolCallSucceeded: "tool-call-succeeded",
  ToolCallFailed: "tool-call-failed",
  AgentSwitched: "agent-switched",
  AgentRestarted: "agent-restarted",
  SubagentSpawned: "subagent-spawned",
  SubagentSucceeded: "subagent-succeeded",
  SubagentFailed: "subagent-failed",
  TaskCreated: "task-created",
  TaskUpdated: "task-updated",
  TaskCompleted: "task-completed",
  TaskFailed: "task-failed",
  TaskStopped: "task-stopped",
  TaskDeleted: "task-deleted",
  BranchCreated: "branch-created",
  BranchSwitched: "branch-switched",
  QuestionsAsked: "questions-asked",
  ErrorOccurred: "error-occurred",
}

const mapEventType = (tag: string): SimpleEventType | undefined => EVENT_TAG_MAP[tag]

// ── Simple State Config ──

export interface SimpleStateConfig<S> {
  readonly initial: S
  readonly reduce: (
    state: Readonly<S>,
    event: SimpleEvent,
  ) => { readonly state: S; readonly effects?: ReadonlyArray<SimpleEffect> }
  readonly derive?: (state: Readonly<S>) => {
    readonly promptSections?: ReadonlyArray<PromptSection>
    readonly toolPolicy?: {
      readonly include?: ReadonlyArray<string>
      readonly exclude?: ReadonlyArray<string>
    }
    readonly uiModel?: unknown
  }
  readonly persist?: { readonly schema: Schema.Schema<S> }
}

export interface SimpleEffect {
  readonly type: "queue-follow-up"
  readonly content: string
}

// ── Hook Types for ext.on() ──

type TransformHandler<I, O> = (input: I, next: (input: I) => Promise<O>) => O | Promise<O>
type FireAndForgetHandler<I> = (input: I) => void | Promise<void>

interface SimpleHookHandlers {
  readonly "prompt.system": TransformHandler<SystemPromptInput, string>
  readonly "tool.execute": TransformHandler<ToolExecuteInput, unknown>
  readonly "permission.check": TransformHandler<PermissionCheckInput, PermissionResult>
  readonly "context.messages": TransformHandler<ContextMessagesInput, ReadonlyArray<Message>>
  readonly "turn.after": FireAndForgetHandler<TurnAfterInput>
  readonly "tool.result": TransformHandler<ToolResultInput, unknown>
}

// ── Actor Result (from fromReducer/fromMachine) ──

export interface ActorResult {
  readonly spawn: SpawnExtensionRef
  readonly projection?: ExtensionProjectionConfig
}

// ── Extension Builder ──

export interface ExtensionBuilder {
  // ── Simple path (no Effect) ──

  /** Register a tool. Accepts SimpleToolDef or full AnyToolDefinition. */
  tool(def: SimpleToolDef | AnyToolDefinition): void
  /** Register an agent. Accepts SimpleAgentDef or full AgentDefinition. */
  agent(def: SimpleAgentDef | AgentDefinition): void
  /** Add a static system prompt section. */
  promptSection(section: PromptSection): void
  /** Register a hook using plain async handlers. */
  on<K extends keyof SimpleHookHandlers>(key: K, handler: SimpleHookHandlers[K]): void
  /** Register stateful extension via simplified reducer. Mutually exclusive with actor(). */
  state<S>(config: SimpleStateConfig<S>): void
  /** Register a startup hook. Multiple calls compose in order. */
  onStartup(fn: () => void | Promise<void>): void
  /** Register a shutdown hook. Multiple calls compose in order. */
  onShutdown(fn: () => void | Promise<void>): void

  // ── Imperative side effects (usable from ext.on() handlers) ──

  /** Queue a follow-up message after the current turn completes.
   *  Only usable from turn.after, tool.execute, tool.result, context.messages handlers. */
  queueFollowUp(content: string, metadata?: MessageMetadata): void
  /** Inject a message mid-turn (interrupts the current turn).
   *  Only usable from turn.after, tool.execute, tool.result, context.messages handlers. */
  interject(content: string): void

  /** File-backed key-value storage, namespaced by extension ID.
   *  Stored at ~/.gent/extensions/<id>/storage/<key>.json.
   *  Available at setup time and in hook handlers. */
  readonly storage: ExtensionStorage

  // ── Full-power path (Effect-aware) ──

  /** Register a raw Effect interceptor. */
  interceptor(descriptor: ExtensionInterceptorDescriptor): void
  interceptor<K extends ExtensionInterceptorKey>(key: K, run: ExtensionInterceptorMap[K]): void
  /** Register an actor from fromReducer() or fromMachine(). Mutually exclusive with state(). */
  actor(result: ActorResult): void
  /** Register public protocol definitions for this extension boundary. */
  protocol(protocol: ExtensionProtocol): void
  /** Provide a service Layer. Multiple calls merge. */
  layer(layer: Layer.Layer<never, never, object>): void
  /** Register an AI model provider. */
  provider(provider: ProviderContribution): void
  /** Register an interaction handler. */
  interactionHandler(handler: InteractionHandlerContribution): void
  /** Register a tag-conditional tool injection. */
  tagInjection(injection: TagInjection): void
  /** Register an Effect-based startup hook. Composes with onStartup(). */
  onStartupEffect(effect: Effect.Effect<void>): void
  /** Register an Effect-based shutdown hook. Composes with onShutdown(). */
  onShutdownEffect(effect: Effect.Effect<void>): void

  // ── Event observation ──

  /** Observe all events (including diagnostic) without needing actors or state.
   *  Fire-and-forget: return value ignored, errors caught and logged.
   *  Runs after reduction — no re-entrance risk.
   *  @deprecated Use `ext.bus.on("agent:*", handler)` instead. */
  observe(handler: (event: AgentEvent) => void | Promise<void>): void

  // ── Event bus ──

  /** Channel-based event bus for extension communication.
   *  Replaces `observe()` with richer routing and full service access in handlers. */
  readonly bus: {
    /** Subscribe to a bus channel. Handlers run with full service access.
     *  Pattern: exact match (e.g. `"@gent/task-tools:StopTask"`) or wildcard (`"agent:*"`).
     *  `"agent:*"` matches all agent events — equivalent to `ext.observe()`.
     *  Handler can return void, Promise<void>, or Effect<void, any, any> for service access.
     *  Effect handlers run in the full service context — all services available. */
    on(
      pattern: string,
      handler: (envelope: {
        channel: string
        payload: unknown
        sessionId?: string
        branchId?: string
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) => void | Promise<void> | Effect.Effect<void, any, any>,
    ): void
  }
}

// ── Internal Helpers ──

class SimpleToolError extends Data.TaggedError("@gent/core/src/extensions/api/SimpleToolError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

class SimpleHookError extends Data.TaggedError("@gent/core/src/extensions/api/SimpleHookError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

const isFullToolDef = (def: SimpleToolDef | AnyToolDefinition): def is AnyToolDefinition =>
  typeof def === "object" && def !== null && ToolDefinitionBrand in def

const schemaTypeMap: Record<string, Schema.Schema<unknown>> = {
  string: Schema.String as Schema.Schema<unknown>,
  number: Schema.Number as Schema.Schema<unknown>,
  boolean: Schema.Boolean as Schema.Schema<unknown>,
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const buildParamsSchema = (params?: SimpleParams): Schema.Decoder<any, never> => {
  if (params === undefined || Object.keys(params).length === 0) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return Schema.Struct({}) as unknown as Schema.Decoder<any, never>
  }
  const fields: Record<string, Schema.Schema<unknown>> = {}
  for (const [key, param] of Object.entries(params)) {
    const base = schemaTypeMap[param.type] ?? Schema.Unknown
    fields[key] = param.optional === true ? Schema.optional(base) : base
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return Schema.Struct(fields) as unknown as Schema.Decoder<any, never>
}

const convertSimpleTool = (def: SimpleToolDef): AnyToolDefinition =>
  defineTool({
    name: def.name,
    action: def.action ?? "read",
    description: def.description,
    params: buildParamsSchema(def.parameters),
    concurrency: def.concurrency,
    idempotent: def.idempotent,
    interactive: def.interactive,
    promptSnippet: def.promptSnippet,
    promptGuidelines: def.promptGuidelines,
    execute: (params: Record<string, unknown>, ctx: ToolContext) =>
      Effect.tryPromise({
        try: () => Promise.resolve(def.execute(params, ctx)),
        catch: (e) => new SimpleToolError({ message: String(e), cause: e }),
      }),
  }) as AnyToolDefinition

const convertSimpleAgent = (def: SimpleAgentDef): AgentDefinition =>
  defineAgent({
    name: def.name,
    kind: def.kind ?? "subagent",
    model: def.model as never,
    systemPromptAddendum: def.systemPromptAddendum,
    description: def.description,
    allowedTools: def.allowedTools,
    deniedTools: def.deniedTools,
    temperature: def.temperature,
    hidden: def.hidden,
  })

/** Extract sessionId/branchId from hook input for effect draining */
const extractContext = (
  _key: string,
  input: unknown,
): { sessionId?: string; branchId?: string } => {
  const record = input as Record<string, unknown>
  return {
    sessionId: record["sessionId"] as string | undefined,
    branchId: record["branchId"] as string | undefined,
  }
}

/** Keys where queueFollowUp/interject are allowed (have sessionId/branchId in input) */
const EFFECT_CAPABLE_HOOKS = new Set([
  "turn.after",
  "tool.execute",
  "tool.result",
  "context.messages",
])

type EffectBinder = {
  bind: (effects: ExtensionEffect[], hookKey: string) => void
  unbind: () => void
}

const drainEffects = (effects: ExtensionEffect[], hookKey: string, input: unknown) =>
  Effect.gen(function* () {
    if (effects.length === 0) return
    const ctx = extractContext(hookKey, input)
    const tc = yield* Effect.serviceOption(ExtensionTurnControl)
    if (tc._tag === "Some" && ctx.sessionId !== undefined) {
      yield* interpretEffects(
        effects,
        ctx.sessionId as never,
        ctx.branchId as never,
        tc.value,
      ).pipe(Effect.catchDefect(() => Effect.void))
    }
  })

const wrapTransformHandler =
  <I, O>(
    handler: TransformHandler<I, O>,
    hookKey: string,
    effectBinder: EffectBinder,
  ): ((input: I, next: (input: I) => Effect.Effect<O>) => Effect.Effect<O>) =>
  (input, next) => {
    const effects: ExtensionEffect[] = []
    effectBinder.bind(effects, hookKey)
    return Effect.tryPromise({
      try: () => {
        const effectNext = (i: I) => Effect.runPromise(next(i))
        return Promise.resolve(handler(input, effectNext))
      },
      catch: (e) => new SimpleHookError({ message: String(e), cause: e }),
    }).pipe(
      Effect.orDie,
      // Always unbind (even on failure) to keep the stack clean
      Effect.ensuring(Effect.sync(() => effectBinder.unbind())),
      // Drain effects only on success
      Effect.tap(() => drainEffects(effects, hookKey, input)),
    ) as Effect.Effect<O>
  }

const wrapFireAndForgetHandler =
  <I>(
    handler: FireAndForgetHandler<I>,
    hookKey: string,
    effectBinder: EffectBinder,
  ): ((input: I, next: (input: I) => Effect.Effect<void>) => Effect.Effect<void>) =>
  (input, next) =>
    Effect.gen(function* () {
      yield* next(input)
      const effects: ExtensionEffect[] = []
      effectBinder.bind(effects, hookKey)
      yield* Effect.tryPromise({
        try: () => Promise.resolve(handler(input)),
        catch: (e) => new SimpleHookError({ message: String(e), cause: e }),
      }).pipe(Effect.orDie, Effect.ensuring(Effect.sync(() => effectBinder.unbind())))
      yield* drainEffects(effects, hookKey, input)
    })

const convertSimpleEffect = (effect: SimpleEffect): ExtensionEffect => {
  switch (effect.type) {
    case "queue-follow-up":
      return { _tag: "QueueFollowUp", content: effect.content }
  }
}

/** Convert SimpleStateConfig to fromReducer result. Extracted to reduce factory generator complexity. */
const resolveSimpleState = (
  id: string,
  sc: SimpleStateConfig<unknown>,
): { error: string } | { spawn: SpawnExtensionRef; projection?: ExtensionProjectionConfig } => {
  if (sc.persist !== undefined && sc.persist.schema === undefined) {
    return { error: `ext.state() persist requires a schema: { persist: { schema } }` } as const
  }
  const reducerResult = fromReducer({
    id,
    initial: sc.initial,
    reduce: (
      state: unknown,
      event: AgentEvent,
      _ctx: ExtensionReduceContext,
    ): ReduceResult<unknown> => {
      const simpleType = mapEventType(event._tag)
      if (simpleType === undefined) return { state }
      const simpleEvent: SimpleEvent = { type: simpleType, _tag: event._tag, raw: event }
      const result = sc.reduce(state as Readonly<typeof sc.initial>, simpleEvent)
      return { state: result.state, effects: result.effects?.map(convertSimpleEffect) }
    },
    derive: (() => {
      const deriveFn = sc.derive
      if (deriveFn === undefined) return undefined
      return (state: unknown): ExtensionProjection => {
        const derived = deriveFn(state as Readonly<typeof sc.initial>)
        return {
          promptSections: derived.promptSections,
          toolPolicy: derived.toolPolicy,
          uiModel: derived.uiModel,
        }
      }
    })(),
    stateSchema: sc.persist?.schema,
    persist: sc.persist !== undefined,
  })
  return {
    spawn: reducerResult.spawn,
    projection: reducerResult.projection,
  } as const
}

// ── Public API ──

/** Setup context passed to the factory function. */
export interface ExtensionContext {
  readonly cwd: string
  readonly source: string
  readonly home: string
}

type BusSubscriptionEntry = NonNullable<ExtensionSetup["busSubscriptions"]>[number]

/** Merge startup hooks into a single Effect. Extracted to reduce generator complexity. */
const mergeStartupHooks = (
  fns: Array<() => void | Promise<void>>,
  effects: Array<Effect.Effect<void>>,
): Effect.Effect<void> | undefined => {
  const all: Effect.Effect<void>[] = [
    ...fns.map((fn) =>
      Effect.tryPromise({
        try: () => Promise.resolve(fn()),
        catch: (e) => new SimpleHookError({ message: `onStartup: ${String(e)}`, cause: e }),
      }).pipe(Effect.orDie, Effect.asVoid),
    ),
    ...effects,
  ]
  return all.length > 0 ? Effect.all(all, { discard: true }).pipe(Effect.asVoid) : undefined
}

/** Merge shutdown hooks into a single Effect. Extracted to reduce generator complexity. */
const mergeShutdownHooks = (
  fns: Array<() => void | Promise<void>>,
  effects: Array<Effect.Effect<void>>,
): Effect.Effect<void> | undefined => {
  const all: Effect.Effect<void>[] = [
    ...fns.map((fn) =>
      Effect.tryPromise({
        try: () => Promise.resolve(fn()),
        catch: (e) => new SimpleHookError({ message: `onShutdown: ${String(e)}`, cause: e }),
      }).pipe(Effect.orDie, Effect.asVoid),
    ),
    ...effects,
  ]
  return all.length > 0 ? Effect.all(all, { discard: true }).pipe(Effect.asVoid) : undefined
}

/**
 * Create an extension. One API for both simple and full-power extensions.
 *
 * Factory runs at setup time (not import time), receives setup context.
 * Sync factories work — async/Promise is optional.
 */
export const extension = (
  id: string,
  factory: (ext: ExtensionBuilder, ctx: ExtensionContext) => void | Promise<void>,
): GentExtension => ({
  manifest: { id },
  setup: (ctx) =>
    Effect.gen(function* () {
      const tools: AnyToolDefinition[] = []
      const agents: AgentDefinition[] = []
      const promptSections: PromptSection[] = []
      const interceptors: ExtensionInterceptorDescriptor[] = []
      const startupFns: Array<() => void | Promise<void>> = []
      const shutdownFns: Array<() => void | Promise<void>> = []
      const startupEffects: Array<Effect.Effect<void>> = []
      const shutdownEffects: Array<Effect.Effect<void>> = []
      const providers: ProviderContribution[] = []
      const interactionHandlers: InteractionHandlerContribution[] = []
      const tagInjections: TagInjection[] = []
      const observers: Array<(event: AgentEvent) => void | Promise<void>> = []
      const busSubscriptions: BusSubscriptionEntry[] = []
      const layers: Array<Layer.Layer<never, never, object>> = []
      const protocols = new Map<
        string,
        ReturnType<typeof listExtensionProtocolDefinitions>[number]
      >()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let stateConfig: SimpleStateConfig<any> | undefined
      let actorResult: ActorResult | undefined

      // Stack-based effect buffer for imperative side effects.
      // Stack is necessary because interceptor chains nest via next() — an outer
      // handler's buffer must survive while inner interceptors bind their own.
      const effectStack: Array<{ effects: ExtensionEffect[]; hookKey: string }> = []
      const effectBinder: EffectBinder = {
        bind: (effects, hookKey) => {
          effectStack.push({ effects, hookKey })
        },
        unbind: () => {
          effectStack.pop()
        },
      }

      const extensionStorage = createExtensionStorage(id, joinPath(ctx.home, ".gent", "extensions"))

      const builder: ExtensionBuilder = {
        storage: extensionStorage,

        tool: (def) => {
          if (isFullToolDef(def)) {
            tools.push(def)
          } else {
            tools.push(convertSimpleTool(def as SimpleToolDef))
          }
        },

        agent: (def) => {
          if (AgentDefinitionBrand in def || "_tag" in def) {
            agents.push(def as AgentDefinition)
          } else {
            agents.push(convertSimpleAgent(def as SimpleAgentDef))
          }
        },

        promptSection: (section) => promptSections.push(section),

        on: ((key: keyof SimpleHookHandlers, handler: SimpleHookHandlers[typeof key]) => {
          if (key === "turn.after") {
            interceptors.push(
              defineInterceptor(
                key,
                wrapFireAndForgetHandler(
                  handler as FireAndForgetHandler<TurnAfterInput>,
                  key,
                  effectBinder,
                ),
              ),
            )
          } else {
            interceptors.push(
              defineInterceptor(
                key,
                wrapTransformHandler(
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  handler as TransformHandler<any, any>,
                  key,
                  effectBinder,
                ) as never,
              ),
            )
          }
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }) as any,

        queueFollowUp: (content, metadata?) => {
          const top = effectStack[effectStack.length - 1]
          if (top === undefined) {
            throw new Error(
              `ext.queueFollowUp() called outside of a hook handler. ` +
                `Use it inside ext.on("turn.after", ...) or ext.on("tool.execute", ...).`,
            )
          }
          if (!EFFECT_CAPABLE_HOOKS.has(top.hookKey)) {
            throw new Error(
              `ext.queueFollowUp() is not available in "${top.hookKey}" handlers. ` +
                `Use it in turn.after, tool.execute, tool.result, or context.messages handlers.`,
            )
          }
          top.effects.push({ _tag: "QueueFollowUp", content, metadata })
        },

        interject: (content) => {
          const top = effectStack[effectStack.length - 1]
          if (top === undefined) {
            throw new Error(
              `ext.interject() called outside of a hook handler. ` +
                `Use it inside ext.on("turn.after", ...) or ext.on("tool.execute", ...).`,
            )
          }
          if (!EFFECT_CAPABLE_HOOKS.has(top.hookKey)) {
            throw new Error(
              `ext.interject() is not available in "${top.hookKey}" handlers. ` +
                `Use it in turn.after, tool.execute, tool.result, or context.messages handlers.`,
            )
          }
          top.effects.push({ _tag: "Interject", content })
        },

        state: (config) => {
          if (stateConfig !== undefined || actorResult !== undefined) {
            throw new Error(
              `extension "${id}": state() and actor() are mutually exclusive, and each can only be called once`,
            )
          }
          stateConfig = config
        },

        onStartup: (fn) => startupFns.push(fn),
        onShutdown: (fn) => shutdownFns.push(fn),

        // Full-power methods

        interceptor: ((
          ...args:
            | [ExtensionInterceptorDescriptor]
            | [ExtensionInterceptorKey, ExtensionInterceptorMap[ExtensionInterceptorKey]]
        ) => {
          if (args.length === 1) {
            interceptors.push(args[0])
          } else {
            interceptors.push(defineInterceptor(args[0], args[1] as never))
          }
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }) as any,

        actor: (result) => {
          if (actorResult !== undefined || stateConfig !== undefined) {
            throw new Error(
              `extension "${id}": actor() and state() are mutually exclusive, and each can only be called once`,
            )
          }
          actorResult = result
        },

        protocol: (protocol) => {
          for (const definition of listExtensionProtocolDefinitions(protocol)) {
            if (definition.extensionId !== id) {
              throw new Error(
                `extension "${id}": protocol definition "${definition._tag}" belongs to "${definition.extensionId}"`,
              )
            }
            protocols.set(definition._tag, definition)
          }
        },

        layer: (l) => {
          layers.push(l)
        },
        provider: (p) => providers.push(p),
        interactionHandler: (h) => interactionHandlers.push(h),
        tagInjection: (t) => tagInjections.push(t),
        onStartupEffect: (e) => startupEffects.push(e),
        onShutdownEffect: (e) => shutdownEffects.push(e),
        observe: (handler) => observers.push(handler),
        bus: {
          on: (pattern, handler) => busSubscriptions.push({ pattern, handler }),
        },
      }

      // Run factory — sync factories stay sync (no Promise.resolve tick)
      const factoryResult = Effect.try({
        try: () => factory(builder, ctx),
        catch: (e) => new ExtensionLoadError(id, `Extension factory failed: ${String(e)}`, e),
      })
      const result = yield* factoryResult
      // If factory returned a Promise, await it
      if (result !== undefined && typeof (result as Promise<void>).then === "function") {
        yield* Effect.tryPromise({
          try: () => result as Promise<void>,
          catch: (e) => new ExtensionLoadError(id, `Extension factory failed: ${String(e)}`, e),
        })
      }

      // Resolve actor from state() or actor()
      let spawn: ExtensionSetup["spawn"]
      let projection: ExtensionSetup["projection"]

      if (stateConfig !== undefined) {
        const resolved = resolveSimpleState(id, stateConfig)
        if ("error" in resolved) {
          return yield* Effect.fail(new ExtensionLoadError(id, resolved.error))
        }
        spawn = resolved.spawn
        projection = resolved.projection
      } else if (actorResult !== undefined) {
        spawn = actorResult.spawn
        projection = actorResult.projection
      }

      let mergedLayer: Layer.Layer<never, never, object> | undefined
      const [firstLayer, ...remainingLayers] = layers
      if (firstLayer !== undefined) {
        mergedLayer = remainingLayers.reduce<Layer.Layer<never, never, object>>(
          (current, layer) => Layer.merge(current, layer),
          firstLayer,
        )
      }

      const onStartup = mergeStartupHooks(startupFns, startupEffects)
      const onShutdown = mergeShutdownHooks(shutdownFns, shutdownEffects)

      return {
        ...(tools.length > 0 ? { tools } : {}),
        ...(agents.length > 0 ? { agents } : {}),
        ...(protocols.size > 0 ? { protocols: [...protocols.values()] } : {}),
        ...(promptSections.length > 0 ? { promptSections } : {}),
        ...(interceptors.length > 0 ? { hooks: { interceptors } } : {}),
        ...(mergedLayer !== undefined ? { layer: mergedLayer } : {}),
        ...(providers.length > 0 ? { providers } : {}),
        ...(interactionHandlers.length > 0 ? { interactionHandlers } : {}),
        ...(tagInjections.length > 0 ? { tagInjections } : {}),
        ...(observers.length > 0 ? { observers } : {}),
        ...(busSubscriptions.length > 0 ? { busSubscriptions } : {}),
        spawn,
        projection,
        onStartup,
        onShutdown,
      } satisfies ExtensionSetup
    }),
})

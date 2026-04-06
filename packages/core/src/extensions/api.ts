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
 *   ext.actor(MyActor)
 * })
 *
 * // Full-power path — same builder, Effect-aware
 * export default extension("@gent/my-builtin", (ext) => {
 *   ext.tool(MyFullToolDefinition)
 *   ext.interceptor("prompt.system", (input, next) => next(input).pipe(Effect.map(...)))
 *   ext.actor(MyActor)
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
  type AnyExtensionActorDefinition,
  type ExtensionReduceContext,
  type ReduceResult,
  type ExtensionEffect,
  type ProviderContribution,
  type ScheduledJobContribution,
  type TagInjection,
} from "../domain/extension.js"
import { type AnyExtensionCommandMessage } from "../domain/extension-protocol.js"
import {
  defineTool,
  ToolDefinitionBrand,
  type ToolAction,
  type ToolContext,
  type AnyToolDefinition,
} from "../domain/tool.js"
import type { ExtensionHostContext } from "../domain/extension-host-context.js"
import { type AgentDefinition, AgentDefinitionBrand, defineAgent } from "../domain/agent.js"
import type { PromptSection } from "../domain/prompt.js"
import type { AgentEvent } from "../domain/event.js"
import type { PermissionResult } from "../domain/permission.js"
import type { Message, MessageMetadata } from "../domain/message.js"
import { ExtensionTurnControl } from "../runtime/extensions/turn-control.js"
import { interpretEffects } from "../runtime/extensions/extension-actor-shared.js"
import { ExtensionEventBus } from "../runtime/extensions/event-bus.js"
import { ExtensionStateRuntime } from "../runtime/extensions/state-runtime.js"
import {
  createExtensionStorage,
  type ExtensionStorage,
} from "../runtime/extensions/extension-storage.js"
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { join as joinPath } from "node:path"

// ── Re-exports for full-power extension authors ──

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
  type ScheduledJobContribution,
  type TagInjection,
  type ExtensionEffect,
  type ReduceResult,
  type ExtensionReduceContext,
  type ExtensionDeriveContext,
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
  readonly model: string
  readonly systemPromptAddendum?: string
  readonly description?: string
  readonly allowedTools?: ReadonlyArray<string>
  readonly deniedTools?: ReadonlyArray<string>
  readonly temperature?: number
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
  readonly raw: SimpleEventRaw
}

type LegacySimpleAgentRunEvent =
  | (Omit<Extract<AgentEvent, { readonly _tag: "AgentRunSpawned" }>, "_tag"> & {
      readonly _tag: "SubagentSpawned"
    })
  | (Omit<Extract<AgentEvent, { readonly _tag: "AgentRunSucceeded" }>, "_tag"> & {
      readonly _tag: "SubagentSucceeded"
    })
  | (Omit<Extract<AgentEvent, { readonly _tag: "AgentRunFailed" }>, "_tag"> & {
      readonly _tag: "SubagentFailed"
    })

type SimpleEventRaw = AgentEvent | LegacySimpleAgentRunEvent

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

// ── Actor Result ──

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
  /** Publish a message to the event bus.
   *  Only usable from turn.after, tool.execute, tool.result, context.messages handlers. */
  busEmit(channel: string, payload: unknown): void
  /** Send a command message to another extension's actor (fire-and-forget).
   *  Only usable from turn.after, tool.execute, tool.result, context.messages handlers. */
  send(message: AnyExtensionCommandMessage): void

  /** File-backed key-value storage, namespaced by extension ID.
   *  Stored at ~/.gent/extensions/<id>/storage/<key>.json.
   *  Available at setup time and in hook handlers. */
  readonly storage: ExtensionStorage

  // ── Full-power path (Effect-aware) ──

  /** Register a raw Effect interceptor. */
  interceptor(descriptor: ExtensionInterceptorDescriptor): void
  interceptor<K extends ExtensionInterceptorKey>(key: K, run: ExtensionInterceptorMap[K]): void
  /** Register a stateful actor. Stateless extensions can omit this. */
  actor(actor: AnyExtensionActorDefinition): void
  /** Provide a service Layer. Multiple calls merge. */
  layer(layer: Layer.Layer<never, never, object>): void
  /** Register an AI model provider. */
  provider(provider: ProviderContribution): void
  /** Register durable host-owned scheduled jobs. */
  jobs(...jobs: ReadonlyArray<ScheduledJobContribution>): void
  /** Register a tag-conditional tool injection. */
  tagInjection(injection: TagInjection): void
  /** Register an Effect-based startup hook. Composes with onStartup(). */
  onStartupEffect(effect: Effect.Effect<void>): void
  /** Register an Effect-based shutdown hook. Composes with onShutdown(). */
  onShutdownEffect(effect: Effect.Effect<void>): void

  // ── Event bus ──

  /** Channel-based event bus for extension communication. */
  readonly bus: {
    /** Subscribe to a bus channel.
     *  Pattern: exact match (e.g. `"@gent/task-tools:StopTask"`) or wildcard (`"agent:*"`).
     *  Handler can return void, Promise<void>, or Effect<void>. */
    on(
      pattern: string,
      handler: (envelope: {
        channel: string
        payload: unknown
        sessionId?: string
        branchId?: string
      }) => void | Promise<void> | Effect.Effect<void>,
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
    model: def.model as never,
    systemPromptAddendum: def.systemPromptAddendum,
    description: def.description,
    allowedTools: def.allowedTools,
    deniedTools: def.deniedTools,
    temperature: def.temperature,
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
      const bus = yield* Effect.serviceOption(ExtensionEventBus)
      const stateRuntime = yield* Effect.serviceOption(ExtensionStateRuntime)
      yield* interpretEffects(effects, ctx.sessionId as never, ctx.branchId as never, {
        turnControl: tc.value,
        busEmit:
          bus._tag === "Some"
            ? (channel, payload) =>
                bus.value.emit({
                  channel,
                  payload,
                  sessionId: ctx.sessionId as never,
                  branchId: ctx.branchId as never,
                })
            : undefined,
        send:
          stateRuntime._tag === "Some"
            ? (sessionId, message) =>
                stateRuntime.value
                  .send(sessionId, message)
                  .pipe(Effect.catchEager(() => Effect.void))
            : undefined,
      }).pipe(Effect.catchDefect(() => Effect.void))
    }
  })

const wrapTransformHandler =
  <I, O>(
    handler: TransformHandler<I, O>,
    hookKey: string,
    effectBinder: EffectBinder,
  ): ((
    input: I,
    next: (input: I) => Effect.Effect<O>,
    _ctx: ExtensionHostContext,
  ) => Effect.Effect<O>) =>
  (input, next, _ctx) => {
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
  ): ((
    input: I,
    next: (input: I) => Effect.Effect<void>,
    _ctx: ExtensionHostContext,
  ) => Effect.Effect<void>) =>
  (input, next, _ctx) =>
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
      const jobs: ScheduledJobContribution[] = []
      const tagInjections: TagInjection[] = []
      const busSubscriptions: BusSubscriptionEntry[] = []
      const layers: Array<Layer.Layer<never, never, object>> = []
      let actorResult: AnyExtensionActorDefinition | undefined

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

        busEmit: (channel, payload) => {
          const top = effectStack[effectStack.length - 1]
          if (top === undefined) {
            throw new Error(
              `ext.busEmit() called outside of a hook handler. ` +
                `Use it inside ext.on("turn.after", ...) or ext.on("tool.execute", ...).`,
            )
          }
          if (!EFFECT_CAPABLE_HOOKS.has(top.hookKey)) {
            throw new Error(
              `ext.busEmit() is not available in "${top.hookKey}" handlers. ` +
                `Use it in turn.after, tool.execute, tool.result, or context.messages handlers.`,
            )
          }
          top.effects.push({ _tag: "BusEmit", channel, payload })
        },

        send: (message) => {
          const top = effectStack[effectStack.length - 1]
          if (top === undefined) {
            throw new Error(
              `ext.send() called outside of a hook handler. ` +
                `Use it inside ext.on("turn.after", ...) or ext.on("tool.execute", ...).`,
            )
          }
          if (!EFFECT_CAPABLE_HOOKS.has(top.hookKey)) {
            throw new Error(
              `ext.send() is not available in "${top.hookKey}" handlers. ` +
                `Use it in turn.after, tool.execute, tool.result, or context.messages handlers.`,
            )
          }
          top.effects.push({ _tag: "Send", message })
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

        actor: (actor) => {
          if (actorResult !== undefined) {
            throw new Error(`extension "${id}": actor() can only be called once`)
          }
          actorResult = actor
        },

        layer: (l) => {
          layers.push(l)
        },
        provider: (p) => providers.push(p),
        jobs: (...entries) => jobs.push(...entries),
        tagInjection: (t) => tagInjections.push(t),
        onStartupEffect: (e) => startupEffects.push(e),
        onShutdownEffect: (e) => shutdownEffects.push(e),
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
        ...(promptSections.length > 0 ? { promptSections } : {}),
        ...(interceptors.length > 0 ? { hooks: { interceptors } } : {}),
        ...(mergedLayer !== undefined ? { layer: mergedLayer } : {}),
        ...(providers.length > 0 ? { providers } : {}),
        ...(jobs.length > 0 ? { jobs } : {}),
        ...(tagInjections.length > 0 ? { tagInjections } : {}),
        ...(busSubscriptions.length > 0 ? { busSubscriptions } : {}),
        ...(actorResult !== undefined ? { actor: actorResult } : {}),
        onStartup,
        onShutdown,
      } satisfies ExtensionSetup
    }),
})

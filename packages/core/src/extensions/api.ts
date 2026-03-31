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
  type SpawnActor,
} from "../domain/extension.js"
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
import type { Message } from "../domain/message.js"
import { fromReducer } from "../runtime/extensions/from-reducer.js"

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
  type SpawnActor,
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
export type { PromptSection } from "../domain/prompt.js"
export type { AgentEvent } from "../domain/event.js"

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
  | "session-started"
  | "message-received"
  | "stream-started"
  | "stream-ended"
  | "turn-completed"
  | "tool-call-started"
  | "tool-call-succeeded"
  | "tool-call-failed"
  | "agent-switched"
  | "error-occurred"

export interface SimpleEvent {
  readonly type: SimpleEventType
  readonly _tag: string
  readonly raw: AgentEvent
}

const mapEventType = (tag: string): SimpleEventType | undefined => {
  switch (tag) {
    case "SessionStarted":
      return "session-started"
    case "MessageReceived":
      return "message-received"
    case "StreamStarted":
      return "stream-started"
    case "StreamEnded":
      return "stream-ended"
    case "TurnCompleted":
      return "turn-completed"
    case "ToolCallStarted":
      return "tool-call-started"
    case "ToolCallSucceeded":
      return "tool-call-succeeded"
    case "ToolCallFailed":
      return "tool-call-failed"
    case "AgentSwitched":
      return "agent-switched"
    case "ErrorOccurred":
      return "error-occurred"
    default:
      return undefined
  }
}

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
  readonly spawnActor: SpawnActor
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

  // ── Full-power path (Effect-aware) ──

  /** Register a raw Effect interceptor. */
  interceptor(descriptor: ExtensionInterceptorDescriptor): void
  interceptor<K extends ExtensionInterceptorKey>(key: K, run: ExtensionInterceptorMap[K]): void
  /** Register an actor from fromReducer() or fromMachine(). Mutually exclusive with state(). */
  actor(result: ActorResult): void
  /** Provide a service Layer. Multiple calls merge. */
  layer(layer: Layer.Any): void
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

const wrapTransformHandler =
  <I, O>(
    handler: TransformHandler<I, O>,
  ): ((input: I, next: (input: I) => Effect.Effect<O>) => Effect.Effect<O>) =>
  (input, next) =>
    Effect.tryPromise({
      try: () => {
        const effectNext = (i: I) => Effect.runPromise(next(i))
        return Promise.resolve(handler(input, effectNext))
      },
      catch: (e) => new SimpleHookError({ message: String(e), cause: e }),
    }).pipe(Effect.orDie) as Effect.Effect<O>

const wrapFireAndForgetHandler =
  <I>(
    handler: FireAndForgetHandler<I>,
  ): ((input: I, next: (input: I) => Effect.Effect<void>) => Effect.Effect<void>) =>
  (input, next) =>
    Effect.gen(function* () {
      yield* next(input)
      yield* Effect.tryPromise({
        try: () => Promise.resolve(handler(input)),
        catch: (e) => new SimpleHookError({ message: String(e), cause: e }),
      }).pipe(Effect.orDie)
    })

const convertSimpleEffect = (effect: SimpleEffect): ExtensionEffect => {
  switch (effect.type) {
    case "queue-follow-up":
      return { _tag: "QueueFollowUp", content: effect.content }
  }
}

// ── Public API ──

/** Setup context passed to the factory function. */
export interface ExtensionContext {
  readonly cwd: string
  readonly source: string
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
      const layers: Layer.Any[] = []
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let stateConfig: SimpleStateConfig<any> | undefined
      let actorResult: ActorResult | undefined

      const builder: ExtensionBuilder = {
        tool: (def) => {
          if (isFullToolDef(def)) {
            tools.push(def)
          } else {
            tools.push(convertSimpleTool(def as SimpleToolDef))
          }
        },

        agent: (def) => {
          if (AgentDefinitionBrand in def) {
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
                wrapFireAndForgetHandler(handler as FireAndForgetHandler<TurnAfterInput>),
              ),
            )
          } else {
            interceptors.push(
              defineInterceptor(
                key,
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                wrapTransformHandler(handler as TransformHandler<any, any>) as never,
              ),
            )
          }
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }) as any,

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

        layer: (l) => layers.push(l),
        provider: (p) => providers.push(p),
        interactionHandler: (h) => interactionHandlers.push(h),
        tagInjection: (t) => tagInjections.push(t),
        onStartupEffect: (e) => startupEffects.push(e),
        onShutdownEffect: (e) => shutdownEffects.push(e),
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
      let spawnActor: ExtensionSetup["spawnActor"]
      let projection: ExtensionSetup["projection"]

      if (stateConfig !== undefined) {
        const sc = stateConfig
        if (sc.persist !== undefined && sc.persist.schema === undefined) {
          return yield* Effect.fail(
            new ExtensionLoadError(
              id,
              `ext.state() persist requires a schema: { persist: { schema } }`,
            ),
          )
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
            return (state: unknown, _deriveCtx: ExtensionDeriveContext): ExtensionProjection => {
              const derived = deriveFn(state as Readonly<typeof sc.initial>)
              return { promptSections: derived.promptSections, toolPolicy: derived.toolPolicy }
            }
          })(),
          stateSchema: sc.persist?.schema,
          persist: sc.persist !== undefined,
        })
        spawnActor = reducerResult.spawnActor
        projection = reducerResult.projection
      } else if (actorResult !== undefined) {
        spawnActor = actorResult.spawnActor
        projection = actorResult.projection
      }

      // Merge layers — cast through Layer<never> to satisfy Layer.mergeAll variance
      type NarrowLayer = Layer.Layer<never>
      let mergedLayer: Layer.Any | undefined
      if (layers.length === 1) {
        mergedLayer = layers[0]
      } else if (layers.length > 1) {
        mergedLayer = Layer.mergeAll(...(layers as [NarrowLayer, NarrowLayer, ...NarrowLayer[]]))
      }

      // Merge startup effects (Promise fns + Effect values)
      const allStartup: Effect.Effect<void>[] = [
        ...startupFns.map((fn) =>
          Effect.tryPromise({
            try: () => Promise.resolve(fn()),
            catch: (e) => new SimpleHookError({ message: `onStartup: ${String(e)}`, cause: e }),
          }).pipe(Effect.orDie, Effect.asVoid),
        ),
        ...startupEffects,
      ]
      const onStartup =
        allStartup.length > 0
          ? Effect.all(allStartup, { discard: true }).pipe(Effect.asVoid)
          : undefined

      const allShutdown: Effect.Effect<void>[] = [
        ...shutdownFns.map((fn) =>
          Effect.tryPromise({
            try: () => Promise.resolve(fn()),
            catch: (e) => new SimpleHookError({ message: `onShutdown: ${String(e)}`, cause: e }),
          }).pipe(Effect.orDie, Effect.asVoid),
        ),
        ...shutdownEffects,
      ]
      const onShutdown =
        allShutdown.length > 0
          ? Effect.all(allShutdown, { discard: true }).pipe(Effect.asVoid)
          : undefined

      return {
        ...(tools.length > 0 ? { tools } : {}),
        ...(agents.length > 0 ? { agents } : {}),
        ...(promptSections.length > 0 ? { promptSections } : {}),
        ...(interceptors.length > 0 ? { hooks: { interceptors } } : {}),
        ...(mergedLayer !== undefined ? { layer: mergedLayer } : {}),
        ...(providers.length > 0 ? { providers } : {}),
        ...(interactionHandlers.length > 0 ? { interactionHandlers } : {}),
        ...(tagInjections.length > 0 ? { tagInjections } : {}),
        spawnActor,
        projection,
        onStartup,
        onShutdown,
      } satisfies ExtensionSetup
    }),
})

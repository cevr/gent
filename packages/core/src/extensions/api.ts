/**
 * Imperative extension authoring API.
 *
 * No Effect or Schema knowledge required. Plain objects and async functions.
 *
 * @example
 * ```ts
 * import { simpleExtension } from "@gent/core/extensions/api"
 *
 * export default simpleExtension("my-ext", async (ext, ctx) => {
 *   ext.tool({
 *     name: "greet",
 *     description: "Say hello",
 *     parameters: { name: { type: "string" } },
 *     execute: async (params) => `Hello, ${params.name}!`,
 *   })
 *
 *   ext.on("prompt.system", (input, next) => {
 *     return next({ ...input, basePrompt: input.basePrompt + "\nBe friendly." })
 *   })
 *
 *   ext.state({
 *     initial: { turns: 0 },
 *     reduce: (state, event) => {
 *       if (event.type === "turn-completed") return { state: { turns: state.turns + 1 } }
 *       return { state }
 *     },
 *     derive: (state) => ({
 *       promptSections: [{ id: "turn-count", content: `Turns: ${state.turns}`, priority: 50 }],
 *     }),
 *   })
 * })
 * ```
 *
 * @module
 */
import { Effect, Schema, Data } from "effect"
import {
  defineExtension,
  defineInterceptor,
  ExtensionLoadError,
  type GentExtension,
  type ExtensionSetup,
  type ExtensionInterceptorDescriptor,
  type SystemPromptInput,
  type ToolExecuteInput,
  type PermissionCheckInput,
  type ContextMessagesInput,
  type TurnAfterInput,
  type ToolResultInput,
  type ExtensionDeriveContext,
  type ExtensionProjection,
  type ExtensionReduceContext,
  type ReduceResult,
  type ExtensionEffect,
} from "../domain/extension.js"
import {
  defineTool,
  type ToolAction,
  type ToolContext,
  type AnyToolDefinition,
} from "../domain/tool.js"
import { defineAgent, type AgentDefinition } from "../domain/agent.js"
import type { PromptSection } from "../domain/prompt.js"
import type { AgentEvent } from "../domain/event.js"
import type { PermissionResult } from "../domain/permission.js"
import type { Message } from "../domain/message.js"
import { fromReducer } from "../runtime/extensions/from-reducer.js"

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
  /** The raw AgentEvent _tag for advanced filtering */
  readonly _tag: string
  /** The full raw event data */
  readonly raw: AgentEvent
}

/** Map AgentEvent._tag to SimpleEventType. Returns undefined for internal/diagnostic events. */
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

/** Transform hook handler — receives input, calls next to continue chain */
type TransformHandler<I, O> = (input: I, next: (input: I) => Promise<O>) => O | Promise<O>

/** Fire-and-forget hook handler */
type FireAndForgetHandler<I> = (input: I) => void | Promise<void>

/** Hook handler type map — maps hook keys to their handler signatures */
interface SimpleHookHandlers {
  readonly "prompt.system": TransformHandler<SystemPromptInput, string>
  readonly "tool.execute": TransformHandler<ToolExecuteInput, unknown>
  readonly "permission.check": TransformHandler<PermissionCheckInput, PermissionResult>
  readonly "context.messages": TransformHandler<ContextMessagesInput, ReadonlyArray<Message>>
  readonly "turn.after": FireAndForgetHandler<TurnAfterInput>
  readonly "tool.result": TransformHandler<ToolResultInput, unknown>
}

// ── Extension Builder ──

export interface ExtensionBuilder {
  /** Register a tool with plain objects — no Schema or Effect needed. */
  tool(def: SimpleToolDef): void
  /** Register an agent definition. */
  agent(def: SimpleAgentDef): void
  /** Add a static system prompt section. */
  promptSection(section: PromptSection): void
  /** Register a hook interceptor. */
  on<K extends keyof SimpleHookHandlers>(key: K, handler: SimpleHookHandlers[K]): void
  /** Register a startup hook (runs during setup). Multiple calls compose in order. */
  onStartup(fn: () => void | Promise<void>): void
  /** Register a shutdown hook (runs on scope close). Multiple calls compose in order. */
  onShutdown(fn: () => void | Promise<void>): void
  /** Register stateful extension via reducer. One call per extension. */
  state<S>(config: SimpleStateConfig<S>): void
}

class SimpleToolError extends Data.TaggedError("@gent/core/src/extensions/api/SimpleToolError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

// ── Schema Conversion ──

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

// ── Convert SimpleToolDef → AnyToolDefinition ──

const convertTool = (def: SimpleToolDef): AnyToolDefinition =>
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

// ── Convert SimpleAgentDef → AgentDefinition ──

const convertAgent = (def: SimpleAgentDef): AgentDefinition =>
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

// ── Wrap Promise handler into Effect interceptor ──

class SimpleHookError extends Data.TaggedError("@gent/core/src/extensions/api/SimpleHookError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

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

// ── Convert SimpleEffect to ExtensionEffect ──

const convertEffect = (effect: SimpleEffect): ExtensionEffect => {
  switch (effect.type) {
    case "queue-follow-up":
      return { _tag: "QueueFollowUp", content: effect.content }
  }
}

// ── Public API ──

/** Setup context passed to the factory function. */
export interface SimpleExtensionContext {
  readonly cwd: string
  readonly source: string
}

/**
 * Create an extension using a simple imperative API.
 * No Effect or Schema knowledge required.
 *
 * Factory runs at setup time (not import time), receives setup context.
 *
 * @param id Extension identifier
 * @param factory Builder function — call methods on `ext` to register contributions
 * @returns A GentExtension compatible with the extension loader
 */
export const simpleExtension = (
  id: string,
  factory: (ext: ExtensionBuilder, ctx: SimpleExtensionContext) => void | Promise<void>,
): GentExtension =>
  defineExtension({
    manifest: { id },
    setup: (ctx) =>
      Effect.gen(function* () {
        const tools: AnyToolDefinition[] = []
        const agents: AgentDefinition[] = []
        const promptSections: PromptSection[] = []
        const interceptors: ExtensionInterceptorDescriptor[] = []
        const startupFns: Array<() => void | Promise<void>> = []
        const shutdownFns: Array<() => void | Promise<void>> = []
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let stateConfig: SimpleStateConfig<any> | undefined

        const builder: ExtensionBuilder = {
          tool: (def) => tools.push(convertTool(def)),
          agent: (def) => agents.push(convertAgent(def)),
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
              // All other hooks are transform hooks
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

          onStartup: (fn) => startupFns.push(fn),
          onShutdown: (fn) => shutdownFns.push(fn),

          state: (config) => {
            if (stateConfig !== undefined) {
              throw new Error(`simpleExtension "${id}": ext.state() can only be called once`)
            }
            stateConfig = config
          },
        }

        // Run factory (async-capable)
        yield* Effect.tryPromise({
          try: () => Promise.resolve(factory(builder, ctx)),
          catch: (e) => new ExtensionLoadError(id, `Extension factory failed: ${String(e)}`, e),
        })

        // State config → fromReducer
        let spawnActor: ExtensionSetup["spawnActor"]
        let projection: ExtensionSetup["projection"]

        if (stateConfig !== undefined) {
          const sc = stateConfig

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
              return {
                state: result.state,
                effects: result.effects?.map(convertEffect),
              }
            },
            derive: (() => {
              const deriveFn = sc.derive
              if (deriveFn === undefined) return undefined
              return (state: unknown, _deriveCtx: ExtensionDeriveContext): ExtensionProjection => {
                const derived = deriveFn(state as Readonly<typeof sc.initial>)
                return {
                  promptSections: derived.promptSections,
                  toolPolicy: derived.toolPolicy,
                }
              }
            })(),
            stateSchema: sc.persist?.schema,
            persist: sc.persist !== undefined,
          })

          spawnActor = reducerResult.spawnActor
          projection = reducerResult.projection
        }

        return {
          ...(tools.length > 0 ? { tools } : {}),
          ...(agents.length > 0 ? { agents } : {}),
          ...(promptSections.length > 0 ? { promptSections } : {}),
          ...(interceptors.length > 0 ? { hooks: { interceptors } } : {}),
          ...(startupFns.length > 0
            ? {
                onStartup: Effect.forEach(startupFns, (fn) =>
                  Effect.tryPromise({
                    try: () => Promise.resolve(fn()),
                    catch: (e) =>
                      new SimpleHookError({ message: `onStartup: ${String(e)}`, cause: e }),
                  }),
                ).pipe(Effect.orDie, Effect.asVoid),
              }
            : {}),
          ...(shutdownFns.length > 0
            ? {
                onShutdown: Effect.forEach(shutdownFns, (fn) =>
                  Effect.tryPromise({
                    try: () => Promise.resolve(fn()),
                    catch: (e) =>
                      new SimpleHookError({ message: `onShutdown: ${String(e)}`, cause: e }),
                  }),
                ).pipe(Effect.orDie, Effect.asVoid),
              }
            : {}),
          spawnActor,
          projection,
        } satisfies ExtensionSetup
      }),
  })

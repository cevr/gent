/**
 * Fluent extension authoring API.
 *
 * @example
 * ```ts
 * import { extension } from "@gent/core/extensions/api"
 *
 * // Simple — tools, agents, commands
 * export default extension("my-ext", ({ ext }) =>
 *   ext.tools({ name: "greet", description: "Say hello", execute: async (p) => `Hi ${p.name}!` })
 * )
 *
 * // Effect path — hooks, layers, providers
 * export default extension("@gent/my-builtin", ({ ext }) =>
 *   ext
 *     .tools(MyTool)
 *     .on("prompt.system", (input, next) => next(input).pipe(Effect.map(...)))
 *     .actor(MyActor)
 *     .layer(MyService.Live)
 *     .provider(myProvider)
 * )
 * ```
 *
 * @module
 */
import { Effect, Schema, Data, type Layer } from "effect"
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
  type MessageInputInput,
  type ExtensionDeriveContext,
  type AnyExtensionActorDefinition,
  type ExtensionReduceContext,
  type ReduceResult,
  type ExtensionEffect,
  type ProviderContribution,
  type ScheduledJobContribution,
  type CommandContribution,
  type ExtensionSetupContext,
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
import { toExtensionContext, type ExtensionContext } from "../domain/extension-context.js"
import { type AgentDefinition, AgentDefinitionBrand, defineAgent } from "../domain/agent.js"
import type { PromptSection, PromptSectionInput, DynamicPromptSection } from "../domain/prompt.js"
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
  type CommandContribution,
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
  type MessageInputInput,
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
export type { PromptSection, PromptSectionInput, DynamicPromptSection } from "../domain/prompt.js"
export type { AgentEvent } from "../domain/event.js"
export type { ExtensionStorage } from "../runtime/extensions/extension-storage.js"
export { type ExtensionContext, toExtensionContext } from "../domain/extension-context.js"

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

// ── Async Hook Types (used by ext.async.on()) ──

type AsyncTransformHandler<I, O> = (
  input: I,
  next: (input: I) => Promise<O>,
  ctx: ExtensionContext,
) => O | Promise<O>
type AsyncFireAndForgetHandler<I> = (
  input: I,
  next: (input: I) => Promise<void>,
  ctx: ExtensionContext,
) => void | Promise<void>

interface AsyncHookHandlers {
  readonly "prompt.system": AsyncTransformHandler<SystemPromptInput, string>
  readonly "tool.execute": AsyncTransformHandler<ToolExecuteInput, unknown>
  readonly "permission.check": AsyncTransformHandler<PermissionCheckInput, PermissionResult>
  readonly "context.messages": AsyncTransformHandler<ContextMessagesInput, ReadonlyArray<Message>>
  readonly "turn.after": AsyncFireAndForgetHandler<TurnAfterInput>
  readonly "tool.result": AsyncTransformHandler<ToolResultInput, unknown>
  readonly "message.input": AsyncTransformHandler<MessageInputInput, string>
}

// ── Actor Result ──

// ── Extension Builder ──

/** Opaque brand carried by all builder chain results. Used as the factory return type
 *  so that `Omit<ExtensionBuilder<P>, ...>` is assignable to it. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface ExtensionBuilderResult<_Provides = never> {}

export interface ExtensionBuilder<Provides = never> extends ExtensionBuilderResult<Provides> {
  // ── Registration (single-call, variadic where applicable) ──

  /** Register tools. Accepts SimpleToolDef or full AnyToolDefinition. Single call. */
  tools(
    ...defs: ReadonlyArray<SimpleToolDef | AnyToolDefinition>
  ): Omit<ExtensionBuilder<Provides>, "tools">
  /** Register agents. Accepts SimpleAgentDef or full AgentDefinition. Single call. */
  agents(
    ...defs: ReadonlyArray<SimpleAgentDef | AgentDefinition>
  ): Omit<ExtensionBuilder<Provides>, "agents">
  /** Register a slash command. Multiple calls ok. */
  command(
    name: string,
    options: {
      description?: string
      handler: (args: string, ctx: ExtensionContext) => void | Promise<void>
    },
  ): ExtensionBuilder<Provides>
  /** Register prompt sections. Static or dynamic. Single call.
   *  Dynamic sections' R is constrained to Provides — services must come from .layer(). */
  promptSections(
    ...sections: ReadonlyArray<PromptSection | DynamicPromptSection<Provides>>
  ): Omit<ExtensionBuilder<Provides>, "promptSections">
  /** Register an Effect-native interceptor hook. Multiple calls ok. */
  on<K extends ExtensionInterceptorKey>(
    key: K,
    handler: ExtensionInterceptorMap[K],
  ): ExtensionBuilder<Provides>
  /** Execute a shell command. Returns stdout, stderr, and exitCode. */
  exec(
    command: string,
    args?: ReadonlyArray<string>,
    options?: { cwd?: string },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>
  /** Register a startup hook. Multiple calls compose in order. */
  onStartup(fn: () => void | Promise<void>): ExtensionBuilder<Provides>
  /** Register a shutdown hook. Multiple calls compose in order. */
  onShutdown(fn: () => void | Promise<void>): ExtensionBuilder<Provides>

  // ── Imperative side effects (usable from ext.async.on() handlers) ──

  /** Send a follow-up message after the current turn completes. */
  sendMessage(content: string, metadata?: MessageMetadata): void
  /** Inject a user message mid-turn (interrupts the current turn). */
  sendUserMessage(content: string): void
  /** @deprecated Use sendMessage() instead. */
  queueFollowUp(content: string, metadata?: MessageMetadata): void
  /** @deprecated Use sendUserMessage() instead. */
  interject(content: string): void
  /** Publish a message to the event bus. */
  busEmit(channel: string, payload: unknown): void
  /** Send a command message to another extension's actor (fire-and-forget). */
  send(message: AnyExtensionCommandMessage): void

  /** File-backed key-value storage, namespaced by extension ID. */
  readonly storage: ExtensionStorage

  // ── Full-power path (Effect-aware) ──

  /** Register a stateful actor. Single call. */
  actor(actor: AnyExtensionActorDefinition): Omit<ExtensionBuilder<Provides>, "actor">
  /** Provide a service Layer. Single call — compose with Layer.merge before passing. Widens Provides.
   *  Layers with unsatisfied requirements (R) are accepted — the runtime provides them (e.g. SqlClient). */
  layer<A, R>(layer: Layer.Layer<A, never, R>): Omit<ExtensionBuilder<Provides | A>, "layer">
  /** Register an AI model provider. Single call. */
  provider(provider: ProviderContribution): Omit<ExtensionBuilder<Provides>, "provider">
  /** Register durable host-owned scheduled jobs. Single call. */
  jobs(...jobs: ReadonlyArray<ScheduledJobContribution>): Omit<ExtensionBuilder<Provides>, "jobs">
  /** Register an Effect-based startup hook. Composes with onStartup(). */
  onStartupEffect(effect: Effect.Effect<void>): ExtensionBuilder<Provides>
  /** Register an Effect-based shutdown hook. Composes with onShutdown(). */
  onShutdownEffect(effect: Effect.Effect<void>): ExtensionBuilder<Provides>
  /** Subscribe to a bus channel. Multiple calls ok. */
  bus(
    pattern: string,
    handler: (envelope: {
      channel: string
      payload: unknown
      sessionId?: string
      branchId?: string
    }) => void | Promise<void> | Effect.Effect<void>,
  ): ExtensionBuilder<Provides>

  // ── Async surface (Promise-based handlers with ExtensionContext) ──

  /** Promise-based counterpart to Effect-native methods. */
  readonly async: AsyncExtensionBuilder
}

export interface AsyncExtensionBuilder {
  /** Register an async interceptor hook. Handler receives ExtensionContext (Promise-based). */
  on<K extends keyof AsyncHookHandlers>(key: K, handler: AsyncHookHandlers[K]): void
  /** Register a slash command. Handler receives ExtensionContext (Promise-based). */
  command(
    name: string,
    options: {
      description?: string
      handler: (args: string, ctx: ExtensionContext) => void | Promise<void>
    },
  ): void
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
  "message.input",
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
    handler: AsyncTransformHandler<I, O>,
    hookKey: string,
    effectBinder: EffectBinder,
  ): ((
    input: I,
    next: (input: I) => Effect.Effect<O>,
    ctx: ExtensionHostContext,
  ) => Effect.Effect<O>) =>
  (input, next, ctx) => {
    const effects: ExtensionEffect[] = []
    effectBinder.bind(effects, hookKey)
    return Effect.tryPromise({
      try: () => {
        const effectNext = (i: I) => Effect.runPromise(next(i))
        return Promise.resolve(handler(input, effectNext, toExtensionContext(ctx)))
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
    handler: AsyncFireAndForgetHandler<I>,
    hookKey: string,
    effectBinder: EffectBinder,
  ): ((
    input: I,
    next: (input: I) => Effect.Effect<void>,
    ctx: ExtensionHostContext,
  ) => Effect.Effect<void>) =>
  (input, next, ctx) =>
    Effect.gen(function* () {
      const effects: ExtensionEffect[] = []
      effectBinder.bind(effects, hookKey)
      // Bridge Effect→Promise for async handler — intentional runPromise inside Effect
      // @effect-diagnostics-next-line runEffectInsideEffect:off
      yield* Effect.tryPromise({
        try: () => {
          const effectNext = (i: I) => Effect.runPromise(next(i))
          return Promise.resolve(handler(input, effectNext, toExtensionContext(ctx)))
        },
        catch: (e) => new SimpleHookError({ message: String(e), cause: e }),
      }).pipe(Effect.orDie, Effect.ensuring(Effect.sync(() => effectBinder.unbind())))
      yield* drainEffects(effects, hookKey, input)
    })

// ── Public API ──

// ExtensionSetupContext re-exported from domain — single source of truth
export type { ExtensionSetupContext } from "../domain/extension.js"

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
 * The callback receives `{ ext, ctx }` and must return the builder (for fluent chaining).
 * Sync factories work — async/Promise is optional.
 *
 * @example
 * ```ts
 * // Simple
 * export const MyExt = extension("my-ext", ({ ext }) =>
 *   ext.tools(MyTool, OtherTool)
 * )
 *
 * // With layer + dynamic prompt section (Provides tracking)
 * export const MyExt = extension("my-ext", ({ ext, ctx }) =>
 *   ext
 *     .layer(MyService.Live)
 *     .tools(MyTool)
 *     .promptSections({ id: "x", priority: 80, resolve: Effect.gen(...) })
 * )
 * ```
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const extension = <P = never>(
  id: string,
  factory: (args: {
    ext: ExtensionBuilder<never>
    ctx: ExtensionSetupContext
  }) => ExtensionBuilderResult<P> | Promise<ExtensionBuilderResult<P>>,
): GentExtension => ({
  manifest: { id },
  setup: (ctx) =>
    Effect.gen(function* () {
      let _tools: AnyToolDefinition[] | undefined
      let _agents: AgentDefinition[] | undefined
      const _commands: CommandContribution[] = []
      let _promptSections: PromptSectionInput[] | undefined
      const _interceptors: ExtensionInterceptorDescriptor[] = []
      const _startupFns: Array<() => void | Promise<void>> = []
      const _shutdownFns: Array<() => void | Promise<void>> = []
      const _startupEffects: Array<Effect.Effect<void>> = []
      const _shutdownEffects: Array<Effect.Effect<void>> = []
      let _provider: ProviderContribution | undefined
      let _jobs: ScheduledJobContribution[] | undefined
      const _busSubscriptions: BusSubscriptionEntry[] = []
      let _layer: Layer.Layer<never, never, object> | undefined
      let _actorResult: AnyExtensionActorDefinition | undefined

      const guardSingle = (name: string, current: unknown) => {
        if (current !== undefined) {
          throw new Error(`extension "${id}": ${name}() can only be called once`)
        }
      }

      // Stack-based effect buffer for imperative side effects.
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

      const pushEffect = (caller: string, effect: ExtensionEffect) => {
        const top = effectStack[effectStack.length - 1]
        if (top === undefined) {
          throw new Error(
            `ext.${caller}() called outside of a hook handler. ` +
              `Use it inside ext.on("turn.after", ...) or ext.on("tool.execute", ...).`,
          )
        }
        if (!EFFECT_CAPABLE_HOOKS.has(top.hookKey)) {
          throw new Error(
            `ext.${caller}() is not available in "${top.hookKey}" handlers. ` +
              `Use it in turn.after, tool.execute, tool.result, or context.messages handlers.`,
          )
        }
        top.effects.push(effect)
      }

      const registerCommand = (
        name: string,
        options: {
          description?: string
          handler: (args: string, ctx: ExtensionContext) => void | Promise<void>
        },
      ) => _commands.push({ name, description: options.description, handler: options.handler })

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const builder: ExtensionBuilder<any> = {
        storage: extensionStorage,

        tools: (...defs) => {
          guardSingle("tools", _tools)
          _tools = []
          for (const def of defs) {
            if (isFullToolDef(def)) {
              _tools.push(def)
            } else {
              _tools.push(convertSimpleTool(def as SimpleToolDef))
            }
          }
          return builder
        },

        agents: (...defs) => {
          guardSingle("agents", _agents)
          _agents = []
          for (const def of defs) {
            if (AgentDefinitionBrand in def || "_tag" in def) {
              _agents.push(def as AgentDefinition)
            } else {
              _agents.push(convertSimpleAgent(def as SimpleAgentDef))
            }
          }
          return builder
        },

        command: (name, options) => {
          registerCommand(name, options)
          return builder
        },

        promptSections: (...sections) => {
          guardSingle("promptSections", _promptSections)
          _promptSections = sections.map((s) => s as PromptSectionInput)
          return builder
        },

        on: (<K extends ExtensionInterceptorKey>(key: K, handler: ExtensionInterceptorMap[K]) => {
          _interceptors.push(defineInterceptor(key, handler as never))
          return builder
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }) as any,

        sendMessage: (content, metadata?) => {
          pushEffect("sendMessage", { _tag: "QueueFollowUp", content, metadata })
        },
        sendUserMessage: (content) => {
          pushEffect("sendUserMessage", { _tag: "Interject", content })
        },
        queueFollowUp: (content, metadata?) => {
          pushEffect("queueFollowUp", { _tag: "QueueFollowUp", content, metadata })
        },
        interject: (content) => {
          pushEffect("interject", { _tag: "Interject", content })
        },

        busEmit: (channel, payload) => {
          pushEffect("busEmit", { _tag: "BusEmit", channel, payload })
        },
        send: (message) => {
          pushEffect("send", { _tag: "Send", message })
        },

        exec: async (command, args, options) => {
          const proc = Bun.spawn([command, ...(args ?? [])], {
            cwd: options?.cwd ?? ctx.cwd,
            stdout: "pipe",
            stderr: "pipe",
          })
          const [stdout, stderr] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
          ])
          const exitCode = await proc.exited
          return { stdout, stderr, exitCode }
        },

        onStartup: (fn) => {
          _startupFns.push(fn)
          return builder
        },
        onShutdown: (fn) => {
          _shutdownFns.push(fn)
          return builder
        },

        // Full-power methods

        actor: (actor) => {
          guardSingle("actor", _actorResult)
          _actorResult = actor
          return builder
        },

        layer: (l) => {
          guardSingle("layer", _layer)
          _layer = l as Layer.Layer<never, never, object>
          return builder
        },
        provider: (p) => {
          guardSingle("provider", _provider)
          _provider = p
          return builder
        },
        jobs: (...entries) => {
          guardSingle("jobs", _jobs)
          _jobs = [...entries]
          return builder
        },
        onStartupEffect: (e) => {
          _startupEffects.push(e)
          return builder
        },
        onShutdownEffect: (e) => {
          _shutdownEffects.push(e)
          return builder
        },
        bus: (pattern, handler) => {
          _busSubscriptions.push({ pattern, handler })
          return builder
        },
        async: {
          on: ((key: keyof AsyncHookHandlers, handler: AsyncHookHandlers[typeof key]) => {
            if (key === "turn.after") {
              _interceptors.push(
                defineInterceptor(
                  key,
                  wrapFireAndForgetHandler(
                    handler as AsyncFireAndForgetHandler<TurnAfterInput>,
                    key,
                    effectBinder,
                  ),
                ),
              )
            } else {
              _interceptors.push(
                defineInterceptor(
                  key,
                  wrapTransformHandler(
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    handler as AsyncTransformHandler<any, any>,
                    key,
                    effectBinder,
                  ) as never,
                ),
              )
            }
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          }) as any,
          command: (name, options) => registerCommand(name, options),
        },
      }

      // Run factory — sync factories stay sync (no Promise.resolve tick)
      const factoryResult = Effect.try({
        try: () => factory({ ext: builder as ExtensionBuilder<never>, ctx }),
        catch: (e) => new ExtensionLoadError(id, `Extension factory failed: ${String(e)}`, e),
      })
      const result = yield* factoryResult
      // If factory returned a Promise, await it
      if (result !== undefined && typeof (result as Promise<unknown>).then === "function") {
        yield* Effect.tryPromise({
          try: () => result as Promise<unknown>,
          catch: (e) => new ExtensionLoadError(id, `Extension factory failed: ${String(e)}`, e),
        })
      }

      const onStartup = mergeStartupHooks(_startupFns, _startupEffects)
      const onShutdown = mergeShutdownHooks(_shutdownFns, _shutdownEffects)
      return {
        ...(_tools !== undefined && _tools.length > 0 ? { tools: _tools } : {}),
        ...(_agents !== undefined && _agents.length > 0 ? { agents: _agents } : {}),
        ...(_commands.length > 0 ? { commands: _commands } : {}),
        ...(_promptSections !== undefined && _promptSections.length > 0
          ? { promptSections: _promptSections }
          : {}),
        ...(_interceptors.length > 0 ? { hooks: { interceptors: _interceptors } } : {}),
        ...(_layer !== undefined ? { layer: _layer } : {}),
        ...(_provider !== undefined ? { providers: [_provider] } : {}),
        ...(_jobs !== undefined && _jobs.length > 0 ? { jobs: _jobs } : {}),
        ...(_busSubscriptions.length > 0 ? { busSubscriptions: _busSubscriptions } : {}),
        ...(_actorResult !== undefined ? { actor: _actorResult } : {}),
        onStartup,
        onShutdown,
      } satisfies ExtensionSetup
    }),
})

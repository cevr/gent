/**
 * Fluent extension authoring API.
 *
 * Effect-native end-to-end: every contribution returns Effect. There are no Promise
 * edges in the contribution surface — gent is a library used inside Effect programs.
 *
 * @example
 * ```ts
 * import { Effect } from "effect"
 * import { extension } from "@gent/core/extensions/api"
 *
 * export default extension("my-ext", ({ ext }) =>
 *   ext
 *     .tools({
 *       name: "greet",
 *       description: "Say hello",
 *       execute: (p) => Effect.succeed(`Hi ${p.name}!`),
 *     })
 *     .on("prompt.system", (input, next) =>
 *       next(input).pipe(Effect.map((s) => s + "\n-- house rule")),
 *     )
 *     .actor(MyActor)
 *     .layer(MyService.Live)
 *     .provider(myProvider)
 * )
 * ```
 *
 * @module
 */
import { Data, Effect, Schema, type Layer } from "effect"
import {
  defineInterceptor,
  ExtensionLoadError,
  type GentExtension,
  type ExtensionSetup,
  type ExtensionInterceptorDescriptor,
  type ExtensionInterceptorKey,
  type ExtensionInterceptorMap,
  type AnyExtensionActorDefinition,
  type ProviderContribution,
  type ScheduledJobContribution,
  type CommandContribution,
  type ExtensionSetupContext,
} from "../domain/extension.js"
import {
  defineTool,
  ToolDefinitionBrand,
  type ToolContext,
  type AnyToolDefinition,
} from "../domain/tool.js"
import type { ExtensionHostContext } from "../domain/extension-host-context.js"
import type { TurnExecutorContribution } from "../domain/turn-executor.js"
import { type AgentDefinition, AgentDefinitionBrand, defineAgent } from "../domain/agent.js"
import type { PromptSection, PromptSectionInput, DynamicPromptSection } from "../domain/prompt.js"
import type { AgentEvent } from "../domain/event.js"
import { ModelId } from "../domain/model.js"
import type { PermissionRule } from "../domain/permission.js"
import {
  createExtensionStorage,
  type ExtensionStorage,
} from "../runtime/extensions/extension-storage.js"

// ── Re-exports for full-power extension authors ──

export {
  defineTool,
  ToolDefinitionBrand,
  type AnyToolDefinition,
  type ToolContext,
} from "../domain/tool.js"
export {
  defineAgent,
  AgentDefinition,
  AgentDefinitionBrand,
  AgentName,
  DEFAULT_AGENT_NAME,
  ModelExecution,
  ExternalExecution,
  AgentExecution,
  AUDITOR_PROMPT,
  LIBRARIAN_PROMPT,
  ARCHITECT_PROMPT,
  COWORK_PROMPT,
  DEEPWORK_PROMPT,
  EXPLORE_PROMPT,
  SUMMARIZER_PROMPT,
  getDurableAgentRunSessionId,
  AgentRunError,
  type AgentRunResult,
} from "../domain/agent.js"
export {
  defineInterceptor,
  type ExtensionInterceptorDescriptor,
  type ExtensionInterceptorKey,
  type ExtensionInterceptorMap,
  type ExtensionActorDefinition,
  type AnyExtensionActorDefinition,
  type TurnProjection,
  type ProviderAuthInfo,
  type ProviderHints,
  type ProviderContribution,
  type ScheduledJobContribution,
  type CommandContribution,
  type ExtensionEffect,
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
export type {
  TurnExecutor,
  TurnExecutorContribution,
  TurnContext,
  TurnEvent,
} from "../domain/turn-executor.js"
export {
  TurnError,
  TextDelta,
  ReasoningDelta,
  ToolStarted,
  ToolCompleted,
  ToolFailed,
  Finished as TurnFinished,
  TurnEventUsage,
} from "../domain/turn-executor.js"
export {
  AgentEvent,
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
export type { ExtensionStorage } from "../runtime/extensions/extension-storage.js"
export { SessionId, BranchId, TaskId, ArtifactId, MessageId, ToolCallId } from "../domain/ids.js"
export { ModelId } from "../domain/model.js"
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
export type { ExtensionHostContext } from "../domain/extension-host-context.js"
export { isRecord, isRecordArray } from "../domain/guards.js"
export { EventPublisher } from "../domain/event-publisher.js"
export { FileIndex } from "../domain/file-index.js"
export { FileLockService } from "../domain/file-lock.js"
export {
  defineExtensionPackage,
  type ExtensionPackage,
  type ExtensionInput,
} from "../domain/extension-package.js"
export type { ProviderResolution } from "../domain/provider-contribution.js"
export { buildToolJsonSchema, flattenAllOf } from "../domain/tool-schema.js"
export { ProviderAuthError } from "../providers/provider-auth.js"
export { ToolRunner, type ToolRunnerService } from "../runtime/agent/tool-runner.js"

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
  readonly parameters?: SimpleParams
  readonly concurrency?: "serial" | "parallel"
  readonly idempotent?: boolean
  readonly interactive?: boolean
  readonly promptSnippet?: string
  readonly promptGuidelines?: ReadonlyArray<string>
  readonly execute: (params: Record<string, unknown>, ctx: ToolContext) => Effect.Effect<unknown>
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

// ── Errors ──

export class ExecError extends Data.TaggedError("@gent/core/src/extensions/api/ExecError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

export interface ExecResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
  readonly timedOut: boolean
}

// ── Internal Helpers ──

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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-type-assertion
    return Schema.Struct({}) as unknown as Schema.Decoder<any, never>
  }
  const fields: Record<string, Schema.Schema<unknown>> = {}
  for (const [key, param] of Object.entries(params)) {
    const base = schemaTypeMap[param.type] ?? Schema.Unknown
    fields[key] = param.optional === true ? Schema.optional(base) : base
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-type-assertion
  return Schema.Struct(fields) as unknown as Schema.Decoder<any, never>
}

const convertSimpleTool = (def: SimpleToolDef): AnyToolDefinition =>
  defineTool({
    name: def.name,
    description: def.description,
    params: buildParamsSchema(def.parameters),
    concurrency: def.concurrency,
    idempotent: def.idempotent,
    interactive: def.interactive,
    promptSnippet: def.promptSnippet,
    promptGuidelines: def.promptGuidelines,
    execute: (params: Record<string, unknown>, ctx: ToolContext) => def.execute(params, ctx),
  }) as AnyToolDefinition

const convertSimpleAgent = (def: SimpleAgentDef): AgentDefinition =>
  defineAgent({
    name: def.name,
    model: ModelId.of(def.model),
    systemPromptAddendum: def.systemPromptAddendum,
    description: def.description,
    allowedTools: def.allowedTools,
    deniedTools: def.deniedTools,
    temperature: def.temperature,
  })

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
  /** Register a slash command. Multiple calls ok. Handler returns Effect. */
  command(
    name: string,
    options: {
      description?: string
      handler: (args: string, ctx: ExtensionHostContext) => Effect.Effect<void>
    },
  ): ExtensionBuilder<Provides>
  /** Register prompt sections. Static or dynamic. Single call.
   *  Dynamic sections' R is constrained to Provides — services must come from .layer(). */
  promptSections(
    ...sections: ReadonlyArray<PromptSection | DynamicPromptSection<Provides>>
  ): Omit<ExtensionBuilder<Provides>, "promptSections">
  /** Register permission deny/allow rules. Single call. */
  permissionRules(
    ...rules: ReadonlyArray<PermissionRule>
  ): Omit<ExtensionBuilder<Provides>, "permissionRules">
  /** Register a turn executor for external agent dispatch. Multiple calls ok. */
  turnExecutor(
    id: string,
    executor: TurnExecutorContribution["executor"],
  ): ExtensionBuilder<Provides>
  /** Register an Effect-native interceptor hook. Multiple calls ok. */
  on<K extends ExtensionInterceptorKey>(
    key: K,
    handler: ExtensionInterceptorMap[K],
  ): ExtensionBuilder<Provides>
  /** Spawn a shell command at setup time. Returns Effect. For runtime exec during turns,
   *  use the bash tool instead. */
  exec(
    command: string,
    args?: ReadonlyArray<string>,
    options?: { cwd?: string; timeout?: number },
  ): Effect.Effect<ExecResult, ExecError>
  /** Register a startup hook. Effect-only. Multiple calls compose in order. */
  onStartup(effect: Effect.Effect<void>): ExtensionBuilder<Provides>
  /** Register a shutdown hook. Effect-only. Multiple calls compose in order. */
  onShutdown(effect: Effect.Effect<void>): ExtensionBuilder<Provides>

  /** File-backed key-value storage, namespaced by extension ID.
   *  All methods return Effect — pipe the result, don't await. */
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
  /** Subscribe to a bus channel. Effect-only handler. Multiple calls ok. */
  bus(
    pattern: string,
    handler: (envelope: {
      channel: string
      payload: unknown
      sessionId?: string
      branchId?: string
    }) => Effect.Effect<void>,
  ): ExtensionBuilder<Provides>
}

// ── Public API ──

// ExtensionSetupContext re-exported from domain — single source of truth
export type { ExtensionSetupContext } from "../domain/extension.js"

type BusSubscriptionEntry = NonNullable<ExtensionSetup["busSubscriptions"]>[number]

/** Merge startup effects in registration order. */
const mergeEffectHooks = (
  effects: ReadonlyArray<Effect.Effect<void>>,
): Effect.Effect<void> | undefined =>
  effects.length === 0 ? undefined : Effect.all(effects, { discard: true }).pipe(Effect.asVoid)

/** Effect-native shell exec via Bun.spawn. Used by `ext.exec()` at setup time. */
const execEffect = (
  command: string,
  args: ReadonlyArray<string> | undefined,
  options: { cwd?: string; timeout?: number } | undefined,
  defaultCwd: string,
): Effect.Effect<ExecResult, ExecError> =>
  Effect.tryPromise({
    try: async () => {
      const timeoutMs = options?.timeout ?? 30_000
      const proc = Bun.spawn([command, ...(args ?? [])], {
        cwd: options?.cwd ?? defaultCwd,
        stdout: "pipe",
        stderr: "pipe",
      })

      let timer: ReturnType<typeof setTimeout> | undefined

      const completion = (async () => {
        const [stdout, stderr] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ])
        const exitCode = await proc.exited
        if (timer !== undefined) clearTimeout(timer)
        return { stdout, stderr, exitCode, timedOut: false as const }
      })()

      const deadline = new Promise<ExecResult>((resolve) => {
        timer = setTimeout(() => {
          try {
            process.kill(-proc.pid, "SIGTERM")
          } catch {
            // already dead
          }
          setTimeout(() => {
            try {
              process.kill(-proc.pid, 0)
              process.kill(-proc.pid, "SIGKILL")
            } catch {
              // already dead
            }
          }, 3000)
          resolve({ stdout: "", stderr: "", exitCode: -1, timedOut: true })
        }, timeoutMs)
      })

      return Promise.race([completion, deadline])
    },
    catch: (e) => new ExecError({ message: String(e), cause: e }),
  })

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
  }) => ExtensionBuilderResult<P>,
): GentExtension => ({
  manifest: { id },
  setup: (ctx) =>
    Effect.gen(function* () {
      let _tools: AnyToolDefinition[] | undefined
      let _agents: AgentDefinition[] | undefined
      const _commands: CommandContribution[] = []
      let _promptSections: PromptSectionInput[] | undefined
      const _interceptors: ExtensionInterceptorDescriptor[] = []
      const _startupEffects: Array<Effect.Effect<void>> = []
      const _shutdownEffects: Array<Effect.Effect<void>> = []
      let _provider: ProviderContribution | undefined
      let _jobs: ScheduledJobContribution[] | undefined
      let _permissionRules: PermissionRule[] | undefined
      const _busSubscriptions: BusSubscriptionEntry[] = []
      const _turnExecutors: TurnExecutorContribution[] = []
      let _layer: Layer.Layer<never, never, object> | undefined
      let _actorResult: AnyExtensionActorDefinition | undefined

      const guardSingle = (name: string, current: unknown) => {
        if (current !== undefined) {
          throw new Error(`extension "${id}": ${name}() can only be called once`)
        }
      }

      const extensionStorage = createExtensionStorage(
        id,
        `${ctx.home}/.gent/extensions`,
        ctx.fs,
        ctx.path,
      )

      const registerCommand = (
        name: string,
        options: {
          description?: string
          handler: (args: string, ctx: ExtensionHostContext) => Effect.Effect<void>
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
              // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
              _agents.push(def as AgentDefinition)
            } else {
              // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
              _agents.push(convertSimpleAgent(def as SimpleAgentDef))
            }
          }
          return builder
        },

        turnExecutor: (id, executor) => {
          _turnExecutors.push({ id, executor })
          return builder
        },

        command: (name, options) => {
          registerCommand(name, options)
          return builder
        },

        promptSections: (...sections) => {
          guardSingle("promptSections", _promptSections)
          // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
          _promptSections = sections.map((s) => s as PromptSectionInput)
          return builder
        },

        permissionRules: (...rules) => {
          guardSingle("permissionRules", _permissionRules)
          _permissionRules = [...rules]
          return builder
        },

        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        on: (<K extends ExtensionInterceptorKey>(key: K, handler: ExtensionInterceptorMap[K]) => {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
          _interceptors.push(defineInterceptor(key, handler as never))
          return builder
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }) as any,

        exec: (command, args, options) => execEffect(command, args, options, ctx.cwd),

        onStartup: (effect) => {
          _startupEffects.push(effect)
          return builder
        },
        onShutdown: (effect) => {
          _shutdownEffects.push(effect)
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
          // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
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
        bus: (pattern, handler) => {
          _busSubscriptions.push({ pattern, handler })
          return builder
        },
      }

      // Run factory — synchronous; mutations land on the builder
      yield* Effect.try({
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        try: () => factory({ ext: builder as ExtensionBuilder<never>, ctx }),
        catch: (e) => new ExtensionLoadError(id, `Extension factory failed: ${String(e)}`, e),
      })

      const onStartup = mergeEffectHooks(_startupEffects)
      const onShutdown = mergeEffectHooks(_shutdownEffects)
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
        ...(_turnExecutors.length > 0 ? { turnExecutors: _turnExecutors } : {}),
        ...(_jobs !== undefined && _jobs.length > 0 ? { jobs: _jobs } : {}),
        ...(_busSubscriptions.length > 0 ? { busSubscriptions: _busSubscriptions } : {}),
        ...(_actorResult !== undefined ? { actor: _actorResult } : {}),
        ...(_permissionRules !== undefined && _permissionRules.length > 0
          ? { permissionRules: _permissionRules }
          : {}),
        onStartup,
        onShutdown,
      } satisfies ExtensionSetup
    }),
})

/**
 * Imperative extension authoring API.
 *
 * No Effect or Schema knowledge required. Plain objects and async functions.
 *
 * @example
 * ```ts
 * import { simpleExtension } from "@gent/core/extensions/api"
 *
 * export default simpleExtension("my-ext", (ext) => {
 *   ext.tool({
 *     name: "greet",
 *     description: "Say hello",
 *     parameters: { name: { type: "string", description: "Who to greet" } },
 *     execute: async (params) => `Hello, ${params.name}!`,
 *   })
 *
 *   ext.promptSection({
 *     id: "my-context",
 *     content: "Always be friendly.",
 *     priority: 50,
 *   })
 * })
 * ```
 *
 * @module
 */
import { Effect, Schema, Data } from "effect"
import { defineExtension, type GentExtension, type ExtensionSetup } from "../domain/extension.js"
import {
  defineTool,
  type ToolAction,
  type ToolContext,
  type AnyToolDefinition,
} from "../domain/tool.js"
import { defineAgent, type AgentDefinition } from "../domain/agent.js"
import type { PromptSection } from "../domain/prompt.js"

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

// ── Extension Builder ──

export interface ExtensionBuilder {
  /** Register a tool with plain objects — no Schema or Effect needed. */
  tool(def: SimpleToolDef): void
  /** Register an agent definition. */
  agent(def: SimpleAgentDef): void
  /** Add a static system prompt section. */
  promptSection(section: PromptSection): void
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

// ── Public API ──

/**
 * Create an extension using a simple imperative API.
 * No Effect or Schema knowledge required.
 *
 * @param id Extension identifier
 * @param factory Builder function — call `ext.tool()`, `ext.agent()`, `ext.promptSection()`
 * @returns A GentExtension compatible with the extension loader
 */
export const simpleExtension = (
  id: string,
  factory: (ext: ExtensionBuilder) => void,
): GentExtension => {
  const tools: AnyToolDefinition[] = []
  const agents: AgentDefinition[] = []
  const promptSections: PromptSection[] = []

  const builder: ExtensionBuilder = {
    tool: (def) => tools.push(convertTool(def)),
    agent: (def) => agents.push(convertAgent(def)),
    promptSection: (section) => promptSections.push(section),
  }

  factory(builder)

  const setup: ExtensionSetup = {
    ...(tools.length > 0 ? { tools } : {}),
    ...(agents.length > 0 ? { agents } : {}),
    ...(promptSections.length > 0 ? { promptSections } : {}),
  }

  return defineExtension({
    manifest: { id },
    setup: () => Effect.succeed(setup),
  })
}

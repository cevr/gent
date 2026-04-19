/**
 * PipelineContribution — transforming middleware with `next`.
 *
 * Six hooks where the runtime invokes a chain of contributions, each of which
 * may transform input, transform output, or short-circuit. The handler shape
 * is `(input, next, ctx) => Effect<output>` — `next` actually does work and
 * the return value is meaningful (output type ≠ void).
 *
 * Sister primitive: `SubscriptionContribution` for void observers (`turn.before`,
 * `turn.after`, `message.output`) where `next` was bookkeeping in the legacy
 * `Interceptor<I, void>` shape. Codex's C6 correction: don't conflate
 * transformers with observers — Pipeline ≠ Subscription.
 *
 * Composition: scope-ordered (builtin → user → project, then id-stable). The
 * highest-precedence pipeline contribution wraps the lower-precedence ones,
 * so a project-scope Pipeline runs OUTSIDE a user-scope Pipeline runs OUTSIDE
 * a builtin Pipeline. Defects in any handler fall through to the previous
 * `next` with a warning log.
 *
 * @module
 */
import type { Effect } from "effect"
import type {
  ContextMessagesInput,
  MessageInputInput,
  PermissionCheckInput,
  SystemPromptInput,
  ToolExecuteInput,
  ToolResultInput,
} from "./extension.js"
import type { ExtensionHostContext } from "./extension-host-context.js"
import type { Message } from "./message.js"
import type { PermissionResult } from "./permission.js"

/** Map of pipeline-key to (input, output) tuple. The runtime invokes
 *  `runPipeline(key, input, base, ctx)` and gets back `Effect<output>`. */
export interface PipelineMap {
  readonly "prompt.system": { input: SystemPromptInput; output: string }
  readonly "tool.execute": { input: ToolExecuteInput; output: unknown }
  readonly "permission.check": { input: PermissionCheckInput; output: PermissionResult }
  readonly "context.messages": { input: ContextMessagesInput; output: ReadonlyArray<Message> }
  readonly "tool.result": { input: ToolResultInput; output: unknown }
  readonly "message.input": { input: MessageInputInput; output: string }
}

export type PipelineKey = keyof PipelineMap
export type PipelineInput<K extends PipelineKey> = PipelineMap[K]["input"]
export type PipelineOutput<K extends PipelineKey> = PipelineMap[K]["output"]

/** Handler for a single pipeline registration. `next` is the lower-precedence
 *  pipeline (or the runtime `base` at the innermost call). */
export type PipelineHandler<K extends PipelineKey, E = never, R = never> = (
  input: PipelineInput<K>,
  next: (input: PipelineInput<K>) => Effect.Effect<PipelineOutput<K>, E, R>,
  ctx: ExtensionHostContext,
) => Effect.Effect<PipelineOutput<K>, E, R>

export interface PipelineContribution<K extends PipelineKey = PipelineKey, E = never, R = never> {
  readonly hook: K
  readonly handler: PipelineHandler<K, E, R>
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyPipelineContribution = PipelineContribution<PipelineKey, any, any>

/** Smart constructor for a `PipelineContribution` — keeps `K` inferred so the
 *  handler signature is type-checked at the authoring site. */
export const definePipeline = <K extends PipelineKey, E = never, R = never>(
  hook: K,
  handler: PipelineHandler<K, E, R>,
): PipelineContribution<K, E, R> => ({ hook, handler })

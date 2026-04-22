/**
 * ProjectionContribution — derive read-only views of services on demand
 * for agent-loop concerns (system prompt sections, tool policy fragments).
 *
 * UI is NOT a projection surface. Client widgets fetch state via the
 * extension's typed `client.extension.request(...)` and refetch on
 * `ExtensionStateChanged` pulses. The privileged out-of-band UI snapshot
 * channel (`ExtensionUiSnapshot`, `Projection.ui`, `ctx.getSnapshot`) is gone.
 *
 * A projection:
 *   1. Has a `query` Effect that reads from services and produces a value `A`.
 *      Read-only by structural type fence: `R extends ReadOnlyTag` blocks
 *      write-capable service Tags at compile time (B11.4). See
 *      `domain/read-only.ts` and the per-service read-only Tags
 *      (`MachineExecute`, `TaskStorageReadOnly`, `MemoryVaultReadOnly`,
 *      `InteractionPendingReader`, `Skills`).
 *   2. Optionally exposes the projected value through:
 *      - `prompt` — additional `PromptSection`s injected into the system prompt
 *      - `policy` — `ToolPolicyFragment` shaping the active tool set
 *      - `systemPrompt` — explicit system-prompt rewrite slot
 *      - `contextMessages` — explicit context-message rewrite slot
 *   3. Is evaluated on demand by `ProjectionRegistry.evaluateTurn(ctx)`
 *      during prompt assembly. There is no per-event reducer.
 *
 * @module
 */
import { Schema, type Effect } from "effect"
import type {
  ContextMessagesInput,
  ExtensionTurnContext,
  SystemPromptInput,
  ToolPolicyFragment,
} from "./extension.js"
import type { BranchId, SessionId } from "./ids.js"
import type { Message } from "./message.js"
import type { PromptSection } from "./prompt.js"
import type { ReadOnlyTag } from "./read-only.js"

/** Failure raised by a projection query. Carries projection id + cause for diagnostics. */
export class ProjectionError extends Schema.TaggedErrorClass<ProjectionError>()("ProjectionError", {
  projectionId: Schema.String,
  reason: Schema.String,
}) {}

/** Turn context — `turn` is required. Used by `evaluateTurn` during prompt
 *  assembly when prompt sections / tool policy are derived from projections. */
export interface ProjectionTurnContext {
  readonly sessionId: SessionId
  readonly branchId?: BranchId
  /** Process working directory (host cwd). */
  readonly cwd: string
  /** User home directory. */
  readonly home: string
  /** Session-scoped working directory, if the session was opened in a specific cwd. */
  readonly sessionCwd?: string
  readonly turn: ExtensionTurnContext
}

/** Context handed to a projection's `query` Effect.
 *
 *  Read-only by design — no mutation/control surfaces here. If a projection
 *  needs to mutate state, author a write-intent `request(...)` capability instead.
 */
export type ProjectionContext = ProjectionTurnContext

/**
 * A pure derivation of a value from services, surfaced into the agent loop
 * as prompt sections and/or tool policy. UI is the client's concern.
 *
 * The `R` channel is type-fenced: every service Tag yielded by `query` must
 * carry the `ReadOnly` brand (`ReadOnlyTag`). Write-capable Tags fail to
 * compile in this position. See `domain/read-only.ts` for the brand and
 * the per-service read-only Tags introduced in B11.4 (`MachineExecute`,
 * `TaskStorageReadOnly`, `MemoryVaultReadOnly`, `InteractionPendingReader`,
 * `Skills`).
 */
export interface ProjectionContribution<A = unknown, R extends ReadOnlyTag = never> {
  /** Stable id (extension-local). Used for keying, logging, and dedupe. */
  readonly id: string

  /**
   * Read-only Effect producing the projected value. The `R` channel must be
   * `ReadOnly`-branded — write capabilities are blocked at the type level.
   *
   * The Effect's requirement `R` is provided by the runtime — typically an
   * extension-contributed service Layer.
   */
  readonly query: (ctx: ProjectionContext) => Effect.Effect<A, ProjectionError, R>

  /** Project the queried value into prompt sections. */
  readonly prompt?: (value: A) => ReadonlyArray<PromptSection>

  /** Project the queried value into a tool policy fragment. */
  readonly policy?: (value: A, ctx: ProjectionContext) => ToolPolicyFragment

  /**
   * Explicit system-prompt rewrite slot.
   *
   * Replaces the generic `"prompt.system"` pipeline for read-only,
   * turn-scoped prompt shaping. The input carries the already-compiled
   * prompt string plus the structured sections used to build it; return the
   * final prompt string the runtime should send.
   */
  readonly systemPrompt?: (
    value: A,
    input: SystemPromptInput,
    ctx: ProjectionTurnContext,
  ) => Effect.Effect<string>

  /**
   * Explicit context-message rewrite slot.
   *
   * Replaces the generic `"context.messages"` pipeline for read-only,
   * turn-scoped context shaping. Return the message list the runtime should
   * send to the driver.
   */
  readonly contextMessages?: (
    value: A,
    input: ContextMessagesInput,
    ctx: ProjectionTurnContext,
  ) => Effect.Effect<ReadonlyArray<Message>>
}

/**
 * Existential projection — the value bucket type used at the
 * `defineExtension` boundary. R is constrained to `ReadOnlyTag` so
 * inline projection literals authored under `defineExtension({
 * projections: [...] })` flow contextually through the read-only
 * fence. Keeping `any` for the value `A` is intentional — `A` is a
 * pure data shape that downstream consumers narrow per call.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyProjectionContribution = ProjectionContribution<any, ReadOnlyTag>

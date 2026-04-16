/**
 * ProjectionContribution — derive read-only views of services on demand.
 *
 * The replacement primitive for "actor mirrors storage state into a snapshot
 * field" patterns (task list, vault index, interaction list). A projection:
 *
 *   1. Has a `query` Effect that reads from services and produces a value `A`.
 *      The query MUST be read-only — enforced structurally by the
 *      `lint/no-projection-writes` rule.
 *
 *   2. Optionally exposes the projected value through three independent surfaces:
 *      - `prompt` — additional `PromptSection`s injected into the system prompt
 *      - `ui`     — UI snapshot model (with optional schema validation)
 *      - `policy` — `ToolPolicyFragment` shaping the active tool set
 *
 *   3. Is evaluated on demand by `ProjectionRegistry.evaluateAll(ctx)` during
 *      prompt assembly / UI snapshot resolution. There is no per-event reducer;
 *      derive-don't-create is the whole point.
 *
 * Subtraction-before-addition: projections collapse the
 *   (actor.mapEvent → actor.snapshot.project → actor.turn.project)
 * triple into a single Effect. The actor pattern remains for genuine workflow
 * state (Commit 8); pure derivations move here.
 *
 * @module
 */
import { Data, type Effect, type Schema } from "effect"
import type { ExtensionTurnContext, ToolPolicyFragment } from "./extension.js"
import type { PromptSection } from "./prompt.js"

/** Failure raised by a projection query. Carries projection id + cause for diagnostics. */
export class ProjectionError extends Data.TaggedError(
  "@gent/core/src/domain/projection/ProjectionError",
)<{
  readonly projectionId: string
  readonly reason: string
}> {}

/** Context handed to a projection's `query` Effect. */
export interface ProjectionContext {
  readonly turn: ExtensionTurnContext
}

/** UI surface — projected value rendered into an extension UI snapshot. */
export interface ProjectionUiSurface<A, U = unknown> {
  /** Optional runtime validation of the projected UI model. */
  readonly schema?: Schema.Schema<U>
  /** Project the queried value into the UI snapshot model. */
  readonly project: (value: A) => U
}

/**
 * A pure derivation of a value from services, optionally surfaced into the
 * agent runtime as prompt sections, UI snapshot, and/or tool policy.
 */
export interface ProjectionContribution<A = unknown, R = never> {
  /** Stable id (extension-local). Used for keying, logging, and dedupe. */
  readonly id: string

  /**
   * Read-only Effect producing the projected value. Must not perform writes
   * (no `.create(`, `.update(`, `.delete(`, `.set(`, `.write(` calls on
   * service interfaces). Enforced by `gent/no-projection-writes` lint rule.
   *
   * The Effect's requirement `R` is provided by the runtime — typically an
   * extension-contributed service Layer.
   */
  readonly query: (ctx: ProjectionContext) => Effect.Effect<A, ProjectionError, R>

  /** Project the queried value into prompt sections. */
  readonly prompt?: (value: A) => ReadonlyArray<PromptSection>

  /** Project the queried value into a UI snapshot model. */
  readonly ui?: ProjectionUiSurface<A>

  /** Project the queried value into a tool policy fragment. */
  readonly policy?: (value: A, ctx: ProjectionContext) => ToolPolicyFragment
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyProjectionContribution = ProjectionContribution<any, any>

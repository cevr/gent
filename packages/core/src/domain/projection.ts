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
 *   3. Is evaluated on demand by `ProjectionRegistry.evaluateUi(ctx)` (event
 *      publisher → SSE → TUI) and `ProjectionRegistry.evaluateTurn(ctx)`
 *      (prompt assembly). There is no per-event reducer; derive-don't-create
 *      is the whole point.
 *
 * Subtraction-before-addition: projections collapse the
 *   (actor.mapEvent → actor.snapshot.project → actor.turn.project)
 * triple into a single Effect. The actor pattern remains for genuine workflow
 * state (Commit 8); pure derivations move here.
 *
 * @module
 */
import { Schema, type Effect } from "effect"
import type { ExtensionTurnContext, ToolPolicyFragment } from "./extension.js"
import type { BranchId, SessionId } from "./ids.js"
import type { PromptSection } from "./prompt.js"

/** Failure raised by a projection query. Carries projection id + cause for diagnostics. */
export class ProjectionError extends Schema.TaggedErrorClass<ProjectionError>()("ProjectionError", {
  projectionId: Schema.String,
  reason: Schema.String,
}) {}

/** Base context — fields common to UI and turn evaluation. Read-only by design. */
interface ProjectionContextBase {
  readonly sessionId: SessionId
  /** Process working directory (host cwd). */
  readonly cwd: string
  /** User home directory. */
  readonly home: string
  /** Session-scoped working directory, if the session was opened in a specific cwd. */
  readonly sessionCwd?: string
}

/** UI-only context — no `turn`. Used by `evaluateUi` for snapshot emission
 *  (event-publisher → SSE → TUI). Projections that depend on `turn` are skipped
 *  structurally during UI evaluation. */
export interface ProjectionUiContext extends ProjectionContextBase {
  readonly branchId: BranchId
  readonly turn?: never
}

/** Turn context — `turn` is required. Used by `evaluateTurn` during prompt
 *  assembly when prompt sections / tool policy are derived from projections. */
export interface ProjectionTurnContext extends ProjectionContextBase {
  readonly branchId?: BranchId
  readonly turn: ExtensionTurnContext
}

/** Context handed to a projection's `query` Effect.
 *
 *  Read-only by design — no mutation/control surfaces here. If a projection
 *  needs `ctx.extension.send`/`ctx.interaction.approve`/etc., it isn't a
 *  projection — it's a workflow or mutation.
 *
 *  Discriminated union: `evaluateUi` provides `ProjectionUiContext` (no
 *  `turn`); `evaluateTurn` provides `ProjectionTurnContext` (`turn` required).
 *  Projections may inspect `ctx.turn` to opt out of UI-only contexts.
 */
export type ProjectionContext = ProjectionUiContext | ProjectionTurnContext

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

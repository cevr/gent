/**
 * ProjectionRegistry — evaluates `ProjectionContribution[]` on demand.
 *
 * Projections are flat; there is no per-event reduction step. `evaluateAll(ctx)`
 * runs every registered projection's `query` Effect, then collects:
 *   - `promptSections`  from `projection.prompt(value)`
 *   - `uiSnapshots`     from `projection.ui.project(value)` (schema-validated)
 *   - `policyFragments` from `projection.policy(value, ctx)`
 *
 * Failure isolation: a failing projection logs and is skipped. Other projections
 * continue. Mirrors the actor pattern's `runSupervised` resilience but without
 * the lifecycle complexity.
 *
 * Scope precedence is provided by the caller — `compileProjections` accepts an
 * already-sorted array and preserves order, so later-scope projections appear
 * later in the result lists.
 *
 * @module
 */
import { Effect, Schema } from "effect"
import { ExtensionUiSnapshot } from "../../domain/event.js"
import type {
  ExtensionTurnContext,
  LoadedExtension,
  ToolPolicyFragment,
} from "../../domain/extension.js"
import type { AnyProjectionContribution, ProjectionContext } from "../../domain/projection.js"
import type { PromptSection } from "../../domain/prompt.js"
import { SCOPE_PRECEDENCE } from "./disabled.js"

interface RegisteredProjection {
  readonly extensionId: string
  readonly projection: AnyProjectionContribution
}

export interface ProjectionEvaluation {
  readonly promptSections: ReadonlyArray<PromptSection>
  readonly policyFragments: ReadonlyArray<ToolPolicyFragment>
  readonly uiSnapshots: ReadonlyArray<ExtensionUiSnapshot>
}

export interface CompiledProjections {
  readonly entries: ReadonlyArray<RegisteredProjection>
  /** Run every projection and collect projected outputs. */
  readonly evaluateAll: (ctx: {
    readonly turn: ExtensionTurnContext
  }) => Effect.Effect<ProjectionEvaluation>
  /** Run a single projection by `extensionId/projectionId` — returns the raw value. */
  readonly query: (
    extensionId: string,
    projectionId: string,
    ctx: { readonly turn: ExtensionTurnContext },
  ) => Effect.Effect<unknown | undefined>
}

const sortedExtensions = (
  extensions: ReadonlyArray<LoadedExtension>,
): ReadonlyArray<LoadedExtension> =>
  [...extensions].sort((a, b) => {
    const scopeDiff = SCOPE_PRECEDENCE[a.kind] - SCOPE_PRECEDENCE[b.kind]
    if (scopeDiff !== 0) return scopeDiff
    return a.manifest.id.localeCompare(b.manifest.id)
  })

const collectProjections = (extensions: ReadonlyArray<LoadedExtension>): RegisteredProjection[] => {
  const entries: RegisteredProjection[] = []
  for (const ext of sortedExtensions(extensions)) {
    for (const projection of ext.setup.projections ?? []) {
      entries.push({ extensionId: ext.manifest.id, projection })
    }
  }
  return entries
}

/** Compile registered projections into an evaluator. */
export const compileProjections = (
  extensions: ReadonlyArray<LoadedExtension>,
): CompiledProjections => {
  const entries = collectProjections(extensions)

  const runOne = (
    entry: RegisteredProjection,
    ctx: ProjectionContext,
  ): Effect.Effect<unknown | undefined> =>
    // @effect-diagnostics-next-line anyUnknownInErrorContext:off — projection R/E erased at registry boundary
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    (entry.projection.query(ctx) as Effect.Effect<unknown, unknown>).pipe(
      Effect.catchEager((error) =>
        Effect.logWarning("extension.projection.query.failed").pipe(
          Effect.annotateLogs({
            extensionId: entry.extensionId,
            projectionId: entry.projection.id,
            error: String(error),
          }),
          Effect.as(undefined),
        ),
      ),
      Effect.catchDefect((defect) =>
        Effect.logWarning("extension.projection.query.defect").pipe(
          Effect.annotateLogs({
            extensionId: entry.extensionId,
            projectionId: entry.projection.id,
            defect: String(defect),
          }),
          Effect.as(undefined),
        ),
      ),
    )

  const evaluateUi = (
    entry: RegisteredProjection,
    value: unknown,
    sessionId: ExtensionTurnContext["sessionId"],
    branchId: ExtensionTurnContext["branchId"],
  ): Effect.Effect<ExtensionUiSnapshot | undefined> =>
    Effect.gen(function* () {
      const ui = entry.projection.ui
      if (ui === undefined) return undefined
      const projectedExit = yield* Effect.exit(Effect.sync(() => ui.project(value)))
      if (projectedExit._tag === "Failure") {
        yield* Effect.logWarning("extension.projection.ui.project.failed").pipe(
          Effect.annotateLogs({
            extensionId: entry.extensionId,
            projectionId: entry.projection.id,
          }),
        )
        return undefined
      }
      let model: unknown = projectedExit.value
      if (ui.schema !== undefined) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        const decoded = yield* Schema.decodeUnknownEffect(ui.schema as Schema.Any)(model).pipe(
          Effect.catchEager(() =>
            Effect.logWarning("extension.projection.ui.schema.failed").pipe(
              Effect.annotateLogs({
                extensionId: entry.extensionId,
                projectionId: entry.projection.id,
              }),
              Effect.as(undefined),
            ),
          ),
        )
        if (decoded === undefined) return undefined
        model = decoded
      }
      return new ExtensionUiSnapshot({
        sessionId,
        branchId,
        extensionId: entry.extensionId,
        epoch: 0,
        model,
      })
    })

  const evaluateAll: CompiledProjections["evaluateAll"] = (ctx) =>
    Effect.gen(function* () {
      const promptSections: PromptSection[] = []
      const policyFragments: ToolPolicyFragment[] = []
      const uiSnapshots: ExtensionUiSnapshot[] = []
      for (const entry of entries) {
        const value = yield* runOne(entry, ctx)
        if (value === undefined) continue
        const promptFn = entry.projection.prompt
        if (promptFn !== undefined) {
          const sectionsExit = yield* Effect.exit(Effect.sync(() => promptFn(value)))
          if (sectionsExit._tag === "Success") {
            promptSections.push(...sectionsExit.value)
          } else {
            yield* Effect.logWarning("extension.projection.prompt.failed").pipe(
              Effect.annotateLogs({
                extensionId: entry.extensionId,
                projectionId: entry.projection.id,
              }),
            )
          }
        }
        const policyFn = entry.projection.policy
        if (policyFn !== undefined) {
          const policyExit = yield* Effect.exit(Effect.sync(() => policyFn(value, ctx)))
          if (policyExit._tag === "Success") {
            policyFragments.push(policyExit.value)
          } else {
            yield* Effect.logWarning("extension.projection.policy.failed").pipe(
              Effect.annotateLogs({
                extensionId: entry.extensionId,
                projectionId: entry.projection.id,
              }),
            )
          }
        }
        const ui = yield* evaluateUi(entry, value, ctx.turn.sessionId, ctx.turn.branchId)
        if (ui !== undefined) uiSnapshots.push(ui)
      }
      return { promptSections, policyFragments, uiSnapshots }
    })

  const query: CompiledProjections["query"] = (extensionId, projectionId, ctx) =>
    Effect.gen(function* () {
      const entry = entries.find(
        (e) => e.extensionId === extensionId && e.projection.id === projectionId,
      )
      if (entry === undefined) return undefined
      return yield* runOne(entry, ctx)
    })

  return { entries, evaluateAll, query }
}

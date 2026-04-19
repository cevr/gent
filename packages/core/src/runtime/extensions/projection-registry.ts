/**
 * ProjectionRegistry — evaluates `ProjectionContribution[]` on demand.
 *
 * Projections are flat; there is no per-event reduction step. The registry
 * exposes one evaluator (`evaluateTurn`) for prompt/policy contributions,
 * plus a `query(extensionId, projectionId, ctx)` for direct lookup.
 *
 * UI projection is gone — client widgets read state via the extension's
 * typed `client.extension.query(...)` and refetch on `ExtensionStateChanged`
 * pulses (see `event-publisher.ts`).
 *
 * Failure isolation: a failing projection logs and is skipped. Other projections
 * continue.
 *
 * Scope precedence is provided by the caller — `compileProjections` accepts an
 * already-sorted array and preserves order, so later-scope projections appear
 * later in the result lists.
 *
 * @module
 */
import { Effect } from "effect"
import type { LoadedExtension, ToolPolicyFragment } from "../../domain/extension.js"
import { extractProjections } from "../../domain/contribution.js"
import type {
  AnyProjectionContribution,
  ProjectionContext,
  ProjectionTurnContext,
} from "../../domain/projection.js"
import type { PromptSection } from "../../domain/prompt.js"
import { SCOPE_PRECEDENCE } from "./disabled.js"

interface RegisteredProjection {
  readonly extensionId: string
  readonly projection: AnyProjectionContribution
}

/** Turn evaluation result — prompt + policy fragments produced for the active turn. */
export interface ProjectionTurnEvaluation {
  readonly promptSections: ReadonlyArray<PromptSection>
  readonly policyFragments: ReadonlyArray<ToolPolicyFragment>
}

export interface CompiledProjections {
  readonly entries: ReadonlyArray<RegisteredProjection>
  /** Evaluate turn-bearing projections (turn required). Used during prompt assembly
   *  to derive prompt sections + tool policy fragments. */
  readonly evaluateTurn: (ctx: ProjectionTurnContext) => Effect.Effect<ProjectionTurnEvaluation>
  /**
   * Run a single projection by `extensionId/projectionId` — returns the raw value.
   * If multiple registrations share the same id (across scopes), the highest-precedence
   * one (project > user > builtin) wins.
   */
  readonly query: (
    extensionId: string,
    projectionId: string,
    ctx: ProjectionContext,
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

const collectProjections = (
  extensions: ReadonlyArray<LoadedExtension>,
): ReadonlyArray<RegisteredProjection> => {
  const sorted = sortedExtensions(extensions)
  const entries: RegisteredProjection[] = []
  for (const ext of sorted) {
    const projections = extractProjections(ext.contributions)
    for (const projection of projections) {
      if (projection === undefined) continue
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

  // Pre-partition entries by surface to avoid running queries for projections
  // that won't contribute to the requested context.
  const turnBearing = entries.filter(
    (e) => e.projection.prompt !== undefined || e.projection.policy !== undefined,
  )

  const evaluateTurn: CompiledProjections["evaluateTurn"] = (ctx) =>
    Effect.gen(function* () {
      // Id-keyed dedup matches the legacy `promptSection` map semantics —
      // higher-scope projection's section with the same id shadows a
      // lower-scope one (codex MEDIUM on C7). Entries are scope-sorted at
      // `collectProjections`, so last write wins.
      const sectionsById = new Map<string, PromptSection>()
      const policyFragments: ToolPolicyFragment[] = []
      for (const entry of turnBearing) {
        const value = yield* runOne(entry, ctx)
        if (value === undefined) continue
        const promptFn = entry.projection.prompt
        if (promptFn !== undefined) {
          const sectionsExit = yield* Effect.exit(Effect.sync(() => promptFn(value)))
          if (sectionsExit._tag === "Success") {
            for (const section of sectionsExit.value) sectionsById.set(section.id, section)
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
      }
      return { promptSections: [...sectionsById.values()], policyFragments }
    })

  const query: CompiledProjections["query"] = (extensionId, projectionId, ctx) =>
    Effect.gen(function* () {
      // Entries are scope-sorted (builtin → user → project) — iterate in reverse
      // so the highest-precedence registration wins.
      let entry: RegisteredProjection | undefined
      for (let i = entries.length - 1; i >= 0; i--) {
        const candidate = entries[i]
        if (
          candidate !== undefined &&
          candidate.extensionId === extensionId &&
          candidate.projection.id === projectionId
        ) {
          entry = candidate
          break
        }
      }
      if (entry === undefined) return undefined
      return yield* runOne(entry, ctx)
    })

  return { entries, evaluateTurn, query }
}

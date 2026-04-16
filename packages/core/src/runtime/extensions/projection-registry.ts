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
import type { LoadedExtension, ToolPolicyFragment } from "../../domain/extension.js"
import type { BranchId, SessionId } from "../../domain/ids.js"
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
  /** Demoted ui surfaces — extensions that contributed more than one ui-bearing projection. */
  readonly uiCollisions: ReadonlyArray<{
    readonly extensionId: string
    readonly projectionId: string
  }>
  /** Run every projection and collect projected outputs. */
  readonly evaluateAll: (ctx: ProjectionContext) => Effect.Effect<ProjectionEvaluation>
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

interface CollectionResult {
  readonly entries: ReadonlyArray<RegisteredProjection>
  readonly uiCollisions: ReadonlyArray<{
    readonly extensionId: string
    readonly projectionId: string
  }>
}

const collectProjections = (extensions: ReadonlyArray<LoadedExtension>): CollectionResult => {
  const sorted = sortedExtensions(extensions)
  const entries: RegisteredProjection[] = []
  const uiCollisions: Array<{ extensionId: string; projectionId: string }> = []

  // Snapshot collisions: ExtensionUiSnapshot is keyed only by extensionId today,
  // so if one extension contributes multiple `ui`-bearing projections (whether
  // within the same scope or stacked across scopes), later snapshots would
  // silently overwrite earlier ones in the TUI store. Enforce
  // one-UI-per-extension-id structurally — keep the highest-scope, first-declared
  // ui-bearing projection; demote later ones (record them without `ui`).
  //
  // Pre-pass: walk in highest-precedence-first order to identify the single
  // (extensionId, projectionId, registrationIndex) that owns the UI surface.
  // Using a (extensionId → {projectionId, registrationIndex}) tuple distinguishes
  // two extensions sharing the same id (e.g. project shadowing builtin).
  interface UiOwner {
    readonly projectionId: string
    /** Index into the to-be-built `entries` array — disambiguates same-id same-projectionId cases. */
    readonly extensionIndex: number
    readonly projectionIndex: number
  }
  const uiOwner = new Map<string, UiOwner>()
  for (let i = sorted.length - 1; i >= 0; i--) {
    const ext = sorted[i]
    if (ext === undefined) continue
    if (uiOwner.has(ext.manifest.id)) continue
    const projections = ext.setup.projections ?? []
    for (let pi = 0; pi < projections.length; pi++) {
      const projection = projections[pi]
      if (projection?.ui !== undefined) {
        uiOwner.set(ext.manifest.id, {
          projectionId: projection.id,
          extensionIndex: i,
          projectionIndex: pi,
        })
        break
      }
    }
  }

  for (let ei = 0; ei < sorted.length; ei++) {
    const ext = sorted[ei]
    if (ext === undefined) continue
    const projections = ext.setup.projections ?? []
    for (let pi = 0; pi < projections.length; pi++) {
      const projection = projections[pi]
      if (projection === undefined) continue
      if (projection.ui !== undefined) {
        const owner = uiOwner.get(ext.manifest.id)
        const isOwner =
          owner !== undefined && owner.extensionIndex === ei && owner.projectionIndex === pi
        if (!isOwner) {
          uiCollisions.push({ extensionId: ext.manifest.id, projectionId: projection.id })
          entries.push({
            extensionId: ext.manifest.id,
            projection: { ...projection, ui: undefined },
          })
          continue
        }
      }
      entries.push({ extensionId: ext.manifest.id, projection })
    }
  }

  return { entries, uiCollisions }
}

/** Compile registered projections into an evaluator. */
export const compileProjections = (
  extensions: ReadonlyArray<LoadedExtension>,
): CompiledProjections => {
  const { entries, uiCollisions } = collectProjections(extensions)
  // Surface collisions via console at compile time — one structured line per
  // demoted projection. Avoids requiring an Effect at registration boundary.
  for (const collision of uiCollisions) {
    // eslint-disable-next-line no-console
    console.warn(
      `[gent] projection ui collision: extension "${collision.extensionId}" already has a UI-bearing projection; demoting projection "${collision.projectionId}" (its ui surface is dropped). Each extension must have at most one ui-bearing projection.`,
    )
  }

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
    sessionId: SessionId,
    branchId: BranchId,
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
        if (ctx.branchId !== undefined) {
          const ui = yield* evaluateUi(entry, value, ctx.sessionId, ctx.branchId)
          if (ui !== undefined) uiSnapshots.push(ui)
        }
      }
      return { promptSections, policyFragments, uiSnapshots }
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

  return { entries, uiCollisions, evaluateAll, query }
}

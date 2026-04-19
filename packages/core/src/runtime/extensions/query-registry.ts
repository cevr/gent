/**
 * QueryRegistry — typed dispatch over `QueryContribution[]`.
 *
 * Routes `(extensionId, queryId, input)` to the registered contribution,
 * validates input/output via Schema, runs the handler Effect with the
 * extension's contributed Layer providing `R`. Replaces the
 * `actor.mapRequest → Machine event → slot fn` indirection used by the
 * legacy task actor.
 *
 * Scope precedence: project > user > builtin (highest-precedence registration
 * for a given `(extensionId, queryId)` wins). Same rule as projections.
 *
 * @module
 */
import { Effect, Schema } from "effect"
import type { LoadedExtension } from "../../domain/extension.js"
import { type AnyCapabilityContribution } from "../../domain/capability.js"
import { extractCapabilities, extractQueries } from "../../domain/contribution.js"
import {
  QueryError,
  QueryNotFoundError,
  type AnyQueryContribution,
  type QueryContext,
} from "../../domain/query.js"
import { SCOPE_PRECEDENCE } from "./disabled.js"

interface RegisteredQuery {
  readonly extensionId: string
  readonly query: AnyQueryContribution
}

export interface CompiledQueries {
  readonly entries: ReadonlyArray<RegisteredQuery>
  /** Run a query by `(extensionId, queryId)`. Validates input + output via Schema.
   *  If multiple registrations share the same id (across scopes), the
   *  highest-precedence one (project > user > builtin) wins. */
  readonly run: (
    extensionId: string,
    queryId: string,
    input: unknown,
    ctx: QueryContext,
  ) => Effect.Effect<unknown, QueryError | QueryNotFoundError>
}

const sortedExtensions = (
  extensions: ReadonlyArray<LoadedExtension>,
): ReadonlyArray<LoadedExtension> =>
  [...extensions].sort((a, b) => {
    const scopeDiff = SCOPE_PRECEDENCE[a.kind] - SCOPE_PRECEDENCE[b.kind]
    if (scopeDiff !== 0) return scopeDiff
    return a.manifest.id.localeCompare(b.manifest.id)
  })

/**
 * C4.2 bridge — lower a `Capability` whose `intent: "read"` includes the
 * `"agent-protocol"` audience into a `QueryContribution`-shaped adapter so
 * the legacy `compileQueries` dispatch path keeps working while extensions
 * migrate. `ctx.extension.query(ref, input)` continues to call this
 * registry; underneath the contribution may be either a legacy `query()` or
 * a new `capability()` declaration.
 *
 * Per the migrate-callers-then-delete-legacy-apis rule, this bridge exists
 * only for the duration of C4.2-4. C4.5 deletes the legacy QueryContribution
 * type and replaces this whole file with a thin wrapper around
 * `CapabilityHost`.
 */
const capabilityToQuery = (cap: AnyCapabilityContribution): AnyQueryContribution => ({
  id: cap.id,
  input: cap.input,
  output: cap.output,
  handler: (input, ctx) => {
    // The capability declares the full `CapabilityContext` (= ModelCapabilityContext)
    // but the handlers we bridge here only ever read CapabilityCoreContext fields
    // (sessionId/branchId/cwd/home). The legacy registry call sites already
    // supply those four fields via `QueryContext`. Cast through `unknown`
    // because QueryContext.branchId is optional while CapabilityCoreContext
    // requires it — at every real call site upstream branchId is present.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    const wideCtx = ctx as unknown as Parameters<typeof cap.effect>[1]
    // @effect-diagnostics-next-line anyUnknownInErrorContext:off — capability R/E erased at registry boundary
    return cap.effect(input, wideCtx).pipe(
      Effect.catchTag("@gent/core/src/domain/capability/CapabilityError", (e) =>
        Effect.fail(
          new QueryError({
            extensionId: e.extensionId,
            queryId: e.capabilityId,
            reason: e.reason,
          }),
        ),
      ),
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    ) as ReturnType<AnyQueryContribution["handler"]>
  },
})

/** Compile registered queries into a dispatcher. */
export const compileQueries = (extensions: ReadonlyArray<LoadedExtension>): CompiledQueries => {
  const sorted = sortedExtensions(extensions)
  const entries: RegisteredQuery[] = []
  for (const ext of sorted) {
    for (const query of extractQueries(ext.contributions)) {
      entries.push({ extensionId: ext.manifest.id, query })
    }
    // Bridge: read+agent-protocol capabilities show up here as queries.
    for (const capability of extractCapabilities(ext.contributions)) {
      if (capability.intent !== "read") continue
      if (!capability.audiences.includes("agent-protocol")) continue
      entries.push({ extensionId: ext.manifest.id, query: capabilityToQuery(capability) })
    }
  }

  const findEntry = (extensionId: string, queryId: string): RegisteredQuery | undefined => {
    // Iterate in reverse so the highest-precedence registration wins.
    for (let i = entries.length - 1; i >= 0; i--) {
      const candidate = entries[i]
      if (
        candidate !== undefined &&
        candidate.extensionId === extensionId &&
        candidate.query.id === queryId
      ) {
        return candidate
      }
    }
    return undefined
  }

  const run: CompiledQueries["run"] = (extensionId, queryId, input, ctx) =>
    Effect.gen(function* () {
      const entry = findEntry(extensionId, queryId)
      if (entry === undefined) {
        return yield* new QueryNotFoundError({ extensionId, queryId })
      }
      // Decode input — caller-supplied, validated at the boundary.
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      const decodedInput = yield* Schema.decodeUnknownEffect(entry.query.input as Schema.Any)(
        input,
      ).pipe(
        Effect.catchEager((e) =>
          Effect.fail(
            new QueryError({
              extensionId,
              queryId,
              reason: `input decode failed: ${String(e)}`,
            }),
          ),
        ),
      )
      // Run handler — R is provided by the extension's contributed Layer at
      // composition time; QueryRegistry treats it as already-provided.
      // @effect-diagnostics-next-line anyUnknownInErrorContext:off — query R/E erased at registry boundary
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      const handlerEffect = entry.query.handler(decodedInput, ctx) as Effect.Effect<
        unknown,
        QueryError
      >
      const output = yield* handlerEffect.pipe(
        Effect.catchDefect((defect) =>
          Effect.fail(
            new QueryError({
              extensionId,
              queryId,
              reason: `handler defect: ${String(defect)}`,
            }),
          ),
        ),
      )
      // Validate output shape — handler returns typed (decoded) form; encode
      // confirms it matches the schema contract. Misshape is a host bug, not
      // user input. Return the original typed value (callers expect decoded form).
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      yield* Schema.encodeUnknownEffect(entry.query.output as Schema.Any)(output).pipe(
        Effect.catchEager((e) =>
          Effect.fail(
            new QueryError({
              extensionId,
              queryId,
              reason: `output validation failed: ${String(e)}`,
            }),
          ),
        ),
      )
      return output
    })

  return { entries, run }
}

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

/**
 * The legacy `QueryContribution` source — handler is invoked directly.
 * Always eligible for `query()` dispatch.
 */
interface RegisteredLegacyQuery {
  readonly _source: "query"
  readonly extensionId: string
  readonly query: AnyQueryContribution
}

/**
 * A `CapabilityContribution` source. Eligibility for `query()` dispatch is
 * decided AFTER identity-first scope resolution by checking
 * `intent === "read"` AND `audiences.includes("agent-protocol")`. A
 * higher-scope capability that doesn't match those criteria still shadows
 * lower-scope entries with the same `(extensionId, id)` — invocation through
 * `query()` returns `QueryNotFoundError`, mirroring CapabilityHost's
 * "scope precedence first, then audience authorization" rule (codex BLOCK
 * on C4.1 / C4.2).
 */
interface RegisteredCapabilityEntry {
  readonly _source: "capability"
  readonly extensionId: string
  readonly capability: AnyCapabilityContribution
}

type RegisteredQuery = RegisteredLegacyQuery | RegisteredCapabilityEntry

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
 * Identity of a registered query/capability for the dispatch lookup.
 */
const entryId = (entry: RegisteredQuery): string =>
  entry._source === "query" ? entry.query.id : entry.capability.id

/**
 * C4.2 bridge — `compileQueries` collects BOTH legacy `QueryContribution`s
 * AND every `CapabilityContribution` from the contribution set, regardless
 * of intent/audience. Identity-first scope resolution wins, then audience +
 * intent are authorized at the matched entry — exactly mirroring
 * `CapabilityHost.findEntry`'s "scope precedence first, audience second"
 * rule.
 *
 * If the highest-scope entry is a capability that doesn't include
 * `"agent-protocol"` in audiences OR doesn't have `intent: "read"`, the
 * lookup returns `QueryNotFoundError` — it does NOT fall through to a
 * lower-scope match. Otherwise a project override could narrow audiences
 * and accidentally re-expose the builtin (codex BLOCK on C4.1, repeated
 * here for the bridge in C4.2).
 *
 * Per the migrate-callers-then-delete-legacy-apis rule, this bridge exists
 * only for the duration of C4.2-4. C4.5 deletes the legacy
 * QueryContribution type and replaces this whole file with a thin wrapper
 * around `CapabilityHost`.
 */
/** Compile registered queries into a dispatcher. */
export const compileQueries = (extensions: ReadonlyArray<LoadedExtension>): CompiledQueries => {
  const sorted = sortedExtensions(extensions)
  const entries: RegisteredQuery[] = []
  for (const ext of sorted) {
    for (const query of extractQueries(ext.contributions)) {
      entries.push({ _source: "query", extensionId: ext.manifest.id, query })
    }
    // Bridge: ALL capabilities enter the entry list so identity-first scope
    // shadowing applies. Audience/intent authorization happens at lookup,
    // not at compile time.
    for (const capability of extractCapabilities(ext.contributions)) {
      entries.push({ _source: "capability", extensionId: ext.manifest.id, capability })
    }
  }

  const findEntry = (extensionId: string, queryId: string): RegisteredQuery | undefined => {
    // Iterate in reverse so the highest-precedence registration wins.
    for (let i = entries.length - 1; i >= 0; i--) {
      const candidate = entries[i]
      if (
        candidate !== undefined &&
        candidate.extensionId === extensionId &&
        entryId(candidate) === queryId
      ) {
        return candidate
      }
    }
    return undefined
  }

  /**
   * After identity-first resolution, authorize the entry as a query call.
   * Legacy QueryContribution entries are always authorized. Capability
   * entries must declare `intent: "read"` and include `"agent-protocol"`
   * in their audience set.
   */
  const isAuthorizedAsQuery = (entry: RegisteredQuery): boolean => {
    if (entry._source === "query") return true
    return (
      entry.capability.intent === "read" && entry.capability.audiences.includes("agent-protocol")
    )
  }

  const run: CompiledQueries["run"] = (extensionId, queryId, input, ctx) =>
    Effect.gen(function* () {
      const entry = findEntry(extensionId, queryId)
      // Identity-first miss — no contribution at all for this id.
      if (entry === undefined) {
        return yield* new QueryNotFoundError({ extensionId, queryId })
      }
      // Identity-first hit, but the highest-scope entry isn't authorized
      // as a query call (capability with wrong intent or missing audience).
      // Treat as not-found — must NOT fall through to a lower-scope entry.
      if (!isAuthorizedAsQuery(entry)) {
        return yield* new QueryNotFoundError({ extensionId, queryId })
      }
      // Pull schemas + handler — uniform interface over both sources.
      const inputSchema = entry._source === "query" ? entry.query.input : entry.capability.input
      const outputSchema = entry._source === "query" ? entry.query.output : entry.capability.output

      // Decode input — caller-supplied, validated at the boundary.
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      const decodedInput = yield* Schema.decodeUnknownEffect(inputSchema as Schema.Any)(input).pipe(
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
      const handlerEffect: Effect.Effect<unknown, QueryError> =
        entry._source === "query"
          ? // @effect-diagnostics-next-line anyUnknownInErrorContext:off — query R/E erased at registry boundary
            // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
            (entry.query.handler(decodedInput, ctx) as Effect.Effect<unknown, QueryError>)
          : // Bridge: invoke the capability's effect, translating
            // CapabilityError → QueryError. The capability's parameter is
            // typed as the wide `ModelCapabilityContext`, but in this bridge
            // we only ever invoke through migrated capabilities that declare
            // their handler over the structurally-narrower `CapabilityCoreContext`
            // (the param is contravariant, so this is well-typed at the
            // capability declaration site). The cast widens QueryContext to
            // satisfy the declared parameter type — sound because the only
            // fields the bridged handlers ever read are the four
            // `CapabilityCoreContext` fields, all of which QueryContext now
            // provides (branchId is required after the C4.2 BLOCK fix).
            // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
            (entry.capability
              .effect(
                decodedInput,
                // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
                ctx as unknown as Parameters<typeof entry.capability.effect>[1],
              )
              .pipe(
                Effect.catchTag(
                  "@gent/core/src/domain/capability/CapabilityError",
                  (e: { extensionId: string; capabilityId: string; reason: string }) =>
                    Effect.fail(
                      new QueryError({
                        extensionId: e.extensionId,
                        queryId: e.capabilityId,
                        reason: e.reason,
                      }),
                    ),
                ),
                // @effect-diagnostics-next-line anyUnknownInErrorContext:off — capability R/E erased at registry boundary
                // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
              ) as Effect.Effect<unknown, QueryError>)
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
      yield* Schema.encodeUnknownEffect(outputSchema as Schema.Any)(output).pipe(
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

/**
 * MutationRegistry — typed dispatch over `MutationContribution[]`.
 *
 * Routes `(extensionId, mutationId, input)` to the registered contribution,
 * validates input/output via Schema, runs the handler Effect with the
 * extension's contributed Layer providing `R`. Replaces the
 * `actor.mapRequest → Machine event → slot fn` indirection used by the
 * legacy task actor for write operations.
 *
 * Scope precedence: project > user > builtin (highest-precedence registration
 * for a given `(extensionId, mutationId)` wins). Same rule as projections /
 * queries.
 *
 * @module
 */
import { Effect, Schema } from "effect"
import type { LoadedExtension } from "../../domain/extension.js"
import { type AnyCapabilityContribution } from "../../domain/capability.js"
import { extractCapabilities, extractMutations } from "../../domain/contribution.js"
import {
  MutationError,
  MutationNotFoundError,
  type AnyMutationContribution,
  type MutationContext,
} from "../../domain/mutation.js"
import { SCOPE_PRECEDENCE } from "./disabled.js"

/** Legacy `MutationContribution` source — handler invoked directly. */
interface RegisteredLegacyMutation {
  readonly _source: "mutation"
  readonly extensionId: string
  readonly mutation: AnyMutationContribution
}

/**
 * `CapabilityContribution` source. Eligibility for `mutate()` dispatch is
 * decided AFTER identity-first scope resolution by checking
 * `intent === "write"` AND `audiences.includes("agent-protocol")`. Mirrors
 * the query-registry bridge — see that file for the full rationale.
 */
interface RegisteredCapabilityEntry {
  readonly _source: "capability"
  readonly extensionId: string
  readonly capability: AnyCapabilityContribution
}

type RegisteredMutation = RegisteredLegacyMutation | RegisteredCapabilityEntry

export interface CompiledMutations {
  readonly entries: ReadonlyArray<RegisteredMutation>
  readonly run: (
    extensionId: string,
    mutationId: string,
    input: unknown,
    ctx: MutationContext,
  ) => Effect.Effect<unknown, MutationError | MutationNotFoundError>
}

const sortedExtensions = (
  extensions: ReadonlyArray<LoadedExtension>,
): ReadonlyArray<LoadedExtension> =>
  [...extensions].sort((a, b) => {
    const scopeDiff = SCOPE_PRECEDENCE[a.kind] - SCOPE_PRECEDENCE[b.kind]
    if (scopeDiff !== 0) return scopeDiff
    return a.manifest.id.localeCompare(b.manifest.id)
  })

const entryId = (entry: RegisteredMutation): string =>
  entry._source === "mutation" ? entry.mutation.id : entry.capability.id

/**
 * C4.2 bridge — see `query-registry.ts` for full design notes. Identity-first
 * scope resolution + audience/intent authorization on the winner; capabilities
 * that don't match `intent: "write"` + `audiences.includes("agent-protocol")`
 * still SHADOW lower-scope entries with the same `(extensionId, id)`.
 */
/** Compile registered mutations into a dispatcher. */
export const compileMutations = (extensions: ReadonlyArray<LoadedExtension>): CompiledMutations => {
  const sorted = sortedExtensions(extensions)
  const entries: RegisteredMutation[] = []
  for (const ext of sorted) {
    for (const mutation of extractMutations(ext.contributions)) {
      entries.push({ _source: "mutation", extensionId: ext.manifest.id, mutation })
    }
    // Bridge: ALL capabilities enter the entry list so identity-first scope
    // shadowing applies. Audience/intent authorization happens at lookup.
    for (const capability of extractCapabilities(ext.contributions)) {
      entries.push({ _source: "capability", extensionId: ext.manifest.id, capability })
    }
  }

  const findEntry = (extensionId: string, mutationId: string): RegisteredMutation | undefined => {
    for (let i = entries.length - 1; i >= 0; i--) {
      const candidate = entries[i]
      if (
        candidate !== undefined &&
        candidate.extensionId === extensionId &&
        entryId(candidate) === mutationId
      ) {
        return candidate
      }
    }
    return undefined
  }

  const isAuthorizedAsMutation = (entry: RegisteredMutation): boolean => {
    if (entry._source === "mutation") return true
    return (
      entry.capability.intent === "write" && entry.capability.audiences.includes("agent-protocol")
    )
  }

  const run: CompiledMutations["run"] = (extensionId, mutationId, input, ctx) =>
    Effect.gen(function* () {
      const entry = findEntry(extensionId, mutationId)
      if (entry === undefined) {
        return yield* new MutationNotFoundError({ extensionId, mutationId })
      }
      // Identity-first hit, but the highest-scope entry isn't authorized as a
      // mutation call (capability with wrong intent or missing audience).
      // Treat as not-found — must NOT fall through to a lower-scope entry.
      if (!isAuthorizedAsMutation(entry)) {
        return yield* new MutationNotFoundError({ extensionId, mutationId })
      }
      const inputSchema =
        entry._source === "mutation" ? entry.mutation.input : entry.capability.input
      const outputSchema =
        entry._source === "mutation" ? entry.mutation.output : entry.capability.output

      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      const decodedInput = yield* Schema.decodeUnknownEffect(inputSchema as Schema.Any)(input).pipe(
        Effect.catchEager((e) =>
          Effect.fail(
            new MutationError({
              extensionId,
              mutationId,
              reason: `input decode failed: ${String(e)}`,
            }),
          ),
        ),
      )
      const handlerEffect: Effect.Effect<unknown, MutationError> =
        entry._source === "mutation"
          ? // @effect-diagnostics-next-line anyUnknownInErrorContext:off — mutation R/E erased at registry boundary
            // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
            (entry.mutation.handler(decodedInput, ctx) as Effect.Effect<unknown, MutationError>)
          : // Bridge: invoke the capability's effect, translating
            // CapabilityError → MutationError. See query-registry's bridge
            // for the full rationale on the ctx widening.
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
                      new MutationError({
                        extensionId: e.extensionId,
                        mutationId: e.capabilityId,
                        reason: e.reason,
                      }),
                    ),
                ),
                // @effect-diagnostics-next-line anyUnknownInErrorContext:off — capability R/E erased at registry boundary
                // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
              ) as Effect.Effect<unknown, MutationError>)
      const output = yield* handlerEffect.pipe(
        Effect.catchDefect((defect) =>
          Effect.fail(
            new MutationError({
              extensionId,
              mutationId,
              reason: `handler defect: ${String(defect)}`,
            }),
          ),
        ),
      )
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      yield* Schema.encodeUnknownEffect(outputSchema as Schema.Any)(output).pipe(
        Effect.catchEager((e) =>
          Effect.fail(
            new MutationError({
              extensionId,
              mutationId,
              reason: `output validation failed: ${String(e)}`,
            }),
          ),
        ),
      )
      return output
    })

  return { entries, run }
}
